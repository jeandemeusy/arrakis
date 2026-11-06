import 'server-only';

import {
  Pool,
  types as pgTypes,
  type FieldDef,
  type PoolClient,
  type QueryConfig,
} from 'pg';

import { HttpError } from '../api/errors';
import type { NetworkConfig } from '../networks';
import { columnType, type Column } from './columns';
import type { BindValue } from './params';

/**
 * Runs SQL against a data source, read-only, bounded in time, rows and
 * concurrency. Every query in Arrakis — an editor's experiment, a scheduled
 * refresh, a system lookup — goes through `runReadOnly`; there is no second
 * path to a data source for saved queries.
 *
 * Read-only is enforced three times over:
 *
 *  1. The role. Before a network's first query, and every few minutes after,
 *     the role is checked for any write privilege — its own, a role it can
 *     switch to, a predefined role with server access, dblink, a foreign
 *     server, the file functions; a network whose role could write is
 *     refused outright.
 *  2. The transaction. Each run is `BEGIN READ ONLY`, which rejects writes even
 *     if a privilege slipped through.
 *  3. The statement. The query is the body of `DECLARE … CURSOR FOR`, which
 *     only accepts a SELECT or VALUES, and is wrapped as a subquery, where a
 *     data-modifying CTE is a syntax error. It is sent alone through the
 *     extended protocol, which refuses a second statement.
 */

const BATCH_ROWS = 5_000;
const ROLE_CHECK_MS = 5 * 60_000;

function settings() {
  const integer = (name: string, fallback: number) => {
    const value = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    timeoutMs: integer('ARRAKIS_QUERY_TIMEOUT_MS', 30_000),
    concurrency: integer('ARRAKIS_QUERY_CONCURRENCY', 3),
    queue: integer('ARRAKIS_QUERY_QUEUE', 10),
    allowWritableRole: process.env.ARRAKIS_UNSAFE_ALLOW_WRITABLE_ROLE === '1',
  };
}

/**
 * Parsers that keep what JSON cannot hold exactly as text: dates and naive
 * timestamps stay as PostgreSQL printed them rather than becoming a JS Date in
 * the server's local time zone. int8 and numeric are already strings by default.
 */
export const TYPES = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === 1082 || oid === 1114) return (value: string) => value;
    return format === 'binary'
      ? pgTypes.getTypeParser(oid, 'binary')
      : pgTypes.getTypeParser(oid, 'text');
  },
} as const;

const pools = new Map<string, Pool>();

function poolFor(network: NetworkConfig): Pool {
  let pool = pools.get(network.id);
  if (!pool) {
    pool = new Pool({
      connectionString: network.queryDatabaseUrl,
      // The pool size IS the concurrency limit: a run holds its connection for
      // its whole duration, so at most this many run on one network at once.
      max: settings().concurrency,
      idleTimeoutMillis: 30_000,
      application_name: 'arrakis-query',
    });
    // An idle client losing its connection must not crash the process.
    pool.on('error', (error) => {
      console.error(`Query pool for ${network.id}:`, error.message);
    });
    pools.set(network.id, pool);
  }
  return pool;
}

const roleChecks = new Map<
  string,
  { at: number; problem: string | null; pending?: Promise<string | null> }
>();

/**
 * Describes any way the network's role could write, or null if it cannot.
 *
 * Checks superuser, CREATE on the database and on any schema, and
 * INSERT/UPDATE/DELETE/TRUNCATE on any relation outside the system catalogs;
 * then what reaches further: membership in the predefined roles that write
 * or touch the server (pg_write_all_data, the server-file and -program roles,
 * pg_signal_backend), a role it can SET ROLE to that could write (NOINHERIT
 * memberships, which the privilege functions above do not follow), dblink
 * and the file and large-object functions, and usable foreign servers.
 * Reading everything (pg_read_all_data) is not a problem: it cannot write.
 */
async function writePrivileges(client: PoolClient): Promise<string | null> {
  const { rows } = await client.query<{ problem: string }>(`
    SELECT 'is a superuser' AS problem
      FROM pg_roles WHERE rolname = current_user AND rolsuper
    UNION ALL
    SELECT 'can create in database ' || current_database()
      WHERE has_database_privilege(current_database(), 'CREATE')
    UNION ALL
    (SELECT 'can create in schema ' || nspname
       FROM pg_namespace
      WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
        AND has_schema_privilege(oid, 'CREATE')
      LIMIT 3)
    UNION ALL
    (SELECT 'can write to ' || n.nspname || '.' || c.relname
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
        AND (has_table_privilege(c.oid, 'INSERT')
          OR has_table_privilege(c.oid, 'UPDATE')
          OR has_table_privilege(c.oid, 'DELETE')
          OR has_table_privilege(c.oid, 'TRUNCATE'))
      LIMIT 3)
    UNION ALL
    -- Roles it belongs to with powers beyond reading: writing anywhere, the
    -- server's files and programs, other sessions.
    (SELECT 'belongs to ' || r.rolname
       FROM pg_roles r
      WHERE r.rolname IN ('pg_write_all_data', 'pg_read_server_files',
                          'pg_write_server_files', 'pg_execute_server_program',
                          'pg_signal_backend', 'pg_database_owner')
        AND r.rolname <> current_user
        AND pg_has_role(current_user, r.oid, 'MEMBER')
      LIMIT 3)
    UNION ALL
    -- A role it can SET ROLE to without inheriting from it (NOINHERIT): the
    -- checks above see only what it inherits, a query can switch.
    (SELECT 'can switch to role ' || r.rolname || ', which '
            || CASE WHEN r.rolsuper THEN 'is a superuser'
                    ELSE 'can write or create' END
       FROM pg_roles r
      WHERE r.rolname <> current_user
        AND r.rolname NOT LIKE 'pg\\_%'
        AND pg_has_role(current_user, r.oid, 'MEMBER')
        AND (r.rolsuper
          OR has_database_privilege(r.oid, current_database(), 'CREATE')
          OR EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
              AND (has_table_privilege(r.oid, c.oid, 'INSERT')
                OR has_table_privilege(r.oid, c.oid, 'UPDATE')
                OR has_table_privilege(r.oid, c.oid, 'DELETE')
                OR has_table_privilege(r.oid, c.oid, 'TRUNCATE'))))
      LIMIT 3)
    UNION ALL
    -- Functions that reach past the transaction or onto the server:
    -- dblink opens connections of its own, which READ ONLY does not bind;
    -- the file and large-object functions read or write the server's files.
    (SELECT 'can call ' || p.proname
       FROM pg_proc p
      WHERE p.proname IN ('dblink', 'dblink_exec', 'dblink_connect',
                          'dblink_connect_u', 'lo_import', 'lo_export',
                          'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir')
        AND has_function_privilege(p.oid, 'EXECUTE')
        AND NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)
      LIMIT 3)
    UNION ALL
    (SELECT 'can use the foreign server ' || srvname
            || ', whose connections the read-only transaction does not bind'
       FROM pg_foreign_server
      WHERE has_server_privilege(oid, 'USAGE')
      LIMIT 3)
  `);
  return rows.length ? rows.map((row) => row.problem).join('; ') : null;
}

async function assertReadOnlyRole(
  network: NetworkConfig,
  client: PoolClient,
): Promise<void> {
  const now = Date.now();
  let entry = roleChecks.get(network.id);
  if (!entry || now - entry.at > ROLE_CHECK_MS) {
    const pending = entry?.pending ?? writePrivileges(client);
    entry = { at: entry?.at ?? 0, problem: entry?.problem ?? null, pending };
    roleChecks.set(network.id, entry);
    try {
      const problem = await pending;
      entry = { at: Date.now(), problem };
      roleChecks.set(network.id, entry);
    } catch (error) {
      roleChecks.delete(network.id);
      throw error;
    }
  }
  if (entry.problem && !settings().allowWritableRole) {
    throw new HttpError(
      503,
      `Queries on ${network.label} are disabled: its database role is not read-only (${entry.problem}). Connect with a role that can only SELECT.`,
    );
  }
}

/** The role check's verdict for a network, for health reporting. */
export function roleStatus(networkId: string): string | null | undefined {
  return roleChecks.get(networkId)?.problem;
}

export type RunRequest = {
  network: NetworkConfig;
  text: string;
  values: BindValue[];
  /** Rows beyond this are not fetched; `truncated` says whether any existed. */
  rowLimit: number;
  timeoutMs?: number;
  /**
   * Receives rows in batches instead of collecting them, so a result of
   * millions of rows never sits in memory whole. Columns arrive with the first
   * call, which may carry zero rows.
   */
  onBatch?: (rows: unknown[][], columns: Column[]) => Promise<void>;
  /**
   * Lists the run among those in progress while it lasts, so it can be seen
   * and cancelled from any replica. Left out for the server's own lookups.
   */
  track?: RunTracking;
  /**
   * Returns the plan instead of the rows, one line per row. `analyze` runs the
   * query to measure it, inside the same read-only transaction and time limit.
   */
  explain?: 'plan' | 'analyze';
};

export type RunTracking = {
  kind: 'preview' | 'store' | 'schedule';
  query?: string;
  /** A preview's token, chosen by the page that started it. */
  runKey?: string;
  startedBy?: string;
};

export type RunOutcome = {
  columns: Column[];
  /** Empty when `onBatch` consumed the rows. */
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
};

type PgError = Error & {
  code?: string;
  detail?: string;
  hint?: string;
  position?: string;
};

/** Turns a database error into something an editor can act on. */
function explain(error: unknown, timeoutMs: number): unknown {
  const pg = error as PgError;
  if (typeof pg?.code !== 'string') return error;
  if (pg.code === '57014') {
    // Someone stopped it, rather than the clock.
    if (/user request/i.test(pg.message)) {
      return new HttpError(409, 'Query cancelled', {
        details: { cancelled: true },
      });
    }
    return new HttpError(
      408,
      `Query stopped after ${Math.round(timeoutMs / 1000)} s, its time limit. Make it lighter, or raise the limit under Run limits.`,
      { details: { timedOut: true } },
    );
  }
  // Classes 08 (connection), 53 (resources), 57 (operator intervention) and
  // 58 (system) are the database's trouble, not the query's.
  if (/^(08|53|57|58)/.test(pg.code)) {
    return new HttpError(503, `Database unavailable: ${pg.message}`);
  }
  return new HttpError(400, pg.message, {
    details: {
      sqlstate: pg.code,
      ...(pg.detail ? { detail: pg.detail } : {}),
      ...(pg.hint ? { hint: pg.hint } : {}),
    },
  });
}

export async function runReadOnly(request: RunRequest): Promise<RunOutcome> {
  const { network, text, values, rowLimit, onBatch } = request;
  const timeoutMs = request.timeoutMs ?? settings().timeoutMs;
  const pool = poolFor(network);
  if (pool.waitingCount >= settings().queue) {
    throw new HttpError(
      429,
      `Too many queries waiting on ${network.label}; try again shortly`,
      { headers: { 'retry-after': '10' } },
    );
  }

  const started = Date.now();
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    throw new HttpError(
      503,
      `Cannot reach the ${network.label} database: ${(error as Error).message}`,
    );
  }

  let broken = false;
  const tracked = request.track
    ? await startTracking(network.id, client, request.track)
    : null;
  try {
    await assertReadOnlyRole(network, client);
    await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    // Bounded integers only, so interpolating them is safe; SET takes no binds.
    await client.query(
      `SET LOCAL statement_timeout = ${Math.max(1, timeoutMs)}`,
    );
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(
      `SET LOCAL idle_in_transaction_session_timeout = ${timeoutMs + 10_000}`,
    );
    // Day buckets and ::date casts mean the same thing on every server.
    await client.query("SET LOCAL TimeZone = 'UTC'");

    // The plan of the same wrapped statement a run would fetch from, so
    // only a query can be explained, never anything else.
    if (request.explain) {
      const plan: QueryConfig<BindValue[]> & { queryMode: 'extended' } = {
        text: `EXPLAIN (${request.explain === 'analyze' ? 'ANALYZE, BUFFERS, ' : ''}FORMAT TEXT) SELECT * FROM (\n${text}\n) AS arrakis_query`,
        values,
        queryMode: 'extended',
      };
      const result = await client.query<Record<string, string>>(plan);
      await client.query('COMMIT');
      const rows = result.rows.map((row) => [Object.values(row)[0]]);
      return {
        columns: [{ name: 'QUERY PLAN', type: 'text' }],
        rows,
        rowCount: rows.length,
        truncated: false,
        durationMs: Date.now() - started,
      };
    }

    // `queryMode` is honoured by pg but missing from its type definitions.
    // Extended mode even without values: the simple protocol would accept a
    // second statement.
    const declare: QueryConfig<BindValue[]> & { queryMode: 'extended' } = {
      text: `DECLARE arrakis_cursor NO SCROLL CURSOR FOR SELECT * FROM (\n${text}\n) AS arrakis_query`,
      values,
      queryMode: 'extended',
    };
    await client.query(declare);

    let columns: Column[] | null = null;
    const rows: unknown[][] = [];
    let rowCount = 0;
    let truncated = false;
    for (;;) {
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0)
        throw Object.assign(new Error('timeout'), { code: '57014' });
      // The budget covers the whole run, not each batch: a query that streams
      // slowly cannot outlive it by being fetched in many small pieces.
      await client.query(`SET LOCAL statement_timeout = ${remaining}`);
      const wanted = Math.min(BATCH_ROWS, rowLimit + 1 - rowCount);
      const batch = await client.query<unknown[]>({
        text: `FETCH FORWARD ${wanted} FROM arrakis_cursor`,
        rowMode: 'array',
        types: TYPES,
      });
      columns ??= batch.fields.map((field: FieldDef) => ({
        name: field.name,
        type: columnType(field.dataTypeID),
      }));
      let fetched = batch.rows;
      if (rowCount + fetched.length > rowLimit) {
        truncated = true;
        fetched = fetched.slice(0, rowLimit - rowCount);
      }
      rowCount += fetched.length;
      if (onBatch) {
        if (fetched.length || rowCount === 0) {
          // Wrapped so a failure writing the batch elsewhere is not mistaken
          // for an error in the query itself.
          await onBatch(fetched, columns).catch((cause: unknown) => {
            throw new Error('Could not store the result', { cause });
          });
        }
      } else {
        for (const row of fetched) rows.push(row);
      }
      if (truncated || batch.rows.length < wanted) break;
    }
    await client.query('COMMIT');
    return {
      columns: columns ?? [],
      rows,
      rowCount,
      truncated,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw explain(error, timeoutMs);
  } finally {
    // A query can leave session state behind that outlives its transaction —
    // a session-level advisory lock, a set_config(…, false). The connection
    // goes back to a shared pool, so it goes back clean, or not at all.
    if (!broken) {
      await client.query('DISCARD ALL').catch(() => {
        broken = true;
      });
    }
    client.release(broken);
    if (tracked) await stopTracking(tracked);
  }
}

/** Records a run as in progress; null when the app database is not there. */
async function startTracking(
  network: string,
  client: PoolClient,
  track: RunTracking,
): Promise<string | null> {
  // The backend serving this run: what pg_cancel_backend is given to stop it.
  const pid = (client as PoolClient & { processID?: number }).processID;
  if (!pid || !process.env.APP_DATABASE_URL?.trim()) return null;
  try {
    const { appDb } = await import('../db/app');
    const db = await appDb();
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO active_runs (network, pid, kind, query_slug, run_key, started_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        network,
        pid,
        track.kind,
        track.query ?? null,
        track.runKey ?? null,
        track.startedBy ?? null,
      ],
    );
    return rows[0]?.id ?? null;
  } catch (error) {
    // Not being cancellable is no reason not to run.
    console.error('Could not record a run:', (error as Error).message);
    return null;
  }
}

async function stopTracking(id: string): Promise<void> {
  try {
    const { appDb } = await import('../db/app');
    await (await appDb()).query('DELETE FROM active_runs WHERE id = $1', [id]);
  } catch {
    // Pruned later if it stays behind.
  }
}

/** Closes every query pool. Tests only. */
export async function closeQueryPools(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  roleChecks.clear();
  await Promise.all(all.map((pool) => pool.end()));
}

import 'server-only';

import { Pool } from 'pg';

import { HttpError } from '../api/errors';
import { appDb } from './app';

/**
 * The connection hand-written chart SQL runs on.
 *
 * APP_CHARTS_DATABASE_URL logs in to the application database as a role of
 * its own, separate from the app's. That role may call one function,
 * `chart_access.result_rows`, which returns the rows of a stored result for a
 * ticket the app issued for the run (see 0007_chart_access.sql), and nothing
 * else: no table, no schema it can create in, no role it belongs to. A chart
 * therefore reads its own query's result and nothing more, and because the
 * connection is that role from the start there is no `SET ROLE` to undo.
 *
 * Before the first chart runs, and every few minutes after, the role is
 * checked for anything more it could do; SQL charts are refused while it
 * could. Without the variable they are refused too, and step charts, which
 * never run anyone's SQL, are unaffected.
 */

const CHECK_MS = 5 * 60_000;

let pool: Pool | undefined;
let check:
  | { at: number; role: string; problem: string | null }
  | undefined;
let pending: Promise<{ role: string; problem: string | null }> | undefined;

function url(): string | null {
  return process.env.APP_CHARTS_DATABASE_URL?.trim() || null;
}

export function chartsDatabaseConfigured(): boolean {
  return url() !== null;
}

function poolFor(connectionString: string): Pool {
  pool ??= new Pool({
    connectionString,
    // Chart SQL is light by design and bounded at ten seconds; a few at once
    // is plenty, and keeps a burst of them from crowding out anything else.
    max: 4,
    idleTimeoutMillis: 30_000,
    application_name: 'arrakis-charts',
  });
  pool.on('error', (error) => {
    console.error('Charts pool:', error.message);
  });
  return pool;
}

/**
 * Everything the charts role could do beyond calling result_rows, as a
 * sentence each; empty when it can do nothing more.
 */
async function inspect(
  charts: Pool,
): Promise<{ role: string; problem: string | null }> {
  const app = await appDb();
  const [{ rows: who }, { rows: appWho }] = await Promise.all([
    charts.query<{ role: string; database: string }>(
      'SELECT current_user AS role, current_database() AS database',
    ),
    app.query<{ role: string; database: string }>(
      'SELECT current_user AS role, current_database() AS database',
    ),
  ]);
  const role = who[0].role;
  if (role === appWho[0].role) {
    return {
      role,
      problem:
        'it logs in as the same role as APP_DATABASE_URL; give it a role of its own',
    };
  }
  if (who[0].database !== appWho[0].database) {
    return {
      role,
      problem: `it connects to database ${who[0].database}, not the app's ${appWho[0].database}`,
    };
  }

  // The one thing it may do. The app owns the function, so it grants it.
  for (const statement of [
    'GRANT USAGE ON SCHEMA chart_access TO %I',
    'GRANT EXECUTE ON FUNCTION chart_access.result_rows(text) TO %I',
  ]) {
    const { rows: built } = await app.query<{ sql: string }>(
      'SELECT format($1::text, $2::text) AS sql',
      [statement, role],
    );
    await app.query(built[0].sql);
  }

  const { rows } = await charts.query<{ problem: string }>(`
    SELECT 'is a superuser' AS problem
      FROM pg_roles WHERE rolname = current_user AND rolsuper
    UNION ALL
    (SELECT 'belongs to role ' || r.rolname
       FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
      WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      LIMIT 3)
    UNION ALL
    (SELECT 'owns ' || n.nspname || '.' || c.relname
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
      LIMIT 3)
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
    (SELECT 'can read or write ' || n.nspname || '.' || c.relname
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
        AND (has_table_privilege(c.oid, 'SELECT')
          OR has_table_privilege(c.oid, 'INSERT')
          OR has_table_privilege(c.oid, 'UPDATE')
          OR has_table_privilege(c.oid, 'DELETE')
          OR has_table_privilege(c.oid, 'TRUNCATE'))
      LIMIT 3)
    UNION ALL
    (SELECT 'can call ' || p.proname || ', which opens connections of its own'
       FROM pg_proc p
      WHERE p.proname IN ('dblink_connect', 'dblink_connect_u', 'dblink', 'dblink_exec')
        AND has_function_privilege(p.oid, 'EXECUTE')
      LIMIT 1)
    UNION ALL
    (SELECT 'can use the foreign-data wrapper ' || fdwname
       FROM pg_foreign_data_wrapper
      WHERE has_foreign_data_wrapper_privilege(oid, 'USAGE')
      LIMIT 1)
  `);
  return {
    role,
    problem: rows.length ? rows.map((row) => row.problem).join('; ') : null,
  };
}

/**
 * The charts pool, once its role is known to hold nothing more than it
 * should; a 503 that says why otherwise.
 */
export async function chartsDb(): Promise<Pool> {
  const connectionString = url();
  if (!connectionString) {
    throw new HttpError(
      503,
      'SQL charts are off: APP_CHARTS_DATABASE_URL is not set. Use steps, or give charts a role of their own (see the README).',
    );
  }
  const charts = poolFor(connectionString);
  if (!check || Date.now() - check.at > CHECK_MS) {
    pending ??= inspect(charts).finally(() => {
      pending = undefined;
    });
    let found: { role: string; problem: string | null };
    try {
      found = await pending;
    } catch (error) {
      throw new HttpError(
        503,
        `SQL charts are unavailable: cannot reach APP_CHARTS_DATABASE_URL (${(error as Error).message})`,
      );
    }
    check = { at: Date.now(), ...found };
  }
  if (check.problem) {
    throw new HttpError(
      503,
      `SQL charts are off: their role ${check.role} ${check.problem}. It should be able to do nothing but log in (see the README).`,
    );
  }
  return charts;
}

/** Closes the pool. Tests only. */
export async function closeChartsDb(): Promise<void> {
  const current = pool;
  pool = undefined;
  check = undefined;
  pending = undefined;
  await current?.end();
}

import 'server-only';

import { randomBytes } from 'node:crypto';

import { HttpError, badRequest, notFound } from '../api/errors';
import { appDb, transaction } from '../db/app';
import type { NetworkConfig } from '../networks';
import {
  STORAGE_TYPE,
  storageNames,
  toJsonValue,
  toStoredValue,
  type Column,
} from './columns';
import { compile } from './compile';
import { inputsFingerprint, parameterKey, prepare } from './execute';
import { rowLimitFor, timeoutFor } from './limits';
import { runReadOnly, TYPES } from './runner';
import { fragmentResolver, type QueryRecord, type QueryVersion } from './store';
import { listResolver } from './lists';

/**
 * Materialized results.
 *
 * A saved query's rows are copied into a real table in the application
 * database — `results.r_<created>_<random>` — so that any number of
 * visualizations can aggregate one result without reading the data source again, and
 * public readers are served from here and never cause a query to run.
 *
 * A run writes a fresh table and only then points the result row at it, in one
 * transaction, so readers see the old rows or the new ones, never a mix. The
 * table it replaces is kept one generation, for a reader that resolved its name
 * just before the swap, and dropped at the next one.
 */

const RESULTS_SCHEMA = 'results';
const TABLE = /^r_[0-9a-z]+_[0-9a-f]{8}$/;

export function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Whether a name is one of the stored result tables this module makes. */
export function isResultTable(name: string): boolean {
  return TABLE.test(name);
}

function qualified(table: string): string {
  if (!TABLE.test(table)) throw new Error(`Not a result table name: ${table}`);
  return `${RESULTS_SCHEMA}.${quote(table)}`;
}

function newTableName(): string {
  return `r_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

export type RunTrigger = 'editor' | 'schedule';

export type StoredResult = {
  network: string;
  parameters: Record<string, unknown>;
  columns: Column[];
  rowCount: number;
  truncated: boolean;
  finishedAt: string;
  durationMs: number;
  timebase: 'rpc' | 'estimated' | null;
};

/**
 * Runs a query version on one network and stores the result.
 *
 * Only one run per (version, network, parameters) at a time: a second request
 * while one is in flight gets a 409, and a claim older than the longest a run
 * can take is treated as abandoned.
 */
export async function materialize(options: {
  query: QueryRecord;
  version?: QueryVersion;
  network: NetworkConfig;
  supplied: Record<string, unknown>;
  trigger: RunTrigger;
  /** Who asked for it, shown among the runs in progress. */
  startedBy?: string;
}): Promise<StoredResult> {
  const { query, network, supplied, trigger } = options;
  const version = options.version ?? query.current;
  if (!version) throw badRequest(`Query "${query.slug}" has no version`);
  if (query.kind !== 'query') {
    throw badRequest('A fragment is not materialized; run it as a preview');
  }

  const prepared = await prepare(version, supplied, network);
  const db = await appDb();
  const claim = await db.query<{ id: string }>(
    `INSERT INTO query_results
       (query_version_id, network, parameters_hash, parameters,
        attempt_status, attempt_started_at, attempt_trigger, attempt_inputs_hash)
     VALUES ($1, $2, $3, $4, 'running', now(), $5, $6)
     ON CONFLICT (query_version_id, network, parameters_hash) DO UPDATE SET
       attempt_status = 'running',
       attempt_started_at = now(),
       attempt_finished_at = NULL,
       attempt_error = NULL,
       attempt_trigger = EXCLUDED.attempt_trigger,
       attempt_inputs_hash = EXCLUDED.attempt_inputs_hash
     WHERE query_results.attempt_status IS DISTINCT FROM 'running'
        OR query_results.attempt_started_at < now() - interval '15 minutes'
     RETURNING id`,
    [
      version.id,
      network.id,
      prepared.parameters.hash,
      JSON.stringify(prepared.parameters.values),
      trigger,
      prepared.inputsHash,
    ],
  );
  const resultId = claim.rows[0]?.id;
  if (!resultId) {
    throw new HttpError(409, 'This query is already running on that network');
  }

  const table = newTableName();
  let created = false;
  let columns: Column[] = [];
  let written = 0;
  try {
    const outcome = await runReadOnly({
      network,
      text: prepared.compiled.text,
      values: prepared.values,
      rowLimit: rowLimitFor(query.rowLimit),
      // Generous next to an editor preview by default: a scheduled refresh of
      // a heavy history is exactly what this path exists for.
      timeoutMs: timeoutFor('store', query.timeoutSeconds),
      track: {
        kind: trigger === 'schedule' ? 'schedule' : 'store',
        query: query.slug,
        startedBy: options.startedBy,
      },
      onBatch: async (rows, fields) => {
        if (!created) {
          if (!fields.length) throw badRequest('The query returns no columns');
          const names = storageNames(fields.map((field) => field.name));
          columns = fields.map((field, index) => ({
            ...field,
            column: names[index],
          }));
          await db.query(
            `CREATE TABLE ${qualified(table)} (
               arrakis_row bigint NOT NULL,
               ${columns
                 .map(
                   (column) =>
                     `${quote(column.column ?? '')} ${STORAGE_TYPE[column.type]}`,
                 )
                 .join(',\n')}
             )`,
          );
          created = true;
        }
        if (!rows.length) return;
        const arrays: unknown[][] = [
          rows.map((_, index) => written + index + 1),
          ...columns.map((column, index) =>
            rows.map((row) => toStoredValue(row[index], column.type)),
          ),
        ];
        const casts = [
          '$1::bigint[]',
          ...columns.map(
            (column, index) => `$${index + 2}::${STORAGE_TYPE[column.type]}[]`,
          ),
        ];
        await db.query(
          `INSERT INTO ${qualified(table)}
             (arrakis_row, ${columns.map((column) => quote(column.column ?? '')).join(', ')})
           SELECT * FROM unnest(${casts.join(', ')})`,
          arrays,
        );
        written += rows.length;
      },
    });

    const previous = await transaction(async (client) => {
      const { rows } = await client.query<{
        table_name: string | null;
        previous_table_name: string | null;
      }>(
        `SELECT table_name, previous_table_name FROM query_results
         WHERE id = $1 FOR UPDATE`,
        [resultId],
      );
      await client.query(
        `UPDATE query_results SET
           table_name = $2,
           previous_table_name = table_name,
           columns = $3,
           row_count = $4,
           truncated = $5,
           inputs_hash = $6,
           timebase = $7,
           finished_at = now(),
           duration_ms = $8,
           attempt_status = 'succeeded',
           attempt_finished_at = now(),
           attempt_error = NULL
         WHERE id = $1`,
        [
          resultId,
          table,
          JSON.stringify(columns),
          outcome.rowCount,
          outcome.truncated,
          prepared.inputsHash,
          null,
          outcome.durationMs,
        ],
      );
      return rows[0]?.previous_table_name ?? null;
    });
    if (previous) {
      await db.query(`DROP TABLE IF EXISTS ${qualified(previous)}`);
    }
    return {
      network: network.id,
      parameters: prepared.parameters.values,
      columns,
      rowCount: outcome.rowCount,
      truncated: outcome.truncated,
      finishedAt: new Date().toISOString(),
      durationMs: outcome.durationMs,
      timebase: null,
    };
  } catch (error) {
    if (created) {
      await db
        .query(`DROP TABLE IF EXISTS ${qualified(table)}`)
        .catch(() => undefined);
    }
    const cause = (error as Error).cause as Error | undefined;
    const message =
      error instanceof HttpError
        ? error.message
        : cause?.message
          ? `${(error as Error).message}: ${cause.message}`
          : 'Internal error';
    await db
      .query(
        `UPDATE query_results SET
           attempt_status = 'failed', attempt_finished_at = now(), attempt_error = $2
         WHERE id = $1`,
        [resultId, message.slice(0, 2_000)],
      )
      .catch(() => undefined);
    throw error;
  }
}

type ResultRow = {
  network: string;
  table_name: string | null;
  columns: Column[] | null;
  row_count: string | null;
  truncated: boolean | null;
  inputs_hash: string | null;
  timebase: 'rpc' | 'estimated' | null;
  finished_at: Date | null;
  duration_ms: number | null;
  parameters: Record<string, unknown>;
  attempt_status: string | null;
  attempt_error: string | null;
  attempt_finished_at: Date | null;
  attempt_started_at: Date | null;
};

export type ResultPage = {
  query: string;
  version: number;
  networks: Array<{
    id: string;
    status: 'ready' | 'pending' | 'failed';
    rowCount: number | null;
    truncated: boolean;
    finishedAt: string | null;
    durationMs: number | null;
    timebase: 'rpc' | 'estimated' | null;
    /** The stored rows predate a change to the exits or a fragment. */
    stale: boolean;
    lastAttempt: {
      status: string;
      at: string | null;
      error: string | null;
    } | null;
  }>;
  parameters: Record<string, unknown>;
  columns: Column[];
  rows: unknown[][];
  offset: number;
  limit: number;
};

export type NetworkStatus = ResultPage['networks'][number];

export type Located = {
  version: QueryVersion;
  parameters: { values: Record<string, unknown>; hash: string };
  networks: NetworkStatus[];
  /** Ready tables that share one shape, in target order. */
  tables: Array<{ network: string; table: string; columns: Column[] }>;
};

/**
 * Finds the stored tables behind a query's result on each target network,
 * with each network's status. Never runs anything.
 *
 * A network whose table has different columns from the first ready one is
 * reported as failed and left out, so stacking the rest stays well-formed.
 */
export async function locateResults(options: {
  query: QueryRecord;
  version?: QueryVersion;
  targets: NetworkConfig[];
  supplied: Record<string, unknown>;
}): Promise<Located> {
  const { query, targets, supplied } = options;
  const version = options.version ?? query.current;
  if (!version) throw notFound(`Query "${query.slug}" has no version`);
  if (query.kind !== 'query')
    throw badRequest('A fragment has no stored result');
  if (targets.length > 1 && query.combine === 'hidden') {
    throw new HttpError(
      404,
      `"${query.slug}" has no combined view across networks; ask for one network`,
    );
  }

  const compiled = await compile(
    version.sql,
    version.parameters,
    fragmentResolver(),
    listResolver(),
  );
  const key = parameterKey(compiled, supplied);
  const db = await appDb();
  const { rows: found } = await db.query<ResultRow>(
    `SELECT network, table_name, columns, row_count, truncated, inputs_hash,
            timebase, finished_at, duration_ms, parameters, attempt_status,
            attempt_error, attempt_finished_at, attempt_started_at
     FROM query_results
     WHERE query_version_id = $1 AND parameters_hash = $2 AND network = ANY ($3)`,
    [version.id, key.hash, targets.map((network) => network.id)],
  );
  const byNetwork = new Map(found.map((row) => [row.network, row]));

  const networks: NetworkStatus[] = [];
  const ready: Located['tables'] = [];
  for (const network of targets) {
    const row = byNetwork.get(network.id);
    const isReady = Boolean(row?.table_name && row.columns);
    const current = await inputsFingerprint(compiled, network);
    networks.push({
      id: network.id,
      status: isReady
        ? 'ready'
        : row?.attempt_status === 'failed'
          ? 'failed'
          : 'pending',
      rowCount: row?.row_count === null || !row ? null : Number(row.row_count),
      truncated: row?.truncated ?? false,
      finishedAt: row?.finished_at?.toISOString() ?? null,
      durationMs: row?.duration_ms ?? null,
      timebase: row?.timebase ?? null,
      stale: isReady && row?.inputs_hash !== current,
      lastAttempt: row?.attempt_status
        ? {
            status: row.attempt_status,
            at:
              (
                row.attempt_finished_at ?? row.attempt_started_at
              )?.toISOString() ?? null,
            error: row.attempt_error,
          }
        : null,
    });
    if (isReady && row?.table_name && row.columns) {
      ready.push({
        network: network.id,
        table: row.table_name,
        columns: row.columns,
      });
    }
  }

  const signature = (columns: Column[]) =>
    JSON.stringify(columns.map((column) => [column.name, column.type]));
  const shape = ready.length ? signature(ready[0].columns) : null;
  const tables = ready.filter((entry) => signature(entry.columns) === shape);
  for (const entry of ready) {
    if (signature(entry.columns) === shape) continue;
    const status = networks.find((network) => network.id === entry.network);
    if (status) {
      status.status = 'failed';
      status.lastAttempt = {
        status: 'failed',
        at: status.finishedAt,
        error: 'Returned different columns from the other networks',
      };
    }
  }
  return { version, parameters: key, networks, tables };
}

/**
 * SQL for the stored rows, ordered as the query returned them: one table, or
 * several stacked under a leading `network` column. Column names are the
 * storage names. Network ids are checked identifiers (lowercase, digits,
 * dashes), so they are inlined as literals and the relation needs no binds.
 */
export function storedRelation(
  tables: Located['tables'],
  multi: boolean,
): { sql: string; columns: Array<{ name: string; type: Column['type'] }> } {
  if (!tables.length)
    throw new Error('storedRelation needs at least one table');
  const columns = tables[0].columns;
  // A query that names a column `network` itself keeps it; the stacked
  // relation cannot add a second one.
  if (columns.some((column) => column.name === 'network')) multi = false;
  const names = columns.map((column) => quote(column.column ?? column.name));
  const select = tables
    .map((entry, index) => {
      if (!/^[a-z0-9-]+$/.test(entry.network)) {
        throw new Error(`Unexpected network id ${entry.network}`);
      }
      return `SELECT ${multi ? `'${entry.network}'::text AS network, ${index} AS arrakis_network_order, ` : ''}arrakis_row, ${names.join(', ')} FROM ${qualified(entry.table)}`;
    })
    .join('\nUNION ALL\n');
  return {
    sql: `SELECT ${multi ? 'network, ' : ''}${names.join(', ')} FROM (${select}) AS stored ORDER BY ${multi ? 'arrakis_network_order, ' : ''}arrakis_row`,
    columns: [
      ...(multi ? [{ name: 'network', type: 'text' as const }] : []),
      ...columns.map((column) => ({
        name: column.column ?? column.name,
        type: column.type,
      })),
    ],
  };
}

/**
 * Reads a stored result. Never runs anything: a result that does not exist
 * yet is reported as pending.
 *
 * Across several networks the stored tables are stacked under a leading
 * `network` column, which requires them to have the same columns.
 */
export async function readResult(options: {
  query: QueryRecord;
  version?: QueryVersion;
  targets: NetworkConfig[];
  supplied: Record<string, unknown>;
  limit: number;
  offset: number;
}): Promise<ResultPage> {
  const db = await appDb();
  const multi = options.targets.length > 1;
  for (let attempt = 0; ; attempt += 1) {
    const located = await locateResults(options);
    const page: ResultPage = {
      query: options.query.slug,
      version: located.version.version,
      networks: located.networks,
      parameters: located.parameters.values,
      columns: [],
      rows: [],
      offset: options.offset,
      limit: options.limit,
    };
    if (!located.tables.length) return page;
    const relation = storedRelation(located.tables, multi);
    // Past the last stored row there is nothing to read; asking the database
    // would still make it scan every row to find that out.
    const stored = located.networks
      .filter((network) =>
        located.tables.some((entry) => entry.network === network.id),
      )
      .reduce((sum, network) => sum + (network.rowCount ?? 0), 0);
    if (options.offset >= stored) {
      const columns = located.tables[0].columns;
      page.columns = multi
        ? [
            { name: 'network', type: 'text' },
            ...columns.map(({ name, type }) => ({ name, type })),
          ]
        : columns.map(({ name, type }) => ({ name, type }));
      return page;
    }
    try {
      const { rows } = await db.query({
        text: `${relation.sql} LIMIT $1 OFFSET $2`,
        values: [options.limit, options.offset],
        rowMode: 'array',
        // Dates as stored, not shifted into the server's time zone.
        types: TYPES,
      });
      const columns = located.tables[0].columns;
      page.columns = multi
        ? [
            { name: 'network', type: 'text' },
            ...columns.map(({ name, type }) => ({ name, type })),
          ]
        : columns.map(({ name, type }) => ({ name, type }));
      page.rows = (rows as unknown[][]).map((row) => row.map(toJsonValue));
      return page;
    } catch (error) {
      // 42P01: a swap dropped the table between reading its name and reading
      // it. The new name is already committed, so one retry finds it.
      if ((error as { code?: string }).code === '42P01' && attempt < 2)
        continue;
      throw error;
    }
  }
}

/**
 * Housekeeping, run by the scheduler: forget results of superseded versions
 * after a week, and drop result tables nothing points at any more — left by a
 * process that died mid-run, or by a forgotten result.
 */
export async function pruneResults(): Promise<void> {
  const db = await appDb();
  // Chart runs delete their own tickets; these are from runs that died.
  await db.query('DELETE FROM chart_access.tickets WHERE expires_at < now()');
  await db.query(`
    DELETE FROM query_results r
    USING query_versions v, queries q
    WHERE v.id = r.query_version_id AND q.id = v.query_id
      AND q.current_version_id IS DISTINCT FROM v.id
      AND COALESCE(r.finished_at, r.attempt_started_at) < now() - interval '7 days'
  `);
  const { rows } = await db.query<{ name: string }>(
    `SELECT c.relname AS name
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = 'r'
       AND NOT EXISTS (
         SELECT 1 FROM query_results r
         WHERE r.table_name = c.relname OR r.previous_table_name = c.relname
       )`,
    [RESULTS_SCHEMA],
  );
  const hourAgo = Date.now() - 3_600_000;
  for (const { name } of rows) {
    if (!TABLE.test(name)) continue;
    // A table still being filled is not referenced yet; leave young ones be.
    const created = Number.parseInt(name.split('_')[1], 36);
    if (Number.isFinite(created) && created > hourAgo) continue;
    await db.query(`DROP TABLE IF EXISTS ${qualified(name)}`);
  }
}

export type RunState = {
  query: string;
  /** A refresh of its current version is under way on one of the networks. */
  running: boolean;
  /** When its newest stored result finished. */
  finishedAt: string | null;
  /** Its last attempt failed on one of the networks. */
  failed: boolean;
};

/**
 * Whether each of these queries is being run right now, for a dashboard to
 * show live: one cheap read of the results table, no compiling. A run that
 * claimed its row more than 15 minutes ago counts as abandoned, as the claim
 * itself does.
 */
export async function runStates(
  slugs: string[],
  networks: string[],
): Promise<RunState[]> {
  if (!slugs.length) return [];
  const db = await appDb();
  const { rows } = await db.query<{
    slug: string;
    running: boolean | null;
    finished_at: Date | null;
    failed: boolean | null;
  }>(
    `SELECT q.slug,
            bool_or(r.attempt_status = 'running'
                    AND r.attempt_started_at > now() - interval '15 minutes') AS running,
            max(r.finished_at) AS finished_at,
            bool_or(r.attempt_status = 'failed') AS failed
     FROM queries q
     LEFT JOIN query_results r
       ON r.query_version_id = q.current_version_id
      AND r.network = ANY ($2)
     WHERE q.slug = ANY ($1)
     GROUP BY q.slug`,
    [slugs, networks],
  );
  return rows.map((row) => ({
    query: row.slug,
    running: Boolean(row.running),
    finishedAt: row.finished_at?.toISOString() ?? null,
    failed: Boolean(row.failed),
  }));
}

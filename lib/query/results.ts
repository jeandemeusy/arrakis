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
import { runReadOnly, TYPES } from './runner';
import { fragmentResolver, type QueryRecord, type QueryVersion } from './store';

/**
 * Materialized results.
 *
 * A saved query's rows are copied into a real table in the application
 * database — `results.r_<created>_<random>` — so that any number of
 * visualizations can aggregate one result without reading Blokli again, and
 * public readers are served from here and never cause a query to run.
 *
 * A run writes a fresh table and only then points the result row at it, in one
 * transaction, so readers see the old rows or the new ones, never a mix. The
 * table it replaces is kept one generation, for a reader that resolved its name
 * just before the swap, and dropped at the next one.
 */

const RESULTS_SCHEMA = 'results';
const TABLE = /^r_[0-9a-z]+_[0-9a-f]{8}$/;

function rowLimit(): number {
  const value = Number.parseInt(process.env.ARRAKIS_RESULT_ROW_LIMIT ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : 5_000_000;
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
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
      rowLimit: rowLimit(),
      // Generous next to an editor preview: a scheduled refresh of the heavy
      // redemption history is exactly what this path exists for.
      timeoutMs: Number(process.env.ARRAKIS_MATERIALIZE_TIMEOUT_MS) || 120_000,
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
          prepared.timebase,
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
      timebase: prepared.timebase,
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
  );
  const key = parameterKey(compiled, supplied);
  const db = await appDb();

  for (let attempt = 0; ; attempt += 1) {
    const { rows: found } = await db.query<ResultRow>(
      `SELECT network, table_name, columns, row_count, truncated, inputs_hash,
              timebase, finished_at, duration_ms, parameters, attempt_status,
              attempt_error, attempt_finished_at, attempt_started_at
       FROM query_results
       WHERE query_version_id = $1 AND parameters_hash = $2 AND network = ANY ($3)`,
      [version.id, key.hash, targets.map((network) => network.id)],
    );
    const byNetwork = new Map(found.map((row) => [row.network, row]));

    const page: ResultPage = {
      query: query.slug,
      version: version.version,
      networks: [],
      parameters: key.values,
      columns: [],
      rows: [],
      offset: options.offset,
      limit: options.limit,
    };
    const readable: Array<{
      network: string;
      table: string;
      columns: Column[];
    }> = [];
    for (const network of targets) {
      const row = byNetwork.get(network.id);
      const ready = Boolean(row?.table_name && row.columns);
      const current = await inputsFingerprint(compiled, network);
      page.networks.push({
        id: network.id,
        status: ready
          ? 'ready'
          : row?.attempt_status === 'failed'
            ? 'failed'
            : 'pending',
        rowCount:
          row?.row_count === null || !row ? null : Number(row.row_count),
        truncated: row?.truncated ?? false,
        finishedAt: row?.finished_at?.toISOString() ?? null,
        durationMs: row?.duration_ms ?? null,
        timebase: row?.timebase ?? null,
        stale: ready && row?.inputs_hash !== current,
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
      if (ready && row?.table_name && row.columns) {
        readable.push({
          network: network.id,
          table: row.table_name,
          columns: row.columns,
        });
      }
    }
    if (!readable.length) return page;

    const multi = targets.length > 1;
    const signature = (columns: Column[]) =>
      JSON.stringify(columns.map((column) => [column.name, column.type]));
    const shape = signature(readable[0].columns);
    const consistent = readable.filter(
      (entry) => signature(entry.columns) === shape,
    );
    for (const entry of readable) {
      if (signature(entry.columns) !== shape) {
        const status = page.networks.find(
          (network) => network.id === entry.network,
        );
        if (status) {
          status.status = 'failed';
          status.lastAttempt = {
            status: 'failed',
            at: status.finishedAt,
            error: 'Returned different columns from the other networks',
          };
        }
      }
    }

    const columns = readable[0].columns;
    const select = consistent
      .map(
        (entry, index) =>
          `SELECT ${multi ? `$${index + 3}::text AS network, ${index} AS arrakis_network_order, ` : ''}arrakis_row, ${entry.columns
            .map((column) => quote(column.column ?? ''))
            .join(', ')} FROM ${qualified(entry.table)}`,
      )
      .join('\nUNION ALL\n');
    try {
      const { rows } = await db.query({
        text: `${select}
               ORDER BY ${multi ? 'arrakis_network_order, ' : ''}arrakis_row
               LIMIT $1 OFFSET $2`,
        values: [
          options.limit,
          options.offset,
          ...(multi ? consistent.map((entry) => entry.network) : []),
        ],
        rowMode: 'array',
        // Dates as stored, not shifted into the server's time zone.
        types: TYPES,
      });
      page.columns = multi
        ? [
            { name: 'network', type: 'text' },
            ...columns.map(({ name, type }) => ({ name, type })),
          ]
        : columns.map(({ name, type }) => ({ name, type }));
      page.rows = (rows as unknown[][]).map((row) => {
        // Drop the bookkeeping columns: the order index and the row number.
        const values = multi ? [row[0], ...row.slice(3)] : row.slice(1);
        return values.map(toJsonValue);
      });
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

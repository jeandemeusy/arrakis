import 'server-only';

import { createHash } from 'node:crypto';

import { HttpError, badRequest } from '../api/errors';
import { appDb } from '../db/app';
import type { NetworkConfig } from '../networks';
import { columnType, toJsonValue, type ColumnType } from '../query/columns';
import {
  locateResults,
  storedRelation,
  type NetworkStatus,
} from '../query/results';
import { TYPES } from '../query/runner';
import { segments } from '../query/scan';
import type { QueryRecord } from '../query/store';
import type { VisualizationConfig } from './config';
import { MAX_ROWS, buildSql, type Column } from './transform';

/**
 * Runs a visualization over its query's stored result.
 *
 * Reads only the application database — the result tables a query run wrote —
 * so a dashboard of twenty charts costs twenty small queries against local
 * tables and not one against a data source. Each run is read-only, time-limited and
 * in UTC; hand-written SQL additionally runs as a role that can see the result
 * tables and nothing else.
 *
 * Outputs are cached for a minute, keyed by the result tables they read: a
 * refresh writes new tables, so a new result is never hidden behind an old
 * cache entry.
 */

const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 500;
const READER_ROLE = 'arrakis_results_reader';

export type VisualizationData = {
  queryVersion: number | null;
  columns: Column[];
  rows: unknown[][];
  truncated: boolean;
  networks: NetworkStatus[];
  /** Nothing stored yet on any requested network. */
  pending: boolean;
};

const cache = new Map<string, { at: number; data: VisualizationData }>();

function remember(key: string, data: VisualizationData) {
  cache.set(key, { at: Date.now(), data });
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

let readerAvailable: Promise<boolean> | undefined;

/**
 * Whether hand-written SQL can run: the reader role exists and this
 * connection may switch to it. Tried for real, in a transaction that is
 * rolled back, because the privilege rules for SET ROLE differ by version.
 */
export function sqlModeAvailable(): Promise<boolean> {
  readerAvailable ??= (async () => {
    const client = await (await appDb()).connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${READER_ROLE}`);
      return true;
    } catch {
      return false;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  })().catch(() => {
    readerAvailable = undefined;
    return false;
  });
  return readerAvailable;
}

/**
 * Expands hand-written visualization SQL: `{{result}}` becomes the stored
 * rows, `{{name}}` a variable bound as text. Like saved queries, positional
 * parameters and a second statement are refused.
 */
function expandSql(
  sql: string,
  relation: string,
  vars: Record<string, string | undefined>,
): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const slots = new Map<string, number>();
  let text = '';
  for (const segment of segments(sql)) {
    if (!segment.code) {
      text += segment.text;
      continue;
    }
    if (/\$\d/.test(segment.text)) {
      throw badRequest(
        'Positional parameters like $1 are not allowed; use {{name}}',
      );
    }
    text += segment.text.replace(
      /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g,
      (_, name: string) => {
        if (name === 'result') return `(${relation})`;
        let slot = slots.get(name);
        if (slot === undefined) {
          values.push(vars[name] ?? null);
          slot = values.length;
          slots.set(name, slot);
        }
        return `$${slot}::text`;
      },
    );
  }
  const trimmed = text.trim().replace(/;\s*$/, '');
  for (const segment of segments(trimmed)) {
    if (segment.code && segment.text.includes(';')) {
      throw badRequest('Only a single statement is allowed');
    }
  }
  if (
    /\{\{/.test(
      segments(trimmed)
        .filter((s) => s.code)
        .map((s) => s.text)
        .join(''),
    )
  ) {
    throw badRequest(
      'Unrecognized placeholder; use {{result}} or {{variable}}',
    );
  }
  return { text: trimmed, values };
}

export async function runVisualization(options: {
  query: QueryRecord;
  config: VisualizationConfig;
  targets: NetworkConfig[];
  vars: Record<string, string | undefined>;
  /** Cache identity; omit for previews of unsaved configs. */
  cacheKey?: string;
}): Promise<VisualizationData> {
  const { query, config, targets, vars } = options;
  if (config.sql && !(await sqlModeAvailable())) {
    throw new HttpError(
      503,
      'SQL visualizations need the arrakis_results_reader role, which this database could not create. Use steps, or create the role (see the README).',
    );
  }
  const db = await appDb();
  const multi = targets.length > 1;

  for (let attempt = 0; ; attempt += 1) {
    const located = await locateResults({ query, targets, supplied: {} });
    if (!located.tables.length) {
      return {
        queryVersion: query.current?.version ?? null,
        columns: [],
        rows: [],
        truncated: false,
        networks: located.networks,
        pending: true,
      };
    }
    // Always with a `network` column, even for one network, so a chart
    // that counts or splits by network reads the same columns whichever
    // network the viewer picks.
    const relation = storedRelation(located.tables, true);
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          options.cacheKey ?? config,
          located.tables.map((entry) => entry.table),
          vars,
          multi,
        ]),
      )
      .digest('hex');
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { ...hit.data, queryVersion: query.current?.version ?? null, networks: located.networks };
    }

    let text: string;
    let values: unknown[];
    let declared: Column[] | null = null;
    if (config.sql) {
      ({ text, values } = expandSql(config.sql, relation.sql, vars));
      text = `SELECT * FROM (\n${text}\n) AS visualization LIMIT ${MAX_ROWS + 1}`;
    } else {
      const built = buildSql(
        { sql: relation.sql, columns: relation.columns },
        config.steps,
        vars,
      );
      ({ sql: text, values } = built);
      declared = built.columns;
    }

    const client = await db.connect();
    let broken = false;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`);
      await client.query("SET LOCAL TimeZone = 'UTC'");
      if (config.sql) await client.query(`SET LOCAL ROLE ${READER_ROLE}`);
      const result = await client.query({
        text,
        values,
        rowMode: 'array',
        types: TYPES,
      });
      await client.query('COMMIT');
      const columns: Column[] =
        declared ??
        result.fields.map((field) => ({
          name: field.name,
          type: columnType(field.dataTypeID) as ColumnType,
        }));
      const rows = (result.rows as unknown[][]).map((row) =>
        row.map(toJsonValue),
      );
      const data: VisualizationData = {
        queryVersion: query.current?.version ?? null,
        columns,
        rows: rows.slice(0, MAX_ROWS),
        truncated: rows.length > MAX_ROWS,
        networks: located.networks,
        pending: false,
      };
      // Large outputs are tables people page through, not dashboard tiles;
      // keeping them would make the cache the biggest thing in the process.
      if (rows.length <= 5_000) remember(key, data);
      return data;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        broken = true;
      });
      const code = (error as { code?: string }).code;
      // A swap dropped the table between locating and reading it; the new one
      // is already committed, so looking again finds it.
      if (code === '42P01' && attempt < 2) continue;
      if (code === '57014') {
        throw new HttpError(
          408,
          `Visualization took longer than ${TIMEOUT_MS / 1000} s`,
        );
      }
      if (code === '42501') {
        throw badRequest(
          'That SQL reads something other than {{result}}, which is not allowed',
        );
      }
      if (typeof code === 'string' && /^(22|42)/.test(code)) {
        throw badRequest((error as Error).message, { sqlstate: code });
      }
      throw error;
    } finally {
      // Whatever the SQL changed for the session — a setting through
      // set_config(…, false), an advisory lock — must not reach the next
      // run handed this connection: it goes back clean, or not at all.
      if (!broken) {
        await client.query('DISCARD ALL').catch(() => {
          broken = true;
        });
      }
      client.release(broken);
    }
  }
}

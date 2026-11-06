import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import type { PoolClient } from 'pg';

import { HttpError, badRequest } from '../api/errors';
import { appDb } from '../db/app';
import { chartsDb } from '../db/charts';
import type { NetworkConfig } from '../networks';
import {
  columnType,
  STORAGE_TYPE,
  toJsonValue,
  type ColumnType,
} from '../query/columns';
import {
  isResultTable,
  locateResults,
  quote,
  storedRelation,
  type Located,
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
 * in UTC, and leaves its connection as it found it. Hand-written SQL runs on a
 * connection of its own (lib/db/charts.ts), as a role that can read nothing
 * but the rows it is handed through a ticket for this run.
 *
 * Outputs are cached for a minute, keyed by the result tables they read: a
 * refresh writes new tables, so a new result is never hidden behind an old
 * cache entry.
 */

const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 500;

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

/**
 * Charts computed at once, on this replica. A chart that is not cached takes
 * a connection for up to ten seconds; without a bound, a burst of them —
 * someone cycling a text variable — would hold the app database's pool and
 * stall logins and saves with it. Beyond ARRAKIS_CHART_CONCURRENCY (4) running
 * and ARRAKIS_CHART_QUEUE (32) waiting, a chart answers 429.
 */
const computing = { running: 0, waiting: [] as Array<() => void> };

function chartSetting(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function startComputing(): Promise<void> {
  if (computing.running < chartSetting('ARRAKIS_CHART_CONCURRENCY', 4)) {
    computing.running += 1;
    return;
  }
  if (computing.waiting.length >= chartSetting('ARRAKIS_CHART_QUEUE', 32)) {
    throw new HttpError(429, 'Too many charts are being drawn; try again shortly.', {
      headers: { 'retry-after': '5' },
    });
  }
  // The slot is handed over by the run that ends, not counted again here.
  await new Promise<void>((resolve) => computing.waiting.push(resolve));
}

function stopComputing(): void {
  const next = computing.waiting.shift();
  if (next) next();
  else computing.running -= 1;
}

/** How long a chart run's tickets stay valid, beyond its own time limit. */
const TICKET_SLACK_MS = 30_000;

/**
 * The stored rows as hand-written chart SQL reads them: each network's table
 * through `chart_access.result_rows`, for a ticket bound as a parameter. The
 * same shape as `storedRelation`, which the step builder reads directly.
 * `marker` stands where each ticket's parameter goes, numbered once the
 * variables have taken theirs.
 */
function ticketedRelation(
  tables: Located['tables'],
  marker: string,
): string {
  const columns = tables[0].columns;
  // A query that names a column `network` itself keeps it.
  const multi = !columns.some((column) => column.name === 'network');
  const names = columns.map((column) => quote(column.column ?? column.name));
  const definition = [
    'arrakis_row bigint',
    ...columns.map(
      (column) =>
        `${quote(column.column ?? column.name)} ${STORAGE_TYPE[column.type]}`,
    ),
  ].join(', ');
  const select = tables
    .map((entry, index) => {
      if (!/^[a-z0-9-]+$/.test(entry.network)) {
        throw new Error(`Unexpected network id ${entry.network}`);
      }
      return `SELECT ${multi ? `'${entry.network}'::text AS network, ${index} AS arrakis_network_order, ` : ''}arrakis_row, ${names.join(', ')} FROM chart_access.result_rows(${marker}${index}_) AS stored_${index}(${definition})`;
    })
    .join('\nUNION ALL\n');
  return `SELECT ${multi ? 'network, ' : ''}${names.join(', ')} FROM (${select}) AS stored ORDER BY ${multi ? 'arrakis_network_order, ' : ''}arrakis_row`;
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
  // Refused up front, with the reason, when charts have no safe role.
  const charts = config.sql ? await chartsDb() : null;
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
    const tickets: string[] = [];
    const ticketed: string[] = [];
    if (config.sql) {
      const marker = `arrakis_ticket_${randomBytes(8).toString('hex')}_`;
      ({ text, values } = expandSql(
        config.sql,
        ticketedRelation(located.tables, marker),
        vars,
      ));
      // A ticket for each table the SQL reads; none when it never names
      // {{result}}, since an unused parameter is an error.
      for (const [index, entry] of located.tables.entries()) {
        const slot = `${marker}${index}_`;
        if (!text.includes(slot)) continue;
        const ticket = randomBytes(32).toString('base64url');
        tickets.push(ticket);
        ticketed.push(entry.table);
        values.push(ticket);
        text = text.replaceAll(slot, `$${values.length}::text`);
      }
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

    // A slot first, then the tickets: a chart waiting its turn must not let
    // them expire, and one turned away must not leave any behind.
    await startComputing();
    let client: PoolClient;
    try {
      if (tickets.length)
        await db.query(
          `INSERT INTO chart_access.tickets (ticket, table_name, expires_at)
           SELECT ticket, name, now() + make_interval(secs => $3)
           FROM unnest($1::text[], $2::text[]) AS issued(ticket, name)`,
          [
            tickets,
            ticketed.map((table) => {
              if (!isResultTable(table)) {
                throw new Error(`Not a result table name: ${table}`);
              }
              return table;
            }),
            (TIMEOUT_MS + TICKET_SLACK_MS) / 1000,
          ],
        );
      client = await (charts ?? db).connect();
    } catch (error) {
      stopComputing();
      if (tickets.length) {
        await db
          .query('DELETE FROM chart_access.tickets WHERE ticket = ANY ($1)', [
            tickets,
          ])
          .catch(() => undefined);
      }
      throw error;
    }
    let broken = false;
    try {
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`);
      await client.query("SET LOCAL TimeZone = 'UTC'");
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
      stopComputing();
      if (tickets.length) {
        await db
          .query('DELETE FROM chart_access.tickets WHERE ticket = ANY ($1)', [
            tickets,
          ])
          .catch(() => undefined);
      }
    }
  }
}

import 'server-only';

import { badRequest } from '../api/errors';
import { appDb } from '../db/app';
import { timeoutFor } from './limits';

/**
 * How long stored runs take, from `query_run_history`: per query over a
 * window, for the Query health chart, and run by run, for the table behind
 * it. Previews are not recorded there, so neither appears here.
 */

export const WINDOWS = { '24h': 1, '7d': 7, '30d': 30 } as const;
export type Window = keyof typeof WINDOWS;

export function windowOf(input: string | null): Window {
  if (input === null) return '7d';
  if (!Object.hasOwn(WINDOWS, input)) {
    throw badRequest(`window must be one of ${Object.keys(WINDOWS).join(', ')}`);
  }
  return input as Window;
}

/** A query's finished runs over the window, summed up. */
export type RunTime = {
  slug: string;
  title: string;
  runs: number;
  failures: number;
  /** Over every finished run with a duration, failed ones included: a run cut off at its limit is the slowest kind. */
  medianMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  /** The newest run's duration. */
  lastMs: number | null;
  /** Where a stored run of it is stopped. */
  limitMs: number;
};

export async function runTimes(window: Window): Promise<RunTime[]> {
  const db = await appDb();
  const { rows } = await db.query<{
    slug: string;
    title: string;
    timeout_seconds: number | null;
    runs: number;
    failures: number;
    median: number | null;
    p95: number | null;
    max: number | null;
    last: number | null;
  }>(
    `SELECT q.slug, q.title, q.timeout_seconds,
            count(*)::int AS runs,
            count(*) FILTER (WHERE h.status = 'failed')::int AS failures,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY h.duration_ms) AS median,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY h.duration_ms) AS p95,
            max(h.duration_ms) AS max,
            (array_agg(h.duration_ms ORDER BY h.started_at DESC)
               FILTER (WHERE h.duration_ms IS NOT NULL))[1] AS last
     FROM query_run_history h
     JOIN query_versions v ON v.id = h.query_version_id
     JOIN queries q ON q.id = v.query_id
     WHERE h.status <> 'running'
       AND h.started_at > now() - make_interval(days => $1)
       AND q.archived_at IS NULL
     GROUP BY q.id
     ORDER BY p95 DESC NULLS LAST, q.slug`,
    [WINDOWS[window]],
  );
  return rows.map((row) => ({
    slug: row.slug,
    title: row.title,
    runs: row.runs,
    failures: row.failures,
    medianMs: row.median === null ? null : Math.round(row.median),
    p95Ms: row.p95 === null ? null : Math.round(row.p95),
    maxMs: row.max,
    lastMs: row.last,
    limitMs: timeoutFor('store', row.timeout_seconds),
  }));
}

export type Run = {
  id: string;
  slug: string;
  title: string;
  network: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed';
  trigger: string | null;
  error: string | null;
  durationMs: number | null;
  rowCount: string | null;
  /** Where a stored run of its query is stopped. */
  limitMs: number;
};

export const MAX_PAGE = 500;

/**
 * Recorded runs, newest first, a page at a time. `before` is the `next` the
 * previous page answered: where it ended, as the start time in microseconds
 * and the run id, so runs that started in the same instant are neither
 * skipped nor repeated. Filters are all optional.
 */
export async function runHistory(filter: {
  query?: string | null;
  network?: string | null;
  status?: string | null;
  window?: Window | null;
  before?: string | null;
  limit: number;
}): Promise<{ runs: Run[]; next: string | null }> {
  if (
    filter.status &&
    !['running', 'succeeded', 'failed'].includes(filter.status)
  ) {
    throw badRequest('status must be running, succeeded or failed');
  }
  const cursor = filter.before
    ? /^(\d{1,17})_(\d{1,19})$/.exec(filter.before)
    : null;
  if (filter.before && !cursor) {
    throw badRequest('before must be the next value of a previous page');
  }
  const db = await appDb();
  const { rows } = await db.query<{
    id: string;
    slug: string;
    title: string;
    network: string;
    started_at: Date;
    finished_at: Date | null;
    status: Run['status'];
    trigger: string | null;
    error: string | null;
    duration_ms: number | null;
    row_count: string | null;
    timeout_seconds: number | null;
    at: string;
  }>(
    `SELECT h.id::text, q.slug, q.title, h.network, h.started_at, h.finished_at,
            h.status, h.trigger, h.error, h.duration_ms, h.row_count::text,
            q.timeout_seconds,
            (extract(epoch FROM h.started_at) * 1000000)::bigint::text AS at
     FROM query_run_history h
     JOIN query_versions v ON v.id = h.query_version_id
     JOIN queries q ON q.id = v.query_id
     WHERE ($1::text IS NULL OR q.slug = $1)
       AND ($2::text IS NULL OR h.network = $2)
       AND ($3::text IS NULL OR h.status = $3)
       AND ($4::int IS NULL OR h.started_at > now() - make_interval(days => $4))
       AND ($5::bigint IS NULL
            OR (h.started_at, h.id) < (to_timestamp($5::double precision / 1000000), $6::bigint))
     ORDER BY h.started_at DESC, h.id DESC
     LIMIT $7`,
    [
      filter.query || null,
      filter.network || null,
      filter.status || null,
      filter.window ? WINDOWS[filter.window] : null,
      cursor?.[1] ?? null,
      cursor?.[2] ?? null,
      filter.limit,
    ],
  );
  const runs = rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    network: row.network,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    status: row.status,
    trigger: row.trigger,
    error: row.error,
    durationMs: row.duration_ms,
    rowCount: row.row_count,
    limitMs: timeoutFor('store', row.timeout_seconds),
  }));
  const last = rows[rows.length - 1];
  return {
    runs,
    next: runs.length === filter.limit && last ? `${last.at}_${last.id}` : null,
  };
}

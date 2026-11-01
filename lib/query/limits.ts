import 'server-only';

/**
 * How long a run may take and how much it may keep: the server's defaults and
 * ceilings, from the environment, and a query's own settings within them.
 *
 *   ARRAKIS_QUERY_TIMEOUT_MS        a preview's default            30 s
 *   ARRAKIS_MATERIALIZE_TIMEOUT_MS  a stored run's default         2 min
 *   ARRAKIS_QUERY_TIMEOUT_MAX_MS    the most a query may ask for   10 min
 *   ARRAKIS_RESULT_ROW_LIMIT        rows a stored result keeps     5,000,000
 *   ARRAKIS_SCHEDULER_CONCURRENCY   scheduled runs at once,
 *                                   across every data source       2
 */

function integer(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function limits() {
  return {
    previewTimeoutMs: integer('ARRAKIS_QUERY_TIMEOUT_MS', 30_000),
    storeTimeoutMs: integer('ARRAKIS_MATERIALIZE_TIMEOUT_MS', 120_000),
    maxTimeoutMs: integer('ARRAKIS_QUERY_TIMEOUT_MAX_MS', 600_000),
    resultRowLimit: integer('ARRAKIS_RESULT_ROW_LIMIT', 5_000_000),
    schedulerConcurrency: integer('ARRAKIS_SCHEDULER_CONCURRENCY', 2),
  };
}

/** The time a run gets: the query's own, else the default, never over the ceiling. */
export function timeoutFor(
  kind: 'preview' | 'store',
  querySeconds: number | null | undefined,
): number {
  const settings = limits();
  const wanted =
    querySeconds != null
      ? querySeconds * 1_000
      : kind === 'preview'
        ? settings.previewTimeoutMs
        : settings.storeTimeoutMs;
  return Math.min(wanted, settings.maxTimeoutMs);
}

/** The rows a stored result keeps: the query's own cap, within the server's. */
export function rowLimitFor(queryLimit: number | null | undefined): number {
  const ceiling = limits().resultRowLimit;
  return Math.min(queryLimit ?? ceiling, ceiling);
}

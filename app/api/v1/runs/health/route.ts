import { noStore, requireEditor, route } from '@/lib/api/handler';
import { appDb } from '@/lib/db/app';
import { networks } from '@/lib/query/networks';
import { locateResults } from '@/lib/query/results';
import { listQueries } from '@/lib/query/store';
import { dashboardsShowing } from '@/lib/viz/store';

export const GET = route(async (request: Request) => {
  await requireEditor(request);
  const sources = networks();
  const queries = await listQueries({ editor: true, kind: 'query' });
  const health = await Promise.all(
    queries
      .filter((query) => query.current)
      .map(async (query) => {
        const statuses = await Promise.all(
          sources.map(async (source) => {
            try {
              const located = await locateResults({
                query,
                targets: [source],
                supplied: {},
              });
              return located.networks[0];
            } catch (error) {
              return {
                id: source.id,
                status: 'unknown',
                stale: false,
                error: (error as Error).message,
              };
            }
          }),
        );
        const affected = await dashboardsShowing(query.slug, true);
        return {
          slug: query.slug,
          title: query.title,
          networks: statuses,
          dashboards: affected.map(({ slug, title }) => ({ slug, title })),
        };
      }),
  );
  const db = await appDb();
  const { rows } =
    await db.query(`SELECT h.id::text, q.slug, h.network, h.started_at AS "startedAt", h.finished_at AS "finishedAt", h.status, h.trigger, h.error, h.duration_ms AS "durationMs", h.row_count::text AS "rowCount"
    FROM query_run_history h JOIN query_versions v ON v.id = h.query_version_id JOIN queries q ON q.id = v.query_id
    ORDER BY h.started_at DESC LIMIT 100`);
  return noStore(request, { health, history: rows });
});

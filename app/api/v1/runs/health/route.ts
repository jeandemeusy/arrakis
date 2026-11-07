import { noStore, requireEditor, route } from '@/lib/api/handler';
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
  return noStore(request, { health });
});

import { notFound } from '@/lib/api/errors';
import { optionalEditor, route, varsFromSearch } from '@/lib/api/handler';
import { json } from '@/lib/http';
import { visualizationData } from '@/lib/viz/dashboard-data';
import { getVisualization } from '@/lib/viz/store';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * One visualization's data, from its query's stored result. Never runs the
 * query. `?network=jura|all` and `?v.<variable>=<value>`.
 */
export const GET = route(async (request: Request, context: Context) => {
  const { id } = await context.params;
  const editor = Boolean(await optionalEditor(request));
  const visualization = await getVisualization(id);
  if (!visualization || (!editor && visualization.queryVisibility === 'private')) {
    throw notFound('No such visualization');
  }
  const url = new URL(request.url);
  const sources = url.searchParams.getAll('source');
  const data = await visualizationData(
    visualization,
    url.searchParams.get('network') ?? 'all',
    varsFromSearch(url),
    sources.length ? sources : undefined,
  );
  return json(request, data, {
    headers: {
      'cache-control':
        visualization.queryVisibility === 'private'
          ? 'no-store'
          : 'public, max-age=15, stale-while-revalidate=60',
    },
  });
});

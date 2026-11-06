import { limitReader } from '@/lib/api/rate-limit';
import { optionalEditor, route, varsFromSearch } from '@/lib/api/handler';
import { json } from '@/lib/http';
import { dashboardData } from '@/lib/viz/dashboard-data';
import { requireDashboard } from '@/lib/viz/store';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

/**
 * Every widget's data for a dashboard, from stored results only.
 * Variables come as `?v.range=7d&v.network=jura&v.client=0x…`.
 */
export const GET = route(async (request: Request, context: Context) => {
  const { slug } = await context.params;
  const editor = Boolean(await optionalEditor(request));
  if (!editor) limitReader(request);
  const dashboard = await requireDashboard(slug, editor);
  const data = await dashboardData(
    dashboard,
    varsFromSearch(new URL(request.url)),
    editor,
  );
  return json(request, data, {
    headers: {
      'cache-control':
        dashboard.visibility === 'private'
          ? 'no-store'
          : 'public, max-age=15, stale-while-revalidate=60',
    },
  });
});

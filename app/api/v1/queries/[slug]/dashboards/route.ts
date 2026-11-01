import { noStore, optionalEditor, route } from '@/lib/api/handler';
import { requireQuery } from '@/lib/query/store';
import { dashboardsShowing } from '@/lib/viz/store';

export const dynamic = 'force-dynamic';

/** The dashboards that show this query's charts. */
export const GET = route(
  async (request: Request, context: { params: Promise<{ slug: string }> }) => {
    const { slug } = await context.params;
    const editor = Boolean(await optionalEditor(request));
    await requireQuery(slug, editor);
    return noStore(request, {
      dashboards: await dashboardsShowing(slug, editor),
    });
  },
);

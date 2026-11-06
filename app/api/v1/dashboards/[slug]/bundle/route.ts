import { requireEditor, route } from '@/lib/api/handler';
import { exportDashboard } from '@/lib/bundles/export';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

/**
 * The dashboard as a bundle file — with the dashboards it links to, its
 * charts, their queries and the fragments those use — for another Arrakis to
 * import. Editors only: a bundle carries the SQL of private queries too.
 */
export const GET = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { slug } = await context.params;
  const bundle = await exportDashboard(slug);
  return new Response(`${JSON.stringify(bundle, null, 2)}\n`, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${slug}.arrakis.json"`,
      'cache-control': 'no-store',
    },
  });
});

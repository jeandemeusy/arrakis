import { noStore, readBody, requireEditor, route } from '@/lib/api/handler';
import { replaceWidgets } from '@/lib/viz/store';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

/**
 * Replaces the layout: `{ "widgets": [{ kind, visualization | text, width,
 * height, options }] }`, in display order.
 */
export const PUT = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { slug } = await context.params;
  const body = await readBody(request);
  return noStore(request, {
    dashboard: await replaceWidgets(slug, body.widgets),
  });
});

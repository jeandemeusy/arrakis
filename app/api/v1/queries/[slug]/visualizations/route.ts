import {
  noStore,
  optionalEditor,
  readBody,
  requireEditor,
  route,
} from '@/lib/api/handler';
import { requireQuery } from '@/lib/query/store';
import { createVisualization, listVisualizations } from '@/lib/viz/store';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

/** The visualizations built on this query's result. */
export const GET = route(async (request: Request, context: Context) => {
  const { slug } = await context.params;
  const editor = Boolean(await optionalEditor(request));
  await requireQuery(slug, editor);
  return noStore(request, {
    visualizations: await listVisualizations({ query: slug, editor }),
  });
});

/** `{ "title": "…", "type": "line", "config": { steps, encoding, options } }` */
export const POST = route(async (request: Request, context: Context) => {
  const principal = await requireEditor(request);
  const { slug } = await context.params;
  const visualization = await createVisualization(
    slug,
    await readBody(request),
    principal,
  );
  return noStore(request, { visualization }, 201);
});

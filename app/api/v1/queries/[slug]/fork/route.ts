import { noStore, readBody, requireEditor, route } from '@/lib/api/handler';
import { forkQuery } from '@/lib/query/store';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

/** Copies the current version into a new private query: `{ "slug": "…", "title": "…" }`. */
export const POST = route(async (request: Request, context: Context) => {
  const principal = await requireEditor(request);
  const { slug } = await context.params;
  const query = await forkQuery(slug, await readBody(request), principal);
  return noStore(request, { query }, 201);
});

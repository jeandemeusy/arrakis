import { noStore, readBody, requireEditor, route } from '@/lib/api/handler';
import { moveDashboard } from '@/lib/viz/folders';

type Context = { params: Promise<{ slug: string }> };

export const PUT = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { slug } = await context.params;
  await moveDashboard(slug, (await readBody(request)).folderId);
  return noStore(request, { ok: true });
});

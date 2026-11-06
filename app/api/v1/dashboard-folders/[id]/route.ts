import { noStore, readBody, requireEditor, route } from '@/lib/api/handler';
import { deleteFolder, saveFolder } from '@/lib/viz/folders';

type Context = { params: Promise<{ id: string }> };

export const PATCH = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { id } = await context.params;
  return noStore(request, {
    folder: await saveFolder(id, (await readBody(request)).name),
  });
});

export const DELETE = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { id } = await context.params;
  await deleteFolder(id);
  return noStore(request, { ok: true });
});

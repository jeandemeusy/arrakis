import { noStore, readBody, requireEditor, route } from '@/lib/api/handler';
import { deleteList, updateList } from '@/lib/query/lists';
import { nudgeScheduler } from '@/lib/query/scheduler';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ name: string }> };

export const PATCH = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { name } = await context.params;
  return noStore(request, {
    list: await updateList(name, await readBody(request)),
  });
});

/** Deletes the list; queries that read it then fail until they stop. */
export const DELETE = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { name } = await context.params;
  await deleteList(name);
  nudgeScheduler();
  return noStore(request, { ok: true });
});

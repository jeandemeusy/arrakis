import { noStore, requireEditor, route } from '@/lib/api/handler';
import { removeValue } from '@/lib/query/lists';
import { nudgeScheduler } from '@/lib/query/scheduler';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ name: string; id: string }> };

/** Removes a value; the removal is kept on record. */
export const DELETE = route(async (request: Request, context: Context) => {
  const principal = await requireEditor(request);
  const { name, id } = await context.params;
  const list = await removeValue(name, id, principal);
  nudgeScheduler();
  return noStore(request, { list });
});

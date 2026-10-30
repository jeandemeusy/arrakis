import { noStore, requireEditor, route } from '@/lib/api/handler';
import { removeExit } from '@/lib/query/exits';
import { network } from '@/lib/query/networks';
import { nudgeScheduler } from '@/lib/query/scheduler';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ network: string; address: string }> };

/** Removes an exit. The removal is recorded, not erased. */
export const DELETE = route(async (request: Request, context: Context) => {
  const principal = await requireEditor(request);
  const { network: id, address } = await context.params;
  const target = network(id);
  await removeExit(target.id, address, principal);
  nudgeScheduler();
  return noStore(request, { ok: true });
});

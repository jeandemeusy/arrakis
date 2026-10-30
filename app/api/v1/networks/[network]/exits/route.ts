import { noStore, readBody, requireEditor, route } from '@/lib/api/handler';
import { addExit, listExits } from '@/lib/query/exits';
import { network } from '@/lib/query/networks';
import { nudgeScheduler } from '@/lib/query/scheduler';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ network: string }> };

/**
 * The exits configured for a network. Public: the downstream figures rest on
 * this list, so anyone reading them can see which addresses it names.
 */
export const GET = route(async (request: Request, context: Context) => {
  const { network: id } = await context.params;
  const target = network(id);
  return noStore(request, {
    network: target.id,
    exits: await listExits(target.id),
  });
});

/** Adds an exit. `{ "address": "0x…", "label": "…" }`. */
export const POST = route(async (request: Request, context: Context) => {
  const principal = await requireEditor(request);
  const { network: id } = await context.params;
  const target = network(id);
  const body = await readBody(request);
  const { exit, warning } = await addExit(
    target,
    { address: body.address, label: body.label },
    principal,
  );
  // Results that read {{exits}} are now stale; let the scheduler see it now.
  nudgeScheduler();
  return noStore(request, { exit, warning }, 201);
});

import { noStore, requireEditor, route } from '@/lib/api/handler';
import { exitActivity } from '@/lib/query/exits';
import { network } from '@/lib/query/networks';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ network: string }> };

/**
 * Each configured exit's last observed redemption. Editors only: it reads the
 * redemption history, which is not something an anonymous visitor should be
 * able to make the database do on demand.
 */
export const GET = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { network: id } = await context.params;
  const target = network(id);
  return noStore(request, {
    network: target.id,
    activity: await exitActivity(target),
  });
});

import { badRequest } from '@/lib/api/errors';
import { noStore, requireEditor, route } from '@/lib/api/handler';
import { network } from '@/lib/query/networks';
import { describeSchema } from '@/lib/query/schema';

export const dynamic = 'force-dynamic';

/** The tables and columns of a network's index, for the editor's sidebar. */
export const GET = route(async (request: Request) => {
  await requireEditor(request);
  const id = new URL(request.url).searchParams.get('network');
  if (!id || id === 'all') throw badRequest('network must name one network');
  return noStore(request, await describeSchema(network(id)));
});

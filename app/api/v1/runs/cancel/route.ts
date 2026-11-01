import { badRequest } from '@/lib/api/errors';
import { noStore, readBody, requireEditor, route } from '@/lib/api/handler';
import { cancelRuns } from '@/lib/query/cancel';

export const dynamic = 'force-dynamic';

/**
 * Stops runs in progress: `{ "id": "…" }` for one, `{ "runKey": "…" }` for a
 * page's preview, or `{ "query": "slug" }` for everything running for a query.
 * Answers how many it reached; a run that just finished is simply not there.
 */
export const POST = route(async (request: Request) => {
  await requireEditor(request);
  const body = await readBody(request);
  const pick = (key: string) =>
    typeof body[key] === 'string' && body[key]
      ? (body[key] as string)
      : undefined;
  const filter = {
    id: pick('id'),
    runKey: pick('runKey'),
    query: pick('query'),
  };
  if (!filter.id && !filter.runKey && !filter.query) {
    throw badRequest('Say which runs to cancel: id, runKey or query');
  }
  if (filter.id && !/^[0-9a-f-]{36}$/i.test(filter.id)) {
    throw badRequest('id must be a run id');
  }
  return noStore(request, { cancelled: await cancelRuns(filter) });
});

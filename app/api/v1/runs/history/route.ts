import { integerParam, noStore, requireEditor, route } from '@/lib/api/handler';
import { MAX_PAGE, runHistory, windowOf } from '@/lib/query/run-times';

export const dynamic = 'force-dynamic';

/**
 * Recorded runs, newest first, a page at a time. All optional:
 *
 *   ?query=<slug>&network=<id>&status=running|succeeded|failed
 *   ?window=24h|7d|30d   only runs started within it
 *   ?limit=50            at most 500
 *   ?before=<next>       the page after the one that answered that `next`
 *
 * Answers `next`, the `before` of the following page, or null at the end.
 * Editors only.
 */
export const GET = route(async (request: Request) => {
  await requireEditor(request);
  const url = new URL(request.url);
  const params = url.searchParams;
  return noStore(
    request,
    await runHistory({
      query: params.get('query'),
      network: params.get('network'),
      status: params.get('status'),
      window: params.get('window') === null ? null : windowOf(params.get('window')),
      before: params.get('before'),
      limit: Math.max(1, integerParam(url, 'limit', 50, MAX_PAGE)),
    }),
  );
});

import { noStore, requireEditor, route } from '@/lib/api/handler';
import { runTimes, windowOf } from '@/lib/query/run-times';

export const dynamic = 'force-dynamic';

/**
 * How long each query's stored runs took over a window (`?window=24h|7d|30d`,
 * 7d by default): run and failure counts, median, 95th percentile, slowest,
 * newest, and its time limit. Slowest first. Editors only.
 */
export const GET = route(async (request: Request) => {
  await requireEditor(request);
  const window = windowOf(new URL(request.url).searchParams.get('window'));
  return noStore(request, { window, queries: await runTimes(window) });
});

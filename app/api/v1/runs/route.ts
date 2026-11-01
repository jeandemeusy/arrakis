import { noStore, requireEditor, route } from '@/lib/api/handler';
import { listActiveRuns } from '@/lib/query/cancel';

export const dynamic = 'force-dynamic';

/** Every run in progress, on every replica: previews, stored and scheduled runs. */
export const GET = route(async (request: Request) => {
  await requireEditor(request);
  return noStore(request, { runs: await listActiveRuns() });
});

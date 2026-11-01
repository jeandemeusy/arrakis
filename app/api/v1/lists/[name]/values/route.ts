import { noStore, readBody, requireEditor, route } from '@/lib/api/handler';
import { addValue } from '@/lib/query/lists';
import { networks } from '@/lib/query/networks';
import { nudgeScheduler } from '@/lib/query/scheduler';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ name: string }> };

/**
 * `{ "value": "…", "label"?: "…", "source"?: "id" }` adds a value, for one
 * data source or (without `source`) for every one. The queries that read the
 * list go stale, and the scheduled ones rerun.
 */
export const POST = route(async (request: Request, context: Context) => {
  const principal = await requireEditor(request);
  const { name } = await context.params;
  const list = await addValue(
    name,
    await readBody(request),
    networks().map((source) => source.id),
    principal,
  );
  nudgeScheduler();
  return noStore(request, { list }, 201);
});

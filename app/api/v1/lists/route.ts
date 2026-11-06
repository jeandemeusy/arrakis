import { noStore, readBody, requireEditor, route } from '@/lib/api/handler';
import { createList, listLists } from '@/lib/query/lists';
import { networks } from '@/lib/query/networks';

export const dynamic = 'force-dynamic';

/** Every list with its values, and the data sources a value can belong to. */
export const GET = route(async (request: Request) => {
  await requireEditor(request);
  return noStore(request, {
    lists: await listLists(),
    sources: networks().map(({ id, label }) => ({ id, label })),
  });
});

/** `{ "name": "exits", "type": "text" | "number" | "bytes", "description"? }`. */
export const POST = route(async (request: Request) => {
  const principal = await requireEditor(request);
  return noStore(
    request,
    { list: await createList(await readBody(request), principal) },
    201,
  );
});

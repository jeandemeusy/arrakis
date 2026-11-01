import { noStore, optionalEditor, route } from '@/lib/api/handler';
import { lineage } from '@/lib/query/lineage';

export const dynamic = 'force-dynamic';

/**
 * Every table, fragment, query, chart and dashboard the caller can see, and
 * what reads what. Backs the lineage page and the search palette.
 */
export const GET = route(async (request: Request) => {
  const editor = Boolean(await optionalEditor(request));
  return noStore(request, await lineage(editor));
});

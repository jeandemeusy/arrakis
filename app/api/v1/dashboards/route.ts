import {
  noStore,
  optionalEditor,
  readBody,
  requireEditor,
  route,
} from '@/lib/api/handler';
import { createDashboard, listDashboards } from '@/lib/viz/store';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: Request) => {
  const editor = Boolean(await optionalEditor(request));
  return noStore(request, { dashboards: await listDashboards(editor) });
});

/**
 * `{ "slug": "…", "title": "…", "visibility": "public", "variables": [...] }`.
 * Without `variables`, a dashboard gets a range (default 30d) and a network.
 */
export const POST = route(async (request: Request) => {
  const principal = await requireEditor(request);
  return noStore(
    request,
    { dashboard: await createDashboard(await readBody(request), principal) },
    201,
  );
});

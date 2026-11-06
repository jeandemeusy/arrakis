import {
  noStore,
  optionalEditor,
  readBody,
  requireEditor,
  route,
} from '@/lib/api/handler';
import { nudgeScheduler } from '@/lib/query/scheduler';
import { listVersions, requireQuery, saveVersion } from '@/lib/query/store';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

/** Every version of the query, newest first. */
export const GET = route(async (request: Request, context: Context) => {
  const { slug } = await context.params;
  const editor = Boolean(await optionalEditor(request));
  await requireQuery(slug, editor);
  return noStore(request, { versions: await listVersions(slug) });
});

/**
 * Saves new SQL as the next version: `{ "sql": "…", "parameters": [...], "note": "…" }`.
 * Saving SQL identical to the current version is a no-op.
 */
export const POST = route(async (request: Request, context: Context) => {
  const principal = await requireEditor(request);
  const { slug } = await context.params;
  const query = await saveVersion(slug, await readBody(request), principal);
  nudgeScheduler();
  return noStore(request, { query }, 201);
});

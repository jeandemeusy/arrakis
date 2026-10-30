import {
  noStore,
  optionalEditor,
  readBody,
  requireEditor,
  route,
} from '@/lib/api/handler';
import { nudgeScheduler } from '@/lib/query/scheduler';
import { archiveQuery, requireQuery, updateQuery } from '@/lib/query/store';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

/** One query with its current SQL. Public and unlisted queries are readable by anyone. */
export const GET = route(async (request: Request, context: Context) => {
  const { slug } = await context.params;
  const editor = Boolean(await optionalEditor(request));
  return noStore(request, { query: await requireQuery(slug, editor) });
});

/**
 * Changes a query's metadata: title, description, visibility, combine,
 * refreshSeconds, official. SQL changes go through /versions.
 */
export const PATCH = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { slug } = await context.params;
  const query = await updateQuery(slug, await readBody(request));
  nudgeScheduler();
  return noStore(request, { query });
});

/** Archives the query. Its versions and results stay on record. */
export const DELETE = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { slug } = await context.params;
  await archiveQuery(slug);
  return noStore(request, { ok: true });
});

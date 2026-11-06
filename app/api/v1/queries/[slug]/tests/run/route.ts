import { badRequest, notFound } from '@/lib/api/errors';
import { noStore, readBody, requireEditor, route } from '@/lib/api/handler';
import { appDb } from '@/lib/db/app';
import { compile, type ResolveFragment } from '@/lib/query/compile';
import { preview } from '@/lib/query/execute';
import { listResolver } from '@/lib/query/lists';
import { targetNetworks } from '@/lib/query/networks';
import { parseDefinitions } from '@/lib/query/params';
import { fragmentResolver, requireQuery } from '@/lib/query/store';

type Context = { params: Promise<{ slug: string }> };
export const POST = route(async (request: Request, context: Context) => {
  const principal = await requireEditor(request);
  const { slug } = await context.params;
  const fragment = await requireQuery(slug, true);
  if (fragment.kind !== 'fragment' || fragment.archivedAt || !fragment.current)
    throw notFound('Fragment not found');
  const body = await readBody(request);
  if (
    typeof body.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      body.id,
    )
  )
    throw badRequest('Invalid test ID');
  if (
    typeof body.sql !== 'string' ||
    !body.sql.trim() ||
    body.sql.length > 200000
  )
    throw badRequest('Draft fragment SQL is required');
  if (typeof body.network !== 'string' || body.network === 'all')
    throw badRequest('Choose one data source');
  const db = await appDb();
  const { rows } = await db.query<{ sql: string }>(
    'SELECT sql FROM fragment_tests WHERE id = $1 AND query_id = $2',
    [body.id, fragment.id],
  );
  if (!rows[0]) throw notFound('Test not found');
  const fallback = fragmentResolver();
  const resolve: ResolveFragment = async (name) =>
    name === slug
      ? { slug, versionId: fragment.current!.id, sql: body.sql as string, parameters: parseDefinitions(body.parameters) }
      : fallback(name);
  const compiled = await compile(rows[0].sql, [], resolve, listResolver());
  if (!compiled.fragments.some((entry) => entry.slug === slug))
    throw badRequest('Test SQL must call this fragment');
  const result = await preview(
    { sql: rows[0].sql, parameters: [] },
    {},
    targetNetworks(body.network),
    2,
    {
      query: slug,
      startedBy: principal.username,
      resolve,
    },
  );
  const valid =
    result.columns.length === 1 &&
    result.columns[0].type === 'boolean' &&
    result.rows.length === 1 &&
    !result.truncated;
  return noStore(request, {
    passed: valid && result.rows[0][0] === true,
    result: valid ? result.rows[0][0] : null,
    error: valid ? null : 'Test must return exactly one boolean value.',
  });
});

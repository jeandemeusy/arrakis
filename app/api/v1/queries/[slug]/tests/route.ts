import { badRequest, HttpError, notFound } from '@/lib/api/errors';
import { noStore, readBody, requireEditor, route } from '@/lib/api/handler';
import { appDb } from '@/lib/db/app';
import { requireQuery } from '@/lib/query/store';

type Context = { params: Promise<{ slug: string }> };
async function fragment(request: Request, context: Context) {
  await requireEditor(request);
  const { slug } = await context.params;
  const query = await requireQuery(slug, true);
  if (query.kind !== 'fragment' || query.archivedAt)
    throw notFound('Fragment not found');
  return query;
}
export const GET = route(async (request: Request, context: Context) => {
  const query = await fragment(request, context);
  const db = await appDb();
  const { rows } = await db.query(
    'SELECT id, name, sql FROM fragment_tests WHERE query_id = $1 ORDER BY lower(name)',
    [query.id],
  );
  return noStore(request, { tests: rows });
});
export const POST = route(async (request: Request, context: Context) => {
  const query = await fragment(request, context);
  const body = await readBody(request);
  if (
    typeof body.name !== 'string' ||
    !body.name.trim() ||
    body.name.trim().length > 120
  )
    throw badRequest('Test name must be between 1 and 120 characters');
  if (
    typeof body.sql !== 'string' ||
    !body.sql.trim() ||
    body.sql.length > 20000
  )
    throw badRequest('Test SQL must be between 1 and 20,000 characters');
  try {
    const db = await appDb();
    const { rows } = await db.query(
      'INSERT INTO fragment_tests (query_id, name, sql) VALUES ($1, $2, $3) RETURNING id, name, sql',
      [query.id, body.name.trim(), body.sql],
    );
    return noStore(request, { test: rows[0] }, 201);
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw new HttpError(409, 'A test with that name already exists');
    throw error;
  }
});
export const DELETE = route(async (request: Request, context: Context) => {
  const query = await fragment(request, context);
  const id = new URL(request.url).searchParams.get('id');
  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    throw badRequest('Invalid test ID');
  const db = await appDb();
  const { rowCount } = await db.query(
    'DELETE FROM fragment_tests WHERE query_id = $1 AND id = $2',
    [query.id, id],
  );
  if (!rowCount) throw notFound('Test not found');
  return noStore(request, { ok: true });
});

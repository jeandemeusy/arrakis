import { badRequest, HttpError, notFound } from '@/lib/api/errors';
import {
  noStore,
  optionalEditor,
  readBody,
  requireEditor,
  route,
} from '@/lib/api/handler';
import { appDb } from '@/lib/db/app';
import { requireDashboard } from '@/lib/viz/store';

type Context = { params: Promise<{ slug: string }> };

export const GET = route(async (request: Request, context: Context) => {
  const { slug } = await context.params;
  const dashboard = await requireDashboard(
    slug,
    Boolean(await optionalEditor(request)),
  );
  const db = await appDb();
  const { rows } = await db.query(
    'SELECT id, name, variables FROM dashboard_views WHERE dashboard_id = $1 ORDER BY lower(name)',
    [dashboard.id],
  );
  return noStore(request, { views: rows });
});

export const POST = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { slug } = await context.params;
  const dashboard = await requireDashboard(slug, true);
  const input = await readBody(request);
  if (
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.trim().length > 120
  )
    throw badRequest('View name must be between 1 and 120 characters');
  if (
    !input.variables ||
    typeof input.variables !== 'object' ||
    Array.isArray(input.variables)
  )
    throw badRequest('View variables must be an object');
  const names = new Set(dashboard.variables.map((variable) => variable.name));
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.variables)) {
    if (!names.has(key) || typeof value !== 'string' || value.length > 2048)
      throw badRequest('Invalid view variable');
    variables[key] = value;
  }
  try {
    const db = await appDb();
    const { rows } = await db.query(
      'INSERT INTO dashboard_views (dashboard_id, name, variables) VALUES ($1, $2, $3) RETURNING id, name, variables',
      [dashboard.id, input.name.trim(), JSON.stringify(variables)],
    );
    return noStore(request, { view: rows[0] }, 201);
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw new HttpError(409, 'A view with that name already exists');
    throw error;
  }
});

export const DELETE = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { slug } = await context.params;
  const dashboard = await requireDashboard(slug, true);
  const id = new URL(request.url).searchParams.get('id');
  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    throw badRequest('Invalid view ID');
  const db = await appDb();
  const { rowCount } = await db.query(
    'DELETE FROM dashboard_views WHERE id = $1 AND dashboard_id = $2',
    [id, dashboard.id],
  );
  if (!rowCount) throw notFound('View not found');
  return noStore(request, { ok: true });
});

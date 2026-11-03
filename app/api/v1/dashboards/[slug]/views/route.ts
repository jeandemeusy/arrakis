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

const viewId = (id: string | null): id is string =>
  Boolean(id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));

function readVariables(input: unknown, names: Set<string>): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw badRequest('View variables must be an object');
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!names.has(key) || typeof value !== 'string' || value.length > 2048)
      throw badRequest('Invalid view variable');
    variables[key] = value;
  }
  return variables;
}

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
  const names = new Set(dashboard.variables.map((variable) => variable.name));
  const variables = readVariables(input.variables, names);
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

export const PATCH = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { slug } = await context.params;
  const dashboard = await requireDashboard(slug, true);
  const id = new URL(request.url).searchParams.get('id');
  if (!viewId(id)) throw badRequest('Invalid view ID');
  const input = await readBody(request);
  const variables = readVariables(input.variables, new Set(dashboard.variables.map((variable) => variable.name)));
  const db = await appDb();
  const { rows } = await db.query(
    'UPDATE dashboard_views SET variables = $1 WHERE id = $2 AND dashboard_id = $3 RETURNING id, name, variables',
    [JSON.stringify(variables), id, dashboard.id],
  );
  if (!rows.length) throw notFound('View not found');
  return noStore(request, { view: rows[0] });
});

export const DELETE = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { slug } = await context.params;
  const dashboard = await requireDashboard(slug, true);
  const id = new URL(request.url).searchParams.get('id');
  if (!viewId(id)) throw badRequest('Invalid view ID');
  const db = await appDb();
  const { rowCount } = await db.query(
    'DELETE FROM dashboard_views WHERE id = $1 AND dashboard_id = $2',
    [id, dashboard.id],
  );
  if (!rowCount) throw notFound('View not found');
  return noStore(request, { ok: true });
});

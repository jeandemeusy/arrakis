import {
  noStore,
  optionalEditor,
  readBody,
  requireEditor,
  route,
} from '@/lib/api/handler';
import {
  archiveDashboard,
  requireDashboard,
  updateDashboard,
} from '@/lib/viz/store';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

export const GET = route(async (request: Request, context: Context) => {
  const { slug } = await context.params;
  const editor = Boolean(await optionalEditor(request));
  return noStore(request, { dashboard: await requireDashboard(slug, editor) });
});

/** Title, description, visibility and variables. Widgets go through /widgets. */
export const PATCH = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { slug } = await context.params;
  return noStore(request, {
    dashboard: await updateDashboard(slug, await readBody(request)),
  });
});

export const DELETE = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { slug } = await context.params;
  await archiveDashboard(slug);
  return noStore(request, { ok: true });
});

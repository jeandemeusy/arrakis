import { notFound } from '@/lib/api/errors';
import {
  noStore,
  optionalEditor,
  readBody,
  requireEditor,
  route,
} from '@/lib/api/handler';
import {
  archiveVisualization,
  getVisualization,
  updateVisualization,
} from '@/lib/viz/store';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

export const GET = route(async (request: Request, context: Context) => {
  const { id } = await context.params;
  const editor = Boolean(await optionalEditor(request));
  const visualization = await getVisualization(id);
  if (!visualization || (!editor && visualization.queryVisibility === 'private')) {
    throw notFound('No such visualization');
  }
  return noStore(request, { visualization });
});

export const PATCH = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { id } = await context.params;
  return noStore(request, {
    visualization: await updateVisualization(id, await readBody(request)),
  });
});

/** Archives it and removes it from every dashboard. */
export const DELETE = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { id } = await context.params;
  await archiveVisualization(id);
  return noStore(request, { ok: true });
});

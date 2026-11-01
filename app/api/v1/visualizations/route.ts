import { noStore, optionalEditor, route } from '@/lib/api/handler';
import { listVisualizations } from '@/lib/viz/store';

export const dynamic = 'force-dynamic';

/** Every visualization a caller may place on a dashboard. */
export const GET = route(async (request: Request) => {
  const editor = Boolean(await optionalEditor(request));
  return noStore(request, {
    visualizations: await listVisualizations({ editor }),
  });
});

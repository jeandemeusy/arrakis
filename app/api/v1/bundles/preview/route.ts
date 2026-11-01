import { noStore, readBody, requireEditor, route } from '@/lib/api/handler';
import { planInstall } from '@/lib/bundles/install';
import { bundleFrom } from '@/lib/bundles/request';

export const dynamic = 'force-dynamic';

/**
 * What importing a bundle would do, item by item, without doing it: the same
 * body as an import. Answers with the bundle too, so a page that sent a URL
 * can import exactly what it was shown.
 */
export const POST = route(async (request: Request) => {
  await requireEditor(request);
  const bundle = await bundleFrom(await readBody(request));
  return noStore(request, { plan: await planInstall(bundle), bundle });
});

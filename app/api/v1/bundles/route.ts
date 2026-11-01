import { noStore, readBody, requireEditor, route } from '@/lib/api/handler';
import { installBundle, installedBundles } from '@/lib/bundles/install';
import { bundleFrom } from '@/lib/bundles/request';
import { nudgeScheduler } from '@/lib/query/scheduler';

export const dynamic = 'force-dynamic';

/** The bundles this Arrakis has imported. Editors only. */
export const GET = route(async (request: Request) => {
  await requireEditor(request);
  return noStore(request, { bundles: await installedBundles() });
});

/**
 * `{ "bundle": {…} }` or `{ "url": "https://…" }` imports a bundle, or brings
 * one imported before up to date; `"replace": true` overwrites items of the
 * same slug that came from elsewhere. Its queries are then run by the
 * scheduler; charts read "pending" until their first results are stored.
 */
export const POST = route(async (request: Request) => {
  const principal = await requireEditor(request);
  const body = await readBody(request);
  const bundle = await bundleFrom(body);
  const report = await installBundle(bundle, principal, {
    replace: body.replace === true,
  });
  nudgeScheduler();
  return noStore(request, { report });
});

import { badRequest } from '@/lib/api/errors';
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
 * Imports a bundle, or brings one imported before up to date:
 *
 *   { "bundle": {…} | "url": "https://…", "digest": "…",
 *     "publish": false, "replace": false }
 *
 * `digest` is the one /preview answered with, so what is installed is what
 * was reviewed. What the import creates is private unless `publish`;
 * `replace` overwrites same-named items from elsewhere and brings back
 * archived ones. Its queries are then run by the scheduler; charts read
 * "pending" until their first results are stored.
 */
export const POST = route(async (request: Request) => {
  const principal = await requireEditor(request);
  const body = await readBody(request);
  if (typeof body.digest !== 'string' || !body.digest) {
    throw badRequest('Preview the bundle first, and import with its digest');
  }
  const bundle = await bundleFrom(body);
  const report = await installBundle(bundle, principal, {
    replace: body.replace === true,
    publish: body.publish === true,
    digest: body.digest,
  });
  nudgeScheduler();
  return noStore(request, { report });
});

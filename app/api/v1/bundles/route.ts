import { badRequest } from '@/lib/api/errors';
import { noStore, readBody, requireEditor, route } from '@/lib/api/handler';
import { nudgeScheduler } from '@/lib/query/scheduler';
import { installSeed, installed, seedNames, seedOf } from '@/lib/seed/install';

export const dynamic = 'force-dynamic';

/**
 * Dashboards that ship with arrakis, ready to install: their saved queries,
 * charts and layout (see db/seed). Editors only.
 */
export const GET = route(async (request: Request) => {
  await requireEditor(request);
  return noStore(request, {
    bundles: await Promise.all(
      seedNames().map(async (name) => {
        const seed = seedOf(name);
        return {
          name,
          title: seed.title,
          dashboard: seed.dashboards[0].slug,
          installed: await installed(name),
        };
      }),
    ),
  });
});

/**
 * `{ "name": "gnosis-vpn" }` installs a bundle, or brings an installed one up
 * to date. Its queries are then run by the scheduler; charts read "pending"
 * until their first results are stored.
 */
export const POST = route(async (request: Request) => {
  const principal = await requireEditor(request);
  const body = await readBody(request);
  if (typeof body.name !== 'string') throw badRequest('name is required');
  const report = await installSeed(body.name, principal);
  nudgeScheduler();
  return noStore(request, { report });
});

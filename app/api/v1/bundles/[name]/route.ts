import { notFound } from '@/lib/api/errors';
import { noStore, requireEditor, route } from '@/lib/api/handler';
import { planRetirement, retire } from '@/lib/bundles/retire';
import { nudgeScheduler } from '@/lib/query/scheduler';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ name: string }> };

const NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;

async function bundleName(context: Context): Promise<string> {
  const { name } = await context.params;
  if (!NAME.test(name)) throw notFound(`No bundle "${name}"`);
  return name;
}

/**
 * What removing a bundle would archive, and what it would keep because
 * something outside the bundle still uses it. Changes nothing. Editors only.
 */
export const GET = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const name = await bundleName(context);
  const plan = await planRetirement(name);
  if (!plan.archive.length && !plan.keep.length)
    throw notFound(`No bundle "${name}"`);
  return noStore(request, { plan });
});

/**
 * Removes a bundle: archives its dashboards, charts and queries, except what
 * something outside it still uses. Lists stay, values and all. Editors only.
 */
export const DELETE = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const name = await bundleName(context);
  const done = await retire(name);
  if (!done.archive.length && !done.keep.length)
    throw notFound(`No bundle "${name}"`);
  nudgeScheduler();
  return noStore(request, { report: done });
});

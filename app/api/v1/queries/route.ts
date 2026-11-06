import { badRequest } from '@/lib/api/errors';
import {
  noStore,
  optionalEditor,
  readBody,
  requireEditor,
  route,
} from '@/lib/api/handler';
import { fragmentArguments, isRelation } from '@/lib/query/compile';
import { nudgeScheduler } from '@/lib/query/scheduler';
import { createQuery, listQueries, type Kind } from '@/lib/query/store';

export const dynamic = 'force-dynamic';

/**
 * Saved queries. Readers see public ones; editors see all, and archived ones
 * too with `?archived=1`. `?kind=fragment` narrows to fragments.
 */
export const GET = route(async (request: Request) => {
  const editor = Boolean(await optionalEditor(request));
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  if (kind !== null && kind !== 'query' && kind !== 'fragment') {
    throw badRequest('kind must be query or fragment');
  }
  const queries = await listQueries({
    editor,
    kind: (kind as Kind | null) ?? undefined,
    includeArchived: url.searchParams.get('archived') === '1',
  });
  // The list is an index; the SQL is fetched per query.
  return noStore(request, {
    queries: queries.map(({ current, ...query }) => ({
      ...query,
      version: current?.version ?? null,
      // How a fragment is called: its arguments, and whether it stands in
      // for a table or for a value.
      ...(query.kind === 'fragment' && current
        ? {
            arguments: fragmentArguments(current.sql).map((entry) => entry.name),
            expression: !isRelation(current.sql),
          }
        : {}),
    })),
  });
});

/** Creates a query and its first version. */
export const POST = route(async (request: Request) => {
  const principal = await requireEditor(request);
  const query = await createQuery(await readBody(request), principal);
  nudgeScheduler();
  return noStore(request, { query }, 201);
});

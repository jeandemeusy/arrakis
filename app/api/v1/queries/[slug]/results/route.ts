import { badRequest, notFound } from '@/lib/api/errors';
import {
  integerParam,
  optionalEditor,
  route,
  suppliedFromSearch,
} from '@/lib/api/handler';
import { json } from '@/lib/http';
import { targetNetworks } from '@/lib/query/networks';
import { readResult } from '@/lib/query/results';
import { listVersions, requireQuery } from '@/lib/query/store';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

/**
 * The stored result of a query. Never runs the query.
 *
 *   ?network=jura|all     default all
 *   ?limit=1000&offset=0  rows, at most 50,000 per page
 *   ?p.<name>=<value>     parameter values; defaults otherwise
 *   ?version=<n>          an earlier version's result, while it is kept
 */
export const GET = route(async (request: Request, context: Context) => {
  const { slug } = await context.params;
  const editor = Boolean(await optionalEditor(request));
  const query = await requireQuery(slug, editor);
  const url = new URL(request.url);

  let version = query.current ?? undefined;
  const wanted = url.searchParams.get('version');
  if (wanted !== null) {
    const number = Number(wanted);
    if (!Number.isInteger(number) || number < 1) {
      throw badRequest('version must be a positive integer');
    }
    version = (await listVersions(slug)).find(
      (entry) => entry.version === number,
    );
    if (!version) throw notFound(`Query "${slug}" has no version ${number}`);
  }

  const page = await readResult({
    query,
    version,
    targets: targetNetworks(url.searchParams.get('network')),
    supplied: suppliedFromSearch(url),
    limit: integerParam(url, 'limit', 1_000, 50_000),
    offset: integerParam(url, 'offset', 0, 100_000_000),
  });
  return json(request, page, {
    headers: {
      'cache-control':
        query.visibility === 'private'
          ? 'no-store'
          : 'public, max-age=15, stale-while-revalidate=60',
    },
  });
});

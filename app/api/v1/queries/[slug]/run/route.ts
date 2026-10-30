import {
  noStore,
  readBody,
  requireEditor,
  route,
  suppliedFromBody,
} from '@/lib/api/handler';
import { preview } from '@/lib/query/execute';
import { targetNetworks } from '@/lib/query/networks';
import { materialize } from '@/lib/query/results';
import { requireQuery } from '@/lib/query/store';
import { badRequest } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

/**
 * Runs the query's current version now: `{ "network": "jura" | "all", "values": {...} }`.
 *
 * A query's result is stored, replacing the previous one for those values, and
 * read back through /results. A fragment has nothing to store, so it runs as a
 * preview and the rows come back directly.
 */
export const POST = route(async (request: Request, context: Context) => {
  await requireEditor(request);
  const { slug } = await context.params;
  const query = await requireQuery(slug, true);
  if (query.archivedAt) throw badRequest(`Query "${slug}" is archived`);
  if (!query.current) throw badRequest(`Query "${slug}" has no version`);
  const body = await readBody(request);
  const supplied = suppliedFromBody(body);
  const targets = targetNetworks(
    typeof body.network === 'string' ? body.network : null,
  );

  if (query.kind === 'fragment') {
    return noStore(request, {
      preview: await preview(query.current, supplied, targets, 10_000),
    });
  }

  const outcomes = await Promise.allSettled(
    targets.map((network) =>
      materialize({ query, network, supplied, trigger: 'editor' }),
    ),
  );
  if (targets.length === 1 && outcomes[0].status === 'rejected') {
    throw outcomes[0].reason;
  }
  return noStore(request, {
    query: slug,
    version: query.current.version,
    runs: outcomes.map((outcome, index) =>
      outcome.status === 'fulfilled'
        ? { ...outcome.value, status: 'succeeded' }
        : {
            network: targets[index].id,
            status: 'failed',
            error: (outcome.reason as Error).message,
          },
    ),
  });
});

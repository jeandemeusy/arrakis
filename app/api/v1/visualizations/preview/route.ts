import { badRequest } from '@/lib/api/errors';
import { noStore, readBody, requireEditor, route } from '@/lib/api/handler';
import { targetNetworks } from '@/lib/query/networks';
import { requireQuery } from '@/lib/query/store';
import { finalizeConfig, parseConfig, parseType } from '@/lib/viz/config';
import { runVisualization } from '@/lib/viz/run';
import { asText } from '@/lib/viz/text';

export const dynamic = 'force-dynamic';

/**
 * Runs an unsaved visualization config against a query's stored result, for
 * the editor's live preview.
 *
 * `{ "query": "slug", "type": "bar", "config": {…}, "network": "all", "vars": {…} }`
 */
export const POST = route(async (request: Request) => {
  await requireEditor(request);
  const body = await readBody(request);
  if (typeof body.query !== 'string') throw badRequest('query is required');
  const query = await requireQuery(body.query, true);
  const vars =
    typeof body.vars === 'object' && body.vars !== null && !Array.isArray(body.vars)
      ? Object.fromEntries(
          Object.entries(body.vars as Record<string, unknown>).map(([key, value]) => [
            key,
            value === null || value === undefined || value === '' ? undefined : asText(value),
          ]),
        )
      : {};
  return noStore(
    request,
    await runVisualization({
      query,
      // A builder needs the chart type to compile; steps and SQL do not.
      config:
        body.type === undefined
          ? parseConfig(body.config)
          : finalizeConfig(parseType(body.type), parseConfig(body.config)),
      targets: targetNetworks(typeof body.network === 'string' ? body.network : null),
      vars,
    }),
  );
});

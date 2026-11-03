import { HttpError, notFound } from '@/lib/api/errors';
import {
  noStore,
  optionalEditor,
  route,
  varsFromSearch,
} from '@/lib/api/handler';
import { getQuery } from '@/lib/query/store';
import { targetNetworks } from '@/lib/query/networks';
import { locateResults } from '@/lib/query/results';
import { getVisualization } from '@/lib/viz/store';
import { runVisualization } from '@/lib/viz/run';
import { valueInputs } from '@/lib/viz/value-inputs';

type Context = { params: Promise<{ id: string }> };
export const GET = route(async (request: Request, context: Context) => {
  const { id } = await context.params;
  const editor = Boolean(await optionalEditor(request));
  const chart = await getVisualization(id);
  if (!chart || (!editor && chart.queryVisibility === 'private'))
    throw notFound('No such visualization');
  if (chart.type !== 'number')
    throw notFound('Input rows are available for number tiles');
  const url = new URL(request.url);
  if (url.searchParams.get('chartVersion') !== chart.updatedAt)
    throw new HttpError(
      409,
      'The chart changed. Close this dialog and reload the dashboard.',
    );
  const plan = valueInputs(chart.config);
  if (!plan.supported)
    return noStore(request, { supported: false, reason: plan.reason });
  const query = await getQuery(chart.query);
  if (!query) throw notFound('Query not found');
  const allowed = url.searchParams.getAll('source');
  const targets = targetNetworks(
    url.searchParams.get('network') ?? 'all',
  ).filter((source) => !allowed.length || allowed.includes(source.id));
  if (!targets.length) throw notFound('No matching data sources');
  const movingRanges = plan.steps.filter(
    (step) => step.op === 'range' && step.anchor === 'now' && step.anchorColumn,
  );
  if (movingRanges.length) {
    const located = await locateResults({ query, targets, supplied: {} });
    for (const range of movingRanges) {
      if (range.op !== 'range') continue;
      const original = located.tables[0]?.columns.find(
        (column) => column.name === range.column,
      );
      if (
        !original ||
        !['integer', 'bigint', 'numeric', 'float'].includes(original.type)
      )
        return noStore(request, {
          supported: false,
          reason:
            'This chart uses a moving time window, so the input rows may have changed since the displayed value was calculated.',
        });
    }
  }
  const data = await runVisualization({
    query,
    targets,
    vars: varsFromSearch(url),
    config: {
      ...chart.config,
      steps: [
        ...plan.steps,
        { op: 'limit', n: plan.scope === 'aggregate' ? 101 : 1 },
      ],
    },
  });
  return noStore(request, {
    supported: true,
    scope: plan.scope,
    ...data,
    hasMore: plan.scope === 'aggregate' && data.rows.length > 100,
    rows: data.rows.slice(0, 100),
  });
});

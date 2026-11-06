import {
  noStore,
  optionalEditor,
  route,
  varsFromSearch,
} from '@/lib/api/handler';
import { runStates } from '@/lib/query/results';
import { dashboardTargets, resolveVariables } from '@/lib/viz/dashboard-data';
import { requireDashboard } from '@/lib/viz/store';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ slug: string }> };

/**
 * Which of a dashboard's queries are running right now, and when each last
 * finished: polled by the page so a chart can say it is being refreshed, and
 * redraw once it is. Cheap on purpose — no chart is computed.
 */
export const GET = route(async (request: Request, context: Context) => {
  const { slug } = await context.params;
  const editor = Boolean(await optionalEditor(request));
  const dashboard = await requireDashboard(slug, editor);
  const vars = resolveVariables(
    dashboard.variables,
    varsFromSearch(new URL(request.url)),
  );
  const queries = [
    ...new Set(
      dashboard.widgets
        .map((widget) => widget.visualization?.query)
        .filter((query): query is string => Boolean(query)),
    ),
  ];
  return noStore(request, {
    queries: await runStates(
      queries,
      dashboardTargets(dashboard.variables, vars).map((entry) => entry.id),
    ),
  });
});

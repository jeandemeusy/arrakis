import 'server-only';

import { toErrorShape, type ApiErrorShape } from './errors';
import { getQuery } from '../query/store';
import {
  networks as configuredNetworks,
  targetNetworks,
} from '../query/networks';
import { runVisualization, type VisualizationData } from './run';
import type { Dashboard, Variable, Visualization } from './store';

/**
 * Everything a dashboard shows, in one call: its variables resolved against
 * the request, and each widget's data.
 *
 * Widgets run side by side and fail on their own: one broken chart renders
 * its error in place and the rest of the dashboard is unaffected, the same
 * rule the page has always followed for a query that cannot be read.
 */

export type WidgetData =
  | { id: string; state: 'ok'; data: VisualizationData }
  | { id: string; state: 'hidden' }
  | { id: string; state: 'text' }
  | { id: string; state: 'error'; error: ApiErrorShape };

/** Request values over defaults, each checked against what the variable allows. */
export function resolveVariables(
  variables: Variable[],
  supplied: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const sources = configuredNetworks().map((network) => network.id);
  const networkIds = new Set(['all', ...sources]);
  const out: Record<string, string | undefined> = {};
  for (const variable of variables) {
    if (variable.type === 'network' && variable.fixed) {
      out[variable.name] = variable.default;
      continue;
    }
    let value = supplied[variable.name];
    if (value === undefined || value === '') value = variable.default;
    if (value !== undefined) {
      if (variable.options && !variable.options.includes(value))
        value = variable.default;
      if (variable.type === 'network' && !networkIds.has(value ?? ''))
        value = 'all';
      // A dashboard that does not stack its sources shows one at a time.
      if (
        variable.type === 'network' &&
        variable.stack === false &&
        value === 'all' &&
        sources.length > 1
      )
        value = sources[0];
      if (variable.type === 'text') value = value?.slice(0, 500);
    }
    out[variable.name] = value;
  }
  return out;
}

/** The network a dashboard's widgets read: its network variable, else all. */
export function networkOf(
  variables: Variable[],
  vars: Record<string, string | undefined>,
): string {
  const variable = variables.find((entry) => entry.type === 'network');
  return (variable && vars[variable.name]) || 'all';
}

/**
 * Whether a variable holds a value a widget can require. A network variable
 * on `all` counts as unset when there are several networks: a figure that
 * only makes sense for one network — its oracle price, say — is hidden from
 * the combined view.
 */
export function isSet(
  variables: Variable[],
  name: string,
  vars: Record<string, string | undefined>,
): boolean {
  const value = vars[name];
  if (!value) return false;
  const variable = variables.find((entry) => entry.name === name);
  // With a single network, `all` is that network.
  return !(
    variable?.type === 'network' &&
    value === 'all' &&
    configuredNetworks().length > 1
  );
}

export async function visualizationData(
  visualization: Visualization,
  network: string,
  vars: Record<string, string | undefined>,
): Promise<VisualizationData> {
  const query = await getQuery(visualization.query);
  if (!query) throw new Error(`Query ${visualization.query} vanished`);
  return runVisualization({
    query,
    config: visualization.config,
    targets: targetNetworks(network),
    vars,
    cacheKey: `${visualization.id}:${visualization.updatedAt}`,
  });
}

export async function dashboardData(
  dashboard: Dashboard,
  supplied: Record<string, string | undefined>,
): Promise<{
  vars: Record<string, string | undefined>;
  widgets: WidgetData[];
}> {
  const vars = resolveVariables(dashboard.variables, supplied);
  const network = networkOf(dashboard.variables, vars);
  const widgets = await Promise.all(
    dashboard.widgets.map(async (widget): Promise<WidgetData> => {
      if (widget.kind === 'text') return { id: widget.id, state: 'text' };
      const required = widget.options.requires;
      if (required && !isSet(dashboard.variables, required, vars)) {
        return { id: widget.id, state: 'hidden' };
      }
      if (!widget.visualization) {
        return {
          id: widget.id,
          state: 'error',
          error: { status: 404, message: 'This visualization was removed.' },
        };
      }
      try {
        return {
          id: widget.id,
          state: 'ok',
          data: await visualizationData(widget.visualization, network, vars),
        };
      } catch (error) {
        return { id: widget.id, state: 'error', error: toErrorShape(error) };
      }
    }),
  );
  return { vars, widgets };
}

import 'server-only';

import { toErrorShape, type ApiErrorShape } from './errors';
import { badRequest } from '../api/errors';
import { getQuery } from '../query/store';
import {
  networks as configuredNetworks,
  targetNetworks,
} from '../query/networks';
import { runVisualization, type VisualizationData } from './run';
import {
  readableChart,
  type Dashboard,
  type Variable,
  type Visualization,
} from './store';
import { normalizeVariableValue } from './variable-value';

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
  /** Its query is private or archived, and the reader is not an editor. */
  | { id: string; state: 'private' }
  | { id: string; state: 'text' }
  | { id: string; state: 'error'; error: ApiErrorShape };

/** Request values over defaults, each checked against what the variable allows. */
export function resolveVariables(
  variables: Variable[],
  supplied: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const sources = configuredNetworks().map((network) => network.id);
  const out: Record<string, string | undefined> = {};
  for (const variable of variables) {
    if (variable.type === 'network' && variable.fixed) {
      out[variable.name] = variable.default;
      continue;
    }
    // Keep the original semantics for dashboards without a source restriction.
    if (variable.type === 'network' && !variable.networks) {
      let value = supplied[variable.name] || variable.default;
      if (value !== undefined && value !== 'all' && !sources.includes(value))
        value = 'all';
      if (value === 'all' && variable.stack === false && sources.length > 1)
        value = sources[0];
      out[variable.name] = value;
      continue;
    }
    if (variable.type === 'network') {
      const allowed = variable.networks
        ? sources.filter((id) => variable.networks!.includes(id))
        : sources;
      if (!allowed.length)
        throw badRequest(
          `No allowed data sources are configured for ${variable.label}`,
        );
      const fallback =
        variable.default && allowed.includes(variable.default)
          ? variable.default
          : variable.stack !== false && allowed.length > 1
            ? 'all'
            : allowed[0];
      let value = supplied[variable.name] || variable.default || fallback;
      if (value !== 'all' && !allowed.includes(value)) value = fallback;
      if (value === 'all' && (variable.stack === false || allowed.length === 1))
        value = allowed[0];
      out[variable.name] = value;
      continue;
    }
    let value = supplied[variable.name];
    if (value === undefined || value === '') value = variable.default;
    if (value !== undefined) {
      if (variable.options && !variable.options.includes(value))
        value = variable.default;
      if (variable.type === 'text') value = value?.slice(0, 500);
    }
    out[variable.name] = normalizeVariableValue(variable, value);
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

/** Resolve "all" within the dashboard's allowed sources. */
export function dashboardTargets(
  variables: Variable[],
  vars: Record<string, string | undefined>,
) {
  const variable = variables.find((entry) => entry.type === 'network');
  const targets = targetNetworks(networkOf(variables, vars));
  const allowed = variable?.networks;
  const selected = allowed
    ? targets.filter((target) => allowed.includes(target.id))
    : targets;
  if (!selected.length)
    throw badRequest(
      'No allowed data sources are configured for this dashboard',
    );
  return selected;
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
    (variable.networks
      ? configuredNetworks().filter((network) =>
          variable.networks!.includes(network.id),
        ).length
      : configuredNetworks().length) > 1
  );
}

export async function visualizationData(
  visualization: Visualization,
  network: string,
  vars: Record<string, string | undefined>,
  sources?: string[],
): Promise<VisualizationData> {
  const query = await getQuery(visualization.query);
  if (!query) throw new Error(`Query ${visualization.query} vanished`);
  const targets = sources
    ? targetNetworks(network).filter((entry) => sources.includes(entry.id))
    : targetNetworks(network);
  if (!targets.length)
    throw badRequest('No matching data sources are configured');
  return runVisualization({
    query,
    config: visualization.config,
    targets,
    vars,
    cacheKey: `${visualization.id}:${visualization.updatedAt}`,
  });
}

export async function dashboardData(
  dashboard: Dashboard,
  supplied: Record<string, string | undefined>,
  /** Whether the reader may see charts on private or archived queries. */
  editor: boolean,
): Promise<{
  vars: Record<string, string | undefined>;
  widgets: WidgetData[];
}> {
  const vars = resolveVariables(dashboard.variables, supplied);
  const network = networkOf(dashboard.variables, vars);
  const sources = dashboardTargets(dashboard.variables, vars).map(
    (source) => source.id,
  );
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
      // Checked before anything is computed: a private query's result is
      // never read on a reader's behalf, not even to be discarded.
      if (!editor && !readableChart(widget.visualization)) {
        return { id: widget.id, state: 'private' };
      }
      try {
        return {
          id: widget.id,
          state: 'ok',
          data: await visualizationData(
            widget.visualization,
            network,
            vars,
            sources,
          ),
        };
      } catch (error) {
        return { id: widget.id, state: 'error', error: toErrorShape(error) };
      }
    }),
  );
  return { vars, widgets };
}

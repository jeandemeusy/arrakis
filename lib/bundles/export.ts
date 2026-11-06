import 'server-only';

import { notFound } from '../api/errors';
import { appDb } from '../db/app';
import { getQuery } from '../query/store';
import { getDashboard, type Dashboard } from '../viz/store';
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  fragmentsNamed,
  listsNamed,
  type Bundle,
  type BundleList,
  type BundleChart,
  type BundleDashboard,
  type BundleQuery,
} from './format';

/**
 * A dashboard as a bundle: the dashboard, every dashboard its charts link to
 * (a drill-down is useless without its target), the charts on them, the
 * queries behind the charts and, recursively, the fragments those queries
 * inline — fragments first, so an import can create them in order.
 */
export async function exportDashboard(slug: string): Promise<Bundle> {
  const main = await getDashboard(slug);
  if (!main || main.archivedAt) throw notFound(`No dashboard "${slug}"`);

  // The dashboard and those its widgets link to, transitively.
  const dashboards: Dashboard[] = [];
  const pending = [main];
  const seen = new Set<string>();
  while (pending.length) {
    const dashboard = pending.shift()!;
    if (seen.has(dashboard.slug)) continue;
    seen.add(dashboard.slug);
    dashboards.push(dashboard);
    for (const widget of dashboard.widgets) {
      const target = widget.options.link?.dashboard;
      if (!target || seen.has(target)) continue;
      const linked = await getDashboard(target);
      if (linked && !linked.archivedAt) pending.push(linked);
    }
  }

  // Charts keep the key a previous import gave them; new ones use their id,
  // which is just as stable from one export to the next.
  const db = await appDb();
  const ids = dashboards.flatMap((dashboard) =>
    dashboard.widgets.flatMap((widget) =>
      widget.visualization ? [widget.visualization.id] : [],
    ),
  );
  const { rows } = await db.query<{ id: string; seed_key: string | null }>(
    'SELECT id, seed_key FROM visualizations WHERE id = ANY($1::uuid[])',
    [ids],
  );
  const keyOf = new Map(rows.map((row) => [row.id, row.seed_key ?? row.id]));

  const charts = new Map<string, BundleChart>();
  for (const dashboard of dashboards) {
    for (const widget of dashboard.widgets) {
      const chart = widget.visualization;
      if (!chart || charts.has(chart.id)) continue;
      charts.set(chart.id, {
        key: keyOf.get(chart.id) ?? chart.id,
        query: chart.query,
        title: chart.title,
        description: chart.description,
        type: chart.type,
        config: chart.config,
      });
    }
  }

  // The queries, then every fragment they reach, ordered so each comes after
  // what it inlines.
  const queries = new Map<string, BundleQuery>();
  const order: string[] = [];
  const visit = async (name: string, trail: Set<string>) => {
    if (queries.has(name) || trail.has(name)) return;
    const query = await getQuery(name);
    if (!query?.current) return;
    trail.add(name);
    for (const fragment of fragmentsNamed(query.current.sql))
      await visit(fragment, trail);
    trail.delete(name);
    queries.set(name, {
      slug: query.slug,
      title: query.title,
      description: query.description,
      kind: query.kind,
      sql: query.current.sql,
      parameters: query.current.parameters,
      ...(query.kind === 'query'
        ? {
            refreshSeconds: query.refreshSeconds,
            rowLimit: query.rowLimit,
          }
        : {}),
      combine: query.combine === 'hidden' ? 'hidden' : 'concat',
      timeoutSeconds: query.timeoutSeconds,
    });
    order.push(name);
  };
  for (const chart of charts.values()) await visit(chart.query, new Set());

  // The lists those queries read, as definitions: their values are this
  // Arrakis's own (its exits, its accounts) and stay here.
  const listNames = [
    ...new Set([...queries.values()].flatMap((query) => listsNamed(query.sql))),
  ];
  const { rows: listRows } = await db.query<BundleList>(
    'SELECT name, type, description FROM lists WHERE name = ANY($1::text[]) ORDER BY name',
    [listNames],
  );

  const exported: BundleDashboard[] = dashboards.map((dashboard) => ({
    slug: dashboard.slug,
    title: dashboard.title,
    description: dashboard.description,
    visibility: dashboard.visibility,
    variables: dashboard.variables,
    widgets: dashboard.widgets.map((widget) =>
      widget.kind === 'visualization' && widget.visualization
        ? {
            kind: 'visualization' as const,
            chart:
              keyOf.get(widget.visualization.id) ?? widget.visualization.id,
            width: widget.width,
            height: widget.height,
            options: widget.options,
          }
        : {
            kind: 'text' as const,
            text: widget.text,
            width: widget.width,
            height: widget.height,
            options: widget.options,
          },
    ),
  }));

  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    name: main.slug,
    title: main.title,
    description: main.description,
    exportedAt: new Date().toISOString(),
    lists: listRows,
    queries: order.map((name) => queries.get(name)!),
    charts: [...charts.values()],
    dashboards: exported,
  };
}

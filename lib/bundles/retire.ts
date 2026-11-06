import 'server-only';

import { appDb } from '../db/app';
import { archiveQuery } from '../query/store';
import { archiveDashboard, archiveVisualization } from '../viz/store';
import { fragmentsNamed } from './format';

/**
 * Retiring what a bundle created: everything it marked, or — when a newer file
 * of the bundle is imported — what that file no longer contains.
 *
 * Retired items are archived, never deleted, as the studio archives them by
 * hand: an archived query keeps its versions, and can be restored. Lists are
 * left alone, values and all; they are this Arrakis's, not the bundle's.
 *
 * Something still in use outside what is retired is kept, with the reason: a
 * fragment that a query of yours inlines, a query a chart of yours reads, a
 * chart on a dashboard of yours. Keeping it keeps what it needs in turn.
 */

export type RetireItem = {
  kind: 'query' | 'fragment' | 'chart' | 'dashboard';
  /** A query's or dashboard's slug; a chart's key. */
  name: string;
  title: string;
  /** Why it is kept, when it is. */
  reason?: string;
};

export type Retirement = { archive: RetireItem[]; keep: RetireItem[] };

/** What the bundle's newer file still contains, and so is not retired. */
export type Kept = {
  queries?: string[];
  /** Chart keys as stored (`seed_key`). */
  charts?: string[];
  dashboards?: string[];
};

type QueryRow = {
  slug: string;
  kind: 'query' | 'fragment';
  title: string;
  sql: string | null;
  bundle: string | null;
};
type ChartRow = {
  id: string;
  key: string | null;
  title: string;
  query: string;
  bundle: string | null;
};
type WidgetRow = { dashboard: string; chart: string };
type DashboardRow = { slug: string; title: string; bundle: string | null };

export async function planRetirement(
  bundle: string,
  kept: Kept = {},
): Promise<Retirement> {
  const db = await appDb();
  const [queries, charts, widgets, dashboards] = await Promise.all([
    db.query<QueryRow>(
      `SELECT q.slug, q.kind, q.title, v.sql, q.bundle
       FROM queries q
       LEFT JOIN query_versions v ON v.id = q.current_version_id
       WHERE q.archived_at IS NULL`,
    ),
    db.query<ChartRow>(
      `SELECT v.id, v.seed_key AS key, v.title, q.slug AS query, v.bundle
       FROM visualizations v
       JOIN queries q ON q.id = v.query_id
       WHERE v.archived_at IS NULL`,
    ),
    db.query<WidgetRow>(
      `SELECT d.slug AS dashboard, w.visualization_id AS chart
       FROM dashboard_widgets w
       JOIN dashboards d ON d.id = w.dashboard_id
       WHERE d.archived_at IS NULL AND w.visualization_id IS NOT NULL`,
    ),
    db.query<DashboardRow>(
      `SELECT slug, title, bundle FROM dashboards WHERE archived_at IS NULL`,
    ),
  ]);

  const keepQueries = new Set(kept.queries ?? []);
  const keepCharts = new Set(kept.charts ?? []);
  const keepDashboards = new Set(kept.dashboards ?? []);

  // The candidates: the bundle's, less what its newer file still has.
  const goingDashboards = new Set(
    dashboards.rows
      .filter((row) => row.bundle === bundle && !keepDashboards.has(row.slug))
      .map((row) => row.slug),
  );
  const goingCharts = new Set(
    charts.rows
      .filter(
        (row) => row.bundle === bundle && !keepCharts.has(row.key ?? row.id),
      )
      .map((row) => row.id),
  );
  const goingQueries = new Set(
    queries.rows
      .filter((row) => row.bundle === bundle && !keepQueries.has(row.slug))
      .map((row) => row.slug),
  );

  const reasons = new Map<string, string>();
  const reads = new Map(
    queries.rows.map((row) => [row.slug, fragmentsNamed(row.sql ?? '')]),
  );
  const chartTitle = new Map(charts.rows.map((row) => [row.id, row.title]));

  // Keeping one item can keep another (a kept query keeps its fragments), so
  // look again until nothing changes.
  for (let changed = true; changed;) {
    changed = false;
    for (const id of goingCharts) {
      // A dashboard the newer file has gets that file's layout, which names
      // none of the charts it dropped: its current widgets do not count.
      const on = widgets.rows.find(
        (row) =>
          row.chart === id &&
          !goingDashboards.has(row.dashboard) &&
          !keepDashboards.has(row.dashboard),
      );
      if (on) {
        goingCharts.delete(id);
        reasons.set(`chart:${id}`, `on the dashboard ${on.dashboard}`);
        changed = true;
      }
    }
    for (const slug of goingQueries) {
      const chart = charts.rows.find(
        (row) => row.query === slug && !goingCharts.has(row.id),
      );
      const reader = queries.rows.find(
        (row) =>
          row.slug !== slug &&
          !goingQueries.has(row.slug) &&
          (reads.get(row.slug) ?? []).includes(slug),
      );
      if (chart || reader) {
        goingQueries.delete(slug);
        reasons.set(
          `query:${slug}`,
          reader
            ? `read by ${reader.kind === 'fragment' ? 'the fragment' : 'the query'} ${reader.slug}`
            : `shown by the chart ${chartTitle.get(chart!.id) ?? chart!.id}`,
        );
        changed = true;
      }
    }
  }

  const archive: RetireItem[] = [];
  const keep: RetireItem[] = [];
  const ORDER = ['dashboard', 'chart', 'query', 'fragment'];
  const sort = (items: RetireItem[]) =>
    items.sort(
      (a, b) =>
        ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) ||
        a.title.localeCompare(b.title),
    );
  for (const row of dashboards.rows) {
    if (goingDashboards.has(row.slug))
      archive.push({ kind: 'dashboard', name: row.slug, title: row.title });
  }
  for (const row of charts.rows) {
    if (row.bundle !== bundle || keepCharts.has(row.key ?? row.id)) continue;
    const item: RetireItem = {
      kind: 'chart',
      name: row.key ?? row.id,
      title: row.title,
    };
    if (goingCharts.has(row.id)) archive.push(item);
    else keep.push({ ...item, reason: reasons.get(`chart:${row.id}`) });
  }
  for (const row of queries.rows) {
    if (row.bundle !== bundle || keepQueries.has(row.slug)) continue;
    const item: RetireItem = {
      kind: row.kind,
      name: row.slug,
      title: row.title,
    };
    if (goingQueries.has(row.slug)) archive.push(item);
    else keep.push({ ...item, reason: reasons.get(`query:${row.slug}`) });
  }
  return { archive: sort(archive), keep: sort(keep) };
}

/** Archives what `planRetirement` would; answers with what it did. */
export async function retire(
  bundle: string,
  kept: Kept = {},
): Promise<Retirement> {
  const plan = await planRetirement(bundle, kept);
  const db = await appDb();
  // Dashboards first, then the charts on them, then the queries under those.
  for (const item of plan.archive.filter((entry) => entry.kind === 'dashboard'))
    await archiveDashboard(item.name);
  for (const item of plan.archive.filter((entry) => entry.kind === 'chart')) {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM visualizations
       WHERE (seed_key = $1 OR id::text = $1) AND bundle = $2 AND archived_at IS NULL`,
      [item.name, bundle],
    );
    for (const row of rows) await archiveVisualization(row.id);
  }
  for (const item of plan.archive.filter(
    (entry) => entry.kind === 'query' || entry.kind === 'fragment',
  ))
    await archiveQuery(item.name);
  return plan;
}

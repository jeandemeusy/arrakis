import 'server-only';

import { appDb } from '../db/app';
import { listDashboards, listVisualizations } from '../viz/store';
import { networks } from './networks';
import { segments } from './scan';
import { describeSchema } from './schema';
import { listQueries } from './store';

/**
 * Where everything comes from and where it goes: the tables of the data
 * sources, the fragments and queries that read them, the charts drawn from the
 * queries, and the dashboards showing the charts.
 *
 * Edges are what each item names itself: a query that reads a table through a
 * fragment links to the fragment, and the fragment to the table. Tables are
 * matched by name in the SQL's code (comments and strings left out), against
 * the tables the read-only roles can see; they are listed for editors only,
 * like the schema itself.
 *
 * The same nodes back the search palette, so every one carries a label, a
 * line of context and where it opens.
 */

export type LineageKind =
  | 'table'
  | 'fragment'
  | 'query'
  | 'chart'
  | 'dashboard';

export type LineageNode = {
  /** `<kind>:<key>`: a slug, a chart id or a table name. */
  id: string;
  kind: LineageKind;
  label: string;
  /** The slug, the query a chart is on, or a table's schema. */
  detail: string;
  description: string;
  href: string;
};

export type LineageEdge = { from: string; to: string };

export type Lineage = { nodes: LineageNode[]; edges: LineageEdge[] };

const FRAGMENT_CALL = /\{\{\s*>\s*([a-z0-9][a-z0-9-]*)/g;

function codeOf(sql: string): string {
  return segments(sql)
    .filter((segment) => segment.code)
    .map((segment) => segment.text)
    .join(' ');
}

/** Table names across every data source, read from the cached schemas. */
async function tableNames(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const described = await Promise.allSettled(
    networks().map((network) => describeSchema(network)),
  );
  for (const result of described) {
    if (result.status !== 'fulfilled') continue;
    for (const table of result.value.tables) {
      if (!out.has(table.name)) out.set(table.name, table.schema);
    }
  }
  return out;
}

export async function lineage(editor: boolean): Promise<Lineage> {
  const [queries, charts, dashboards, tables] = await Promise.all([
    listQueries({ editor }),
    listVisualizations({ editor }),
    listDashboards(editor),
    editor ? tableNames() : Promise.resolve(new Map<string, string>()),
  ]);
  const nodes: LineageNode[] = [];
  const edges: LineageEdge[] = [];
  const seen = new Set<string>();
  const add = (node: LineageNode) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    nodes.push(node);
  };
  const edge = (from: string, to: string) => {
    if (from !== to) edges.push({ from, to });
  };

  const kindOf = new Map(queries.map((query) => [query.slug, query.kind]));
  const usedTables = new Set<string>();
  const tablePatterns = [...tables.keys()].map(
    (name) =>
      [
        name,
        new RegExp(
          `(?<![\\w.$])${name.replace(/[^\w]/g, '\\$&')}(?![\\w$])`,
          'i',
        ),
      ] as const,
  );

  for (const query of queries) {
    const id = `${query.kind}:${query.slug}`;
    add({
      id,
      kind: query.kind,
      label: query.title,
      detail: query.slug,
      description: query.description,
      href: `/queries/${query.slug}`,
    });
    if (!query.current) continue;
    const code = codeOf(query.current.sql);
    for (const match of new Set(
      [...code.matchAll(FRAGMENT_CALL)].map((found) => found[1]),
    )) {
      if (kindOf.get(match) === 'fragment') edge(`fragment:${match}`, id);
    }
    for (const [name, pattern] of tablePatterns) {
      if (!pattern.test(code)) continue;
      usedTables.add(name);
      edge(`table:${name}`, id);
    }
  }

  for (const name of [...usedTables].sort()) {
    add({
      id: `table:${name}`,
      kind: 'table',
      label: name,
      detail: tables.get(name) ?? '',
      description: '',
      href: `/lineage?focus=${encodeURIComponent(`table:${name}`)}`,
    });
  }

  const visibleQueries = new Set(queries.map((query) => query.slug));
  const chartIds = new Set<string>();
  for (const chart of charts) {
    if (!visibleQueries.has(chart.query)) continue;
    chartIds.add(chart.id);
    add({
      id: `chart:${chart.id}`,
      kind: 'chart',
      label: chart.title,
      detail: chart.queryTitle,
      description: chart.description,
      href: `/queries/${chart.query}?tab=charts&chart=${chart.id}`,
    });
    edge(
      `${kindOf.get(chart.query) ?? 'query'}:${chart.query}`,
      `chart:${chart.id}`,
    );
  }

  const db = await appDb();
  const { rows } = await db.query<{ slug: string; visualization: string }>(
    `SELECT DISTINCT d.slug, w.visualization_id AS visualization
     FROM dashboard_widgets w JOIN dashboards d ON d.id = w.dashboard_id
     WHERE w.kind = 'visualization' AND d.archived_at IS NULL`,
  );
  for (const dashboard of dashboards) {
    add({
      id: `dashboard:${dashboard.slug}`,
      kind: 'dashboard',
      label: dashboard.title,
      detail: dashboard.slug,
      description: dashboard.description,
      href: `/dashboards/${dashboard.slug}`,
    });
  }
  for (const row of rows) {
    if (!chartIds.has(row.visualization) || !seen.has(`dashboard:${row.slug}`))
      continue;
    edge(`chart:${row.visualization}`, `dashboard:${row.slug}`);
  }

  return { nodes, edges };
}

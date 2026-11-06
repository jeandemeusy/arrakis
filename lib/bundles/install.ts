import 'server-only';

import { createHash } from 'node:crypto';

import { badRequest, HttpError } from '../api/errors';
import type { Principal } from '../auth/session';
import { appDb } from '../db/app';
import {
  createQuery,
  getQuery,
  saveVersion,
  updateQuery,
} from '../query/store';
import {
  createDashboard,
  createVisualization,
  getDashboard,
  replaceWidgets,
  updateDashboard,
  updateVisualization,
} from '../viz/store';
import type { Bundle } from './format';
import { planRetirement, retire, type Kept } from './retire';

/**
 * Imports a bundle: its queries, charts and dashboards, created through the
 * same store functions the studio uses, so an imported dashboard is
 * indistinguishable from one built by hand.
 *
 * Every item is marked with the bundle's name. Importing the same bundle again
 * updates what it created: a new query version when the SQL changed, the
 * chart configs, the layout. An item with the same slug that came from
 * elsewhere is a conflict: the import refuses until it is told to replace
 * those, and the plan says which they are. What an earlier file of the bundle
 * created and this one no longer has is archived (retire.ts), unless something
 * outside still uses it.
 *
 * A bundle is someone else's SQL, so an import is reviewed before it runs:
 *  - the plan shows every query's SQL (as a diff against what it would
 *    replace), its schedule, and which charts run SQL of their own;
 *  - the import must carry the plan's digest, so what is installed is exactly
 *    what was shown — never a file that changed at its URL in between;
 *  - what it creates is private until the editor chooses to publish it;
 *  - it never brings back what was archived here, or overwrites what came
 *    from elsewhere, unless told to.
 */

export type Action =
  | 'create'
  | 'update'
  | 'replace'
  | 'restore'
  | 'archive'
  | 'keep';

export type PlanItem = {
  kind: 'list' | 'query' | 'fragment' | 'chart' | 'dashboard';
  name: string;
  title: string;
  action: Action;
  /** For a replacement: where the item it would replace came from. */
  from?: string | null;
  /** For an item the bundle dropped but that is kept: what still uses it. */
  reason?: string;
  /** A query's or SQL chart's SQL: what it is now here, and what it becomes. */
  sql?: { before: string | null; after: string };
  /** A query's refresh interval, in seconds, once imported. */
  refreshSeconds?: number | null;
  /** A chart that runs hand-written SQL of its own over its result. */
  runsSql?: boolean;
};

export type Plan = {
  name: string;
  title: string;
  description: string;
  items: PlanItem[];
  /** Items that replace something from elsewhere or bring back something archived. */
  conflicts: number;
  /** What the import must quote, to install exactly this. */
  digest: string;
};

/** Identifies a parsed bundle's content, for the import to match the preview. */
export function bundleDigest(bundle: Bundle): string {
  return createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
}

export type InstallReport = {
  bundle: string;
  dashboard: string;
  created: string[];
  updated: string[];
  unchanged: string[];
  /** What an earlier version created and this one dropped. */
  archived: string[];
};

/** Everything a bundle file contains, as retirement must leave it. */
function keptBy(bundle: Bundle): Kept {
  return {
    queries: bundle.queries.map((query) => query.slug),
    charts: bundle.charts.map((chart) => chartKey(bundle, chart.key)),
    dashboards: bundle.dashboards.map((dashboard) => dashboard.slug),
  };
}

/** What importing the bundle would do, item by item; changes nothing. */
export async function planInstall(bundle: Bundle): Promise<Plan> {
  const db = await appDb();
  const items: PlanItem[] = [];
  for (const list of bundle.lists) {
    const { rows } = await db.query<{ type: string }>(
      'SELECT type FROM lists WHERE name = $1',
      [list.name],
    );
    if (rows[0] && rows[0].type !== list.type) {
      throw badRequest(
        `The bundle needs a list "${list.name}" of ${list.type}; this Arrakis has one of ${rows[0].type}`,
      );
    }
    // An existing list is used as it is, values and all.
    if (!rows[0])
      items.push({
        kind: 'list',
        name: list.name,
        title: list.description || list.name,
        action: 'create',
      });
  }
  for (const query of bundle.queries) {
    const { rows } = await db.query<{
      bundle: string | null;
      archived: boolean;
      sql: string | null;
    }>(
      `SELECT q.bundle, q.archived_at IS NOT NULL AS archived, v.sql
       FROM queries q LEFT JOIN query_versions v ON v.id = q.current_version_id
       WHERE q.slug = $1`,
      [query.slug],
    );
    const existing = rows[0];
    items.push({
      kind: query.kind,
      name: query.slug,
      title: query.title,
      action: !existing
        ? 'create'
        : existing.bundle !== bundle.name
          ? 'replace'
          : existing.archived
            ? 'restore'
            : 'update',
      ...(existing && existing.bundle !== bundle.name
        ? { from: existing.bundle }
        : {}),
      sql: { before: existing?.sql ?? null, after: query.sql },
      ...(query.kind === 'query'
        ? { refreshSeconds: query.refreshSeconds ?? null }
        : {}),
    });
  }
  for (const chart of bundle.charts) {
    const { rows } = await db.query<{ config: { sql?: string } | null }>(
      'SELECT config FROM visualizations WHERE seed_key = $1 AND archived_at IS NULL',
      [chartKey(bundle, chart.key)],
    );
    const sql = (chart.config as { sql?: unknown }).sql;
    items.push({
      kind: 'chart',
      name: chart.key,
      title: chart.title,
      action: rows.length ? 'update' : 'create',
      ...(typeof sql === 'string' && sql
        ? {
            runsSql: true,
            sql: { before: rows[0]?.config?.sql ?? null, after: sql },
          }
        : {}),
    });
  }
  for (const dashboard of bundle.dashboards) {
    const { rows } = await db.query<{ bundle: string | null; archived: boolean }>(
      'SELECT bundle, archived_at IS NOT NULL AS archived FROM dashboards WHERE slug = $1',
      [dashboard.slug],
    );
    const existing = rows[0];
    items.push({
      kind: 'dashboard',
      name: dashboard.slug,
      title: dashboard.title,
      action: !existing
        ? 'create'
        : existing.bundle !== bundle.name
          ? 'replace'
          : existing.archived
            ? 'restore'
            : 'update',
      ...(existing && existing.bundle !== bundle.name
        ? { from: existing.bundle }
        : {}),
    });
  }
  // What an earlier file of this bundle created and this one dropped.
  const dropped = await planRetirement(bundle.name, keptBy(bundle));
  for (const item of dropped.archive)
    items.push({
      kind: item.kind,
      name: item.name,
      title: item.title,
      action: 'archive',
    });
  for (const item of dropped.keep)
    items.push({
      kind: item.kind,
      name: item.name,
      title: item.title,
      action: 'keep',
      ...(item.reason ? { reason: item.reason } : {}),
    });
  return {
    name: bundle.name,
    title: bundle.title,
    description: bundle.description,
    items,
    conflicts: items.filter(
      (item) => item.action === 'replace' || item.action === 'restore',
    ).length,
    digest: bundleDigest(bundle),
  };
}

/** A chart's key, made unique to its bundle unless it already names one. */
function chartKey(bundle: Bundle, key: string): string {
  return key.includes('/') ? key : `${bundle.name}/${key}`;
}

export async function installBundle(
  bundle: Bundle,
  principal: Principal,
  options: {
    /** Overwrite items from elsewhere and bring back archived ones. */
    replace?: boolean;
    /** Make what it creates public and keep its dashboards' visibility. */
    publish?: boolean;
    /** The previewed plan's digest; when given, the bundle must match it. */
    digest?: string;
  } = {},
): Promise<InstallReport> {
  const plan = await planInstall(bundle);
  if (options.digest !== undefined && options.digest !== plan.digest) {
    throw new HttpError(
      409,
      'This is not the bundle that was previewed. Preview it again before importing.',
    );
  }
  if (plan.conflicts && !options.replace) {
    const names = plan.items
      .filter((item) => item.action === 'replace' || item.action === 'restore')
      .map(
        (item) =>
          `${item.kind} "${item.name}"${item.action === 'restore' ? ' (archived)' : ''}`,
      );
    throw badRequest(
      `This Arrakis already has ${names.join(', ')}, not from this bundle or archived. Import with "replace" to overwrite or restore them.`,
      { conflicts: names },
    );
  }
  const publish = options.publish === true;

  const report: InstallReport = {
    bundle: bundle.name,
    dashboard: bundle.dashboards[0].slug,
    created: [],
    updated: [],
    unchanged: [],
    archived: [],
  };
  const db = await appDb();
  const note = `Imported with the bundle ${bundle.title}`;

  // Lists first: queries that read them do not compile without them. They
  // are created empty; their values are for this Arrakis's editors to keep.
  for (const list of bundle.lists) {
    const { rowCount } = await db.query(
      `INSERT INTO lists (name, type, description, created_by)
       VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING`,
      [list.name, list.type, list.description, principal.userId],
    );
    if (rowCount) report.created.push(`list ${list.name}`);
  }

  // Fragments come first in the list, so every query finds what it inlines.
  for (const query of bundle.queries) {
    const label = `${query.kind} ${query.slug}`;
    const metadata = {
      title: query.title,
      description: query.description,
      combine: query.combine ?? 'concat',
      timeoutSeconds: query.timeoutSeconds ?? null,
      ...(query.kind === 'query'
        ? {
            refreshSeconds: query.refreshSeconds ?? null,
            rowLimit: query.rowLimit ?? null,
          }
        : {}),
    };
    const existing = await getQuery(query.slug);
    if (!existing) {
      await createQuery(
        {
          slug: query.slug,
          kind: query.kind,
          // Someone else's SQL stays private until an editor publishes it.
          visibility: publish ? 'public' : 'private',
          ...metadata,
          sql: query.sql,
          parameters: query.parameters,
          note,
        },
        principal,
      );
      report.created.push(label);
    } else {
      if (existing.archivedAt) {
        await db.query(
          'UPDATE queries SET archived_at = NULL WHERE slug = $1',
          [query.slug],
        );
      }
      const before = existing.current?.id;
      const saved = await saveVersion(
        query.slug,
        { sql: query.sql, parameters: query.parameters, note },
        principal,
      );
      await updateQuery(query.slug, metadata);
      (saved.current?.id === before && !existing.archivedAt
        ? report.unchanged
        : report.updated
      ).push(label);
    }
    await updateQuery(query.slug, { official: true });
    await db.query('UPDATE queries SET bundle = $2 WHERE slug = $1', [
      query.slug,
      bundle.name,
    ]);
  }

  const ids = new Map<string, string>();
  for (const chart of bundle.charts) {
    const key = chartKey(bundle, chart.key);
    const { rows } = await db.query<{
      id: string;
      config: unknown;
      title: string;
      type: string;
      query: string;
    }>(
      `SELECT v.id, v.config, v.title, v.type, q.slug AS query
       FROM visualizations v JOIN queries q ON q.id = v.query_id
       WHERE v.seed_key = $1 AND v.archived_at IS NULL`,
      [key],
    );
    const label = `chart ${chart.title}`;
    const input = {
      title: chart.title,
      description: chart.description,
      type: chart.type,
      config: chart.config,
    };
    if (!rows[0]) {
      const created = await createVisualization(chart.query, input, principal);
      await db.query(
        'UPDATE visualizations SET seed_key = $2, bundle = $3 WHERE id = $1',
        [created.id, key, bundle.name],
      );
      ids.set(chart.key, created.id);
      report.created.push(label);
      continue;
    }
    ids.set(chart.key, rows[0].id);
    const updated = await updateVisualization(rows[0].id, input);
    if (rows[0].query !== chart.query) {
      const target = await getQuery(chart.query);
      if (!target || target.kind !== 'query' || target.archivedAt)
        throw badRequest(`No query "${chart.query}" to visualize`);
      await db.query('UPDATE visualizations SET query_id = $2, updated_at = now() WHERE id = $1', [rows[0].id, target.id]);
    }
    const same =
      rows[0].query === chart.query &&
      rows[0].title === updated.title &&
      rows[0].type === updated.type &&
      JSON.stringify(rows[0].config) === JSON.stringify(updated.config);
    (same ? report.unchanged : report.updated).push(label);
  }

  for (const dashboard of bundle.dashboards) {
    const label = `dashboard ${dashboard.slug}`;
    const input = {
      slug: dashboard.slug,
      title: dashboard.title,
      description: dashboard.description,
      variables: dashboard.variables,
    };
    const existing = await getDashboard(dashboard.slug);
    if (existing) {
      if (existing.archivedAt) {
        await db.query(
          'UPDATE dashboards SET archived_at = NULL WHERE slug = $1',
          [dashboard.slug],
        );
      }
      // An update keeps the visibility an editor here chose.
      await updateDashboard(dashboard.slug, input);
    } else {
      await createDashboard(
        {
          ...input,
          visibility: publish ? dashboard.visibility : 'private',
        },
        principal,
      );
    }
    await replaceWidgets(
      dashboard.slug,
      dashboard.widgets.map((widget) =>
        widget.kind === 'text'
          ? {
              kind: 'text',
              text: widget.text,
              width: widget.width,
              height: widget.height,
              options: widget.options,
            }
          : {
              kind: 'visualization',
              visualization: ids.get(widget.chart),
              width: widget.width,
              height: widget.height,
              options: widget.options,
            },
      ),
    );
    await db.query(
      'UPDATE dashboards SET official = TRUE, bundle = $2 WHERE slug = $1',
      [dashboard.slug, bundle.name],
    );
    (existing ? report.updated : report.created).push(label);
  }

  const retired = await retire(bundle.name, keptBy(bundle));
  report.archived = retired.archive.map(
    (item) => `${item.kind} ${item.kind === 'chart' ? item.title : item.name}`,
  );
  return report;
}

/**
 * Bundles this Arrakis has imported, with their dashboards: any bundle with
 * something left that is not archived, so one whose dashboards were archived
 * by hand can still be removed.
 */
export async function installedBundles(): Promise<
  Array<{
    name: string;
    dashboards: Array<{ slug: string; title: string }>;
    queries: number;
    charts: number;
  }>
> {
  const db = await appDb();
  const { rows } = await db.query<{
    name: string;
    dashboards: Array<{ slug: string; title: string }>;
    queries: number;
    charts: number;
  }>(
    `WITH named AS (
       SELECT bundle FROM queries WHERE bundle IS NOT NULL AND archived_at IS NULL
       UNION SELECT bundle FROM visualizations WHERE bundle IS NOT NULL AND archived_at IS NULL
       UNION SELECT bundle FROM dashboards WHERE bundle IS NOT NULL AND archived_at IS NULL
     )
     SELECT n.bundle AS name,
            COALESCE((SELECT json_agg(json_build_object('slug', d.slug, 'title', d.title) ORDER BY d.created_at)
                      FROM dashboards d WHERE d.bundle = n.bundle AND d.archived_at IS NULL), '[]') AS dashboards,
            (SELECT count(*)::int FROM queries q WHERE q.bundle = n.bundle AND q.archived_at IS NULL) AS queries,
            (SELECT count(*)::int FROM visualizations v WHERE v.bundle = n.bundle AND v.archived_at IS NULL) AS charts
     FROM named n ORDER BY n.bundle`,
  );
  return rows;
}

/**
 * The account that owns what an import creates when nobody is logged in (a
 * command-line import). It has no password and is disabled, so it can own
 * rows but never sign in.
 */
export async function installerPrincipal(): Promise<Principal> {
  const db = await appDb();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (username, display_name, role, disabled_at)
     VALUES ('arrakis-installer', 'Bundles', 'admin', now())
     ON CONFLICT (username) DO UPDATE SET updated_at = now()
     RETURNING id`,
  );
  return { userId: rows[0].id, username: 'arrakis-installer', role: 'admin' };
}

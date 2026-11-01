import 'server-only';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { notFound } from '../api/errors';
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
import { SEEDS, type Seed } from './gnosis-vpn';

/**
 * Installs a bundled dashboard: its queries, charts and layout.
 *
 * Everything is created through the same store functions the studio uses, so
 * an installed dashboard is indistinguishable from one built by hand. Run
 * again, it brings what it created up to date — a new query version when the
 * SQL changed, the chart configs, the layout — and touches nothing else.
 * Queries are marked official; their results are computed by the scheduler.
 */

export type InstallReport = {
  seed: string;
  created: string[];
  updated: string[];
  unchanged: string[];
};

export function seedNames(): string[] {
  return Object.keys(SEEDS);
}

export function seedOf(name: string): Seed {
  const seed = SEEDS[name];
  if (!seed) throw notFound(`No bundled dashboard "${name}"`);
  return seed;
}

function seedDirectory(name: string): string {
  return path.join(process.cwd(), 'db', 'seed', name);
}

export async function seedSql(name: string, slug: string): Promise<string> {
  return (
    await readFile(path.join(seedDirectory(name), `${slug}.sql`), 'utf8')
  ).trim();
}

/** Whether a bundled dashboard's main dashboard exists. */
export async function installed(name: string): Promise<boolean> {
  const seed = seedOf(name);
  return Boolean(await getDashboard(seed.dashboards[0].slug));
}

/**
 * The account that installs from the command line, where nobody is logged in.
 * It has no password and is disabled, so it can own rows but never sign in.
 */
export async function installerPrincipal(): Promise<Principal> {
  const db = await appDb();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (username, display_name, role, disabled_at)
     VALUES ('arrakis-installer', 'Bundled dashboards', 'admin', now())
     ON CONFLICT (username) DO UPDATE SET updated_at = now()
     RETURNING id`,
  );
  return { userId: rows[0].id, username: 'arrakis-installer', role: 'admin' };
}

export async function installSeed(
  name: string,
  principal: Principal,
): Promise<InstallReport> {
  const seed = seedOf(name);
  const report: InstallReport = {
    seed: name,
    created: [],
    updated: [],
    unchanged: [],
  };
  const db = await appDb();

  // Fragments come first in the list, so every query finds what it inlines.
  for (const query of seed.queries) {
    const sql = await seedSql(name, query.slug);
    const existing = await getQuery(query.slug);
    const label = `query ${query.slug}`;
    if (!existing || existing.archivedAt) {
      await createQuery(
        {
          slug: query.slug,
          title: query.title,
          description: query.description,
          kind: query.kind,
          visibility: 'public',
          combine: query.combine ?? 'concat',
          ...(query.kind === 'query'
            ? { refreshSeconds: query.refreshSeconds ?? 300 }
            : {}),
          sql,
          parameters: [],
          note: `Installed with the ${seed.title}`,
        },
        principal,
      );
      await updateQuery(query.slug, { official: true });
      report.created.push(label);
      continue;
    }
    const before = existing.current?.id;
    const saved = await saveVersion(
      query.slug,
      { sql, parameters: [], note: `Updated with the ${seed.title}` },
      principal,
    );
    if (!existing.official) await updateQuery(query.slug, { official: true });
    (saved.current?.id === before ? report.unchanged : report.updated).push(
      label,
    );
  }

  const ids = new Map<string, string>();
  for (const visualization of seed.visualizations) {
    const { rows } = await db.query<{
      id: string;
      config: unknown;
      title: string;
      type: string;
    }>(
      `SELECT id, config, title, type FROM visualizations
       WHERE seed_key = $1 AND archived_at IS NULL`,
      [visualization.key],
    );
    const label = `chart ${visualization.key}`;
    const input = {
      title: visualization.title,
      type: visualization.type,
      config: visualization.config,
    };
    if (!rows[0]) {
      const created = await createVisualization(
        visualization.query,
        input,
        principal,
      );
      await db.query('UPDATE visualizations SET seed_key = $2 WHERE id = $1', [
        created.id,
        visualization.key,
      ]);
      ids.set(visualization.key, created.id);
      report.created.push(label);
      continue;
    }
    ids.set(visualization.key, rows[0].id);
    const updated = await updateVisualization(rows[0].id, input);
    const same =
      rows[0].title === updated.title &&
      rows[0].type === updated.type &&
      JSON.stringify(rows[0].config) === JSON.stringify(updated.config);
    (same ? report.unchanged : report.updated).push(label);
  }

  for (const dashboard of seed.dashboards) {
    const label = `dashboard ${dashboard.slug}`;
    const input = {
      slug: dashboard.slug,
      title: dashboard.title,
      description: dashboard.description,
      visibility: dashboard.visibility,
      variables: dashboard.variables,
    };
    const existing = await getDashboard(dashboard.slug);
    if (existing) await updateDashboard(dashboard.slug, input);
    else await createDashboard(input, principal);
    await replaceWidgets(
      dashboard.slug,
      dashboard.widgets.map((widget) =>
        widget.kind === 'text'
          ? {
              kind: 'text',
              text: widget.text,
              width: 12,
              height: 80,
              options: widget.note ? { note: widget.note } : {},
            }
          : {
              kind: 'visualization',
              visualization: ids.get(widget.visualization),
              width: widget.width,
              height: widget.height,
              options: widget.options ?? {},
            },
      ),
    );
    await db.query('UPDATE dashboards SET official = TRUE WHERE slug = $1', [
      dashboard.slug,
    ]);
    (existing ? report.updated : report.created).push(label);
  }
  return report;
}

import 'server-only';

import { appDb } from '../db/app';
import { compile } from './compile';
import { fragmentResolver, listQueries } from './store';
import { listResolver } from './lists';

/**
 * What a fragment's change would reach: every saved query that inlines it,
 * directly or through another fragment, with the charts drawn from each.
 * Saving a new version of the fragment marks all of those stale, and the
 * scheduler reruns the scheduled ones.
 */

export type Dependent = {
  slug: string;
  title: string;
  kind: 'query' | 'fragment';
  /** Names it in its own SQL, rather than through another fragment. */
  direct: boolean;
  charts: number;
};

export async function dependents(
  slug: string,
  editor: boolean,
): Promise<Dependent[]> {
  const queries = await listQueries({ editor });
  const resolve = fragmentResolver();
  const db = await appDb();
  const { rows } = await db.query<{ slug: string; charts: number }>(
    `SELECT q.slug, count(v.id)::int AS charts
     FROM queries q JOIN visualizations v ON v.query_id = q.id
     WHERE v.archived_at IS NULL
     GROUP BY q.slug`,
  );
  const charts = new Map(rows.map((row) => [row.slug, row.charts]));
  const named = new RegExp(
    `\\{\\{\\s*>\\s*${slug.replace(/-/g, '\\-')}\\s*(\\(|\\}\\})`,
  );
  const out: Dependent[] = [];
  for (const query of queries) {
    if (query.slug === slug || !query.current) continue;
    try {
      const compiled = await compile(
        query.current.sql,
        query.current.parameters,
        resolve,
        listResolver(),
      );
      if (!compiled.fragments.some((fragment) => fragment.slug === slug))
        continue;
    } catch {
      // A query that does not compile reaches nothing.
      continue;
    }
    out.push({
      slug: query.slug,
      title: query.title,
      kind: query.kind,
      direct: named.test(query.current.sql),
      charts: charts.get(query.slug) ?? 0,
    });
  }
  return out.sort(
    (a, b) =>
      Number(b.direct) - Number(a.direct) || a.slug.localeCompare(b.slug),
  );
}

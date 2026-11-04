/**
 * Bundles end to end: import the example bundle, import it again, export a
 * dashboard and read it back, and refuse to overwrite what came from
 * elsewhere. Against real PostgreSQL; skipped without TEST_ADMIN_DATABASE_URL.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  adminUrl,
  context,
  cookieFrom,
  createTestDatabases,
  request,
} from './support';
import { fragmentsNamed } from '../lib/bundles/format';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'correct horse battery staple';

type Json = Record<string, unknown>;
type Report = { created: string[]; updated: string[]; unchanged: string[] };
type Plan = {
  items: Array<{ kind: string; name: string; action: string; reason?: string }>;
  conflicts: number;
};
type Retirement = {
  archive: Array<{ kind: string; name: string }>;
  keep: Array<{ kind: string; name: string; reason?: string }>;
};

async function body<T = Json>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe(
  'bundles',
  { skip: !adminUrl && 'TEST_ADMIN_DATABASE_URL not set' },
  () => {
    let cookie = '';
    let example: Json;
    let routes: {
      login: typeof import('../app/api/v1/auth/login/route');
      bundles: typeof import('../app/api/v1/bundles/route');
      bundle: typeof import('../app/api/v1/bundles/[name]/route');
      preview: typeof import('../app/api/v1/bundles/preview/route');
      exported: typeof import('../app/api/v1/dashboards/[slug]/bundle/route');
      queries: typeof import('../app/api/v1/queries/route');
      run: typeof import('../app/api/v1/queries/[slug]/run/route');
    };
    let lib: {
      app: typeof import('../lib/db/app');
      runner: typeof import('../lib/query/runner');
      fetch: typeof import('../lib/bundles/fetch');
    };

    const post = async (
      handler: {
        POST: (request: Request, context: undefined) => Promise<Response>;
      },
      path: string,
      payload: Json,
    ) =>
      handler.POST(request('POST', path, { cookie, body: payload }), undefined);

    before(async () => {
      const databases = await createTestDatabases('arrakis_b');
      const password = await import('../lib/auth/password');
      process.env.APP_DATABASE_URL = databases.appUrl;
      process.env.NETWORKS = JSON.stringify([
        { id: 'jura', label: 'Jura', databaseUrl: databases.readOnly.jura },
      ]);
      process.env.ARRAKIS_EDITOR_PASSWORD_HASH =
        await password.hashPassword(PASSWORD);
      lib = {
        app: await import('../lib/db/app'),
        runner: await import('../lib/query/runner'),
        fetch: await import('../lib/bundles/fetch'),
      };
      routes = {
        login: await import('../app/api/v1/auth/login/route'),
        bundles: await import('../app/api/v1/bundles/route'),
        bundle: await import('../app/api/v1/bundles/[name]/route'),
        preview: await import('../app/api/v1/bundles/preview/route'),
        exported: await import('../app/api/v1/dashboards/[slug]/bundle/route'),
        queries: await import('../app/api/v1/queries/route'),
        run: await import('../app/api/v1/queries/[slug]/run/route'),
      };
      cookie = cookieFrom(
        await routes.login.POST(
          request('POST', '/api/v1/auth/login', {
            body: { password: PASSWORD },
          }),
          undefined,
        ),
      );
      example = JSON.parse(
        await readFile(
          path.join(root, 'examples', 'bundles', 'gnosis-vpn.json'),
          'utf8',
        ),
      ) as Json;
    });

    after(async () => {
      await lib?.runner.closeQueryPools();
      await lib?.app.closeAppDb();
    });

    it('previews an import without changing anything', async () => {
      const response = await post(routes.preview, '/api/v1/bundles/preview', {
        bundle: example,
      });
      assert.equal(response.status, 200);
      const { plan } = await body<{ plan: Plan }>(response);
      assert.equal(plan.conflicts, 0);
      assert.ok(plan.items.every((item) => item.action === 'create'));
      const listed = await body<{ bundles: unknown[] }>(
        await routes.bundles.GET(
          request('GET', '/api/v1/bundles', { cookie }),
          undefined,
        ),
      );
      assert.deepEqual(listed.bundles, []);
    });

    it('imports a bundle, and importing it again changes nothing', async () => {
      const first = await post(routes.bundles, '/api/v1/bundles', {
        bundle: example,
      });
      assert.equal(
        first.status,
        200,
        JSON.stringify(await first.clone().json()),
      );
      const { report } = await body<{ report: Report }>(first);
      // One list, twenty-two queries, twenty-eight charts, two dashboards.
      assert.equal(report.created.length, 1 + 22 + 28 + 2);

      const again = await body<{ report: Report }>(
        await post(routes.bundles, '/api/v1/bundles', { bundle: example }),
      );
      assert.equal(again.report.created.length, 0);
      assert.equal(
        again.report.unchanged.filter((label) => label.startsWith('chart'))
          .length,
        28,
      );

      const { rows } = await (
        await lib.app.appDb()
      ).query<{ n: number }>(
        `SELECT count(*)::int AS n FROM visualizations
         WHERE bundle = 'gnosis-vpn' AND archived_at IS NULL`,
      );
      assert.equal(rows[0].n, 28);
      const listed = await body<{
        bundles: Array<{ name: string; dashboards: Array<{ slug: string }> }>;
      }>(
        await routes.bundles.GET(
          request('GET', '/api/v1/bundles', { cookie }),
          undefined,
        ),
      );
      assert.deepEqual(
        listed.bundles.map((entry) => [
          entry.name,
          entry.dashboards.map((dashboard) => dashboard.slug),
        ]),
        [['gnosis-vpn', ['gnosis-vpn', 'gnosis-vpn-client']]],
      );
    });

    it('rebinds an existing chart when its bundle changes the query', async () => {
      const changed = structuredClone(example) as Json;
      const charts = changed.charts as Array<{ key: string; query: string; title: string }>;
      const queries = changed.queries as Array<{ slug: string; kind: string }>;
      const chart = charts[0];
      const previous = chart.query;
      chart.query = queries.find((query) => query.kind === 'query' && query.slug !== previous)!.slug;
      const response = await post(routes.bundles, '/api/v1/bundles', { bundle: changed });
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      const report = await body<{ report: Report }>(response);
      assert.ok(report.report.updated.includes(`chart ${chart.title}`));
      const db = await lib.app.appDb();
      const result = await db.query<{ slug: string }>(
        `SELECT q.slug FROM visualizations v JOIN queries q ON q.id = v.query_id
         WHERE v.seed_key = $1 AND v.archived_at IS NULL`,
        [chart.key.includes('/') ? chart.key : `gnosis-vpn/${chart.key}`],
      );
      assert.equal(result.rows[0]?.slug, chart.query);
      const restore = await post(routes.bundles, '/api/v1/bundles', { bundle: example });
      assert.equal(restore.status, 200);
    });

    it('runs every query of the example bundle on a Blokli-shaped source', async () => {
      const queries = (
        example.queries as Array<{ slug: string; kind: string }>
      ).filter((query) => query.kind === 'query');
      for (const query of queries) {
        const response = await routes.run.POST(
          request('POST', `/api/v1/queries/${query.slug}/run`, {
            cookie,
            body: { network: 'jura' },
          }),
          context({ slug: query.slug }),
        );
        const answer = await body<{
          runs?: Array<{ status: string; error?: string }>;
        }>(response);
        assert.equal(
          response.status,
          200,
          `${query.slug}: ${JSON.stringify(answer)}`,
        );
        assert.equal(
          answer.runs?.[0].status,
          'succeeded',
          `${query.slug}: ${JSON.stringify(answer)}`,
        );
      }
    });

    it('estimates relayed data from redemptions and their winning probabilities', async () => {
      const app = await lib.app.appDb();
      const { rows: results } = await app.query<{ table_name: string }>(
        `SELECT r.table_name
           FROM query_results r
           JOIN query_versions v ON v.id = r.query_version_id
           JOIN queries q ON q.id = v.query_id
          WHERE q.slug = 'vpn-traffic' AND r.network = 'jura'`,
      );
      assert.equal(results.length, 1);
      const { rows } = await app.query<{
        gigabytes: number;
        expected: number;
        lowest_probability: number;
        highest_probability: number;
      }>(
        `SELECT SUM(gigabytes)::float8 AS gigabytes,
                SUM(CASE WHEN win_probability > 0 THEN 650::float8 / 1073741824 / win_probability ELSE 0 END)::float8 AS expected,
                MIN(win_probability)::float8 AS lowest_probability,
                MAX(win_probability)::float8 AS highest_probability
           FROM results.${results[0].table_name}`,
      );
      assert.ok(rows[0].gigabytes > 0);
      assert.ok(Math.abs(rows[0].gigabytes - rows[0].expected) < 1e-15);
      assert.ok(rows[0].lowest_probability > 0);
      assert.equal(
        rows[0].lowest_probability,
        rows[0].highest_probability,
      );
    });

    it('detects the exits from the service registry, with no list', async () => {
      // The fixture registers accounts 4 and 5 as gvpn:exit (5 updates its
      // metadata afterwards), a client that deregisters again, and account 7
      // with metadata that is not JSON. The list "exits" is empty.
      const app = await lib.app.appDb();
      const { rows } = await app.query<{ table_name: string }>(
        `SELECT r.table_name
           FROM query_results r
           JOIN query_versions v ON v.id = r.query_version_id
           JOIN queries q ON q.id = v.query_id
          WHERE q.slug = 'exit-nodes' AND r.network = 'jura'`,
      );
      assert.equal(rows.length, 1);
      const { rows: exits } = await app.query<{
        exit: string;
        name: string | null;
        found_in: string;
        vpn_server: string | null;
        wireguard_server: string | null;
        redemptions: string;
      }>(
        `SELECT exit, name, found_in, vpn_server, wireguard_server, redemptions
           FROM results.${rows[0].table_name} ORDER BY exit`,
      );
      const pad = (id: number) => `0x${id.toString(16).padStart(40, '0')}`;
      assert.deepEqual(
        exits.map((row) => [row.exit, row.name, row.found_in]),
        [
          [pad(4), 'GVPN-OLD-4', 'registry'],
          [pad(5), 'GVPN-KR-5', 'registry'],
          [pad(7), null, 'registry'],
        ],
      );
      assert.equal(exits[1].vpn_server, '172.30.0.5:8000');
      assert.equal(exits[1].wireguard_server, '172.30.0.5:51820');
      assert.equal(exits[2].vpn_server, null);
      // The registered relays-paying exits make downstream traffic with no list.
      assert.ok(exits.slice(0, 2).every((row) => Number(row.redemptions) > 0));
    });

    it('exports a dashboard with what it links to, fragments first', async () => {
      const response = await routes.exported.GET(
        request('GET', '/api/v1/dashboards/gnosis-vpn/bundle', { cookie }),
        context({ slug: 'gnosis-vpn' }),
      );
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get('content-disposition') ?? '',
        /gnosis-vpn\.arrakis\.json/,
      );
      const exported = await body<{
        queries: Array<{ slug: string; kind: string; sql: string }>;
        charts: unknown[];
        dashboards: Array<{ slug: string; widgets: Array<{ kind: string; text?: string; width: number; options: { textStyle?: string } }> }>;
      }>(response);
      assert.deepEqual(
        exported.dashboards.map((dashboard) => dashboard.slug),
        ['gnosis-vpn', 'gnosis-vpn-client'],
      );
      assert.equal(exported.charts.length, 28);
      const narrative = exported.dashboards.map((dashboard) => dashboard.widgets.filter((widget) => widget.kind === 'text' && widget.options.textStyle));
      assert.ok(narrative[0].length >= 10, 'overview keeps its narrative through export');
      assert.ok(narrative[1].length >= 5, 'client record keeps its narrative through export');
      assert.ok(narrative.every((widgets) => widgets.some((widget) => widget.width < 12)));
      // Each query comes after every fragment it names.
      const seen = new Set<string>();
      for (const query of exported.queries) {
        for (const name of fragmentsNamed(query.sql)) {
          if (exported.queries.some((entry) => entry.slug === name))
            assert.ok(seen.has(name), `${name} before ${query.slug}`);
        }
        seen.add(query.slug);
      }
      // Imported back, it is the same bundle: everything is an update.
      const { plan } = await body<{ plan: Plan }>(
        await post(routes.preview, '/api/v1/bundles/preview', {
          bundle: exported,
        }),
      );
      assert.equal(plan.conflicts, 0);
      assert.ok(plan.items.every((item) => item.action === 'update'));

      const reader = await routes.exported.GET(
        request('GET', '/api/v1/dashboards/gnosis-vpn/bundle'),
        context({ slug: 'gnosis-vpn' }),
      );
      assert.equal(reader.status, 401);
    });

    it('will not overwrite what came from elsewhere unless told to', async () => {
      await post(routes.queries, '/api/v1/queries', {
        slug: 'mine',
        title: 'Mine',
        sql: 'SELECT 1 AS one',
      });
      const other = {
        format: 'arrakis-bundle',
        version: 1,
        name: 'other',
        title: 'Other',
        queries: [
          {
            slug: 'mine',
            title: 'Theirs',
            kind: 'query',
            sql: 'SELECT 2 AS two',
          },
        ],
        charts: [
          { key: 'n', query: 'mine', title: 'N', type: 'table', config: {} },
        ],
        dashboards: [
          {
            slug: 'other',
            title: 'Other',
            widgets: [
              { kind: 'visualization', chart: 'n', width: 6, height: 200 },
            ],
          },
        ],
      };
      const { plan } = await body<{ plan: Plan }>(
        await post(routes.preview, '/api/v1/bundles/preview', {
          bundle: other,
        }),
      );
      assert.equal(plan.conflicts, 1);
      const refused = await post(routes.bundles, '/api/v1/bundles', {
        bundle: other,
      });
      assert.equal(refused.status, 400);
      const replaced = await post(routes.bundles, '/api/v1/bundles', {
        bundle: other,
        replace: true,
      });
      assert.equal(replaced.status, 200);
    });

    it('rejects a file that is not a bundle, saying where', async () => {
      const response = await post(routes.preview, '/api/v1/bundles/preview', {
        bundle: {
          ...example,
          charts: [{ key: 'x', query: 'nope', title: 'X', type: 'table' }],
        },
      });
      assert.equal(response.status, 400);
      assert.match(
        (await body<{ error: string }>(response)).error,
        /charts\[0\]/,
      );
    });

    it('downloads bundles over https from public addresses only', async () => {
      for (const url of [
        'http://example.com/b.json',
        'https://127.0.0.1/b.json',
        'https://localhost/b.json',
        'https://[::1]/b.json',
        'https://169.254.169.254/latest',
      ]) {
        await assert.rejects(
          lib.fetch.fetchBundle(url),
          /https only|private/,
          url,
        );
      }
    });

    it('archives what a newer file of a bundle dropped', async () => {
      const newer = structuredClone(example) as {
        queries: Array<{ slug: string }>;
        charts: Array<{ key: string }>;
        dashboards: Array<{ widgets: Array<{ chart?: string }> }>;
      };
      newer.queries = newer.queries.filter(
        (query) => query.slug !== 'indexed-contracts',
      );
      newer.charts = newer.charts.filter(
        (chart) => chart.key !== 'gnosis-vpn/contracts',
      );
      for (const dashboard of newer.dashboards)
        dashboard.widgets = dashboard.widgets.filter(
          (widget) => widget.chart !== 'gnosis-vpn/contracts',
        );
      const { plan } = await body<{ plan: Plan }>(
        await post(routes.preview, '/api/v1/bundles/preview', {
          bundle: newer,
        }),
      );
      assert.deepEqual(
        plan.items
          .filter((item) => item.action === 'archive')
          .map((item) => `${item.kind} ${item.name}`)
          .sort(),
        ['chart gnosis-vpn/contracts', 'query indexed-contracts'],
      );
      const imported = await body<{ report: { archived: string[] } }>(
        await post(routes.bundles, '/api/v1/bundles', { bundle: newer }),
      );
      assert.equal(imported.report.archived.length, 2);
      const { rows } = await (
        await lib.app.appDb()
      ).query<{ archived: boolean }>(
        `SELECT archived_at IS NOT NULL AS archived FROM queries WHERE slug = 'indexed-contracts'`,
      );
      assert.equal(rows[0].archived, true);
    });

    it('removes a bundle, keeping what something else still uses', async () => {
      // A query of one's own that inlines one of the bundle's fragments.
      const mine = await post(routes.queries, '/api/v1/queries', {
        slug: 'uses-hex',
        title: 'Uses hex',
        sql: "SELECT {{> hex('\\x01'::bytea)}} AS h",
      });
      assert.equal(mine.status, 201);
      const where = context({ name: 'gnosis-vpn' });
      const { plan } = await body<{ plan: Retirement }>(
        await routes.bundle.GET(
          request('GET', '/api/v1/bundles/gnosis-vpn', { cookie }),
          where,
        ),
      );
      assert.deepEqual(
        plan.keep.map((item) => [item.name, item.reason]),
        [['hex', 'read by the query uses-hex']],
      );
      assert.ok(
        plan.archive.some(
          (item) => item.kind === 'dashboard' && item.name === 'gnosis-vpn',
        ),
      );
      const removed = await routes.bundle.DELETE(
        request('DELETE', '/api/v1/bundles/gnosis-vpn', { cookie }),
        where,
      );
      assert.equal(removed.status, 200);
      const listed = await body<{
        bundles: Array<{
          name: string;
          dashboards: unknown[];
          queries: number;
          charts: number;
        }>;
      }>(
        await routes.bundles.GET(
          request('GET', '/api/v1/bundles', { cookie }),
          undefined,
        ),
      );
      const left = listed.bundles.find((entry) => entry.name === 'gnosis-vpn');
      assert.deepEqual(
        left && [left.dashboards.length, left.charts, left.queries],
        [0, 0, 1],
      );
      const unauthorised = await routes.bundle.DELETE(
        request('DELETE', '/api/v1/bundles/other'),
        context({ name: 'other' }),
      );
      assert.equal(unauthorised.status, 401);
    });
  },
);

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
  items: Array<{ kind: string; name: string; action: string }>;
  conflicts: number;
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
      // One list, sixteen queries, thirty charts, two dashboards.
      assert.equal(report.created.length, 1 + 16 + 30 + 2);

      const again = await body<{ report: Report }>(
        await post(routes.bundles, '/api/v1/bundles', { bundle: example }),
      );
      assert.equal(again.report.created.length, 0);
      assert.equal(
        again.report.unchanged.filter((label) => label.startsWith('chart'))
          .length,
        30,
      );

      const { rows } = await (
        await lib.app.appDb()
      ).query<{ n: number }>(
        `SELECT count(*)::int AS n FROM visualizations
         WHERE bundle = 'gnosis-vpn' AND archived_at IS NULL`,
      );
      assert.equal(rows[0].n, 30);
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
        dashboards: Array<{ slug: string }>;
      }>(response);
      assert.deepEqual(
        exported.dashboards.map((dashboard) => dashboard.slug),
        ['gnosis-vpn', 'gnosis-vpn-client'],
      );
      assert.equal(exported.charts.length, 30);
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
  },
);

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  adminUrl,
  context,
  cookieFrom,
  createTestDatabases,
  request,
} from './support';

describe(
  'dashboard views and query reliability',
  { skip: !adminUrl && 'TEST_ADMIN_DATABASE_URL not set' },
  () => {
    let cookie = '';
    let app: typeof import('../lib/db/app');
    let runner: typeof import('../lib/query/runner');
    let routes: {
      dashboards: typeof import('../app/api/v1/dashboards/route');
      views: typeof import('../app/api/v1/dashboards/[slug]/views/route');
      queries: typeof import('../app/api/v1/queries/route');
      tests: typeof import('../app/api/v1/queries/[slug]/tests/route');
      testRun: typeof import('../app/api/v1/queries/[slug]/tests/run/route');
      run: typeof import('../app/api/v1/queries/[slug]/run/route');
      health: typeof import('../app/api/v1/runs/health/route');
    };
    before(async () => {
      const databases = await createTestDatabases('arrakis_improve');
      process.env.APP_DATABASE_URL = databases.appUrl;
      process.env.NETWORKS = JSON.stringify([
        { id: 'jura', label: 'Jura', databaseUrl: databases.readOnly.jura },
      ]);
      process.env.ARRAKIS_EDITOR_PASSWORD_HASH = await (
        await import('../lib/auth/password')
      ).hashPassword('test password');
      app = await import('../lib/db/app');
      runner = await import('../lib/query/runner');
      routes = {
        dashboards: await import('../app/api/v1/dashboards/route'),
        views: await import('../app/api/v1/dashboards/[slug]/views/route'),
        queries: await import('../app/api/v1/queries/route'),
        tests: await import('../app/api/v1/queries/[slug]/tests/route'),
        testRun: await import('../app/api/v1/queries/[slug]/tests/run/route'),
        run: await import('../app/api/v1/queries/[slug]/run/route'),
        health: await import('../app/api/v1/runs/health/route'),
      };
      const login = await (
        await import('../app/api/v1/auth/login/route')
      ).POST(
        request('POST', '/api/v1/auth/login', {
          body: { password: 'test password' },
        }),
        undefined,
      );
      cookie = cookieFrom(login);
    });
    after(async () => {
      await runner?.closeQueryPools();
      await app?.closeAppDb();
    });

    it('saves views with dashboard permissions and validates their variables', async () => {
      const created = await routes.dashboards.POST(
        request('POST', '/api/v1/dashboards', {
          cookie,
          body: { slug: 'views-test', title: 'Views', visibility: 'public' },
        }),
        undefined,
      );
      assert.equal(created.status, 201);
      const ctx = context({ slug: 'views-test' });
      const save = await routes.views.POST(
        request('POST', '/api/v1/dashboards/views-test/views', {
          cookie,
          body: {
            name: 'Last week',
            variables: { range: '7d', network: 'jura' },
          },
        }),
        ctx,
      );
      assert.equal(save.status, 201);
      const { view } = (await save.json()) as {
        view: { id: string; variables: Record<string, string> };
      };
      assert.equal(view.variables.range, '7d');
      const list = await routes.views.GET(
        request('GET', '/api/v1/dashboards/views-test/views'),
        ctx,
      );
      assert.equal((await list.json()).views.length, 1);
      assert.equal(
        (
          await routes.views.POST(
            request('POST', '/api/v1/dashboards/views-test/views', {
              cookie,
              body: { name: 'Bad', variables: { nonexistent: 'x' } },
            }),
            ctx,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await routes.views.DELETE(
            request(
              'DELETE',
              `/api/v1/dashboards/views-test/views?id=${view.id}`,
            ),
            ctx,
          )
        ).status,
        401,
      );
      assert.equal(
        (
          await routes.views.DELETE(
            request(
              'DELETE',
              `/api/v1/dashboards/views-test/views?id=${view.id}`,
              { cookie },
            ),
            ctx,
          )
        ).status,
        200,
      );
    });

    it('runs fragment assertions against the unsaved draft without saving it', async () => {
      const created = await routes.queries.POST(
        request('POST', '/api/v1/queries', {
          cookie,
          body: {
            slug: 'add-one',
            title: 'Add one',
            kind: 'fragment',
            sql: '{{$value}} + 1',
          },
        }),
        undefined,
      );
      assert.equal(created.status, 201, await created.clone().text());
      const ctx = context({ slug: 'add-one' });
      const saved = await routes.tests.POST(
        request('POST', '/api/v1/queries/add-one/tests', {
          cookie,
          body: { name: 'Draft adds two', sql: 'SELECT {{> add-one(2)}} = 4' },
        }),
        ctx,
      );
      assert.equal(saved.status, 201);
      const { test } = (await saved.json()) as { test: { id: string } };
      const run = await routes.testRun.POST(
        request('POST', '/api/v1/queries/add-one/tests/run', {
          cookie,
          body: {
            id: test.id,
            sql: '{{$value}} + 2',
            parameters: [],
            network: 'jura',
          },
        }),
        ctx,
      );
      assert.equal(run.status, 200, await run.clone().text());
      assert.equal((await run.json()).passed, true);
      const fail = await routes.testRun.POST(
        request('POST', '/api/v1/queries/add-one/tests/run', {
          cookie,
          body: {
            id: test.id,
            sql: '{{$value}} + 1',
            parameters: [],
            network: 'jura',
          },
        }),
        ctx,
      );
      assert.equal((await fail.json()).passed, false);
    });

    it('records repeated stored runs and serves health only to editors', async () => {
      const created = await routes.queries.POST(
        request('POST', '/api/v1/queries', {
          cookie,
          body: {
            slug: 'run-history',
            title: 'Run history',
            sql: 'SELECT 1 AS n',
          },
        }),
        undefined,
      );
      assert.equal(created.status, 201);
      for (let n = 0; n < 2; n++) {
        const run = await routes.run.POST(
          request('POST', '/api/v1/queries/run-history/run', {
            cookie,
            body: { network: 'jura' },
          }),
          context({ slug: 'run-history' }),
        );
        assert.equal(run.status, 200, await run.clone().text());
      }
      assert.equal(
        (
          await routes.health.GET(
            request('GET', '/api/v1/runs/health'),
            undefined,
          )
        ).status,
        401,
      );
      const health = await routes.health.GET(
        request('GET', '/api/v1/runs/health', { cookie }),
        undefined,
      );
      assert.equal(health.status, 200, await health.clone().text());
      const result = (await health.json()) as {
        history: Array<{ slug: string; status: string }>;
      };
      assert.equal(
        result.history.filter(
          (entry) =>
            entry.slug === 'run-history' && entry.status === 'succeeded',
        ).length,
        2,
      );
      const db = await app.appDb();
      await db.query(`DELETE FROM query_results WHERE query_version_id = (SELECT current_version_id FROM queries WHERE slug = 'run-history')`);
      const preserved = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM query_run_history h JOIN query_versions v ON v.id = h.query_version_id JOIN queries q ON q.id = v.query_id WHERE q.slug = 'run-history'`);
      assert.equal(preserved.rows[0].count, '2');
    });
  },
);

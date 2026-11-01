/**
 * Visualizations and dashboards end to end, through the route handlers,
 * against real PostgreSQL. Skipped without TEST_ADMIN_DATABASE_URL.
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'correct horse battery staple';
const CLIENT = `0x${'06'.padStart(40, '0')}`;

type Json = Record<string, unknown>;
type Data = {
  columns: Array<{ name: string; type: string }>;
  rows: unknown[][];
  pending: boolean;
  truncated: boolean;
};

async function body<T = Json>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe(
  'visualizations and dashboards',
  { skip: !adminUrl && 'TEST_ADMIN_DATABASE_URL not set' },
  () => {
    let cookie = '';
    let routes: {
      login: typeof import('../app/api/v1/auth/login/route');
      queries: typeof import('../app/api/v1/queries/route');
      run: typeof import('../app/api/v1/queries/[slug]/run/route');
      queryVisualizations: typeof import('../app/api/v1/queries/[slug]/visualizations/route');
      visualization: typeof import('../app/api/v1/visualizations/[id]/route');
      visualizationData: typeof import('../app/api/v1/visualizations/[id]/data/route');
      preview: typeof import('../app/api/v1/visualizations/preview/route');
      dashboards: typeof import('../app/api/v1/dashboards/route');
      dashboard: typeof import('../app/api/v1/dashboards/[slug]/route');
      widgets: typeof import('../app/api/v1/dashboards/[slug]/widgets/route');
      dashboardData: typeof import('../app/api/v1/dashboards/[slug]/data/route');
      dashboardStatus: typeof import('../app/api/v1/dashboards/[slug]/status/route');
    };
    let lib: {
      app: typeof import('../lib/db/app');
      runner: typeof import('../lib/query/runner');
    };

    const preview = async (
      config: Json,
      network = 'jura',
      vars: Json = {},
      query = 'timed',
    ) => {
      const response = await routes.preview.POST(
        request('POST', '/api/v1/visualizations/preview', {
          cookie,
          body: { query, config, network, vars },
        }),
        undefined,
      );
      return {
        status: response.status,
        data: await body<Data & Json>(response),
      };
    };

    before(async () => {
      const databases = await createTestDatabases('arrakis_v');
      const password = await import('../lib/auth/password');
      process.env.APP_DATABASE_URL = databases.appUrl;
      process.env.NETWORKS = JSON.stringify([
        { id: 'jura', label: 'Jura', databaseUrl: databases.readOnly.jura },
        { id: 'dev', label: 'Dev', databaseUrl: databases.readOnly.dev },
      ]);
      process.env.ARRAKIS_EDITOR_PASSWORD_HASH =
        await password.hashPassword(PASSWORD);
      lib = {
        app: await import('../lib/db/app'),
        runner: await import('../lib/query/runner'),
      };
      routes = {
        login: await import('../app/api/v1/auth/login/route'),
        queries: await import('../app/api/v1/queries/route'),
        run: await import('../app/api/v1/queries/[slug]/run/route'),
        queryVisualizations:
          await import('../app/api/v1/queries/[slug]/visualizations/route'),
        visualization: await import('../app/api/v1/visualizations/[id]/route'),
        visualizationData:
          await import('../app/api/v1/visualizations/[id]/data/route'),
        preview: await import('../app/api/v1/visualizations/preview/route'),
        dashboards: await import('../app/api/v1/dashboards/route'),
        dashboard: await import('../app/api/v1/dashboards/[slug]/route'),
        widgets: await import('../app/api/v1/dashboards/[slug]/widgets/route'),
        dashboardData:
          await import('../app/api/v1/dashboards/[slug]/data/route'),
        dashboardStatus:
          await import('../app/api/v1/dashboards/[slug]/status/route'),
      };
      const login = await routes.login.POST(
        request('POST', '/api/v1/auth/login', { body: { password: PASSWORD } }),
        undefined,
      );
      cookie = cookieFrom(login);

      // Every redemption paid to an announced node, timestamped.
      const redemptions = (
        await readFile(path.join(root, 'sql', 'v1', 'redemptions.sql'), 'utf8')
      )
        .replaceAll('$1::bytea[]', '{{exits}}')
        .replace(/;\s*$/, '');
      const created = await routes.queries.POST(
        request('POST', '/api/v1/queries', {
          cookie,
          body: {
            slug: 'timed',
            title: 'Timed redemptions',
            visibility: 'public',
            sql: `WITH r AS (\n${redemptions}\n)\nSELECT r.*, {{block_time(r.published_block)}} AS at FROM r`,
          },
        }),
        undefined,
      );
      assert.equal(
        created.status,
        201,
        JSON.stringify(await created.clone().json()),
      );
      const run = await routes.run.POST(
        request('POST', '/api/v1/queries/timed/run', {
          cookie,
          body: { network: 'all' },
        }),
        context({ slug: 'timed' }),
      );
      assert.equal(run.status, 200);
    });

    after(async () => {
      await lib?.runner.closeQueryPools();
      await lib?.app.closeAppDb();
    });

    describe('steps', () => {
      it('passes the stored rows through untouched with no steps', async () => {
        const { status, data } = await preview({ steps: [] });
        assert.equal(status, 200);
        assert.equal(data.rows.length, 252);
        // A network column even for one network, so a chart that splits or
        // counts by network works whichever network is picked.
        assert.ok(data.rows.every((row) => row[0] === 'jura'));
        assert.deepEqual(
          data.columns.map((column) => column.name),
          [
            'network',
            'source',
            'destination',
            'source_announced',
            'published_block',
            'tickets',
            'at',
          ],
        );
      });

      it('stacks networks under a network column for "all"', async () => {
        const { data } = await preview(
          {
            steps: [
              {
                op: 'aggregate',
                groupBy: ['network'],
                measures: [{ fn: 'count', as: 'n' }],
              },
            ],
          },
          'all',
        );
        const counts = Object.fromEntries(data.rows as Array<[string, string]>);
        assert.deepEqual(counts, { jura: '252', dev: '253' });
      });

      it('buckets by day, aggregates and sorts', async () => {
        const { data } = await preview({
          steps: [
            { op: 'bucket', column: 'at', unit: 'day', as: 'day' },
            {
              op: 'aggregate',
              groupBy: ['day'],
              measures: [
                { fn: 'count', as: 'redemptions' },
                { fn: 'sum', columns: ['tickets'], as: 'tickets' },
              ],
            },
            { op: 'sort', by: [{ column: 'day' }] },
          ],
        });
        const days = data.rows.map((row) => row[0] as string);
        assert.deepEqual(days, [...days].sort());
        assert.equal(
          data.rows.reduce((total, row) => total + Number(row[1]), 0),
          252,
        );
        assert.deepEqual(
          data.columns.map((column) => [column.name, column.type]),
          [
            ['day', 'date'],
            ['redemptions', 'bigint'],
            ['tickets', 'numeric'],
          ],
        );
      });

      it('folds the long tail into Others and keeps the total', async () => {
        const { data } = await preview({
          steps: [
            {
              op: 'aggregate',
              groupBy: ['destination'],
              measures: [{ fn: 'sum', columns: ['tickets'], as: 'tickets' }],
            },
            {
              op: 'top',
              column: 'destination',
              by: 'tickets',
              n: 2,
              sum: ['tickets'],
            },
            { op: 'sort', by: [{ column: 'tickets', desc: true }] },
          ],
        });
        assert.equal(data.rows.length, 3);
        assert.ok(data.rows.some((row) => row[0] === 'Others'));
        // Byte labels read as 0x-hex, as they do everywhere else.
        for (const row of data.rows) {
          if (row[0] !== 'Others')
            assert.match(String(row[0]), /^0x[0-9a-f]{40}$/);
        }
        const { data: all } = await preview({
          steps: [
            {
              op: 'aggregate',
              groupBy: [],
              measures: [{ fn: 'sum', columns: ['tickets'], as: 't' }],
            },
          ],
        });
        assert.equal(
          data.rows.reduce((total, row) => total + Number(row[1]), 0),
          Number(all.rows[0][0]),
        );
      });

      it('counts distinct clients over a trailing window, every day filled', async () => {
        const { data } = await preview({
          steps: [
            {
              op: 'filter',
              column: 'source_announced',
              operator: '=',
              value: { literal: false },
            },
            { op: 'bucket', column: 'at', unit: 'day', as: 'day' },
            {
              op: 'rolling',
              time: 'day',
              days: 7,
              fill: true,
              measures: [
                { fn: 'count_distinct', columns: ['source'], as: 'weekly' },
              ],
            },
            { op: 'sort', by: [{ column: 'day' }] },
          ],
        });
        const days = data.rows.map((row) =>
          Date.parse(`${row[0] as string}T00:00:00Z`),
        );
        for (let index = 1; index < days.length; index += 1) {
          assert.equal(
            days[index] - days[index - 1],
            86_400_000,
            'consecutive days',
          );
        }
        const peak = Math.max(...data.rows.map((row) => Number(row[1])));
        assert.ok(peak > 0 && peak <= 20, `20 clients at most, got ${peak}`);
      });

      it('limits to a trailing range from a variable, and "all" keeps everything', async () => {
        const steps = [
          { op: 'range', column: 'at' },
          {
            op: 'aggregate',
            groupBy: [],
            measures: [{ fn: 'count', as: 'n' }],
          },
        ];
        // The fixture's redemptions span about six days.
        const week = await preview({ steps }, 'jura', { range: '2d' });
        const all = await preview({ steps }, 'jura', { range: 'all' });
        assert.equal(all.data.rows[0][0], '252');
        assert.ok(Number(week.data.rows[0][0]) < 252);
        assert.ok(Number(week.data.rows[0][0]) > 0);
      });

      it('filters by a variable when set, and skips an optional filter when not', async () => {
        const steps = [
          {
            op: 'filter',
            column: 'source',
            operator: '=',
            value: { var: 'client' },
            optional: true,
          },
          {
            op: 'aggregate',
            groupBy: [],
            measures: [{ fn: 'count', as: 'n' }],
          },
        ];
        assert.equal((await preview({ steps })).data.rows[0][0], '252');
        assert.equal(
          (await preview({ steps }, 'jura', { client: CLIENT })).data
            .rows[0][0],
          '9',
        );
      });

      it('shapes an hour-of-week grid', async () => {
        const { data } = await preview({
          steps: [
            { op: 'bucket', column: 'at', unit: 'day_of_week', as: 'weekday' },
            { op: 'bucket', column: 'at', unit: 'hour_of_day', as: 'hour' },
            {
              op: 'aggregate',
              groupBy: ['weekday', 'hour'],
              measures: [{ fn: 'count', as: 'n' }],
            },
          ],
        });
        for (const [weekday, hour] of data.rows as number[][]) {
          assert.ok(weekday >= 1 && weekday <= 7);
          assert.ok(hour >= 0 && hour <= 23);
        }
      });

      it('builds cohorts from window and compute steps', async () => {
        const { status, data } = await preview({
          steps: [
            { op: 'bucket', column: 'at', unit: 'month', as: 'month' },
            {
              op: 'window',
              as: 'cohort',
              fn: 'min',
              column: 'month',
              partitionBy: ['source'],
            },
            {
              op: 'compute',
              as: 'offset',
              left: 'month',
              operator: 'months_between',
              right: 'cohort',
            },
            {
              op: 'aggregate',
              groupBy: ['cohort', 'offset'],
              measures: [
                { fn: 'count_distinct', columns: ['source'], as: 'active' },
              ],
            },
            {
              op: 'window',
              as: 'size',
              fn: 'max',
              column: 'active',
              partitionBy: ['cohort'],
            },
            {
              op: 'compute',
              as: 'share',
              left: 'active',
              operator: '/',
              right: 'size',
            },
          ],
        });
        assert.equal(status, 200, JSON.stringify(data));
        for (const row of data.rows) {
          const share = Number(
            row[data.columns.findIndex((column) => column.name === 'share')],
          );
          assert.ok(share > 0 && share <= 1);
        }
      });

      it('names the missing column when a step refers to one', async () => {
        const { status, data } = await preview({
          steps: [
            {
              op: 'aggregate',
              groupBy: ['nope'],
              measures: [{ fn: 'count', as: 'n' }],
            },
          ],
        });
        assert.equal(status, 400);
        assert.match(
          String(data.error),
          /no column "nope"; available: network, source, destination/,
        );
      });
    });

    describe('SQL mode', () => {
      it('reads the stored result through {{result}}', async () => {
        const { status, data } = await preview(
          {
            sql: 'SELECT network, count(*) AS n FROM {{result}} GROUP BY network ORDER BY network',
          },
          'all',
        );
        assert.equal(status, 200, JSON.stringify(data));
        assert.deepEqual(data.rows, [
          ['dev', '253'],
          ['jura', '252'],
        ]);
      });

      it('binds variables as text', async () => {
        const { data } = await preview(
          {
            sql: `SELECT count(*) FROM {{result}} WHERE '0x' || encode(source, 'hex') = {{client}}`,
          },
          'jura',
          { client: CLIENT },
        );
        assert.deepEqual(data.rows, [['9']]);
      });

      it('cannot read anything but results', async () => {
        const { status, data } = await preview({
          sql: 'SELECT username, password_hash FROM users',
        });
        assert.equal(status, 400);
        assert.match(String(data.error), /not allowed/);
        const write = await preview({ sql: 'DELETE FROM sessions' });
        assert.equal(write.status, 400);
      });
    });

    describe('saved visualizations and dashboards', () => {
      let daily = '';
      let perClient = '';

      it('saves visualizations on a query and serves their data publicly', async () => {
        const save = async (input: Json) => {
          const response = await routes.queryVisualizations.POST(
            request('POST', '/api/v1/queries/timed/visualizations', {
              cookie,
              body: input,
            }),
            context({ slug: 'timed' }),
          );
          assert.equal(
            response.status,
            201,
            JSON.stringify(await response.clone().json()),
          );
          return ((await body(response)) as { visualization: { id: string } })
            .visualization.id;
        };
        daily = await save({
          title: 'Redemptions per day',
          type: 'bar',
          config: {
            steps: [
              { op: 'range', column: 'at' },
              { op: 'bucket', column: 'at', unit: 'day', as: 'day' },
              {
                op: 'aggregate',
                groupBy: ['day'],
                measures: [{ fn: 'count', as: 'redemptions' }],
              },
              { op: 'sort', by: [{ column: 'day' }] },
            ],
            encoding: { x: 'day', y: ['redemptions'] },
          },
        });
        perClient = await save({
          title: 'One client',
          type: 'number',
          config: {
            steps: [
              {
                op: 'filter',
                column: 'source',
                operator: '=',
                value: { var: 'client' },
              },
              {
                op: 'aggregate',
                groupBy: [],
                measures: [{ fn: 'count', as: 'n' }],
              },
            ],
            encoding: { y: ['n'] },
          },
        });

        const anonymous = await routes.visualizationData.GET(
          request(
            'GET',
            `/api/v1/visualizations/${daily}/data?network=jura&v.range=all`,
          ),
          context({ id: daily }),
        );
        assert.equal(anonymous.status, 200);
        const data = await body<Data>(anonymous);
        assert.equal(
          data.rows.reduce((total, row) => total + Number(row[1]), 0),
          252,
        );
        assert.match(anonymous.headers.get('cache-control') ?? '', /public/);
      });

      it('rejects an unknown chart type', async () => {
        const response = await routes.queryVisualizations.POST(
          request('POST', '/api/v1/queries/timed/visualizations', {
            cookie,
            body: { title: 'x', type: 'pie', config: {} },
          }),
          context({ slug: 'timed' }),
        );
        assert.equal(response.status, 400);
      });

      it('builds a dashboard whose widgets read its variables', async () => {
        const created = await routes.dashboards.POST(
          request('POST', '/api/v1/dashboards', {
            cookie,
            body: { slug: 'usage', title: 'Usage', visibility: 'public' },
          }),
          undefined,
        );
        assert.equal(created.status, 201);
        const { dashboard } = (await body(created)) as {
          dashboard: { variables: Array<{ name: string; default: string }> };
        };
        assert.deepEqual(
          dashboard.variables.map((variable) => [
            variable.name,
            variable.default,
          ]),
          [
            ['range', '30d'],
            ['network', 'all'],
          ],
        );
        await routes.dashboard.PATCH(
          request('PATCH', '/api/v1/dashboards/usage', {
            cookie,
            body: {
              variables: [
                { name: 'range', type: 'range', default: 'all' },
                { name: 'network', type: 'network', default: 'jura' },
                { name: 'client', type: 'text' },
              ],
            },
          }),
          context({ slug: 'usage' }),
        );
        const layout = await routes.widgets.PUT(
          request('PUT', '/api/v1/dashboards/usage/widgets', {
            cookie,
            body: {
              widgets: [
                { kind: 'text', text: 'Usage', width: 12, height: 80 },
                {
                  kind: 'visualization',
                  visualization: daily,
                  width: 8,
                  height: 260,
                },
                {
                  kind: 'visualization',
                  visualization: perClient,
                  width: 4,
                  height: 160,
                  options: { requires: 'client' },
                },
              ],
            },
          }),
          context({ slug: 'usage' }),
        );
        assert.equal(
          layout.status,
          200,
          JSON.stringify(await layout.clone().json()),
        );

        // Tiles are dragged a twelfth at a time: any whole width from 1 to
        // 12 is kept, anything else refused before it reaches the database.
        for (const [width, status] of [
          [5, 200],
          [11, 200],
          [0, 400],
          [13, 400],
          [4.5, 400],
        ] as const) {
          const response = await routes.widgets.PUT(
            request('PUT', '/api/v1/dashboards/usage/widgets', {
              cookie,
              body: {
                widgets: [
                  {
                    kind: 'visualization',
                    visualization: daily,
                    width,
                    height: 280,
                  },
                ],
              },
            }),
            context({ slug: 'usage' }),
          );
          assert.equal(response.status, status, `width ${width}`);
        }
        // Back to the layout the rest of this test reads.
        await routes.widgets.PUT(
          request('PUT', '/api/v1/dashboards/usage/widgets', {
            cookie,
            body: {
              widgets: [
                { kind: 'text', text: 'Usage', width: 12, height: 80 },
                {
                  kind: 'visualization',
                  visualization: daily,
                  width: 8,
                  height: 260,
                },
                {
                  kind: 'visualization',
                  visualization: perClient,
                  width: 4,
                  height: 160,
                  options: { requires: 'client' },
                },
              ],
            },
          }),
          context({ slug: 'usage' }),
        );

        const read = async (search: string) =>
          body<{
            vars: Record<string, string>;
            widgets: Array<{
              state: string;
              data?: Data;
              error?: { message: string };
            }>;
          }>(
            await routes.dashboardData.GET(
              request('GET', `/api/v1/dashboards/usage/data${search}`),
              context({ slug: 'usage' }),
            ),
          );

        const plain = await read('');
        assert.deepEqual(plain.vars, { range: 'all', network: 'jura' });
        assert.deepEqual(
          plain.widgets.map((widget) => widget.state),
          ['text', 'ok', 'hidden'],
        );
        assert.equal(
          plain.widgets[1].data?.rows.reduce(
            (total, row) => total + Number(row[1]),
            0,
          ),
          252,
        );

        // Which of the dashboard's queries are running, for the page to
        // show live: none, until a run claims its result.
        const status = async () =>
          (
            await body<{
              queries: Array<{ query: string; running: boolean }>;
            }>(
              await routes.dashboardStatus.GET(
                request('GET', '/api/v1/dashboards/usage/status'),
                context({ slug: 'usage' }),
              ),
            )
          ).queries;
        const idle = await status();
        assert.ok(idle.length > 0);
        assert.ok(idle.every((entry) => !entry.running));
        const db = await lib.app.appDb();
        const claim = (started: string) =>
          db.query(
            `UPDATE query_results SET attempt_status = 'running',
                    attempt_started_at = now() - $2::interval
             WHERE query_version_id =
                   (SELECT current_version_id FROM queries WHERE slug = $1)`,
            [idle[0].query, started],
          );
        await claim('0 seconds');
        assert.equal(
          (await status()).find((entry) => entry.query === idle[0].query)
            ?.running,
          true,
        );
        // A claim older than a run can last was abandoned, not running.
        await claim('20 minutes');
        assert.ok((await status()).every((entry) => !entry.running));
        await db.query(
          `UPDATE query_results SET attempt_status = 'succeeded'
           WHERE attempt_status = 'running'`,
        );

        const drilled = await read(`?v.client=${CLIENT}&v.network=dev`);
        assert.equal(drilled.widgets[2].state, 'ok');
        // Dev has one more redemption on this client's channel than jura.
        assert.deepEqual(drilled.widgets[2].data?.rows, [['10']]);
        assert.equal(
          drilled.widgets[1].data?.rows.reduce(
            (total, row) => total + Number(row[1]),
            0,
          ),
          253,
        );

        // A value outside a variable's options falls back to its default.
        const bogus = await read('?v.network=nowhere');
        assert.equal(bogus.vars.network, 'all');
      });

      it('keeps private dashboards private', async () => {
        await routes.dashboards.POST(
          request('POST', '/api/v1/dashboards', {
            cookie,
            body: { slug: 'drafts', title: 'Drafts' },
          }),
          undefined,
        );
        const anonymous = await routes.dashboardData.GET(
          request('GET', '/api/v1/dashboards/drafts/data'),
          context({ slug: 'drafts' }),
        );
        assert.equal(anonymous.status, 404);
        const list = await body<{ dashboards: Array<{ slug: string }> }>(
          await routes.dashboards.GET(
            request('GET', '/api/v1/dashboards'),
            undefined,
          ),
        );
        assert.deepEqual(
          list.dashboards.map((entry) => entry.slug),
          ['usage'],
        );
      });

      it('takes an archived visualization off its dashboards', async () => {
        const removed = await routes.visualization.DELETE(
          request('DELETE', `/api/v1/visualizations/${perClient}`, { cookie }),
          context({ id: perClient }),
        );
        assert.equal(removed.status, 200);
        const { dashboard } = await body<{ dashboard: { widgets: unknown[] } }>(
          await routes.dashboard.GET(
            request('GET', '/api/v1/dashboards/usage'),
            context({ slug: 'usage' }),
          ),
        );
        assert.equal(dashboard.widgets.length, 2);
      });

      it('reports a query with nothing stored yet as pending', async () => {
        await routes.queries.POST(
          request('POST', '/api/v1/queries', {
            cookie,
            body: { slug: 'empty', title: 'Never run', sql: 'SELECT 1 AS one' },
          }),
          undefined,
        );
        const { data } = await preview({ steps: [] }, 'jura', {}, 'empty');
        assert.equal(data.pending, true);
      });
    });
  },
);

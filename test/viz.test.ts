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
      visualizationInputs: typeof import('../app/api/v1/visualizations/[id]/inputs/route');
      preview: typeof import('../app/api/v1/visualizations/preview/route');
      dashboards: typeof import('../app/api/v1/dashboards/route');
      dashboard: typeof import('../app/api/v1/dashboards/[slug]/route');
      widgets: typeof import('../app/api/v1/dashboards/[slug]/widgets/route');
      dashboardData: typeof import('../app/api/v1/dashboards/[slug]/data/route');
      dashboardStatus: typeof import('../app/api/v1/dashboards/[slug]/status/route');
      lineage: typeof import('../app/api/v1/lineage/route');
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
      process.env.APP_CHARTS_DATABASE_URL = databases.chartsUrl;
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
        visualizationInputs:
          await import('../app/api/v1/visualizations/[id]/inputs/route'),
        preview: await import('../app/api/v1/visualizations/preview/route'),
        dashboards: await import('../app/api/v1/dashboards/route'),
        dashboard: await import('../app/api/v1/dashboards/[slug]/route'),
        widgets: await import('../app/api/v1/dashboards/[slug]/widgets/route'),
        dashboardData:
          await import('../app/api/v1/dashboards/[slug]/data/route'),
        dashboardStatus:
          await import('../app/api/v1/dashboards/[slug]/status/route'),
        lineage: await import('../app/api/v1/lineage/route'),
      };
      const login = await routes.login.POST(
        request('POST', '/api/v1/auth/login', { body: { password: PASSWORD } }),
        undefined,
      );
      cookie = cookieFrom(login);

      // The exits the redemption query reads: none listed.
      await (
        await lib.app.appDb()
      ).query("INSERT INTO lists (name, type) VALUES ('exits', 'bytes')");

      // Every redemption paid to an announced node, timestamped.
      const redemptions = (
        await readFile(
          path.join(root, 'test', 'fixtures', 'sql', 'v1', 'redemptions.sql'),
          'utf8',
        )
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
            sql: `WITH r AS (\n${redemptions}\n)\nSELECT r.*, to_timestamp(extract(epoch FROM now()) - ((SELECT last_indexed_block FROM chain_info ORDER BY id LIMIT 1) - r.published_block) * 5) AS at FROM r`,
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

      it('cannot leave its role for the app\'s and read the app database', async () => {
        // The escape that SET ROLE allowed: switch back to the login role,
        // then run a query string under it.
        const { status, data } = await preview({
          sql: `SELECT set_config('role', session_user, true) AS r,
                       query_to_xml('SELECT username FROM users', true, false, '') AS x
                FROM {{result}} LIMIT 1`,
        });
        assert.equal(status, 400, JSON.stringify(data));
        assert.match(String(data.error), /not allowed/);
        assert.doesNotMatch(JSON.stringify(data), /editor/);
      });

      it('cannot read another stored result by name', async () => {
        const db = await lib.app.appDb();
        const { rows } = await db.query<{ table_name: string }>(
          'SELECT table_name FROM query_results WHERE table_name IS NOT NULL LIMIT 1',
        );
        assert.ok(rows[0], 'a stored result to aim at');
        const { status, data } = await preview({
          sql: `SELECT count(*) FROM results."${rows[0].table_name}"`,
        });
        assert.equal(status, 400);
        assert.match(String(data.error), /not allowed/);
      });

      it('leaves nothing on its connection for the next run', async () => {
        const set = await preview({
          sql: `SELECT set_config('arrakis.leak', 'left behind', false) AS v FROM {{result}} LIMIT 1`,
        });
        assert.equal(set.status, 200, JSON.stringify(set.data));
        for (let run = 0; run < 3; run += 1) {
          const { data } = await preview({
            sql: `SELECT current_setting('arrakis.leak', true) AS v FROM {{result}} LIMIT 1`,
          });
          assert.notEqual(data.rows?.[0]?.[0], 'left behind');
        }
      });

      it('is refused while its login could do more than read its ticket', async () => {
        const charts = await import('../lib/db/charts');
        const own = process.env.APP_CHARTS_DATABASE_URL;
        try {
          process.env.APP_CHARTS_DATABASE_URL = process.env.APP_DATABASE_URL;
          await charts.closeChartsDb();
          const { status, data } = await preview({
            sql: 'SELECT count(*) FROM {{result}}',
          });
          assert.equal(status, 503);
          assert.match(String(data.error), /SQL charts are off/);
        } finally {
          process.env.APP_CHARTS_DATABASE_URL = own;
          await charts.closeChartsDb();
        }
        const { status } = await preview({ sql: 'SELECT count(*) FROM {{result}}' });
        assert.equal(status, 200);
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

      it('shows matching stored input rows for an ungrouped number and refuses stale chart settings', async () => {
        const saved = await body<{ visualization: { updatedAt: string } }>(
          await routes.visualization.GET(request('GET', `/api/v1/visualizations/${perClient}`), context({ id: perClient })),
        );
        const params = new URLSearchParams({ network: 'jura', 'v.client': CLIENT, chartVersion: saved.visualization.updatedAt });
        const inputs = await routes.visualizationInputs.GET(request('GET', `/api/v1/visualizations/${perClient}/inputs?${params}`), context({ id: perClient }));
        assert.equal(inputs.status, 200, await inputs.clone().text());
        const inputData = await body<{ supported: boolean; columns: Array<{ name: string }>; rows: unknown[][]; hasMore: boolean }>(inputs);
        assert.equal(inputData.supported, true);
        const source = inputData.columns.findIndex((column) => column.name === 'source');
        assert.ok(source >= 0);
        assert.equal(inputData.rows.length, 9);
        assert.ok(inputData.rows.every((row) => row[source] === CLIENT));
        const chart = await body<Data>(await routes.visualizationData.GET(request('GET', `/api/v1/visualizations/${perClient}/data?network=jura&v.client=${CLIENT}`), context({ id: perClient })));
        assert.equal(Number(chart.rows[0][0]), inputData.rows.length);
        assert.equal(inputData.hasMore, false);
        params.set('chartVersion', 'outdated');
        assert.equal((await routes.visualizationInputs.GET(request('GET', `/api/v1/visualizations/${perClient}/inputs?${params}`), context({ id: perClient }))).status, 409);
        const db = await lib.app.appDb();
        await db.query("UPDATE queries SET visibility = 'private' WHERE slug = 'timed'");
        try {
          params.set('chartVersion', saved.visualization.updatedAt);
          const privateResponse = await routes.visualizationInputs.GET(request('GET', `/api/v1/visualizations/${perClient}/inputs?${params}`), context({ id: perClient }));
          assert.equal(privateResponse.status, 404);
        } finally {
          await db.query("UPDATE queries SET visibility = 'public' WHERE slug = 'timed'");
        }
      });

      it('rejects an unknown chart type', async () => {
        const response = await routes.queryVisualizations.POST(
          request('POST', '/api/v1/queries/timed/visualizations', {
            cookie,
            body: { title: 'x', type: 'radar', config: {} },
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
        const textTile = await routes.widgets.PUT(
          request('PUT', '/api/v1/dashboards/usage/widgets', {
            cookie,
            body: { widgets: [{ kind: 'text', text: '# Context\n\nHelpful notes.', width: 4, height: 240, options: { textStyle: 'card', layout: { column: 6, row: 2, unit: 'cells', rows: 3 } } }] },
          }),
          context({ slug: 'usage' }),
        );
        assert.equal(textTile.status, 200, JSON.stringify(await textTile.clone().json()));
        const saved = await body<{ dashboard: { widgets: Array<{ width: number; text: string; options: { textStyle: string; layout: { column: number; rows: number } } }> } }>(textTile);
        assert.equal(saved.dashboard.widgets[0].width, 4);
        assert.equal(saved.dashboard.widgets[0].text, '# Context\n\nHelpful notes.');
        assert.equal(saved.dashboard.widgets[0].options.textStyle, 'card');
        assert.equal(saved.dashboard.widgets[0].options.layout.column, 6);
        assert.equal(saved.dashboard.widgets[0].options.layout.rows, 3);
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

      it('keeps a tile on a private or archived query, without its data', async () => {
        const db = await lib.app.appDb();
        type Shown = {
          dashboard: {
            widgets: Array<{
              visualization: {
                id: string;
                title: string;
                query: string;
                queryTitle: string;
                config: { steps: unknown[]; sql?: string };
              } | null;
            }>;
          };
        };
        type Read = {
          widgets: Array<{ id: string; state: string; data?: unknown }>;
        };
        const tileOf = async (cookieValue?: string) =>
          (
            await body<Shown>(
              await routes.dashboard.GET(
                request('GET', '/api/v1/dashboards/usage', cookieValue ? { cookie: cookieValue } : {}),
                context({ slug: 'usage' }),
              ),
            )
          ).dashboard.widgets.find((widget) => widget.visualization?.id === daily)!;
        const dataOf = async (cookieValue?: string) =>
          body<Read>(
            await routes.dashboardData.GET(
              request('GET', '/api/v1/dashboards/usage/data', cookieValue ? { cookie: cookieValue } : {}),
              context({ slug: 'usage' }),
            ),
          );

        for (const hide of [
          "UPDATE queries SET visibility = 'private' WHERE slug = 'timed'",
          'UPDATE queries SET archived_at = now() WHERE slug = \'timed\'',
        ]) {
          await db.query(hide);
          try {
            // The reader keeps the tile and its title, and nothing else.
            const tile = await tileOf();
            assert.equal(tile.visualization?.title, 'Redemptions per day');
            assert.equal(tile.visualization?.query, '');
            assert.equal(tile.visualization?.queryTitle, '');
            assert.deepEqual(tile.visualization?.config.steps, []);

            const shown = await dataOf();
            const index = shown.widgets.findIndex((entry) => entry.state === 'private');
            assert.ok(index >= 0, JSON.stringify(shown.widgets.map((entry) => entry.state)));
            assert.equal(shown.widgets[index].data, undefined);

            const status = await body<{ queries: Array<{ query: string }> }>(
              await routes.dashboardStatus.GET(
                request('GET', '/api/v1/dashboards/usage/status'),
                context({ slug: 'usage' }),
              ),
            );
            assert.ok(status.queries.every((entry) => entry.query !== 'timed'));

            const direct = await routes.visualizationData.GET(
              request('GET', `/api/v1/visualizations/${daily}/data`),
              context({ id: daily }),
            );
            assert.equal(direct.status, 404);

            // Editors still see it all.
            assert.equal((await tileOf(cookie)).visualization?.query, 'timed');
            assert.ok((await dataOf(cookie)).widgets.every((entry) => entry.state !== 'private'));
          } finally {
            await db.query(
              "UPDATE queries SET visibility = 'public', archived_at = NULL WHERE slug = 'timed'",
            );
          }
        }
      });

      it('tells a reader that a refresh failed, not what the database said', async () => {
        const db = await lib.app.appDb();
        const secret = 'connect ECONNREFUSED 10.9.8.7:5432';
        const { rows } = await db.query<{ id: string }>(
          `UPDATE query_results r SET attempt_status = 'failed', attempt_error = $1
           FROM query_versions v, queries q
           WHERE v.id = r.query_version_id AND q.id = v.query_id
             AND q.slug = 'timed' AND q.current_version_id = v.id
           RETURNING r.id`,
          [secret],
        );
        assert.ok(rows.length > 0);
        try {
          const results = await import('../app/api/v1/queries/[slug]/results/route');
          const read = async (cookieValue?: string) =>
            JSON.stringify(
              await body(
                await results.GET(
                  request('GET', '/api/v1/queries/timed/results?limit=1', cookieValue ? { cookie: cookieValue } : {}),
                  context({ slug: 'timed' }),
                ),
              ),
            );
          const signedOut = await read();
          assert.doesNotMatch(signedOut, /10\.9\.8\.7/);
          assert.match(signedOut, /The last refresh failed/);
          assert.match(await read(cookie), /10\.9\.8\.7/);

          const chart = JSON.stringify(
            await body(
              await routes.visualizationData.GET(
                request('GET', `/api/v1/visualizations/${daily}/data`),
                context({ id: daily }),
              ),
            ),
          );
          assert.doesNotMatch(chart, /10\.9\.8\.7/);
          const board = JSON.stringify(
            await body(
              await routes.dashboardData.GET(
                request('GET', '/api/v1/dashboards/usage/data'),
                context({ slug: 'usage' }),
              ),
            ),
          );
          assert.doesNotMatch(board, /10\.9\.8\.7/);
        } finally {
          await db.query(
            `UPDATE query_results SET attempt_status = 'succeeded', attempt_error = NULL
             WHERE attempt_error = $1`,
            [secret],
          );
        }
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

      it('traces tables to queries, charts and dashboards', async () => {
        for (const [slug, kind, sql] of [
          ['one', 'fragment', 'SELECT 1 AS one'],
          [
            'uses-one',
            'query',
            'SELECT * FROM {{> one}} AS o -- not FROM account',
          ],
        ]) {
          const created = await routes.queries.POST(
            request('POST', '/api/v1/queries', {
              cookie,
              body: { slug, kind, title: slug, sql },
            }),
            undefined,
          );
          assert.equal(created.status, 201);
        }
        type Graph = {
          nodes: Array<{ id: string; href: string }>;
          edges: Array<{ from: string; to: string }>;
        };
        const read = async (signedIn: boolean) =>
          body<Graph>(
            await routes.lineage.GET(
              request(
                'GET',
                '/api/v1/lineage',
                signedIn ? { cookie } : undefined,
              ),
              undefined,
            ),
          );
        const has = (graph: Graph, from: string, to: string) =>
          graph.edges.some((edge) => edge.from === from && edge.to === to);

        const editor = await read(true);
        const ids = new Set(editor.nodes.map((node) => node.id));
        assert.ok(ids.has('fragment:one') && ids.has('query:uses-one'));
        assert.ok(has(editor, 'fragment:one', 'query:uses-one'));
        // A table named only in a comment is not read.
        assert.ok(
          !editor.edges.some(
            (edge) =>
              edge.to === 'query:uses-one' && edge.from.startsWith('table:'),
          ),
        );
        // The redemptions query reads tables of the index.
        assert.ok(
          editor.edges.some(
            (edge) =>
              edge.to === 'query:timed' && edge.from.startsWith('table:'),
          ),
        );
        assert.ok(has(editor, 'query:timed', `chart:${daily}`));
        assert.ok(has(editor, `chart:${daily}`, 'dashboard:usage'));
        assert.ok(ids.has('dashboard:drafts'));
        assert.equal(
          editor.nodes.find((node) => node.id === `chart:${daily}`)?.href,
          `/queries/timed?tab=charts&chart=${daily}`,
        );

        // Readers see what is public, and no tables.
        const reader = await read(false);
        const seen = new Set(reader.nodes.map((node) => node.id));
        assert.ok(seen.has('query:timed') && seen.has('dashboard:usage'));
        assert.ok(!seen.has('fragment:one') && !seen.has('query:uses-one'));
        assert.ok(!seen.has('dashboard:drafts'));
        assert.ok(![...seen].some((id) => id.startsWith('table:')));
        assert.ok(has(reader, `chart:${daily}`, 'dashboard:usage'));
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

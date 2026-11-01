/**
 * End-to-end tests of the query store against real PostgreSQL databases,
 * through the route handlers. Skipped without TEST_ADMIN_DATABASE_URL.
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
  type TestDatabases,
} from './support';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'correct horse battery staple';
const EXIT_A = `0x${'04'.padStart(40, '0')}`;
const EXIT_B = `0x${'05'.padStart(40, '0')}`;
const CLIENT = `0x${'06'.padStart(40, '0')}`;

type Json = Record<string, unknown> & {
  [key: string]: unknown;
};

async function body(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

describe(
  'query store',
  { skip: !adminUrl && 'TEST_ADMIN_DATABASE_URL not set' },
  () => {
    let databases: TestDatabases;
    let cookie = '';
    // Imported after the environment is in place.
    let routes: {
      login: typeof import('../app/api/v1/auth/login/route');
      logout: typeof import('../app/api/v1/auth/logout/route');
      session: typeof import('../app/api/v1/auth/session/route');
      queries: typeof import('../app/api/v1/queries/route');
      query: typeof import('../app/api/v1/queries/[slug]/route');
      versions: typeof import('../app/api/v1/queries/[slug]/versions/route');
      fork: typeof import('../app/api/v1/queries/[slug]/fork/route');
      run: typeof import('../app/api/v1/queries/[slug]/run/route');
      results: typeof import('../app/api/v1/queries/[slug]/results/route');
      adhoc: typeof import('../app/api/v1/run/route');
      exits: typeof import('../app/api/v1/networks/[network]/exits/route');
      exit: typeof import('../app/api/v1/networks/[network]/exits/[address]/route');
      schema: typeof import('../app/api/v1/schema/route');
      runs: typeof import('../app/api/v1/runs/route');
      cancel: typeof import('../app/api/v1/runs/cancel/route');
    };
    let lib: {
      app: typeof import('../lib/db/app');
      runner: typeof import('../lib/query/runner');
      scheduler: typeof import('../lib/query/scheduler');
      password: typeof import('../lib/auth/password');
    };

    const networks = (withUnsafe = false) =>
      JSON.stringify([
        { id: 'jura', label: 'Jura', databaseUrl: databases.readOnly.jura },
        { id: 'dev', label: 'Dev', databaseUrl: databases.readOnly.dev },
        ...(withUnsafe
          ? [{ id: 'unsafe', label: 'Unsafe', databaseUrl: databases.writable }]
          : []),
      ]);

    const adhoc = (sql: string, extra: Record<string, unknown> = {}) =>
      routes.adhoc.POST(
        request('POST', '/api/v1/run', { cookie, body: { sql, ...extra } }),
        undefined,
      );

    before(async () => {
      databases = await createTestDatabases();
      lib = {
        app: await import('../lib/db/app'),
        runner: await import('../lib/query/runner'),
        scheduler: await import('../lib/query/scheduler'),
        password: await import('../lib/auth/password'),
      };
      process.env.APP_DATABASE_URL = databases.appUrl;
      process.env.NETWORKS = networks();
      process.env.ARRAKIS_EDITOR_PASSWORD_HASH =
        await lib.password.hashPassword(PASSWORD);
      delete process.env.EXITS;
      routes = {
        login: await import('../app/api/v1/auth/login/route'),
        logout: await import('../app/api/v1/auth/logout/route'),
        session: await import('../app/api/v1/auth/session/route'),
        queries: await import('../app/api/v1/queries/route'),
        query: await import('../app/api/v1/queries/[slug]/route'),
        versions: await import('../app/api/v1/queries/[slug]/versions/route'),
        fork: await import('../app/api/v1/queries/[slug]/fork/route'),
        run: await import('../app/api/v1/queries/[slug]/run/route'),
        results: await import('../app/api/v1/queries/[slug]/results/route'),
        adhoc: await import('../app/api/v1/run/route'),
        exits: await import('../app/api/v1/networks/[network]/exits/route'),
        exit: await import('../app/api/v1/networks/[network]/exits/[address]/route'),
        schema: await import('../app/api/v1/schema/route'),
        runs: await import('../app/api/v1/runs/route'),
        cancel: await import('../app/api/v1/runs/cancel/route'),
      };
    });

    after(async () => {
      await lib?.scheduler.releaseLeadership();
      await lib?.runner.closeQueryPools();
      await lib?.app.closeAppDb();
    });

    describe('authentication', () => {
      it('reports no session before login', async () => {
        const response = await routes.session.GET(
          request('GET', '/api/v1/auth/session'),
          undefined,
        );
        assert.deepEqual(await body(response), { user: null });
      });

      it('refuses a wrong password', async () => {
        const response = await routes.login.POST(
          request('POST', '/api/v1/auth/login', { body: { password: 'nope' } }),
          undefined,
        );
        assert.equal(response.status, 401);
      });

      it('opens a session with the right password', async () => {
        const response = await routes.login.POST(
          request('POST', '/api/v1/auth/login', {
            body: { password: PASSWORD },
          }),
          undefined,
        );
        assert.equal(response.status, 200);
        const setCookie = response.headers.get('set-cookie') ?? '';
        assert.match(setCookie, /HttpOnly/);
        assert.match(setCookie, /SameSite=Strict/);
        cookie = cookieFrom(response);
        const session = await routes.session.GET(
          request('GET', '/api/v1/auth/session', { cookie }),
          undefined,
        );
        assert.deepEqual((await body(session)).user, {
          username: 'editor',
          role: 'admin',
        });
      });

      it('requires a session to write, and refuses cross-origin writes', async () => {
        const anonymous = await routes.queries.POST(
          request('POST', '/api/v1/queries', {
            body: { slug: 'x', title: 'x', sql: 'SELECT 1' },
          }),
          undefined,
        );
        assert.equal(anonymous.status, 401);
        const crossSite = await routes.queries.POST(
          request('POST', '/api/v1/queries', {
            cookie,
            origin: 'https://evil.example',
            body: { slug: 'x', title: 'x', sql: 'SELECT 1' },
          }),
          undefined,
        );
        assert.equal(crossSite.status, 403);
      });

      it('throttles repeated failures from one address', async () => {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          await routes.login.POST(
            request('POST', '/api/v1/auth/login', {
              body: { password: 'x' },
              ip: '198.51.100.9',
            }),
            undefined,
          );
        }
        const blocked = await routes.login.POST(
          request('POST', '/api/v1/auth/login', {
            body: { password: PASSWORD },
            ip: '198.51.100.9',
          }),
          undefined,
        );
        assert.equal(blocked.status, 429);
        assert.ok(blocked.headers.get('retry-after'));
      });
    });

    describe('ad-hoc runs', () => {
      it('stacks networks under a network column', async () => {
        const response = await adhoc(
          'SELECT count(*) AS accounts FROM account',
          { network: 'all' },
        );
        assert.equal(response.status, 200);
        const result = await body(response);
        assert.deepEqual(
          (result.columns as Array<{ name: string }>).map(
            (column) => column.name,
          ),
          ['network', 'accounts'],
        );
        assert.deepEqual(result.rows, [
          ['jura', '25'],
          ['dev', '25'],
        ]);
      });

      it('decodes bytes to hex and keeps bigints exact', async () => {
        const response = await adhoc(
          'SELECT chain_key, published_block, 9007199254740993::bigint AS big FROM account ORDER BY id LIMIT 1',
          { network: 'jura' },
        );
        const result = await body(response);
        assert.deepEqual(result.rows, [
          [`0x${'01'.padStart(40, '0')}`, '39001000', '9007199254740993'],
        ]);
      });

      it('caps rows and says so', async () => {
        const result = await body(
          await adhoc('SELECT generate_series(1, 10005) AS n', {
            network: 'jura',
          }),
        );
        assert.equal((result.rows as unknown[]).length, 10_000);
        assert.equal(result.truncated, true);
      });

      it('interpolates block_time() and reports the timebase', async () => {
        const result = await body(
          await adhoc(
            `SELECT published_block, {{block_time(published_block)}} AS at
           FROM account ORDER BY published_block`,
            { network: 'jura' },
          ),
        );
        const rows = result.rows as Array<[string, string]>;
        const times = rows.map(([, at]) => Date.parse(at));
        assert.ok(
          times.every((time, index) => index === 0 || time > times[index - 1]),
        );
        // 1,000 blocks apart at five seconds a block.
        assert.equal((times[1] - times[0]) / 1000, 5_000);
        assert.equal(
          (result.networks as Array<{ timebase: string }>)[0].timebase,
          'estimated',
        );
      });

      it('binds declared parameters', async () => {
        const result = await body(
          await adhoc(
            'SELECT count(*) FROM account WHERE published_block > {{after}}',
            {
              network: 'jura',
              parameters: [{ name: 'after', type: 'integer' }],
              values: { after: 39020000 },
            },
          ),
        );
        assert.deepEqual(result.rows, [['5']]);
      });

      it('rejects writes even when written as a CTE', async () => {
        const response = await adhoc(
          'WITH gone AS (DELETE FROM log RETURNING *) SELECT * FROM gone',
          {
            network: 'jura',
          },
        );
        assert.equal(response.status, 400);
      });

      it('stops a query at the time limit', async () => {
        process.env.ARRAKIS_QUERY_TIMEOUT_MS = '500';
        try {
          const response = await adhoc('SELECT pg_sleep(3)', {
            network: 'jura',
          });
          assert.equal(response.status, 408);
        } finally {
          delete process.env.ARRAKIS_QUERY_TIMEOUT_MS;
        }
      });

      it("stops at the query's own time limit, over the default", async () => {
        const started = Date.now();
        const response = await adhoc('SELECT pg_sleep(3)', {
          network: 'jura',
          timeoutSeconds: 1,
        });
        assert.equal(response.status, 408);
        assert.equal((await body(response)).timedOut, true);
        assert.ok(Date.now() - started < 2_900);
      });

      it('lists a run in progress, and cancels it by its key', async () => {
        const runKey = 'test-run-key-1';
        const running = adhoc('SELECT pg_sleep(10)', {
          network: 'jura',
          runKey,
        });
        // Wait for the run to be listed: it is, once it holds a connection.
        let listed: Array<{ kind: string; startedBy: string }> = [];
        for (let attempt = 0; attempt < 50 && !listed.length; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          listed = (
            (await body(
              await routes.runs.GET(
                request('GET', '/api/v1/runs', { cookie }),
                undefined,
              ),
            )) as { runs: typeof listed }
          ).runs;
        }
        assert.equal(listed.length, 1);
        assert.equal(listed[0].kind, 'preview');
        assert.equal(listed[0].startedBy, 'editor');

        const started = Date.now();
        const cancel = await routes.cancel.POST(
          request('POST', '/api/v1/runs/cancel', {
            cookie,
            body: { runKey },
          }),
          undefined,
        );
        assert.equal((await body(cancel)).cancelled, 1);
        const response = await running;
        assert.equal(response.status, 409);
        assert.equal((await body(response)).cancelled, true);
        assert.ok(Date.now() - started < 3_000);
        // And it is no longer listed.
        const after = (await body(
          await routes.runs.GET(
            request('GET', '/api/v1/runs', { cookie }),
            undefined,
          ),
        )) as { runs: unknown[] };
        assert.equal(after.runs.length, 0);
      });

      it('needs an editor to list or cancel runs', async () => {
        const list = await routes.runs.GET(
          request('GET', '/api/v1/runs'),
          undefined,
        );
        assert.equal(list.status, 401);
        const cancel = await routes.cancel.POST(
          request('POST', '/api/v1/runs/cancel', { body: { query: 'x' } }),
          undefined,
        );
        assert.equal(cancel.status, 401);
      });

      it('explains a query instead of running it', async () => {
        const plan = await adhoc('SELECT 1 AS one', {
          network: 'jura',
          explain: 'plan',
        });
        assert.equal(plan.status, 200);
        const planned = (await body(plan)) as {
          columns: Array<{ name: string }>;
          rows: string[][];
        };
        assert.deepEqual(
          planned.columns.map((column) => column.name),
          ['QUERY PLAN'],
        );
        assert.ok(planned.rows.length > 0);
        assert.ok(!planned.rows.flat().join('\n').includes('actual time'));

        const measured = (await body(
          await adhoc('SELECT 1 AS one', {
            network: 'jura',
            explain: 'analyze',
          }),
        )) as { rows: string[][] };
        assert.ok(measured.rows.flat().join('\n').includes('actual time'));

        // Only a query can be explained, and still only read.
        const write = await adhoc('DELETE FROM account', {
          network: 'jura',
          explain: 'analyze',
        });
        assert.ok(write.status >= 400);
      });

      it('refuses a network whose role can write', async () => {
        process.env.NETWORKS = networks(true);
        try {
          const response = await adhoc('SELECT 1', { network: 'unsafe' });
          assert.equal(response.status, 503);
          assert.match(
            String((await body(response)).error),
            /can write to public\.log/,
          );

          // Even with the check overridden, the transaction stays read-only.
          process.env.ARRAKIS_UNSAFE_ALLOW_WRITABLE_ROLE = '1';
          const write = await adhoc(
            "SELECT * FROM (SELECT 1) AS x WHERE (SELECT set_config('transaction_read_only', 'off', true)) IS NULL",
            { network: 'unsafe' },
          );
          assert.equal(write.status, 400);
        } finally {
          delete process.env.ARRAKIS_UNSAFE_ALLOW_WRITABLE_ROLE;
          process.env.NETWORKS = networks();
        }
      });

      it('leaves no session state behind on the pooled connection', async () => {
        process.env.ARRAKIS_QUERY_CONCURRENCY = '1';
        try {
          await adhoc(
            "SELECT pg_advisory_lock(42), set_config('application_name', 'tampered', false)",
            { network: 'dev' },
          );
          const result = await body(
            await adhoc(
              `SELECT current_setting('application_name'),
                      (SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid())`,
              { network: 'dev' },
            ),
          );
          assert.deepEqual(result.rows, [['arrakis-query', '0']]);
        } finally {
          delete process.env.ARRAKIS_QUERY_CONCURRENCY;
        }
      });

      it('lists the schema for the editor', async () => {
        const response = await routes.schema.GET(
          request('GET', '/api/v1/schema?network=jura', { cookie }),
          undefined,
        );
        const { tables } = (await body(response)) as {
          tables: Array<{ name: string; columns: Array<{ name: string }> }>;
        };
        const channelState = tables.find(
          (table) => table.name === 'channel_state',
        );
        assert.ok(
          channelState?.columns.some(
            (column) => column.name === 'ticket_index',
          ),
        );
      });
    });

    describe('saved queries, results and exits', () => {
      const create = (input: Record<string, unknown>) =>
        routes.queries.POST(
          request('POST', '/api/v1/queries', { cookie, body: input }),
          undefined,
        );
      const results = (slug: string, search = '', withCookie = false) =>
        routes.results.GET(
          request(
            'GET',
            `/api/v1/queries/${slug}/results${search}`,
            withCookie ? { cookie } : {},
          ),
          context({ slug }),
        );
      const run = (slug: string, network = 'all') =>
        routes.run.POST(
          request('POST', `/api/v1/queries/${slug}/run`, {
            cookie,
            body: { network },
          }),
          context({ slug }),
        );

      it('stores the dashboard redemption query, with exits as a system parameter', async () => {
        const original = await readFile(
          path.join(root, 'sql', 'v1', 'redemptions.sql'),
          'utf8',
        );
        const sql = original.replaceAll('$1::bytea[]', '{{exits}}');
        const response = await create({
          slug: 'client-redemptions',
          title: 'Client redemptions',
          visibility: 'public',
          refreshSeconds: 3600,
          sql,
        });
        assert.equal(response.status, 201);
        const { query } = (await body(response)) as {
          query: { current: { version: number } };
        };
        assert.equal(query.current.version, 1);
      });

      it('reports a never-run result as pending, and never runs it on read', async () => {
        const page = await body(await results('client-redemptions'));
        assert.deepEqual(
          (page.networks as Array<{ status: string }>).map(
            (network) => network.status,
          ),
          ['pending', 'pending'],
        );
        assert.deepEqual(page.rows, []);
      });

      it('materializes on every network and serves the stored rows publicly', async () => {
        const response = await run('client-redemptions');
        assert.equal(response.status, 200);
        const { runs } = (await body(response)) as {
          runs: Array<{ status: string; rowCount: number }>;
        };
        // No exits configured: every redemption paid to an announced node comes
        // back — 20 clients, 2 exits × 3 relays and 2 probing relays, nine each.
        assert.deepEqual(
          runs.map((entry) => [entry.status, entry.rowCount]),
          [
            ['succeeded', 252],
            ['succeeded', 253],
          ],
        );
        const page = await body(
          await results('client-redemptions', '?limit=50000'),
        );
        assert.equal((page.rows as unknown[]).length, 505);
        assert.deepEqual(
          (page.columns as Array<{ name: string }>).map(
            (column) => column.name,
          ),
          [
            'network',
            'source',
            'destination',
            'source_announced',
            'published_block',
            'tickets',
          ],
        );
        const first = (page.rows as unknown[][])[0];
        assert.equal(first[0], 'jura');
        assert.match(String(first[1]), /^0x[0-9a-f]{40}$/);
      });

      it("keeps no more rows than the query's own cap", async () => {
        const patched = await routes.query.PATCH(
          request('PATCH', '/api/v1/queries/client-redemptions', {
            cookie,
            body: { rowLimit: 10, timeoutSeconds: 60 },
          }),
          context({ slug: 'client-redemptions' }),
        );
        assert.equal(patched.status, 200);
        const record = (await body(patched)).query as {
          rowLimit: number;
          timeoutSeconds: number;
        };
        assert.equal(record.rowLimit, 10);
        assert.equal(record.timeoutSeconds, 60);
        const response = await run('client-redemptions');
        const { runs } = (await body(response)) as {
          runs: Array<{ rowCount: number; truncated: boolean }>;
        };
        assert.deepEqual(
          runs.map((entry) => [entry.rowCount, entry.truncated]),
          [
            [10, true],
            [10, true],
          ],
        );
        // Back to the defaults, and the full result, for the tests after.
        await routes.query.PATCH(
          request('PATCH', '/api/v1/queries/client-redemptions', {
            cookie,
            body: { rowLimit: null, timeoutSeconds: null },
          }),
          context({ slug: 'client-redemptions' }),
        );
        await run('client-redemptions');
        const bad = await routes.query.PATCH(
          request('PATCH', '/api/v1/queries/client-redemptions', {
            cookie,
            body: { timeoutSeconds: 0 },
          }),
          context({ slug: 'client-redemptions' }),
        );
        assert.equal(bad.status, 400);
      });

      it('pages through one network', async () => {
        const page = await body(
          await results(
            'client-redemptions',
            '?network=dev&limit=10&offset=250',
          ),
        );
        assert.equal((page.rows as unknown[]).length, 3);
        assert.equal(
          (page.columns as Array<{ name: string }>)[0].name,
          'source',
        );
      });

      it('configures exits per network and warns about an unannounced one', async () => {
        const add = (address: string) =>
          routes.exits.POST(
            request('POST', '/api/v1/networks/jura/exits', {
              cookie,
              body: { address, label: 'exit' },
            }),
            context({ network: 'jura' }),
          );
        const first = await add(EXIT_A);
        assert.equal(first.status, 201);
        assert.equal((await body(first)).warning, null);
        assert.equal((await add(EXIT_B)).status, 201);
        assert.equal((await add(EXIT_B)).status, 409);

        const unannounced = await body(await add(CLIENT));
        assert.match(String(unannounced.warning), /never announced/);
        const removed = await routes.exit.DELETE(
          request('DELETE', `/api/v1/networks/jura/exits/${CLIENT}`, {
            cookie,
          }),
          context({ network: 'jura', address: CLIENT }),
        );
        assert.equal(removed.status, 200);

        const listed = await body(
          await routes.exits.GET(
            request('GET', '/api/v1/networks/jura/exits'),
            context({ network: 'jura' }),
          ),
        );
        assert.deepEqual(
          (listed.exits as Array<{ address: string }>).map(
            (exit) => exit.address,
          ),
          [EXIT_A, EXIT_B],
        );
      });

      it('marks results built on the old exit set stale, and the scheduler reruns them', async () => {
        const before = await body(await results('client-redemptions'));
        assert.deepEqual(
          (before.networks as Array<{ id: string; stale: boolean }>).map(
            (network) => [network.id, network.stale],
          ),
          [
            ['jura', true],
            ['dev', false],
          ],
        );

        await lib.scheduler.runSchedulerOnce();

        const after = await body(
          await results('client-redemptions', '?network=jura&limit=50000'),
        );
        const status = (
          after.networks as Array<{
            stale: boolean;
            rowCount: number;
            lastAttempt: { status: string };
          }>
        )[0];
        assert.equal(status.stale, false);
        assert.equal(status.lastAttempt.status, 'succeeded');
        // With the exits named, probing between relays is left in the database:
        // only the 180 client and 54 exit redemptions remain.
        assert.equal(status.rowCount, 234);
      });

      it('versions SQL immutably', async () => {
        const save = (sql: string) =>
          routes.versions.POST(
            request('POST', '/api/v1/queries/accounts/versions', {
              cookie,
              body: { sql, note: 'v' },
            }),
            context({ slug: 'accounts' }),
          );
        assert.equal(
          (
            await create({
              slug: 'accounts',
              title: 'Accounts',
              sql: 'SELECT count(*) FROM account',
            })
          ).status,
          201,
        );
        assert.equal(
          (await save('SELECT count(*) AS n FROM account')).status,
          201,
        );
        // Identical SQL is not a new version.
        await save('SELECT count(*) AS n FROM account');
        const listed = await body(
          await routes.versions.GET(
            request('GET', '/api/v1/queries/accounts/versions', { cookie }),
            context({ slug: 'accounts' }),
          ),
        );
        assert.deepEqual(
          (listed.versions as Array<{ version: number }>).map(
            (version) => version.version,
          ),
          [2, 1],
        );
        const db = await lib.app.appDb();
        await assert.rejects(
          db.query("UPDATE query_versions SET sql = 'SELECT 2'"),
          /immutable/,
        );
      });

      it('hides private queries from readers', async () => {
        const anonymous = await routes.query.GET(
          request('GET', '/api/v1/queries/accounts'),
          context({ slug: 'accounts' }),
        );
        assert.equal(anonymous.status, 404);
        const list = await body(
          await routes.queries.GET(
            request('GET', '/api/v1/queries'),
            undefined,
          ),
        );
        assert.deepEqual(
          (list.queries as Array<{ slug: string }>).map((query) => query.slug),
          ['client-redemptions'],
        );
        const privateResults = await results('accounts');
        assert.equal(privateResults.status, 404);
      });

      it('builds on fragments, and a fragment change makes dependents stale', async () => {
        const fragment = await create({
          slug: 'clients',
          title: 'Clients',
          kind: 'fragment',
          sql: `SELECT account.id, account.chain_key FROM account
              WHERE NOT EXISTS (SELECT 1 FROM announcement WHERE announcement.account_id = account.id)`,
        });
        assert.equal(fragment.status, 201);
        const created = await create({
          slug: 'client-count',
          title: 'Client count',
          visibility: 'unlisted',
          combine: 'hidden',
          sql: 'SELECT count(*) AS clients FROM {{> clients}} AS c',
        });
        assert.equal(created.status, 201);
        const runs = (await body(await run('client-count', 'jura')))
          .runs as Array<{ rowCount: number }>;
        assert.equal(runs[0].rowCount, 1);
        const page = await body(await results('client-count', '?network=jura'));
        assert.deepEqual(page.rows, [['20']]);

        // Unlisted: readable by link, but no combined view across networks.
        assert.equal(
          (await results('client-count', '?network=all')).status,
          404,
        );

        await routes.versions.POST(
          request('POST', '/api/v1/queries/clients/versions', {
            cookie,
            body: {
              sql: `SELECT account.id FROM account
                  WHERE NOT EXISTS (SELECT 1 FROM announcement WHERE announcement.account_id = account.id)
                    AND account.published_block > 39010000`,
            },
          }),
          context({ slug: 'clients' }),
        );
        const stale = await body(
          await results('client-count', '?network=jura'),
        );
        assert.equal(
          (stale.networks as Array<{ stale: boolean }>)[0].stale,
          true,
        );
        // The stored rows keep serving until the rerun replaces them.
        assert.deepEqual(stale.rows, [['20']]);
      });

      it('rejects templates that cannot compile before storing them', async () => {
        const bad = await create({
          slug: 'bad',
          title: 'Bad',
          sql: 'SELECT * FROM {{> missing}} x',
        });
        assert.equal(bad.status, 400);
        const cycle = await routes.versions.POST(
          request('POST', '/api/v1/queries/clients/versions', {
            cookie,
            body: { sql: 'SELECT * FROM {{> clients}} AS again' },
          }),
          context({ slug: 'clients' }),
        );
        assert.equal(cycle.status, 400);
      });

      it('forks into a private copy', async () => {
        const response = await routes.fork.POST(
          request('POST', '/api/v1/queries/client-redemptions/fork', {
            cookie,
            body: { slug: 'my-redemptions' },
          }),
          context({ slug: 'client-redemptions' }),
        );
        assert.equal(response.status, 201);
        const { query } = (await body(response)) as {
          query: {
            visibility: string;
            forkedFrom: string;
            refreshSeconds: number | null;
          };
        };
        assert.equal(query.visibility, 'private');
        assert.equal(query.forkedFrom, 'client-redemptions');
        assert.equal(query.refreshSeconds, null);
      });

      it('keeps one previous result table and no more', async () => {
        await run('accounts', 'jura');
        await run('accounts', 'jura');
        await run('accounts', 'jura');
        const db = await lib.app.appDb();
        const { rows } = await db.query<{ tables: string }>(
          `SELECT count(*) AS tables FROM pg_tables
         WHERE schemaname = 'results'
           AND tablename IN (
             SELECT table_name FROM query_results r JOIN query_versions v ON v.id = r.query_version_id
             JOIN queries q ON q.id = v.query_id WHERE q.slug = 'accounts'
             UNION ALL
             SELECT previous_table_name FROM query_results r JOIN query_versions v ON v.id = r.query_version_id
             JOIN queries q ON q.id = v.query_id WHERE q.slug = 'accounts')`,
        );
        assert.equal(Number(rows[0].tables), 2);
        const { rows: all } = await db.query<{ n: string }>(
          "SELECT count(*) AS n FROM pg_tables WHERE schemaname = 'results'",
        );
        // client-redemptions ×2 networks (+1 previous on each), client-count,
        // accounts (+1 previous).
        assert.equal(Number(all[0].n), 7);
      });

      it('stores and serves dates as dates, whatever the server time zone', async () => {
        const zone = process.env.TZ;
        process.env.TZ = 'Pacific/Kiritimati';
        try {
          await create({
            slug: 'dates',
            title: 'Dates',
            sql: `SELECT '2026-01-02'::date AS day,
                       '2026-01-02 03:04:05'::timestamp AS naive,
                       '2026-01-02 03:04:05+00'::timestamptz AS aware,
                       '{1,2}'::int[] AS list`,
          });
          await run('dates', 'jura');
          const page = await body(
            await results('dates', '?network=jura', true),
          );
          assert.deepEqual(page.rows, [
            [
              '2026-01-02',
              '2026-01-02 03:04:05',
              '2026-01-02T03:04:05.000Z',
              [1, 2],
            ],
          ]);
        } finally {
          process.env.TZ = zone;
        }
      });

      it('archives instead of deleting', async () => {
        const response = await routes.query.DELETE(
          request('DELETE', '/api/v1/queries/accounts', { cookie }),
          context({ slug: 'accounts' }),
        );
        assert.equal(response.status, 200);
        const again = await routes.query.GET(
          request('GET', '/api/v1/queries/accounts', { cookie }),
          context({ slug: 'accounts' }),
        );
        assert.ok((await body(again)).query);
      });
    });

    describe('session end', () => {
      it('logs out', async () => {
        const response = await routes.logout.POST(
          request('POST', '/api/v1/auth/logout', { cookie }),
          undefined,
        );
        assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/);
        const session = await routes.session.GET(
          request('GET', '/api/v1/auth/session', { cookie }),
          undefined,
        );
        assert.equal((await body(session)).user, null);
      });

      it('disables the env account, and ends its sessions, when its hash is unset', async () => {
        const login = await routes.login.POST(
          request('POST', '/api/v1/auth/login', {
            body: { password: PASSWORD },
            ip: '192.0.2.1',
          }),
          undefined,
        );
        const fresh = cookieFrom(login);
        const hash = process.env.ARRAKIS_EDITOR_PASSWORD_HASH;
        delete process.env.ARRAKIS_EDITOR_PASSWORD_HASH;
        try {
          // What a restart does: the env account is re-synced.
          const { syncEnvUsers } = await import('../lib/auth/session');
          await syncEnvUsers();
          const check = await routes.session.GET(
            request('GET', '/api/v1/auth/session', { cookie: fresh }),
            undefined,
          );
          assert.equal((await body(check)).user, null);
          const again = await routes.login.POST(
            request('POST', '/api/v1/auth/login', {
              body: { password: PASSWORD },
              ip: '192.0.2.1',
            }),
            undefined,
          );
          assert.equal(again.status, 401);
        } finally {
          process.env.ARRAKIS_EDITOR_PASSWORD_HASH = hash;
        }
      });
    });
  },
);

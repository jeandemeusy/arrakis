/**
 * Builds throwaway databases for the integration tests.
 *
 * Needs a PostgreSQL superuser connection in TEST_ADMIN_DATABASE_URL; without
 * it the integration suites skip. It creates, from scratch on every run:
 *
 *   arrakis_t_app          the application database, owned by arrakis_t
 *   arrakis_t_charts       the role chart SQL logs in as, holding nothing
 *   arrakis_t_jura/_dev    two Blokli indexes loaded from fixtures/blokli.sql
 *   arrakis_t_ro           a role that can only SELECT them
 *   arrakis_t_rw           a role that can also INSERT into `log`
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

export const adminUrl = process.env.TEST_ADMIN_DATABASE_URL?.trim() || null;

function withDatabase(
  url: string,
  database: string,
  user?: string,
  password?: string,
): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (user) {
    parsed.username = user;
    parsed.password = password ?? '';
  }
  return parsed.toString();
}

async function admin<T>(
  url: string,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export type TestDatabases = {
  appUrl: string;
  /** The login hand-written chart SQL runs as: it may hold nothing else. */
  chartsUrl: string;
  readOnly: { jura: string; dev: string };
  writable: string;
};

/**
 * `prefix` names every database and role, so suites running in parallel
 * processes each get their own set.
 */
export async function createTestDatabases(
  prefix = 'arrakis_t',
): Promise<TestDatabases> {
  if (!adminUrl) throw new Error('TEST_ADMIN_DATABASE_URL is not set');
  const fixture = await readFile(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'blokli.sql',
    ),
    'utf8',
  );
  await admin(adminUrl, async (client) => {
    for (const database of [
      `${prefix}_app`,
      `${prefix}_jura`,
      `${prefix}_dev`,
    ]) {
      await client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    }
    for (const role of [
      prefix,
      `${prefix}_ro`,
      `${prefix}_rw`,
      `${prefix}_charts`,
    ]) {
      await client.query(`DROP ROLE IF EXISTS ${role}`);
    }
    await client.query(`CREATE ROLE ${prefix} LOGIN PASSWORD 'app'`);
    await client.query(
      `CREATE ROLE ${prefix}_charts LOGIN NOINHERIT PASSWORD 'charts'`,
    );
    await client.query(`CREATE ROLE ${prefix}_ro LOGIN PASSWORD 'ro'`);
    await client.query(`CREATE ROLE ${prefix}_rw LOGIN PASSWORD 'rw'`);
    await client.query(`CREATE DATABASE ${prefix}_app OWNER ${prefix}`);
    // The role SQL visualizations run as is cluster-wide and may already exist
    // from an earlier run; ADMIN on it is what lets the app's migration grant
    // it to itself, as a CREATEROLE app role would in production.
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arrakis_results_reader') THEN
          CREATE ROLE arrakis_results_reader NOLOGIN;
        END IF;
      END $$`);
    await client.query(
      `GRANT arrakis_results_reader TO ${prefix} WITH ADMIN OPTION`,
    );
    await client.query(`CREATE DATABASE ${prefix}_jura`);
    await client.query(`CREATE DATABASE ${prefix}_dev`);
  });
  for (const database of [`${prefix}_jura`, `${prefix}_dev`]) {
    await admin(withDatabase(adminUrl, database), async (client) => {
      await client.query(fixture);
      await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await client.query(
        'REVOKE CREATE, TEMPORARY ON DATABASE ' + database + ' FROM PUBLIC',
      );
      await client.query(
        'GRANT CONNECT ON DATABASE ' +
          database +
          ` TO ${prefix}_ro, ${prefix}_rw`,
      );
      await client.query(
        `GRANT USAGE ON SCHEMA public TO ${prefix}_ro, ${prefix}_rw`,
      );
      await client.query(
        `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${prefix}_ro, ${prefix}_rw`,
      );
      await client.query(`GRANT INSERT ON log TO ${prefix}_rw`);
    });
  }
  // The dev index differs from jura by one extra client redemption, so the two
  // networks' results can be told apart.
  await admin(withDatabase(adminUrl, `${prefix}_dev`), (client) =>
    client.query(`
      INSERT INTO channel_state (channel_id, published_block, published_tx_index,
        published_log_index, epoch, ticket_index, balance, status)
      VALUES (1, 39700000, 1, 0, 1, 1000, '\\x00', 1)`),
  );
  return {
    appUrl: withDatabase(adminUrl, `${prefix}_app`, prefix, 'app'),
    chartsUrl: withDatabase(
      adminUrl,
      `${prefix}_app`,
      `${prefix}_charts`,
      'charts',
    ),
    readOnly: {
      jura: withDatabase(adminUrl, `${prefix}_jura`, `${prefix}_ro`, 'ro'),
      dev: withDatabase(adminUrl, `${prefix}_dev`, `${prefix}_ro`, 'ro'),
    },
    writable: withDatabase(adminUrl, `${prefix}_jura`, `${prefix}_rw`, 'rw'),
  };
}

/** A Request as a browser on the same origin would send it. */
export function request(
  method: string,
  url: string,
  options: {
    body?: unknown;
    cookie?: string;
    origin?: string | null;
    ip?: string;
  } = {},
): Request {
  const headers = new Headers({ host: 'arrakis.test' });
  if (options.body !== undefined)
    headers.set('content-type', 'application/json');
  if (options.cookie) headers.set('cookie', options.cookie);
  if (options.origin !== null && method !== 'GET') {
    headers.set('origin', options.origin ?? 'https://arrakis.test');
  }
  headers.set('x-forwarded-for', options.ip ?? '203.0.113.7');
  return new Request(`https://arrakis.test${url}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

/** The `name=value` part of a Set-Cookie header, ready to send back. */
export function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  return header.split(';')[0];
}

export const context = <T extends Record<string, string>>(params: T) => ({
  params: Promise.resolve(params),
});

/**
 * An application database and two generated Blokli indexes shaped like live
 * networks (fixtures/blokli-demo.sql), with their exits listed: accounts 13
 * to 15 of each. For the parity check, which needs real volume to compare.
 */
export async function createDemoDatabases(
  prefix: string,
  networks: Array<{ id: string; seed: string; clients: number; head: number }>,
): Promise<{
  appUrl: string;
  networks: Array<{ id: string; url: string; exits: string[] }>;
}> {
  if (!adminUrl) throw new Error('TEST_ADMIN_DATABASE_URL is not set');
  const fixture = await readFile(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'blokli-demo.sql',
    ),
    'utf8',
  );
  const databases = networks.map((network) => `${prefix}_${network.id}`);
  await admin(adminUrl, async (client) => {
    for (const database of [`${prefix}_app`, ...databases]) {
      await client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    }
    for (const role of [prefix, `${prefix}_ro`]) {
      await client.query(`DROP ROLE IF EXISTS ${role}`);
    }
    await client.query(`CREATE ROLE ${prefix} LOGIN PASSWORD 'app'`);
    await client.query(`CREATE ROLE ${prefix}_ro LOGIN PASSWORD 'ro'`);
    await client.query(`CREATE DATABASE ${prefix}_app OWNER ${prefix}`);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arrakis_results_reader') THEN
          CREATE ROLE arrakis_results_reader NOLOGIN;
        END IF;
      END $$`);
    await client.query(
      `GRANT arrakis_results_reader TO ${prefix} WITH ADMIN OPTION`,
    );
    for (const database of databases) {
      await client.query(`CREATE DATABASE ${database}`);
    }
  });
  const out: Array<{ id: string; url: string; exits: string[] }> = [];
  for (const [index, network] of networks.entries()) {
    const database = databases[index];
    const exits = await admin(
      withDatabase(adminUrl, database),
      async (client) => {
        await client.query(`SET demo.seed = '${network.seed}'`);
        await client.query(`SET demo.clients = '${network.clients}'`);
        await client.query(`SET demo.head = '${network.head}'`);
        await client.query(fixture);
        await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
        await client.query(
          `REVOKE CREATE, TEMPORARY ON DATABASE ${database} FROM PUBLIC`,
        );
        await client.query(
          `GRANT CONNECT ON DATABASE ${database} TO ${prefix}_ro`,
        );
        await client.query(`GRANT USAGE ON SCHEMA public TO ${prefix}_ro`);
        await client.query(
          `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${prefix}_ro`,
        );
        const { rows } = await client.query<{ address: string }>(
          `SELECT '0x' || encode(chain_key, 'hex') AS address
         FROM account WHERE id BETWEEN 13 AND 15 ORDER BY id`,
        );
        return rows.map((row) => row.address);
      },
    );
    out.push({
      id: network.id,
      url: withDatabase(adminUrl, database, `${prefix}_ro`, 'ro'),
      exits,
    });
  }
  return {
    appUrl: withDatabase(adminUrl, `${prefix}_app`, prefix, 'app'),
    networks: out,
  };
}

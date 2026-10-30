/**
 * Builds throwaway databases for the integration tests.
 *
 * Needs a PostgreSQL superuser connection in TEST_ADMIN_DATABASE_URL; without
 * it the integration suites skip. It creates, from scratch on every run:
 *
 *   arrakis_t_app          the application database, owned by arrakis_t
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
  readOnly: { jura: string; dev: string };
  writable: string;
};

export async function createTestDatabases(): Promise<TestDatabases> {
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
      'arrakis_t_app',
      'arrakis_t_jura',
      'arrakis_t_dev',
    ]) {
      await client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    }
    for (const role of ['arrakis_t', 'arrakis_t_ro', 'arrakis_t_rw']) {
      await client.query(`DROP ROLE IF EXISTS ${role}`);
    }
    await client.query("CREATE ROLE arrakis_t LOGIN PASSWORD 'app'");
    await client.query("CREATE ROLE arrakis_t_ro LOGIN PASSWORD 'ro'");
    await client.query("CREATE ROLE arrakis_t_rw LOGIN PASSWORD 'rw'");
    await client.query('CREATE DATABASE arrakis_t_app OWNER arrakis_t');
    await client.query('CREATE DATABASE arrakis_t_jura');
    await client.query('CREATE DATABASE arrakis_t_dev');
  });
  for (const database of ['arrakis_t_jura', 'arrakis_t_dev']) {
    await admin(withDatabase(adminUrl, database), async (client) => {
      await client.query(fixture);
      await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await client.query(
        'REVOKE CREATE, TEMPORARY ON DATABASE ' + database + ' FROM PUBLIC',
      );
      await client.query(
        'GRANT CONNECT ON DATABASE ' +
          database +
          ' TO arrakis_t_ro, arrakis_t_rw',
      );
      await client.query(
        'GRANT USAGE ON SCHEMA public TO arrakis_t_ro, arrakis_t_rw',
      );
      await client.query(
        'GRANT SELECT ON ALL TABLES IN SCHEMA public TO arrakis_t_ro, arrakis_t_rw',
      );
      await client.query('GRANT INSERT ON log TO arrakis_t_rw');
    });
  }
  // The dev index differs from jura by one extra client redemption, so the two
  // networks' results can be told apart.
  await admin(withDatabase(adminUrl, 'arrakis_t_dev'), (client) =>
    client.query(`
      INSERT INTO channel_state (channel_id, published_block, published_tx_index,
        published_log_index, epoch, ticket_index, balance, status)
      VALUES (1, 39700000, 1, 0, 1, 1000, '\\x00', 1)`),
  );
  return {
    appUrl: withDatabase(adminUrl, 'arrakis_t_app', 'arrakis_t', 'app'),
    readOnly: {
      jura: withDatabase(adminUrl, 'arrakis_t_jura', 'arrakis_t_ro', 'ro'),
      dev: withDatabase(adminUrl, 'arrakis_t_dev', 'arrakis_t_ro', 'ro'),
    },
    writable: withDatabase(adminUrl, 'arrakis_t_jura', 'arrakis_t_rw', 'rw'),
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

import 'server-only';

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';

import { HttpError } from '../api/errors';

/**
 * The application's own database: saved queries, users, sessions, exits and
 * materialized results.
 *
 * Configured with APP_DATABASE_URL. It is deliberately separate from every
 * Blokli database — those are only ever read, through a read-only role, while
 * this one is the only place Arrakis writes.
 *
 * Migrations run lazily, once per process, before the first query is handed a
 * pool, and under an advisory lock so two replicas starting together do not
 * apply the same migration twice.
 */

const MIGRATION_LOCK = 0x61_72_72_61; // 'arra'

let pool: Pool | undefined;
let ready: Promise<Pool> | undefined;

export function appDatabaseConfigured(): boolean {
  return Boolean(process.env.APP_DATABASE_URL?.trim());
}

function migrationsDirectory(): string {
  return path.join(process.cwd(), 'db', 'migrations');
}

async function migrate(target: Pool): Promise<void> {
  const client = await target.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = new Set(
      (
        await client.query<{ version: string }>(
          'SELECT version FROM schema_migrations',
        )
      ).rows.map((row) => row.version),
    );
    const files = (await readdir(migrationsDirectory()))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;
      const sql = await readFile(
        path.join(migrationsDirectory(), file),
        'utf8',
      );
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)',
          [version],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${version} failed: ${(error as Error).message}`,
          { cause: error },
        );
      }
    }
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK])
      .catch(() => undefined);
    client.release();
  }
}

/**
 * The migrated application database.
 *
 * Throws a 503 when it is not configured, so every route built on it degrades
 * the same way rather than each inventing its own message. A failed migration
 * is not cached: the next call tries again, which is what a database that was
 * briefly unreachable at boot needs.
 */
export function appDb(): Promise<Pool> {
  const url = process.env.APP_DATABASE_URL?.trim();
  if (!url) {
    return Promise.reject(
      new HttpError(503, 'Query storage is not configured (APP_DATABASE_URL).'),
    );
  }
  if (!ready) {
    pool ??= new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
    const target = pool;
    ready = migrate(target).then(
      () => target,
      (error: unknown) => {
        ready = undefined;
        throw error;
      },
    );
  }
  return ready;
}

/** Runs `work` in one transaction, rolling back on any error. */
export async function transaction<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await (await appDb()).connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Closes the pool. Tests only: a server keeps it for its whole life. */
export async function closeAppDb(): Promise<void> {
  const current = pool;
  pool = undefined;
  ready = undefined;
  await current?.end();
}

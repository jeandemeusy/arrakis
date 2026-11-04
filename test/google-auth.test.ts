import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import { Client } from 'pg';

import { adminUrl, cookieFrom, createTestDatabases, request } from './support';
import { mockGoogle } from './google';

describe(
  'Google Workspace authentication',
  { skip: !adminUrl && 'TEST_ADMIN_DATABASE_URL not set' },
  () => {
    let google: ReturnType<typeof mockGoogle>;
    let app: typeof import('../lib/db/app');
    let session: typeof import('../app/api/v1/auth/session/route');
    let login: typeof import('../app/api/v1/auth/login/route');
    const errorOf = (response: Response) =>
      new URL(response.headers.get('location')!).searchParams.get('error');
    const userOf = async (cookie: string) => {
      const response = await session.GET(
        request('GET', '/api/v1/auth/session', { cookie }),
        undefined,
      );
      return (await response.json()).user;
    };

    before(async () => {
      const databases = await createTestDatabases('arrakis_auth');
      process.env.APP_DATABASE_URL = databases.appUrl;
      google = mockGoogle();
      // An actual password-era database, with authored content and a live session.
      const db = new Client({ connectionString: databases.appUrl });
      await db.connect();
      try {
        await db.query(
          await readFile(
            new URL('../db/migrations/0001_query_store.sql', import.meta.url),
            'utf8',
          ),
        );
        await db.query(`CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
        INSERT INTO schema_migrations (version) VALUES ('0001_query_store');
        INSERT INTO users (username, password_hash, role, managed_by_env) VALUES ('editor', 'legacy-hash', 'admin', TRUE);
        INSERT INTO queries (slug, title, created_by) SELECT 'legacy', 'Historical query', id FROM users WHERE username = 'editor';`);
        await db.query(
          `INSERT INTO sessions (token_hash, user_id, expires_at)
        SELECT $1, id, now() + interval '12 hours' FROM users WHERE username = 'editor'`,
          [createHash('sha256').update('legacy-token').digest()],
        );
      } finally {
        await db.end();
      }
      app = await import('../lib/db/app');
      session = await import('../app/api/v1/auth/session/route');
      login = await import('../app/api/v1/auth/login/route');
      await app.appDb();
    });

    after(async () => {
      google?.restore();
      await app?.closeAppDb();
    });

    it('invalidates password-era sessions while retaining disabled users and their authorship', async () => {
      assert.equal(await userOf('arrakis_session=legacy-token'), null);
      const { rows } = await (
        await app.appDb()
      ).query(`SELECT users.username, users.disabled_at, queries.title
      FROM queries JOIN users ON users.id = queries.created_by WHERE queries.slug = 'legacy'`);
      assert.equal(rows[0].username, 'editor');
      assert.ok(rows[0].disabled_at);
      assert.equal(rows[0].title, 'Historical query');
      assert.equal(
        (await (await app.appDb()).query('SELECT count(*) FROM sessions'))
          .rows[0].count,
        '0',
      );
    });

    it('uses a browser-bound PKCE redirect and secure production cookies', async () => {
      const previous = process.env.NODE_ENV;
      Object.assign(process.env, { NODE_ENV: 'production' });
      try {
        const attempt = await google.begin('/queries/new?tab=sql');
        assert.equal(
          attempt.authorization.origin,
          'https://accounts.google.com',
        );
        assert.equal(
          attempt.authorization.searchParams.get('hd'),
          'hoprnet.org',
        );
        assert.equal(
          attempt.authorization.searchParams.get('scope'),
          'openid email',
        );
        assert.equal(
          attempt.authorization.searchParams.get('code_challenge_method'),
          'S256',
        );
        assert.equal(
          attempt.authorization.searchParams.get('redirect_uri'),
          'https://arrakis.test/api/v1/auth/callback',
        );
        assert.match(
          attempt.response.headers.get('set-cookie')!,
          /^__Host-arrakis_oauth=.*HttpOnly; SameSite=Lax; Max-Age=600; Secure$/,
        );
        const response = await google.complete(attempt);
        assert.equal(
          response.headers.get('location'),
          'https://arrakis.test/queries/new?tab=sql',
        );
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const cookies = response.headers.getSetCookie();
        assert.match(
          cookies[0],
          /^__Host-arrakis_session=.*HttpOnly; SameSite=Strict; Expires=.*; Secure$/,
        );
        assert.match(cookies[1], /__Host-arrakis_oauth=;.*Max-Age=0; Secure$/);
        assert.deepEqual(await userOf(cookieFrom(response)), {
          username: 'jean@hoprnet.org',
          role: 'editor',
        });
      } finally {
        if (previous === undefined)
          Reflect.deleteProperty(process.env, 'NODE_ENV');
        else Object.assign(process.env, { NODE_ENV: previous });
      }
    });

    it('rejects other organizations, consumer accounts and email-only lookalikes', async () => {
      const db = await app.appDb();
      const count = (await db.query('SELECT count(*) FROM sessions')).rows[0]
        .count;
      for (const claims of [
        { hd: 'other.org' },
        { hd: 'sub.hoprnet.org' },
        { hd: 'hoprnet.org.evil.test' },
        { hd: undefined },
        { email_verified: false },
        { email: undefined },
      ]) {
        const response = await google.complete(await google.begin(), {
          claims,
        });
        assert.equal(
          errorOf(response),
          'access_denied',
          JSON.stringify(claims),
        );
        assert.equal(await userOf(cookieFrom(response)), null);
      }
      assert.equal(
        (await db.query('SELECT count(*) FROM sessions')).rows[0].count,
        count,
      );
    });

    it('verifies token signature, issuer, audience, expiry, nonce and state', async () => {
      const db = await app.appDb();
      const count = (await db.query('SELECT count(*) FROM sessions')).rows[0]
        .count;
      for (const options of [
        { claims: { aud: 'another-client' } },
        { claims: { iss: 'https://evil.test' } },
        { claims: { exp: Math.floor(Date.now() / 1000) - 3600 } },
        { claims: { nonce: 'wrong' } },
        { badSignature: true },
        { noIdToken: true },
      ]) {
        const response = await google.complete(await google.begin(), options);
        assert.equal(
          errorOf(response),
          'login_failed',
          JSON.stringify(options),
        );
      }
      const wrongState = await google.complete(
        await google.begin(),
        {},
        { state: 'wrong' },
      );
      assert.equal(errorOf(wrongState), 'login_failed');
      assert.equal(
        (await db.query('SELECT count(*) FROM sessions')).rows[0].count,
        count,
      );
    });

    it('consumes callbacks once across concurrent requests and rejects missing or expired transactions', async () => {
      const attempt = await google.begin();
      const results = await Promise.all([
        google.complete(attempt),
        google.complete(attempt),
      ]);
      assert.equal(
        results.filter(
          (result) =>
            result.headers.get('location') === 'https://arrakis.test/',
        ).length,
        1,
      );
      assert.equal(
        errorOf(
          await google.complete({ ...(await google.begin()), cookie: '' }),
        ),
        'login_failed',
      );
      const cancelled = await google.complete(
        await google.begin(),
        {},
        { error: 'access_denied' },
      );
      assert.equal(errorOf(cancelled), 'login_failed');
      const expired = await google.begin();
      await (
        await app.appDb()
      ).query(
        "UPDATE oauth_transactions SET expires_at = now() - interval '1 second'",
      );
      assert.equal(errorOf(await google.complete(expired)), 'login_failed');
      assert.equal(errorOf(await google.complete(attempt)), 'login_failed');
    });

    it('rejects external return URLs including normalized paths and backslashes', async () => {
      for (const target of [
        'https://evil.test',
        '//evil.test',
        '/\\evil.test',
        '/a/..//evil.test',
        '/%2e%2e//evil.test',
        '/\t/evil.test',
      ]) {
        const response = await google.complete(await google.begin(target));
        assert.equal(response.headers.get('location'), 'https://arrakis.test/');
      }
    });

    it('fails closed without valid Workspace, client credentials and a canonical HTTPS origin', async () => {
      for (const [key, invalid] of [
        ['ARRAKIS_GOOGLE_WORKSPACE_DOMAIN', ''],
        ['ARRAKIS_GOOGLE_WORKSPACE_DOMAIN', '*'],
        ['ARRAKIS_GOOGLE_CLIENT_ID', ''],
        ['ARRAKIS_GOOGLE_CLIENT_SECRET', ''],
        ['ARRAKIS_PUBLIC_ORIGIN', 'https://arrakis.test/path'],
        ['ARRAKIS_PUBLIC_ORIGIN', 'http://evil.test'],
      ]) {
        const saved = process.env[key];
        try {
          process.env[key] = invalid;
          const response = await login.GET(
            request('GET', '/api/v1/auth/login'),
            undefined,
          );
          assert.equal(response.status, 503);
        } finally {
          process.env[key] = saved;
        }
      }
    });

    it('keeps the same author UUID after an email change and separates other Workspace members', async () => {
      const db = await app.appDb();
      const first = (
        await db.query(
          "SELECT id FROM users WHERE google_subject = 'google-member-123'",
        )
      ).rows[0].id;
      const renamed = await google.complete(await google.begin(), {
        claims: { email: 'renamed@hoprnet.org' },
      });
      assert.equal(
        (await userOf(cookieFrom(renamed))).username,
        'renamed@hoprnet.org',
      );
      assert.equal(
        (
          await db.query(
            "SELECT id FROM users WHERE email = 'renamed@hoprnet.org'",
          )
        ).rows[0].id,
        first,
      );
      const second = await google.complete(await google.begin(), {
        claims: { sub: 'another-member', email: 'another@hoprnet.org' },
      });
      assert.equal(
        (await userOf(cookieFrom(second))).username,
        'another@hoprnet.org',
      );
      assert.notEqual(
        (
          await db.query(
            "SELECT id FROM users WHERE google_subject = 'another-member'",
          )
        ).rows[0].id,
        first,
      );
    });

    it('expires sessions at an absolute 12 hours without renewal on activity', async () => {
      const db = await app.appDb();
      const fresh = cookieFrom(await google.signIn());
      const hash = createHash('sha256')
        .update(fresh.slice(fresh.indexOf('=') + 1))
        .digest();
      const expiry = (
        await db.query(
          'SELECT expires_at, created_at FROM sessions WHERE token_hash = $1',
          [hash],
        )
      ).rows[0];
      assert.ok(
        Math.abs(
          expiry.expires_at.getTime() -
            expiry.created_at.getTime() -
            12 * 3_600_000,
        ) < 1000,
      );
      assert.ok(await userOf(fresh));
      const reread = (
        await db.query(
          'SELECT expires_at FROM sessions WHERE token_hash = $1',
          [hash],
        )
      ).rows[0];
      assert.equal(reread.expires_at.getTime(), expiry.expires_at.getTime());
      await db.query(
        "UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token_hash = $1",
        [hash],
      );
      assert.equal(await userOf(fresh), null);
    });

    it('denies disabled local users immediately and never re-enables them on Google login', async () => {
      const fresh = cookieFrom(await google.signIn());
      const db = await app.appDb();
      await db.query(
        "UPDATE users SET disabled_at = now() WHERE google_subject = 'google-member-123'",
      );
      assert.equal(await userOf(fresh), null);
      assert.equal(
        errorOf(await google.complete(await google.begin())),
        'access_denied',
      );
    });
  },
);

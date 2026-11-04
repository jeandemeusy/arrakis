/**
 * Fake only Google's HTTPS endpoints, not the OIDC client or Arrakis routes.
 * Integration suites still exchange a code, validate PKCE and verify real RSA JWTs.
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mock } from 'node:test';

import { cookieFrom, request } from './support';

type Attempt = { response: Response; authorization: URL; cookie: string };
type TokenOptions = {
  claims?: Record<string, unknown>;
  badSignature?: boolean;
  noIdToken?: boolean;
};

export function mockGoogle() {
  process.env.ARRAKIS_GOOGLE_WORKSPACE_DOMAIN = 'hoprnet.org';
  process.env.ARRAKIS_GOOGLE_CLIENT_ID = 'arrakis-test-client';
  process.env.ARRAKIS_GOOGLE_CLIENT_SECRET = 'test-client-secret';
  process.env.ARRAKIS_PUBLIC_ORIGIN = 'https://arrakis.test';
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrongKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const codes = new Map<string, { attempt: Attempt; options: TokenOptions }>();
  const originalFetch = globalThis.fetch;
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return Response.json({
          keys: [
            {
              ...keys.publicKey.export({ format: 'jwk' }),
              kid: 'test',
              alg: 'RS256',
              use: 'sig',
            },
          ],
        });
      }
      if (url !== 'https://oauth2.googleapis.com/token')
        return originalFetch(input, init);
      const form = new URLSearchParams(String(init?.body));
      const issued = codes.get(form.get('code') ?? '');
      assert.ok(issued, 'a code can be exchanged only once');
      codes.delete(form.get('code')!);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('client_id'), 'arrakis-test-client');
      assert.equal(form.get('client_secret'), 'test-client-secret');
      assert.equal(
        form.get('redirect_uri'),
        'https://arrakis.test/api/v1/auth/callback',
      );
      assert.equal(
        createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url'),
        issued.attempt.authorization.searchParams.get('code_challenge'),
        'the browser transaction must supply the matching PKCE verifier',
      );
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: 'https://accounts.google.com',
        aud: 'arrakis-test-client',
        sub: 'google-member-123',
        email: 'jean@hoprnet.org',
        email_verified: true,
        hd: 'hoprnet.org',
        iat: now,
        exp: now + 3600,
        nonce: issued.attempt.authorization.searchParams.get('nonce'),
        ...issued.options.claims,
      };
      const payload = [
        Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString(
          'base64url',
        ),
        Buffer.from(JSON.stringify(claims)).toString('base64url'),
      ].join('.');
      const signature = sign(
        'RSA-SHA256',
        Buffer.from(payload),
        issued.options.badSignature ? wrongKeys.privateKey : keys.privateKey,
      ).toString('base64url');
      return Response.json({
        access_token: 'unused',
        token_type: 'Bearer',
        expires_in: 3600,
        ...(issued.options.noIdToken
          ? {}
          : { id_token: `${payload}.${signature}` }),
      });
    },
  );

  async function begin(next = '/'): Promise<Attempt> {
    const route = await import('../app/api/v1/auth/login/route');
    const response = await route.GET(
      request('GET', `/api/v1/auth/login?next=${encodeURIComponent(next)}`),
      undefined,
    );
    assert.equal(response.status, 303, await response.clone().text());
    return {
      response,
      authorization: new URL(response.headers.get('location')!),
      cookie: cookieFrom(response),
    };
  }

  async function complete(
    attempt: Attempt,
    options: TokenOptions = {},
    responseParameters: Record<string, string> = {},
  ) {
    const code = randomUUID();
    codes.set(code, { attempt, options });
    const params = new URLSearchParams({
      code,
      state: attempt.authorization.searchParams.get('state')!,
      ...responseParameters,
    });
    const route = await import('../app/api/v1/auth/callback/route');
    return route.GET(
      request('GET', `/api/v1/auth/callback?${params}`, {
        cookie: attempt.cookie,
      }),
      undefined,
    );
  }

  return {
    begin,
    complete,
    restore: () => fetchMock.mock.restore(),
    async signIn() {
      const response = await complete(await begin());
      assert.equal(
        response.headers.get('location'),
        'https://arrakis.test/',
        'Google sign-in must succeed',
      );
      return response;
    },
  };
}

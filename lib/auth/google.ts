import 'server-only';

import { randomBytes } from 'node:crypto';
import * as oidc from 'openid-client';

import { HttpError } from '../api/errors';
import { appDb } from '../db/app';
import { googleSettings, safeReturnPath } from './config';
import {
  createGoogleSession,
  readCookie,
  sessionCookie,
  tokenHash,
} from './session';

export { googleSettings, safeReturnPath } from './config';

const TRANSACTION_SECONDS = 600;

/** Google's published OIDC endpoints; no user-controlled issuer or discovery URL. */
function googleClient(settings: ReturnType<typeof googleSettings>) {
  const config = new oidc.Configuration(
    {
      issuer: 'https://accounts.google.com',
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token',
      jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
      id_token_signing_alg_values_supported: ['RS256'],
    },
    settings.clientId,
    settings.clientSecret,
  );
  // Verify signatures as well as issuer, audience, expiry and nonce.
  oidc.enableNonRepudiationChecks(config);
  config.timeout = 10;
  return config;
}

function transactionCookie(token: string, maxAge: number): string {
  const production = process.env.NODE_ENV === 'production';
  const name = production ? '__Host-arrakis_oauth' : 'arrakis_oauth';
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${production ? '; Secure' : ''}`;
}

function redirect(url: URL, cookies: string[] = []): Response {
  const response = new Response(null, {
    status: 303,
    headers: {
      location: url.href,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
  for (const cookie of cookies) response.headers.append('set-cookie', cookie);
  return response;
}

export async function startGoogleLogin(request: Request): Promise<Response> {
  const settings = googleSettings();
  const config = googleClient(settings);
  const token = randomBytes(32).toString('base64url');
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier();
  const target = safeReturnPath(new URL(request.url).searchParams.get('next'));
  const authorization = oidc.buildAuthorizationUrl(config, {
    redirect_uri: `${settings.origin}/api/v1/auth/callback`,
    scope: 'openid email',
    state,
    nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    hd: settings.domain,
    prompt: 'select_account',
  });
  await (
    await appDb()
  ).query(
    `INSERT INTO oauth_transactions (token_hash, state, nonce, code_verifier, return_path, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')`,
    [tokenHash(token), state, nonce, verifier, target],
  );
  return redirect(authorization, [
    transactionCookie(token, TRANSACTION_SECONDS),
  ]);
}

export async function finishGoogleLogin(request: Request): Promise<Response> {
  const settings = googleSettings();
  const name =
    process.env.NODE_ENV === 'production'
      ? '__Host-arrakis_oauth'
      : 'arrakis_oauth';
  const token = readCookie(request, name);
  let target = '/';
  try {
    if (!token) throw new Error('Missing login transaction');
    const { rows } = await (
      await appDb()
    ).query<{
      state: string;
      nonce: string;
      code_verifier: string;
      return_path: string;
    }>(
      `DELETE FROM oauth_transactions WHERE token_hash = $1 AND expires_at > now()
       RETURNING state, nonce, code_verifier, return_path`,
      [tokenHash(token)],
    );
    const transaction = rows[0];
    if (!transaction) throw new Error('Expired or consumed login transaction');
    target = safeReturnPath(transaction.return_path);
    // Use the configured origin even when the reverse proxy reports an internal host.
    const callback = new URL('/api/v1/auth/callback', settings.origin);
    callback.search = new URL(request.url).search;
    const tokens = await oidc.authorizationCodeGrant(
      googleClient(settings),
      callback,
      {
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        pkceCodeVerifier: transaction.code_verifier,
        idTokenExpected: true,
      },
    );
    const claims = tokens.claims();
    // hd in the request only customizes Google's UI. This signed claim is the gate.
    if (
      !claims ||
      claims.hd !== settings.domain ||
      claims.email_verified !== true ||
      typeof claims.email !== 'string' ||
      !claims.email ||
      typeof claims.sub !== 'string' ||
      !claims.sub ||
      claims.sub.length > 255
    ) {
      throw new HttpError(403, 'Workspace access denied');
    }
    const session = await createGoogleSession(
      {
        sub: claims.sub,
        email: claims.email,
        domain: settings.domain,
      },
      request,
    );
    return redirect(new URL(target, settings.origin), [
      sessionCookie(session.token, session.expiresAt),
      transactionCookie('', 0),
    ]);
  } catch (error) {
    // Never put Google's response, tokens or exception messages into URLs or logs.
    const login = new URL('/login', settings.origin);
    login.searchParams.set(
      'error',
      error instanceof HttpError && error.status === 403
        ? 'access_denied'
        : 'login_failed',
    );
    login.searchParams.set('next', target);
    return redirect(login, [transactionCookie('', 0)]);
  }
}

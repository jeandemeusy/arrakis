import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import { HttpError } from '../api/errors';
import { appDb } from '../db/app';
import { workspaceDomain } from './config';

export type Principal = {
  userId: string;
  username: string;
  role: 'editor' | 'admin';
};

const SESSION_HOURS = 12;

export function sessionCookieName(): string {
  return process.env.NODE_ENV === 'production'
    ? '__Host-arrakis_session'
    : 'arrakis_session';
}

export function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** Called only after the OIDC callback verifies Google's identity claims. */
export async function createGoogleSession(
  identity: { sub: string; email: string; domain: string },
  request: Request,
): Promise<{ token: string; principal: Principal; expiresAt: Date }> {
  if (identity.domain !== workspaceDomain()) {
    throw new HttpError(403, 'This Google Workspace is not allowed to edit.');
  }
  const db = await appDb();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000);
  // Email can change; Google subject, user UUID and all authorship stay put.
  // A generated username fits the existing schema without email collisions.
  const username = `google-${tokenHash(identity.sub).toString('hex').slice(0, 48)}`;
  const { rows } = await db.query<{
    id: string;
    email: string;
    role: Principal['role'];
  }>(
    `WITH account AS (
       INSERT INTO users (username, display_name, google_subject, email, role)
       VALUES ($1, $2, $3, $2, 'editor')
       ON CONFLICT (google_subject) DO UPDATE SET
         email = EXCLUDED.email, display_name = EXCLUDED.display_name, updated_at = now()
       WHERE users.disabled_at IS NULL
       RETURNING id, email, role
     ), opened AS (
       INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent, workspace_domain)
       SELECT $4, id, $5, $6, $7, $8 FROM account
       RETURNING user_id
     )
     SELECT account.* FROM account JOIN opened ON opened.user_id = account.id`,
    [
      username,
      identity.email,
      identity.sub,
      tokenHash(token),
      expiresAt,
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        'unknown',
      request.headers.get('user-agent')?.slice(0, 300) ?? null,
      identity.domain,
    ],
  );
  const user = rows[0];
  if (!user) throw new HttpError(403, 'This Arrakis account is disabled.');
  return {
    token,
    expiresAt,
    principal: { userId: user.id, username: user.email, role: user.role },
  };
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** Lookup never renews expiry: Google offboarding leaves at most 12 hours. */
export async function currentPrincipal(
  request: Request,
): Promise<Principal | null> {
  const token = readCookie(request, sessionCookieName());
  if (!token) return null;
  const domain = workspaceDomain();
  const db = await appDb();
  const { rows } = await db.query<{
    user_id: string;
    email: string;
    role: Principal['role'];
  }>(
    `SELECT users.id AS user_id, users.email, users.role
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = $1
       AND sessions.expires_at > now()
       AND sessions.workspace_domain = $2
       AND users.google_subject IS NOT NULL
       AND users.disabled_at IS NULL`,
    [tokenHash(token), domain],
  );
  const row = rows[0];
  return row
    ? { userId: row.user_id, username: row.email, role: row.role }
    : null;
}

export async function endSession(request: Request): Promise<void> {
  const token = readCookie(request, sessionCookieName());
  if (!token) return;
  await (
    await appDb()
  ).query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
}

export function sessionCookie(token: string, expiresAt: Date): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${sessionCookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict; Expires=${expiresAt.toUTCString()}${secure}`;
}

export function clearedSessionCookie(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${sessionCookieName()}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

/** Shared database state works across replicas; expired transactions are pruned too. */
export async function pruneAuthState(): Promise<void> {
  const db = await appDb();
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  await db.query('DELETE FROM oauth_transactions WHERE expires_at < now()');
}

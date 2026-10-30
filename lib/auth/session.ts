import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import { HttpError } from '../api/errors';
import { appDb } from '../db/app';
import { parseHash, verifyNothing, verifyPassword } from './password';

/**
 * Who is editing, and how they proved it.
 *
 * Editing is gated by a session, and a session is opened by `authenticate`.
 * Today there is a single account, `editor`, whose password hash is
 * ARRAKIS_EDITOR_PASSWORD_HASH, and the login form asks only for a password.
 * The model is already per-user — sessions, authorship and the rate limit all
 * key on a user row — so admitting more people means adding rows and a username
 * field, not reworking this module.
 */

export type Principal = {
  userId: string;
  username: string;
  role: 'editor' | 'admin';
};

export type Credentials = { username?: string; password: string };

/** The account the password-only login unlocks. */
export const DEFAULT_USERNAME = 'editor';

const SESSION_HOURS = 12;
const WINDOW_MINUTES = 15;
/** Failed logins allowed per address per window. */
const MAX_FAILURES_PER_IP = 10;
/**
 * Failed logins allowed from everywhere per window.
 *
 * With one shared password, the per-address limit alone does not stop a guesser
 * spread over many addresses. This caps the total guess rate at the cost of
 * locking everyone out for a few minutes during an attack — the right trade for
 * an editing interface nobody depends on minute to minute.
 */
const MAX_FAILURES_GLOBAL = 200;

export function sessionCookieName(): string {
  // __Host- binds the cookie to this exact origin over HTTPS: no Domain
  // attribute, path `/`, Secure. Browsers refuse it over plain HTTP, so local
  // development uses an ordinary name.
  return process.env.NODE_ENV === 'production'
    ? '__Host-arrakis_session'
    : 'arrakis_session';
}

let bootstrapped: Promise<void> | undefined;

/**
 * Keeps the `editor` account in step with ARRAKIS_EDITOR_PASSWORD_HASH.
 *
 * The environment is the source of truth for this one account: changing the
 * variable and restarting rotates the password, and unsetting it disables the
 * account, which also ends every session it held. A malformed hash is rejected
 * at this point rather than at the first login, where it would look like a
 * wrong password.
 */
export function ensureEnvUsers(): Promise<void> {
  bootstrapped ??= syncEnvUsers().catch((error: unknown) => {
    bootstrapped = undefined;
    throw error;
  });
  return bootstrapped;
}

/** The unmemoized sync behind `ensureEnvUsers`, run once per process. */
export async function syncEnvUsers(): Promise<void> {
  const db = await appDb();
  const hash = process.env.ARRAKIS_EDITOR_PASSWORD_HASH?.trim() || null;
  if (hash && !parseHash(hash)) {
    throw new Error(
      hash.startsWith('scrypt') && !hash.includes(':')
        ? 'ARRAKIS_EDITOR_PASSWORD_HASH looks truncated: the old `scrypt$…` form gets its `$` parts expanded by the env loader. Generate a new one with `npm run hash-password`.'
        : 'ARRAKIS_EDITOR_PASSWORD_HASH is not a valid hash; generate one with `npm run hash-password`',
    );
  }
  await db.query(
    `INSERT INTO users (username, display_name, password_hash, role, managed_by_env, disabled_at)
     VALUES ($1, 'Editor', $2, 'admin', TRUE, CASE WHEN $2::text IS NULL THEN now() END)
     ON CONFLICT (username) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       disabled_at = CASE WHEN EXCLUDED.password_hash IS NULL THEN COALESCE(users.disabled_at, now()) END,
       updated_at = now()
     WHERE users.managed_by_env`,
    [DEFAULT_USERNAME, hash],
  );
  if (!hash) {
    await db.query(
      `DELETE FROM sessions WHERE user_id IN (
         SELECT id FROM users WHERE username = $1 AND managed_by_env
       )`,
      [DEFAULT_USERNAME],
    );
  }
}

function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/**
 * The caller's address, as reported by the proxy in front.
 *
 * Only meaningful behind a proxy that sets X-Forwarded-For — which is how the
 * container is deployed. Without one, every caller shares the `unknown` bucket
 * and the per-address limit degrades into the global one.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || request.headers.get('x-real-ip')?.trim() || 'unknown';
}

async function assertNotThrottled(ip: string): Promise<void> {
  const db = await appDb();
  const { rows } = await db.query<{ mine: string; everyone: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE ip = $1) AS mine,
       COUNT(*) AS everyone
     FROM login_attempts
     WHERE NOT succeeded AND attempted_at > now() - make_interval(mins => $2)`,
    [ip, WINDOW_MINUTES],
  );
  const mine = Number(rows[0]?.mine ?? 0);
  const everyone = Number(rows[0]?.everyone ?? 0);
  if (mine >= MAX_FAILURES_PER_IP || everyone >= MAX_FAILURES_GLOBAL) {
    throw new HttpError(429, 'Too many failed logins. Try again later.', {
      headers: { 'retry-after': String(WINDOW_MINUTES * 60) },
    });
  }
}

/**
 * Checks credentials and opens a session.
 *
 * Returns the session token for the cookie. Every attempt is recorded, and a
 * wrong password, an unknown user and a disabled user all answer with the same
 * message after the same amount of work.
 */
export async function authenticate(
  credentials: Credentials,
  request: Request,
): Promise<{ token: string; principal: Principal; expiresAt: Date }> {
  await ensureEnvUsers();
  const db = await appDb();
  const ip = clientIp(request);
  const username = (credentials.username ?? DEFAULT_USERNAME)
    .trim()
    .toLowerCase();
  await assertNotThrottled(ip);

  const { rows } = await db.query<{
    id: string;
    username: string;
    role: Principal['role'];
    password_hash: string | null;
  }>(
    `SELECT id, username, role, password_hash FROM users
     WHERE username = $1 AND disabled_at IS NULL`,
    [username],
  );
  const user = rows[0];
  const valid = user?.password_hash
    ? await verifyPassword(credentials.password, user.password_hash)
    : await verifyNothing(credentials.password);

  await db.query(
    'INSERT INTO login_attempts (ip, username, succeeded) VALUES ($1, $2, $3)',
    [ip, username.slice(0, 64), valid],
  );
  if (!valid || !user) throw new HttpError(401, 'Invalid credentials.');

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000);
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      tokenHash(token),
      user.id,
      expiresAt,
      ip,
      request.headers.get('user-agent')?.slice(0, 300) ?? null,
    ],
  );
  return {
    token,
    expiresAt,
    principal: { userId: user.id, username: user.username, role: user.role },
  };
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

/** The signed-in user, or null. Never throws for a missing or stale cookie. */
export async function currentPrincipal(
  request: Request,
): Promise<Principal | null> {
  const token = readCookie(request, sessionCookieName());
  if (!token) return null;
  // A restart that unset the password must end its sessions before the first
  // one is honoured, not at the first login attempt.
  await ensureEnvUsers();
  const db = await appDb();
  const { rows } = await db.query<{
    user_id: string;
    username: string;
    role: Principal['role'];
  }>(
    `SELECT users.id AS user_id, users.username, users.role
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = $1
       AND sessions.expires_at > now()
       AND users.disabled_at IS NULL`,
    [tokenHash(token)],
  );
  const row = rows[0];
  return row
    ? { userId: row.user_id, username: row.username, role: row.role }
    : null;
}

export async function endSession(request: Request): Promise<void> {
  const token = readCookie(request, sessionCookieName());
  if (!token) return;
  const db = await appDb();
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [
    tokenHash(token),
  ]);
}

export function sessionCookie(token: string, expiresAt: Date): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${sessionCookieName()}=${token}; Path=/; HttpOnly; SameSite=Strict; Expires=${expiresAt.toUTCString()}${secure}`;
}

export function clearedSessionCookie(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${sessionCookieName()}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

/** Drops expired sessions and old login attempts. Run by the scheduler. */
export async function pruneAuthState(): Promise<void> {
  const db = await appDb();
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  await db.query(
    "DELETE FROM login_attempts WHERE attempted_at < now() - interval '1 day'",
  );
}

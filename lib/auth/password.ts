import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with scrypt, from Node's own crypto: no native addon and no
 * new dependency in the Nix-pinned lockfile.
 *
 * The stored form is self-describing so the cost can be raised later without
 * invalidating existing hashes:
 *
 *   scrypt:<log2 N>:<r>:<p>:<salt, base64url>:<key, base64url>
 *
 * Nothing in it is special to an env file. An earlier form separated the
 * fields with `$`, which Next's env loader expands as variables even inside
 * single quotes, silently mangling the hash; that form is still accepted when
 * it arrives intact, e.g. from a real environment variable.
 *
 * `scripts/hash-password.mjs` produces the same format for
 * ARRAKIS_EDITOR_PASSWORD_HASH — keep the two in step.
 */

const LOG_N = 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

function derive(
  password: string,
  salt: Buffer,
  logN: number,
  r: number,
  p: number,
  length: number,
): Promise<Buffer> {
  const N = 2 ** logN;
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      length,
      // 128 * N * r is what scrypt needs; leave headroom over Node's 32 MiB
      // default so raising the cost later does not start throwing.
      { N, r, p, maxmem: 256 * N * r },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, LOG_N, R, P, KEY_LENGTH);
  return [
    'scrypt',
    LOG_N,
    R,
    P,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join(':');
}

type Parsed = { logN: number; r: number; p: number; salt: Buffer; key: Buffer };

export function parseHash(stored: string): Parsed | null {
  const trimmed = stored.trim();
  const parts = trimmed.split(trimmed.includes(':') ? ':' : '$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [logN, r, p] = parts.slice(1, 4).map(Number);
  // Node's base64 decoder reads both alphabets, with or without padding.
  const salt = Buffer.from(parts[4], 'base64');
  const key = Buffer.from(parts[5], 'base64');
  if (
    ![logN, r, p].every(Number.isInteger) ||
    logN < 10 ||
    logN > 20 ||
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 16 ||
    salt.length < 8 ||
    key.length < 16
  ) {
    return null;
  }
  return { logN, r, p, salt, key };
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const candidate = await derive(
    password,
    parsed.salt,
    parsed.logN,
    parsed.r,
    parsed.p,
    parsed.key.length,
  );
  return timingSafeEqual(candidate, parsed.key);
}

/**
 * Burns the same time as a real verification.
 *
 * Called when the user does not exist, so a login for an unknown name and a
 * login with a wrong password cannot be told apart by how long they take.
 */
let decoy: string | undefined;
export async function verifyNothing(password: string): Promise<false> {
  decoy ??= await hashPassword('decoy');
  await verifyPassword(password, decoy);
  return false;
}

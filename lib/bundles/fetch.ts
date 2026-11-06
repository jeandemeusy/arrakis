import 'server-only';

import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { badRequest } from '../api/errors';

/**
 * Downloads a bundle from a URL, for an import.
 *
 * The server does the fetching (the page's content security policy keeps the
 * browser to its own origin), so it must not become a way to reach what only
 * the server can: only https, only public addresses, at most a few megabytes
 * and a few seconds, and no redirects to somewhere that was not checked.
 *
 * A URL may pin its content: `…/bundle.json#sha256=<hex>` is refused unless
 * the file it downloads has exactly that hash.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

function privateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('fe80')) return true; // link local
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? privateAddress(mapped[1]) : false;
  }
  const [a, b] = address.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast and reserved
  );
}

async function checkedUrl(input: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw badRequest('That is not a URL');
  }
  if (url.protocol !== 'https:')
    throw badRequest('Bundles are imported over https only');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map(
        (entry) => entry.address,
      );
  if (!addresses.length) throw badRequest(`Cannot resolve ${url.hostname}`);
  if (addresses.some(privateAddress))
    throw badRequest(
      `${url.hostname} is a private address; download the file and import it instead`,
    );
  return url;
}

/** The sha256 a URL pins with `#sha256=<hex>`, or null. */
function pinnedHash(input: string): string | null {
  const hash = /#sha256=([0-9a-f]+)$/i.exec(input.trim())?.[1]?.toLowerCase();
  if (hash === undefined) return null;
  if (hash.length !== 64) throw badRequest('#sha256= must be 64 hex digits');
  return hash;
}

export async function fetchBundle(input: string): Promise<unknown> {
  const pinned = pinnedHash(input);
  let url = await checkedUrl(input.trim());
  for (let hop = 0; ; hop++) {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    }).catch((error: unknown) => {
      throw badRequest(
        `Could not download the bundle: ${(error as Error).message}`,
      );
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || hop >= 3)
        throw badRequest('The bundle URL redirects too often');
      url = await checkedUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok)
      throw badRequest(`The bundle URL answered ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES)
      throw badRequest('The bundle is larger than 5 MB');
    const reader = response.body?.getReader();
    if (!reader) throw badRequest('The bundle URL sent nothing');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw badRequest('The bundle is larger than 5 MB');
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    if (pinned) {
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== pinned) {
        throw badRequest(
          `The bundle at that URL does not match its #sha256 (it has ${actual})`,
        );
      }
    }
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw badRequest('The bundle URL did not send JSON');
    }
  }
}

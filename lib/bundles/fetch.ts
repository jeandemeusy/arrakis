import 'server-only';

import { createHash } from 'node:crypto';
import { lookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

import { badRequest } from '../api/errors';

/**
 * Downloads a bundle from a URL, for an import.
 *
 * The server does the fetching (the page's content security policy keeps the
 * browser to its own origin), so it must not become a way to reach what only
 * the server can: only https, only public addresses, at most a few megabytes
 * and a few seconds, and no redirects to somewhere that was not checked.
 *
 * The address is checked where the connection is made: the request resolves
 * the name through `guardedLookup`, which refuses it if any address it
 * resolves to is not public, and connects to the address it checked. Checking
 * first and fetching after would resolve the name twice, and a name that
 * answers a public address the first time and a private one the second
 * (DNS rebinding) would get through.
 *
 * A URL may pin its content: `…/bundle.json#sha256=<hex>` is refused unless
 * the file it downloads has exactly that hash.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

/** Every range that is not the public internet (IANA special-purpose registries). */
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const)
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64, which reaches IPv4 behind it
  ['64:ff9b:1::', 48], // local NAT64
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments, Teredo included
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4, which embeds an IPv4 address
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link local
  ['ff00::', 8], // multicast
] as const)
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv6');

/**
 * Whether an address is on the public internet. An IPv4-mapped IPv6 address
 * (`::ffff:7f00:1`, `::ffff:127.0.0.1`) is judged as the IPv4 address it
 * carries: BlockList treats the two forms as one.
 */
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !NOT_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

function privateRefusal(host: string) {
  return badRequest(
    `${host} is a private address; download the file and import it instead`,
  );
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * `dns.lookup` for the request: resolves every address of the name, refuses
 * the name if any of them is not public, and hands the connection exactly
 * the addresses it checked.
 */
function guardedLookup(
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
): void {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    if (!addresses.length || !addresses.every((entry) => publicAddress(entry.address))) {
      return callback(
        Object.assign(privateRefusal(hostname), { code: 'EARRAKISPRIVATE' }),
        [],
      );
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

/** A URL the download may go to: https, and a public address if literal. */
function checkedUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw badRequest('That is not a URL');
  }
  if (url.protocol !== 'https:')
    throw badRequest('Bundles are imported over https only');
  // A literal address is never looked up, so it is checked here; a name is
  // checked by guardedLookup, when the connection is made.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !publicAddress(host)) throw privateRefusal(url.hostname);
  return url;
}

/** The sha256 a URL pins with `#sha256=<hex>`, or null. */
function pinnedHash(input: string): string | null {
  const hash = /#sha256=([0-9a-f]+)$/i.exec(input.trim())?.[1]?.toLowerCase();
  if (hash === undefined) return null;
  if (hash.length !== 64) throw badRequest('#sha256= must be 64 hex digits');
  return hash;
}

type Answer =
  | { kind: 'redirect'; location: string | undefined }
  | { kind: 'body'; bytes: Buffer };

/** One GET, through guardedLookup, within the size and time limits. */
function get(url: URL, signal: AbortSignal): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const fail = (error: unknown) =>
      reject(
        (error as { code?: string }).code === 'EARRAKISPRIVATE'
          ? error
          : badRequest(
              `Could not download the bundle: ${(error as Error).message}`,
            ),
      );
    const outgoing = httpsRequest(
      url,
      {
        method: 'GET',
        headers: { accept: 'application/json' },
        lookup: guardedLookup,
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          response.resume();
          resolve({ kind: 'redirect', location: response.headers.location });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(badRequest(`The bundle URL answered ${status}`));
          return;
        }
        if (Number(response.headers['content-length'] ?? 0) > MAX_BYTES) {
          response.destroy();
          reject(badRequest('The bundle is larger than 5 MB'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_BYTES) {
            response.destroy();
            reject(badRequest('The bundle is larger than 5 MB'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({ kind: 'body', bytes: Buffer.concat(chunks) }),
        );
        response.on('error', fail);
      },
    );
    outgoing.on('error', fail);
    outgoing.end();
  });
}

export async function fetchBundle(input: string): Promise<unknown> {
  const pinned = pinnedHash(input);
  let url = checkedUrl(input.trim());
  // One budget for the whole download, redirects included.
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; ; hop++) {
    const answer = await get(url, signal);
    if (answer.kind === 'redirect') {
      if (!answer.location || hop >= MAX_REDIRECTS)
        throw badRequest('The bundle URL redirects too often');
      url = checkedUrl(new URL(answer.location, url).toString());
      continue;
    }
    if (pinned) {
      const actual = createHash('sha256').update(answer.bytes).digest('hex');
      if (actual !== pinned) {
        throw badRequest(
          `The bundle at that URL does not match its #sha256 (it has ${actual})`,
        );
      }
    }
    try {
      return JSON.parse(answer.bytes.toString('utf8'));
    } catch {
      throw badRequest('The bundle URL did not send JSON');
    }
  }
}

import 'server-only';

import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';

const toBrotli = promisify(brotliCompress);
const toGzip = promisify(gzip);

/**
 * Brotli effort.
 *
 * Measured on a real snapshot payload of 750 KiB: quality 4 gives 81 KiB in
 * 5 ms and quality 5 gives 79 KiB in the same time, both smaller AND faster
 * than gzip's 127 KiB in 7 ms. Quality 11 reaches 62 KiB but takes 555 ms,
 * which is far too long to spend per request for the 17 KiB it saves.
 */
const BROTLI_QUALITY = 5;

/**
 * Below this, compression is not worth doing.
 *
 * The response headers it adds cost more than the handful of bytes it saves,
 * and every error response this module serves is well under the line.
 */
const MIN_COMPRESSIBLE_BYTES = 1024;

/**
 * Picks an encoding the client actually asked for, preferring brotli.
 *
 * `q=0` is an explicit refusal rather than a weak preference, so an encoding
 * marked that way is dropped instead of ranked.
 */
function negotiate(header: string | null): 'br' | 'gzip' | null {
  if (!header) return null;
  const accepted = new Set<string>();
  for (const part of header.split(',')) {
    const [name, ...parameters] = part.trim().split(';');
    const refused = parameters.some(
      (parameter) => parameter.replaceAll(' ', '') === 'q=0',
    );
    if (!refused) accepted.add(name.trim().toLowerCase());
  }
  if (accepted.has('br')) return 'br';
  if (accepted.has('gzip')) return 'gzip';
  return null;
}

/**
 * A JSON response, compressed when the client can take it.
 *
 * Next compresses the pages it renders but not the responses of route handlers,
 * so this API was serving three quarters of a megabyte uncompressed to every
 * caller — and the README advertises it as the public JSON representation of the
 * dashboard. Compressing here rather than leaving it to a proxy means the saving
 * holds however the container is fronted.
 */
export async function json(
  request: Request,
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Promise<Response> {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  // Anything caching this has to key on the encoding it stored.
  headers.append('vary', 'accept-encoding');

  const encoding =
    payload.length < MIN_COMPRESSIBLE_BYTES
      ? null
      : negotiate(request.headers.get('accept-encoding'));
  if (!encoding) {
    return new Response(payload, { status: init?.status ?? 200, headers });
  }

  // Off the event loop: zlib's callback form runs on the thread pool, so a
  // request compressing 750 KiB does not stall every other one for 5 ms.
  const compressed =
    encoding === 'br'
      ? await toBrotli(payload, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
            [constants.BROTLI_PARAM_SIZE_HINT]: payload.length,
          },
        })
      : await toGzip(payload);

  headers.set('content-encoding', encoding);
  return new Response(compressed, { status: init?.status ?? 200, headers });
}

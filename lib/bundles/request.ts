import 'server-only';

import { badRequest } from '../api/errors';
import { fetchBundle } from './fetch';
import { parseBundle, type Bundle } from './format';

/** The bundle a request carries: inline, or at a URL the server downloads. */
export async function bundleFrom(
  body: Record<string, unknown>,
): Promise<Bundle> {
  if (body.bundle !== undefined) return parseBundle(body.bundle);
  if (typeof body.url === 'string' && body.url.trim())
    return parseBundle(await fetchBundle(body.url));
  throw badRequest('Send a bundle, or the URL of one');
}

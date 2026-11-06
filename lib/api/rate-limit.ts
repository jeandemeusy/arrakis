import 'server-only';

import { clientIp } from '../auth/session';
import { HttpError } from './errors';

/**
 * A per-address budget for what anyone may ask without signing in.
 *
 * Reading a dashboard is cheap for the app, but not free: each request reads
 * stored results, and a chart whose variables were never seen before is
 * computed afresh. Without a limit, one client varying a text variable could
 * keep the app database busy for everyone. Each replica counts on its own, in
 * memory, over a sliding minute: ARRAKIS_READ_RATE_LIMIT requests per address
 * (300 by default — a dashboard page makes a handful, then polls every 20 s).
 * Signed-in editors are not counted. An address the proxy did not report
 * (see clientIp) is not limited, since every caller would share it.
 */

const WINDOW_MS = 60_000;
const MAX_TRACKED = 20_000;

const hits = new Map<string, number[]>();

function budget(): number {
  const value = Number.parseInt(process.env.ARRAKIS_READ_RATE_LIMIT ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : 300;
}

/** Counts one request from the caller's address; 429 once over budget. */
export function limitReader(request: Request): void {
  const address = clientIp(request);
  if (address === 'unknown') return;
  const now = Date.now();
  const recent = (hits.get(address) ?? []).filter(
    (at) => now - at < WINDOW_MS,
  );
  if (recent.length >= budget()) {
    hits.set(address, recent);
    const retry = Math.ceil((WINDOW_MS - (now - recent[0])) / 1000);
    throw new HttpError(429, 'Too many requests. Try again in a minute.', {
      headers: { 'retry-after': String(Math.max(1, retry)) },
    });
  }
  recent.push(now);
  // Re-inserted last, so the map's order is oldest activity first.
  hits.delete(address);
  hits.set(address, recent);
  while (hits.size > MAX_TRACKED) {
    const oldest = hits.keys().next();
    if (oldest.done) break;
    hits.delete(oldest.value);
  }
}

/** Forgets every count. Tests only. */
export function resetReadLimits(): void {
  hits.clear();
}

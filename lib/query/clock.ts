import 'server-only';

import type { NetworkConfig } from '../networks';
import { blockTimestamps } from '../rpc';
import { runReadOnly } from './runner';

/**
 * Anchor blocks with known timestamps, for `{{block_time(expr)}}`.
 *
 * Blokli records block numbers but not times. With an `rpcUrl`, a spread of
 * blocks from the network's first deployment to the last indexed block is
 * timestamped over RPC, and block_time() interpolates between them — Gnosis
 * keeps a steady five-second cadence, so the error is seconds. Without one, or
 * if the RPC fails, two anchors are synthesized from that cadence and the
 * result is marked `estimated`, as the dashboard has always done.
 */

const BLOCK_SECONDS = 5;
const ANCHORS = 128;
const TTL_MS = 60_000;

export type BlockClock = {
  blocks: number[];
  times: number[];
  timebase: 'rpc' | 'estimated';
};

const cache = new Map<string, { at: number; clock: Promise<BlockClock> }>();

async function bounds(
  network: NetworkConfig,
): Promise<{ first: number; last: number }> {
  const { rows } = await runReadOnly({
    network,
    text: `SELECT
      (SELECT MIN(published_block) FROM account) AS first,
      (SELECT last_indexed_block FROM chain_info ORDER BY id LIMIT 1) AS last`,
    values: [],
    rowLimit: 1,
  });
  const [first, last] = (rows[0] ?? []).map((value) => Number(value ?? 0));
  const end = Math.max(1, last || first || 1);
  return { first: Math.min(first || end, end), last: end };
}

function estimated(first: number, last: number): BlockClock {
  const now = Math.floor(Date.now() / 1000);
  const start = Math.min(first, last - 1);
  return {
    blocks: [start, last],
    times: [now - (last - start) * BLOCK_SECONDS, now],
    timebase: 'estimated',
  };
}

async function build(network: NetworkConfig): Promise<BlockClock> {
  const { first, last } = await bounds(network);
  if (!network.rpcUrl || last <= first) return estimated(first, last);
  const span = last - first;
  const wanted = Array.from(
    { length: ANCHORS },
    (_, index) => first + Math.round((span * index) / (ANCHORS - 1)),
  );
  try {
    const { blocks, times } = await blockTimestamps(network.rpcUrl, wanted);
    if (blocks.length >= 2) return { blocks, times, timebase: 'rpc' };
  } catch (error) {
    console.error(`Block clock for ${network.id}:`, (error as Error).message);
  }
  return estimated(first, last);
}

export function blockClock(network: NetworkConfig): Promise<BlockClock> {
  const hit = cache.get(network.id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.clock;
  const clock = build(network);
  cache.set(network.id, { at: Date.now(), clock });
  clock.catch(() => cache.delete(network.id));
  return clock;
}

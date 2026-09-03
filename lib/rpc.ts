// Dense enough that interpolation stays accurate to minutes, which the hour-of-day
// histogram needs, while still costing a single batched request.
const ANCHOR_COUNT = 64;

type RpcReply = {
  id: number;
  result?: { timestamp?: string };
  error?: { message?: string };
};

/** Maps block numbers to unix seconds by interpolating between sampled anchors. */
export type BlockClock = (block: number) => number;

const anchorCache = new Map<number, number>();

async function fetchTimestamps(rpcUrl: string, blocks: number[]): Promise<void> {
  const missing = blocks.filter((block) => !anchorCache.has(block));
  if (!missing.length) return;

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      missing.map((block, id) => ({
        jsonrpc: "2.0",
        id,
        method: "eth_getBlockByNumber",
        params: [`0x${block.toString(16)}`, false],
      })),
    ),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`RPC responded with ${response.status}`);

  const replies = (await response.json()) as RpcReply[];
  for (const reply of replies) {
    const block = missing[reply.id];
    const timestamp = reply.result?.timestamp;
    if (block === undefined || !timestamp) continue;
    anchorCache.set(block, Number.parseInt(timestamp, 16));
  }
}

/**
 * Builds a block-to-time mapping for the [first, last] range.
 *
 * Redemption histories run to tens of thousands of blocks, so asking the RPC for
 * every one of them is not viable. Gnosis produces blocks on a steady five-second
 * cadence, so sampling a handful of anchors and interpolating between them lands
 * within a few seconds of the true timestamp — far below the daily buckets the
 * dashboard renders.
 */
export async function resolveBlockClock(
  rpcUrl: string,
  first: number,
  last: number,
): Promise<BlockClock> {
  const span = Math.max(0, last - first);
  const count = span === 0 ? 1 : ANCHOR_COUNT;
  const anchors = Array.from({ length: count }, (_, index) =>
    count === 1 ? first : first + Math.round((span * index) / (count - 1)),
  );

  await fetchTimestamps(rpcUrl, anchors);
  const known = anchors
    .map((block) => [block, anchorCache.get(block)] as const)
    .filter((entry): entry is readonly [number, number] => entry[1] !== undefined);
  if (!known.length) throw new Error("No block timestamps could be resolved");

  return (block) => {
    if (known.length === 1) return known[0][1];
    let upper = known.findIndex(([candidate]) => candidate >= block);
    if (upper <= 0) upper = 1;
    const [lowBlock, lowTime] = known[upper - 1];
    const [highBlock, highTime] = known[upper];
    if (highBlock === lowBlock) return lowTime;
    const ratio = (block - lowBlock) / (highBlock - lowBlock);
    return Math.round(lowTime + ratio * (highTime - lowTime));
  };
}

type RpcReply = {
  id: number;
  result?: { timestamp?: string };
  error?: { message?: string };
};

const timestampCache = new Map<number, number>();

async function fetchBatch(rpcUrl: string, blocks: number[]): Promise<void> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      blocks.map((block, id) => ({
        jsonrpc: "2.0",
        id,
        method: "eth_getBlockByNumber",
        params: [`0x${block.toString(16)}`, false],
      })),
    ),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`);

  const body = (await response.json()) as RpcReply[] | RpcReply;
  const replies = Array.isArray(body) ? body : [body];
  if (replies.length !== blocks.length) {
    throw new Error("RPC batch response was incomplete");
  }
  for (const reply of replies) {
    const block = blocks[reply.id];
    const timestamp = reply.result?.timestamp;
    if (block === undefined || !timestamp || reply.error) {
      throw new Error(reply.error?.message ?? "RPC block timestamp missing");
    }
    timestampCache.set(block, Number.parseInt(timestamp, 16));
  }
}

export async function resolveBlockTimestamps(rpcUrl: string, blocks: number[]): Promise<Map<number, number>> {
  const unique = [...new Set(blocks)];
  const missing = unique.filter((block) => !timestampCache.has(block));
  for (let index = 0; index < missing.length; index += 100) {
    await fetchBatch(rpcUrl, missing.slice(index, index + 100));
  }
  return new Map(unique.map((block) => [block, timestampCache.get(block) as number]));
}

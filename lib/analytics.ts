import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { Pool, type QueryResultRow } from "pg";

import { COMBINED } from "./constants";
import { fixtureDashboard } from "./fixtures";
import { resolveNetworks, type NetworkConfig, type NetworkSummary } from "./networks";
import { resolveBlockClock, type BlockClock } from "./rpc";
import {
  buildSnapshot,
  dayIndex,
  redemptionVolume,
  unavailableSnapshot,
  type AnalyticsSnapshot,
  type DeployedClient,
  type NetworkDataset,
  type Redemption,
} from "./snapshot";

export type { AnalyticsSnapshot } from "./snapshot";
export { COMBINED } from "./constants";

/** Gnosis block cadence, used to place blocks in time when no RPC is configured. */
const BLOCK_SECONDS = 5;
/** How long a good snapshot serves before the queries are run again. */
const SNAPSHOT_TTL_MS = 60_000;
/**
 * How long a failure is remembered.
 *
 * Short enough that recovery is picked up quickly, long enough that an outage does
 * not turn every page view into another round of queries against a database that is
 * already struggling.
 */
const FAILURE_TTL_MS = 10_000;

/**
 * Every network's view plus the combined one.
 *
 * All of them are computed server-side and sent together, so switching networks in
 * the browser is instant and costs no further database work.
 */
export type Dashboard = {
  networks: NetworkSummary[];
  /** Keyed by network id, plus `all` when more than one network is configured. */
  snapshots: Record<string, AnalyticsSnapshot>;
  defaultNetwork: string;
};

type SummaryRow = QueryResultRow & {
  schema_version: string;
  block_number: string;
  win_prob: string | number | null;
  accounts: string;
  safes: string;
  open_channels: string;
};

type RedemptionRow = QueryResultRow & {
  channel_id: string;
  source: Buffer;
  destination: Buffer;
  published_block: string;
  tickets: string;
};

type DeploymentRow = QueryResultRow & {
  account: Buffer;
  published_block: string;
};

type WinProbRow = QueryResultRow & { block_number: string; win_prob: Buffer };
type TicketPriceRow = QueryResultRow & { block_number: string; ticket_price: Buffer };

const pools = new Map<string, Pool>();
const sqlCache = new Map<string, string>();
let cached: { expiresAt: number; value: Dashboard } | undefined;
let refreshing: Promise<Dashboard> | undefined;

function database(network: NetworkConfig): Pool {
  let pool = pools.get(network.id);
  if (!pool) {
    pool = new Pool({
      connectionString: network.databaseUrl,
      max: 5,
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
    });
    pools.set(network.id, pool);
  }
  return pool;
}

async function sql(name: string): Promise<string> {
  const cachedSql = sqlCache.get(name);
  if (cachedSql) return cachedSql;
  const value = await readFile(path.join(process.cwd(), "sql", "v1", `${name}.sql`), "utf8");
  sqlCache.set(name, value);
  return value;
}

function fromBigEndian(bytes: Buffer): bigint {
  return bytes.reduce((value, byte) => (value << 8n) + BigInt(byte), 0n);
}

function hex(bytes: Buffer): string {
  return `0x${bytes.toString("hex")}`;
}

function sumBalances(rows: Array<{ balance: Buffer }>): bigint {
  return rows.reduce((total, row) => total + fromBigEndian(row.balance), 0n);
}

/**
 * Decodes HOPR's 7-byte encoded winning probability into a probability in [0, 1].
 *
 * Mirrors `WinningProbability::as_f64` in hopr-types: the seven bytes are read
 * big-endian, incremented, and used as the mantissa of a float in [1, 2), from
 * which one is subtracted. The all-zero and all-ones encodings are exact.
 */
function decodeWinProbability(bytes: Buffer): number {
  if (bytes.length !== 7) return 1;
  if (bytes.every((byte) => byte === 0x00)) return 0;
  if (bytes.every((byte) => byte === 0xff)) return 1;
  const significand = fromBigEndian(bytes) + 1n;
  const bits = (1023n << 52n) | (significand >> 4n);
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setBigUint64(0, bits);
  return new DataView(buffer).getFloat64(0) - 1;
}

/**
 * Step function over the win-probability timeline: the newest update at or before
 * a block. Redemptions preceding the first update have no probability on record
 * and resolve to zero, which excludes them from volume rather than guessing.
 *
 * With no timeline at all the caller's fallback applies to every block, which is
 * the degraded path where only the current probability is known.
 */
function winProbabilityAt(
  timeline: Array<[number, number]>,
  fallback: number,
): (block: number) => number {
  if (!timeline.length) return () => fallback;
  return (block) => {
    let low = 0;
    let high = timeline.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (timeline[middle][0] <= block) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found === -1 ? 0 : timeline[found][1];
  };
}

function estimatedClock(latestBlock: number): BlockClock {
  const now = Math.floor(Date.now() / 1000);
  return (block) => now - (latestBlock - block) * BLOCK_SECONDS;
}

/** Reads one index database into the shape the snapshot builder consumes. */
async function queryNetwork(network: NetworkConfig): Promise<NetworkDataset> {
  const db = database(network);
  const warnings: string[] = [];

  // The summary is the only query a network cannot be rendered without; the rest
  // degrade to an empty panel so one broken relation never blanks the dashboard.
  const summaryResult = await db.query<SummaryRow>(await sql("summary"));
  const summary = summaryResult.rows[0];
  if (!summary) throw new Error("Blokli chain_info is not initialized");

  const [channelBalances, safeBalances, redemptionRows, deploymentRows, winProbRows, priceRows] =
    await Promise.allSettled([
      db.query<{ balance: Buffer }>(await sql("channel-balances")),
      db.query<{ balance: Buffer }>(await sql("safe-balances")),
      db.query<RedemptionRow>(await sql("redemptions")),
      db.query<DeploymentRow>(await sql("client-deployments")),
      db.query<WinProbRow>(await sql("win-prob-updates")),
      db.query<TicketPriceRow>(await sql("ticket-price-updates")),
    ]);

  const rawRedemptions = redemptionRows.status === "fulfilled" ? redemptionRows.value.rows : [];
  if (redemptionRows.status === "rejected") {
    warnings.push("Redemption history is unavailable; usage panels are empty.");
  }
  const rawDeployments = deploymentRows.status === "fulfilled" ? deploymentRows.value.rows : [];
  if (deploymentRows.status === "rejected") {
    warnings.push("Client deployments are unavailable; active users count redemptions only.");
  }
  if (priceRows.status === "rejected") {
    warnings.push("Ticket price history is unavailable; ticket parameters are empty.");
  }

  // chain_info holds only the current winning probability. The raw log table, when
  // it lives in this database, carries the full oracle history instead.
  const currentWinProb = Number(summary.win_prob);
  const fallbackWinProb = Number.isFinite(currentWinProb) && currentWinProb > 0 ? currentWinProb : 1;
  const timeline: Array<[number, number]> =
    winProbRows.status === "fulfilled"
      ? winProbRows.value.rows.map((row) => [
          Number(row.block_number),
          decodeWinProbability(row.win_prob),
        ])
      : [];

  let winProbability: NetworkDataset["winProbability"] = "historical";
  if (!timeline.length) {
    winProbability = Number.isFinite(currentWinProb) && currentWinProb > 0 ? "current" : "assumed";
    warnings.push(
      winProbability === "current"
        ? "Winning probability history is unavailable; volume uses the current value throughout."
        : "Winning probability is not indexed; volume assumes a probability of 1.",
    );
  }
  const probabilityAt = winProbabilityAt(timeline, fallbackWinProb);

  const priceTimeline: Array<[number, bigint]> =
    priceRows.status === "fulfilled"
      ? priceRows.value.rows.map((row) => [
          Number(row.block_number),
          fromBigEndian(row.ticket_price),
        ])
      : [];

  const latestBlock = Number(summary.block_number);
  const blocks = [
    ...rawRedemptions.map((row) => Number(row.published_block)),
    ...rawDeployments.map((row) => Number(row.published_block)),
  ];
  const firstBlock = blocks.length ? Math.min(...blocks) : latestBlock;

  let timebase: NetworkDataset["timebase"] = "estimated";
  let clock = estimatedClock(latestBlock);
  if (network.rpcUrl) {
    try {
      clock = await resolveBlockClock(network.rpcUrl, firstBlock, latestBlock);
      timebase = "rpc";
    } catch {
      warnings.push("RPC timestamps are unavailable; dates are estimated from block height.");
    }
  }

  const redemptions: Redemption[] = rawRedemptions.map((row) => {
    const block = Number(row.published_block);
    const timestamp = clock(block);
    return {
      network: network.id,
      channelId: row.channel_id,
      source: hex(row.source),
      destination: hex(row.destination),
      day: dayIndex(timestamp),
      timestamp,
      tickets: Number(row.tickets),
      gigabytes: redemptionVolume(probabilityAt(block)),
    };
  });

  const deployed: DeployedClient[] = rawDeployments.map((row) => {
    const timestamp = clock(Number(row.published_block));
    return {
      network: network.id,
      address: hex(row.account),
      day: dayIndex(timestamp),
      timestamp,
    };
  });

  const currentProbability = timeline.at(-1)?.[1] ?? null;
  const currentPrice = priceTimeline.at(-1)?.[1] ?? null;

  return {
    network: network.id,
    label: network.label,
    lastDay: dayIndex(clock(latestBlock)),
    blockNumber: latestBlock,
    schemaVersion: summary.schema_version,
    accounts: Number(summary.accounts),
    safes: Number(summary.safes),
    openChannels: Number(summary.open_channels),
    channelBalance:
      channelBalances.status === "fulfilled" ? sumBalances(channelBalances.value.rows) : null,
    safeBalance: safeBalances.status === "fulfilled" ? sumBalances(safeBalances.value.rows) : null,
    redemptions,
    deployed,
    ticket: {
      winProbability: currentProbability,
      priceWei: currentPrice?.toString() ?? null,
      valueWei:
        currentPrice !== null && currentProbability
          ? BigInt(Math.round(Number(currentPrice) / currentProbability)).toString()
          : null,
    },
    timebase,
    winProbability,
    hasUsage: redemptionRows.status === "fulfilled",
    hasDeployments: deploymentRows.status === "fulfilled",
    warnings,
  };
}

/**
 * Reads every configured network and builds each view.
 *
 * A network that cannot be read does not take the others down with it: it gets an
 * unavailable snapshot of its own and is left out of the combined view, which says
 * so in its warnings.
 */
async function queryDashboard(): Promise<Dashboard> {
  const networks = resolveNetworks();
  const results = await Promise.allSettled(networks.map(queryNetwork));

  const snapshots: Record<string, AnalyticsSnapshot> = {};
  const datasets: NetworkDataset[] = [];
  const failures: string[] = [];

  results.forEach((result, index) => {
    const network = networks[index];
    if (result.status === "fulfilled") {
      datasets.push(result.value);
      snapshots[network.id] = buildSnapshot([result.value]);
    } else {
      failures.push(network.label);
      snapshots[network.id] = unavailableSnapshot(
        `${network.label} is unavailable: its index database could not be read.`,
      );
    }
  });

  if (networks.length > 1) {
    const combined = datasets.length
      ? buildSnapshot(datasets)
      : unavailableSnapshot("No index database could be read.");
    if (failures.length && datasets.length) {
      combined.source = "degraded";
      combined.warnings = [
        ...combined.warnings,
        `Excluded from these totals: ${failures.join(", ")}.`,
      ];
    }
    snapshots[COMBINED] = combined;
  }

  return {
    networks: networks.map(({ id, label }) => ({ id, label })),
    snapshots,
    defaultNetwork: networks.length > 1 ? COMBINED : networks[0].id,
  };
}

/**
 * Runs the queries once and caches the outcome, successful or not.
 *
 * Failures are cached too, on a shorter clock: without that, an unreachable index
 * database would have every request re-run every query and wait out the statement
 * timeout, putting the most pressure on the database exactly when it is failing.
 */
async function refreshDashboard(): Promise<Dashboard> {
  try {
    const value = await queryDashboard();
    cached = { expiresAt: Date.now() + SNAPSHOT_TTL_MS, value };
    return value;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The dashboard configuration is invalid.";
    const value: Dashboard = {
      networks: [],
      snapshots: { [COMBINED]: unavailableSnapshot(message) },
      defaultNetwork: COMBINED,
    };
    cached = { expiresAt: Date.now() + FAILURE_TTL_MS, value };
    return value;
  } finally {
    refreshing = undefined;
  }
}

/**
 * The cached dashboard, refreshing it when stale.
 *
 * Concurrent callers that arrive during a refresh share the one in-flight run, so
 * a page view costs no database work of its own.
 */
export async function loadDashboard(): Promise<Dashboard> {
  // UI work against synthetic data, with no database and no deploy in the loop.
  if (process.env.DASHBOARD_FIXTURES === "1") return fixtureDashboard();

  if (cached && cached.expiresAt > Date.now()) return cached.value;
  refreshing ??= refreshDashboard();
  return refreshing;
}

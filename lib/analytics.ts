import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { Pool, type QueryResultRow } from "pg";

import { OTHER_RELAYERS } from "./constants";
import { resolveBlockClock, type BlockClock } from "./rpc";

/**
 * Payload one redemption accounts for, before the win-probability scale.
 *
 * A ticket is issued per packet but only wins with probability p, so a redeemed
 * ticket stands in for 1/p packets of 650 bytes: 650 / (2^30 * p) gigabytes.
 */
const GIGABYTES_PER_REDEMPTION = 650 / 2 ** 30;
/** Gnosis block cadence, used to place blocks in time when no RPC is configured. */
const BLOCK_SECONDS = 5;
const DAY_SECONDS = 86_400;
// Trailing windows are inclusive of both endpoints: 7 days is day-6..day and
// 30 days is day-30..day, matching how the published Dune queries slice them.
const WEEK_DAYS = 7;
const MONTH_DAYS = 31;
const RELAYER_LIMIT = 12;
/** Relayers charted individually in the daily stack; the rest collapse into "Other". */
const RELAYER_STACK_LIMIT = 6;
const RELAYER_STACK_DAYS = 30;
const CLIENT_LIMIT = 50;
const DEPLOYMENT_LIMIT = 100;

export type ActiveUserPoint = {
  date: string;
  weekly: number;
  monthly: number;
  deployments: number;
};

export type WeekPoint = {
  key: string;
  label: string;
  redemptions: number;
  tickets: number;
  gigabytes: number;
  cumulativeRedemptions: number;
  cumulativeGigabytes: number;
};

export type Relayer = {
  address: string;
  redemptions: number;
  gigabytes: number;
  share: number;
};

/** One day of relayed volume, keyed by relayer address, for the stacked chart. */
export type RelayerDayPoint = { date: string } & Record<string, number | string>;

export type Client = {
  address: string;
  gigabytes7d: number;
  gigabytesTotal: number;
  redemptions7d: number;
  redemptionsTotal: number;
};

export type Deployment = {
  address: string;
  timestamp: string;
};

export type AnalyticsSnapshot = {
  source: "live" | "degraded" | "unavailable";
  observedAt: string;
  timebase: "rpc" | "estimated";
  winProbability: "historical" | "current" | "assumed";
  schemaVersion: string | null;
  blockNumber: number;
  accounts: number | null;
  safes: number | null;
  openChannels: number | null;
  channelBalance: string | null;
  safeBalance: string | null;
  activeUsers: ActiveUserPoint[];
  weeks: WeekPoint[];
  relayers: Relayer[];
  relayerDaily: RelayerDayPoint[];
  relayerSeries: string[];
  clients: Client[];
  clientCount: number;
  deployments: Deployment[];
  totals: {
    weeklyActiveUsers: number | null;
    monthlyActiveUsers: number | null;
    allTimeUsers: number | null;
    redemptions7d: number | null;
    redemptionsTotal: number | null;
    gigabytes7d: number | null;
    gigabytesTotal: number | null;
    ticketsTotal: number | null;
    relayers7d: number | null;
    deployments7d: number | null;
    deployments30d: number | null;
    clientsDeployed: number | null;
  };
  warnings: string[];
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
  source: Buffer;
  destination: Buffer;
  published_block: string;
  tickets: string;
};

type DeploymentRow = QueryResultRow & {
  account: Buffer;
  published_block: string;
};

type WinProbRow = QueryResultRow & {
  block_number: string;
  win_prob: Buffer;
};

type Redemption = {
  source: string;
  destination: string;
  block: number;
  day: number;
  tickets: number;
  gigabytes: number;
};

let pool: Pool | undefined;
const sqlCache = new Map<string, string>();
let cachedSnapshot: { expiresAt: number; value: AnalyticsSnapshot } | undefined;

function database(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured");
  if (
    !connectionString.startsWith("postgres://") &&
    !connectionString.startsWith("postgresql://")
  ) {
    throw new Error("The dashboard backend currently requires a PostgreSQL DATABASE_URL");
  }
  pool ??= new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
  });
  return pool;
}

async function sql(name: string): Promise<string> {
  const cached = sqlCache.get(name);
  if (cached) return cached;
  const value = await readFile(
    path.join(process.cwd(), "sql", "v1", `${name}.sql`),
    "utf8",
  );
  sqlCache.set(name, value);
  return value;
}

function fromBigEndian(bytes: Buffer): bigint {
  return bytes.reduce((value, byte) => (value << 8n) + BigInt(byte), 0n);
}

function hex(bytes: Buffer): string {
  return `0x${bytes.toString("hex")}`;
}

function sumBalances(rows: Array<{ balance: Buffer }>): string {
  return rows.reduce((total, row) => total + fromBigEndian(row.balance), 0n).toString();
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
 */
function winProbabilityAt(timeline: Array<[number, number]>, fallback: number) {
  if (!timeline.length) return () => fallback;
  return (block: number) => {
    let value = 0;
    for (const [updatedAt, probability] of timeline) {
      if (updatedAt > block) break;
      value = probability;
    }
    return value;
  };
}

/** Volume a redemption accounts for; a zero or unknown probability contributes none. */
function redemptionVolume(probability: number): number {
  return probability > 0 ? GIGABYTES_PER_REDEMPTION / probability : 0;
}

function dayIndex(timestamp: number): number {
  return Math.floor(timestamp / DAY_SECONDS);
}

function isoDate(day: number): string {
  return new Date(day * DAY_SECONDS * 1000).toISOString().slice(0, 10);
}

function estimatedClock(latestBlock: number): BlockClock {
  const now = Math.floor(Date.now() / 1000);
  return (block) => now - (latestBlock - block) * BLOCK_SECONDS;
}

/**
 * Daily snapshots of the trailing 7- and 30-day active-user counts.
 *
 * A client is active in a window when it settled a redemption on one of its
 * channels inside that window, or when it was first deployed inside it. Counting
 * the deployment day means a freshly deployed client registers immediately rather
 * than only once its first tickets are redeemed.
 */
function activeUserSeries(
  actorsByDay: Map<number, Set<string>>,
  deploymentsByDay: Map<number, number>,
  lastDay: number,
): ActiveUserPoint[] {
  const days = [...actorsByDay.keys()].sort((a, b) => a - b);
  if (!days.length) return [];

  const points: ActiveUserPoint[] = [];
  for (let day = days[0]; day <= lastDay; day += 1) {
    const weekly = new Set<string>();
    const monthly = new Set<string>();
    let deployments = 0;
    for (let offset = 0; offset < MONTH_DAYS; offset += 1) {
      deployments += deploymentsByDay.get(day - offset) ?? 0;
      const actors = actorsByDay.get(day - offset);
      if (!actors) continue;
      for (const actor of actors) {
        monthly.add(actor);
        if (offset < WEEK_DAYS) weekly.add(actor);
      }
    }
    points.push({
      date: isoDate(day),
      weekly: weekly.size,
      monthly: monthly.size,
      deployments,
    });
  }
  return points;
}

function weeklySeries(redemptions: Redemption[]): WeekPoint[] {
  const buckets = new Map<number, { redemptions: number; tickets: number; gigabytes: number }>();
  for (const redemption of redemptions) {
    // Anchor each week to the Monday containing it. Unix day 0 was a Thursday,
    // so shift by three days before flooring to a week boundary.
    const week = Math.floor((redemption.day + 3) / 7) * 7 - 3;
    const bucket = buckets.get(week) ?? { redemptions: 0, tickets: 0, gigabytes: 0 };
    bucket.redemptions += 1;
    bucket.tickets += redemption.tickets;
    bucket.gigabytes += redemption.gigabytes;
    buckets.set(week, bucket);
  }

  let cumulativeRedemptions = 0;
  let cumulativeGigabytes = 0;
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([week, bucket]) => {
      cumulativeRedemptions += bucket.redemptions;
      cumulativeGigabytes += bucket.gigabytes;
      return {
        key: isoDate(week),
        label: new Intl.DateTimeFormat("en", {
          day: "2-digit",
          month: "short",
          timeZone: "UTC",
        }).format(new Date(week * DAY_SECONDS * 1000)),
        redemptions: bucket.redemptions,
        tickets: bucket.tickets,
        gigabytes: bucket.gigabytes,
        cumulativeRedemptions,
        cumulativeGigabytes,
      };
    });
}

function relayerDistribution(recent: Redemption[]): Relayer[] {
  const buckets = new Map<string, { redemptions: number; gigabytes: number }>();
  for (const redemption of recent) {
    const bucket = buckets.get(redemption.destination) ?? { redemptions: 0, gigabytes: 0 };
    bucket.redemptions += 1;
    bucket.gigabytes += redemption.gigabytes;
    buckets.set(redemption.destination, bucket);
  }

  const total = recent.length || 1;
  return [...buckets.entries()]
    .map(([address, bucket]) => ({
      address,
      redemptions: bucket.redemptions,
      gigabytes: bucket.gigabytes,
      share: bucket.redemptions / total,
    }))
    .sort((a, b) => b.redemptions - a.redemptions)
    .slice(0, RELAYER_LIMIT);
}

/**
 * Daily relayed volume per relayer over the recent window.
 *
 * Relayers beyond the top few collapse into a single "Other" band so the stack
 * stays readable; every day in the window is emitted, including quiet ones, so
 * the chart does not imply activity on days that had none.
 */
function relayerDailySeries(
  redemptions: Redemption[],
  lastDay: number,
): { points: RelayerDayPoint[]; series: string[] } {
  const firstDay = lastDay - RELAYER_STACK_DAYS + 1;
  const window = redemptions.filter((redemption) => redemption.day >= firstDay);
  if (!window.length) return { points: [], series: [] };

  const totals = new Map<string, number>();
  for (const redemption of window) {
    totals.set(
      redemption.destination,
      (totals.get(redemption.destination) ?? 0) + redemption.gigabytes,
    );
  }
  const ranked = [...totals.entries()].sort(([, a], [, b]) => b - a);
  const charted = new Set(
    ranked.slice(0, RELAYER_STACK_LIMIT).map(([address]) => address),
  );
  const hasOther = ranked.length > charted.size;
  const series = [...charted, ...(hasOther ? [OTHER_RELAYERS] : [])];

  const byDay = new Map<number, Map<string, number>>();
  for (const redemption of window) {
    const key = charted.has(redemption.destination)
      ? redemption.destination
      : OTHER_RELAYERS;
    const day = byDay.get(redemption.day) ?? new Map<string, number>();
    day.set(key, (day.get(key) ?? 0) + redemption.gigabytes);
    byDay.set(redemption.day, day);
  }

  const points: RelayerDayPoint[] = [];
  for (let day = firstDay; day <= lastDay; day += 1) {
    const values = byDay.get(day);
    const point: RelayerDayPoint = { date: isoDate(day) };
    for (const key of series) point[key] = values?.get(key) ?? 0;
    points.push(point);
  }
  return { points, series };
}

/** Per-client usage, ranked by the caller, over both the recent window and all time. */
function clientUsage(redemptions: Redemption[], firstRecentDay: number): Client[] {
  const buckets = new Map<string, Client>();
  for (const redemption of redemptions) {
    const client = buckets.get(redemption.source) ?? {
      address: redemption.source,
      gigabytes7d: 0,
      gigabytesTotal: 0,
      redemptions7d: 0,
      redemptionsTotal: 0,
    };
    client.gigabytesTotal += redemption.gigabytes;
    client.redemptionsTotal += 1;
    if (redemption.day >= firstRecentDay) {
      client.gigabytes7d += redemption.gigabytes;
      client.redemptions7d += 1;
    }
    buckets.set(redemption.source, client);
  }
  return [...buckets.values()].sort((a, b) => b.gigabytesTotal - a.gigabytesTotal);
}

async function querySnapshot(): Promise<AnalyticsSnapshot> {
  const db = database();
  const warnings: string[] = [];

  // The summary is the only query the page cannot render without; the rest degrade
  // to an empty panel so one broken relation never blanks the whole dashboard.
  const summaryResult = await db.query<SummaryRow>(await sql("summary"));
  const summary = summaryResult.rows[0];
  if (!summary) throw new Error("Blokli chain_info is not initialized");

  const [channelBalances, safeBalances, redemptionRows, deploymentRows, winProbRows] =
    await Promise.allSettled([
      db.query<{ balance: Buffer }>(await sql("channel-balances")),
      db.query<{ balance: Buffer }>(await sql("safe-balances")),
      db.query<RedemptionRow>(await sql("redemptions")),
      db.query<DeploymentRow>(await sql("client-deployments")),
      db.query<WinProbRow>(await sql("win-prob-updates")),
    ]);

  const rawRedemptions =
    redemptionRows.status === "fulfilled" ? redemptionRows.value.rows : [];
  if (redemptionRows.status === "rejected") {
    warnings.push("Redemption history is unavailable; usage panels are empty.");
  }
  const rawDeployments =
    deploymentRows.status === "fulfilled" ? deploymentRows.value.rows : [];
  if (deploymentRows.status === "rejected") {
    warnings.push("Client deployments are unavailable; active users count redemptions only.");
  }

  // chain_info holds only the current winning probability. The raw log table, when
  // it lives in this database, carries the full oracle history instead.
  const currentWinProb = Number(summary.win_prob);
  const fallbackWinProb = Number.isFinite(currentWinProb) && currentWinProb > 0
    ? currentWinProb
    : 1;
  const timeline: Array<[number, number]> =
    winProbRows.status === "fulfilled"
      ? winProbRows.value.rows.map((row) => [
          Number(row.block_number),
          decodeWinProbability(row.win_prob),
        ])
      : [];

  let winProbability: AnalyticsSnapshot["winProbability"] = "historical";
  if (!timeline.length) {
    winProbability = Number.isFinite(currentWinProb) && currentWinProb > 0
      ? "current"
      : "assumed";
    warnings.push(
      winProbability === "current"
        ? "Winning probability history is unavailable; volume uses the current value throughout."
        : "Winning probability is not indexed; volume assumes a probability of 1.",
    );
  }
  const probabilityAt = winProbabilityAt(timeline, fallbackWinProb);

  const latestBlock = Number(summary.block_number);
  const blocks = [
    ...rawRedemptions.map((row) => Number(row.published_block)),
    ...rawDeployments.map((row) => Number(row.published_block)),
  ];
  const firstBlock = blocks.length ? Math.min(...blocks) : latestBlock;

  let timebase: AnalyticsSnapshot["timebase"] = "estimated";
  let clock = estimatedClock(latestBlock);
  if (process.env.RPC_URL) {
    try {
      clock = await resolveBlockClock(process.env.RPC_URL, firstBlock, latestBlock);
      timebase = "rpc";
    } catch {
      warnings.push("RPC timestamps are unavailable; dates are estimated from block height.");
    }
  }

  const redemptions: Redemption[] = rawRedemptions.map((row) => {
    const block = Number(row.published_block);
    const tickets = Number(row.tickets);
    return {
      source: hex(row.source),
      destination: hex(row.destination),
      block,
      day: dayIndex(clock(block)),
      tickets,
      gigabytes: redemptionVolume(probabilityAt(block)),
    };
  });

  const actorsByDay = new Map<number, Set<string>>();
  for (const redemption of redemptions) {
    const actors = actorsByDay.get(redemption.day) ?? new Set<string>();
    actors.add(redemption.source);
    actorsByDay.set(redemption.day, actors);
  }

  // A client's deployment day counts as activity in its own right, so add it to
  // the actor set as well as reporting it as a deployment.
  const deploymentsByDay = new Map<number, number>();
  for (const row of rawDeployments) {
    const day = dayIndex(clock(Number(row.published_block)));
    deploymentsByDay.set(day, (deploymentsByDay.get(day) ?? 0) + 1);
    const actors = actorsByDay.get(day) ?? new Set<string>();
    actors.add(hex(row.account));
    actorsByDay.set(day, actors);
  }

  const lastDay = dayIndex(clock(latestBlock));
  const activeUsers = activeUserSeries(actorsByDay, deploymentsByDay, lastDay);
  const weeks = weeklySeries(redemptions);
  const recent = redemptions.filter((redemption) => redemption.day > lastDay - WEEK_DAYS);
  const relayers = relayerDistribution(recent);
  const { points: relayerDaily, series: relayerSeries } = relayerDailySeries(
    redemptions,
    lastDay,
  );
  const allClients = clientUsage(redemptions, lastDay - WEEK_DAYS + 1);
  const deployments = rawDeployments
    .map((row) => ({
      address: hex(row.account),
      timestamp: new Date(clock(Number(row.published_block)) * 1000).toISOString(),
    }))
    .reverse()
    .slice(0, DEPLOYMENT_LIMIT);
  const latest = activeUsers.at(-1);
  const hasUsage = redemptionRows.status === "fulfilled";
  let latestWeekDeployments = 0;
  for (let offset = 0; offset < WEEK_DAYS; offset += 1) {
    latestWeekDeployments += deploymentsByDay.get(lastDay - offset) ?? 0;
  }
  const sum = (rows: Redemption[], pick: (row: Redemption) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);

  return {
    source: warnings.length ? "degraded" : "live",
    observedAt: new Date().toISOString(),
    timebase,
    winProbability,
    schemaVersion: summary.schema_version,
    blockNumber: latestBlock,
    accounts: Number(summary.accounts),
    safes: Number(summary.safes),
    openChannels: Number(summary.open_channels),
    channelBalance:
      channelBalances.status === "fulfilled" ? sumBalances(channelBalances.value.rows) : null,
    safeBalance:
      safeBalances.status === "fulfilled" ? sumBalances(safeBalances.value.rows) : null,
    activeUsers,
    weeks,
    relayers,
    relayerDaily,
    relayerSeries,
    clients: allClients.slice(0, CLIENT_LIMIT),
    clientCount: allClients.length,
    deployments,
    totals: {
      weeklyActiveUsers: latest?.weekly ?? null,
      monthlyActiveUsers: latest?.monthly ?? null,
      allTimeUsers: hasUsage
        ? new Set(redemptions.map((redemption) => redemption.source)).size
        : null,
      redemptions7d: hasUsage ? recent.length : null,
      redemptionsTotal: hasUsage ? redemptions.length : null,
      gigabytes7d: hasUsage ? sum(recent, (row) => row.gigabytes) : null,
      gigabytesTotal: hasUsage ? sum(redemptions, (row) => row.gigabytes) : null,
      ticketsTotal: hasUsage ? sum(redemptions, (row) => row.tickets) : null,
      relayers7d: hasUsage ? new Set(recent.map((row) => row.destination)).size : null,
      deployments7d: latestWeekDeployments,
      deployments30d: latest?.deployments ?? null,
      clientsDeployed: rawDeployments.length || null,
    },
    warnings,
  };
}

function unavailable(message: string): AnalyticsSnapshot {
  return {
    source: "unavailable",
    observedAt: new Date().toISOString(),
    timebase: "estimated",
    winProbability: "assumed",
    schemaVersion: null,
    blockNumber: 0,
    accounts: null,
    safes: null,
    openChannels: null,
    channelBalance: null,
    safeBalance: null,
    activeUsers: [],
    weeks: [],
    relayers: [],
    relayerDaily: [],
    relayerSeries: [],
    clients: [],
    clientCount: 0,
    deployments: [],
    totals: {
      weeklyActiveUsers: null,
      monthlyActiveUsers: null,
      allTimeUsers: null,
      redemptions7d: null,
      redemptionsTotal: null,
      gigabytes7d: null,
      gigabytesTotal: null,
      ticketsTotal: null,
      relayers7d: null,
      deployments7d: null,
      deployments30d: null,
      clientsDeployed: null,
    },
    warnings: [message],
  };
}

export async function loadAnalytics(): Promise<AnalyticsSnapshot> {
  if (cachedSnapshot && cachedSnapshot.expiresAt > Date.now()) {
    return cachedSnapshot.value;
  }
  try {
    const value = await querySnapshot();
    cachedSnapshot = { expiresAt: Date.now() + 60_000, value };
    return value;
  } catch (error) {
    return unavailable(
      error instanceof Error && error.message === "DATABASE_URL is not configured"
        ? error.message
        : "The Blokli index database is currently unavailable.",
    );
  }
}

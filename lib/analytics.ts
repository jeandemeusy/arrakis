import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { Pool, type QueryResultRow } from "pg";

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
/** Window shared by the daily panels: relayer stack, daily users. */
const RECENT_DAYS = 30;
/**
 * First day of the published active-user series.
 *
 * Matches `start_day` in the Dune queries. Client accounts predate the Gnosis VPN
 * programme, so without a floor the chart opens on a long flat run of zeros.
 */
const SERIES_START_DAY = Math.floor(Date.UTC(2026, 0, 1) / 1000 / DAY_SECONDS);
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
const CLIENT_LIMIT = 50;
const DEPLOYMENT_LIMIT = 100;
const REDEMPTION_FEED_LIMIT = 100;

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
  /** Position in `relayerSeries`, so a relayer keeps one colour across panels. */
  colorIndex: number;
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

export type DailyUserPoint = {
  date: string;
  newClients: number;
  returning: number;
};

export type HourPoint = {
  hour: string;
  share: number;
};

export type RecentRedemption = {
  timestamp: string;
  client: string;
  relayer: string;
  channelId: string;
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
  dailyUsers: DailyUserPoint[];
  hourly: HourPoint[];
  recentRedemptions: RecentRedemption[];
  ticket: {
    winProbability: number | null;
    priceWei: string | null;
    valueWei: string | null;
  };
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

type WinProbRow = QueryResultRow & {
  block_number: string;
  win_prob: Buffer;
};

type TicketPriceRow = QueryResultRow & {
  block_number: string;
  ticket_price: Buffer;
};

type Redemption = {
  channelId: string;
  source: string;
  destination: string;
  day: number;
  timestamp: number;
  tickets: number;
  gigabytes: number;
};

let pool: Pool | undefined;
const sqlCache = new Map<string, string>();
let cachedSnapshot: { expiresAt: number; value: AnalyticsSnapshot } | undefined;
let refreshing: Promise<AnalyticsSnapshot> | undefined;

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

/** Volume a redemption accounts for; a zero or unknown probability contributes none. */
function redemptionVolume(probability: number): number {
  return probability > 0 ? GIGABYTES_PER_REDEMPTION / probability : 0;
}

function sum<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
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

  // Trailing windows still read activity from before the start day; only the
  // plotted range is clamped.
  const points: ActiveUserPoint[] = [];
  for (let day = Math.max(days[0], SERIES_START_DAY); day <= lastDay; day += 1) {
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

/**
 * Relayer breakdown over the recent window: the ordering, the daily stack and the
 * share of redemptions.
 *
 * The stacked chart, the donut and the legend all read from one list of relayers,
 * ordered by volume, so a colour means the same relayer everywhere. Every relayer is
 * charted individually — nothing is rolled into an aggregate bucket.
 */
function relayerBreakdown(
  redemptions: Redemption[],
  lastDay: number,
): { series: string[]; daily: RelayerDayPoint[]; distribution: Relayer[] } {
  const firstDay = lastDay - RECENT_DAYS + 1;
  const window = redemptions.filter((redemption) => redemption.day >= firstDay);
  if (!window.length) return { series: [], daily: [], distribution: [] };

  const volumes = new Map<string, number>();
  const byDay = new Map<number, Map<string, number>>();
  for (const redemption of window) {
    volumes.set(
      redemption.destination,
      (volumes.get(redemption.destination) ?? 0) + redemption.gigabytes,
    );
    const day = byDay.get(redemption.day) ?? new Map<string, number>();
    day.set(
      redemption.destination,
      (day.get(redemption.destination) ?? 0) + redemption.gigabytes,
    );
    byDay.set(redemption.day, day);
  }

  // Ordered by volume over the stack's own window, which is the wider of the two,
  // so every relayer appearing in either panel has a place in this ordering.
  const series = [...volumes.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([address]) => address);
  const colorIndexOf = new Map(series.map((address, index) => [address, index]));

  const daily: RelayerDayPoint[] = [];
  for (let day = firstDay; day <= lastDay; day += 1) {
    const values = byDay.get(day);
    const point: RelayerDayPoint = { date: isoDate(day) };
    for (const address of series) point[address] = values?.get(address) ?? 0;
    daily.push(point);
  }

  // The share breakdown answers "who is carrying traffic now", so it reads the
  // trailing week rather than the whole stack window.
  const recent = window.filter((redemption) => redemption.day > lastDay - WEEK_DAYS);
  const totals = new Map<string, { redemptions: number; gigabytes: number }>();
  for (const redemption of recent) {
    const bucket = totals.get(redemption.destination) ?? { redemptions: 0, gigabytes: 0 };
    bucket.redemptions += 1;
    bucket.gigabytes += redemption.gigabytes;
    totals.set(redemption.destination, bucket);
  }
  const distribution = [...totals.entries()]
    .map(([address, bucket]) => ({
      address,
      redemptions: bucket.redemptions,
      gigabytes: bucket.gigabytes,
      share: bucket.redemptions / recent.length,
      colorIndex: colorIndexOf.get(address) ?? 0,
    }))
    .sort((a, b) => b.redemptions - a.redemptions);

  return { series, daily, distribution };
}

/**
 * New versus returning clients per day over the recent window.
 *
 * A client is new on the day it was first deployed and returning on any later day
 * it settles a redemption, so the two bands never double-count the same client.
 */
function dailyUserSeries(
  actorsByDay: Map<number, Set<string>>,
  deploymentDayOf: Map<string, number>,
  lastDay: number,
): DailyUserPoint[] {
  const firstDay = lastDay - RECENT_DAYS + 1;
  const points: DailyUserPoint[] = [];
  for (let day = firstDay; day <= lastDay; day += 1) {
    const actors = actorsByDay.get(day);
    let newClients = 0;
    let returning = 0;
    for (const actor of actors ?? []) {
      if (deploymentDayOf.get(actor) === day) newClients += 1;
      else returning += 1;
    }
    points.push({ date: isoDate(day), newClients, returning });
  }
  return points;
}

/** Share of relayed volume by hour of day, across the whole indexed history. */
function hourlyDistribution(redemptions: Redemption[]): HourPoint[] {
  if (!redemptions.length) return [];
  const hours = new Array<number>(24).fill(0);
  for (const redemption of redemptions) {
    hours[new Date(redemption.timestamp * 1000).getUTCHours()] += redemption.gigabytes;
  }
  const total = hours.reduce((sum, value) => sum + value, 0);
  if (total === 0) return [];
  return hours.map((value, hour) => ({
    hour: `${String(hour).padStart(2, "0")}:00`,
    share: value / total,
  }));
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

  const [
    channelBalances,
    safeBalances,
    redemptionRows,
    deploymentRows,
    winProbRows,
    ticketPriceRows,
  ] = await Promise.allSettled([
      db.query<{ balance: Buffer }>(await sql("channel-balances")),
      db.query<{ balance: Buffer }>(await sql("safe-balances")),
      db.query<RedemptionRow>(await sql("redemptions")),
      db.query<DeploymentRow>(await sql("client-deployments")),
      db.query<WinProbRow>(await sql("win-prob-updates")),
      db.query<TicketPriceRow>(await sql("ticket-price-updates")),
    ]);

  const rawRedemptions =
    redemptionRows.status === "fulfilled" ? redemptionRows.value.rows : [];
  if (redemptionRows.status === "rejected") {
    warnings.push("Redemption history is unavailable; usage panels are empty.");
  }
  if (ticketPriceRows.status === "rejected") {
    warnings.push("Ticket price history is unavailable; ticket parameters are empty.");
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
  const priceTimeline: Array<[number, bigint]> =
    ticketPriceRows.status === "fulfilled"
      ? ticketPriceRows.value.rows.map((row) => [
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
    const timestamp = clock(block);
    return {
      channelId: row.channel_id,
      source: hex(row.source),
      destination: hex(row.destination),
      day: dayIndex(timestamp),
      timestamp,
      tickets: Number(row.tickets),
      gigabytes: redemptionVolume(probabilityAt(block)),
    };
  });

  const actorsByDay = new Map<number, Set<string>>();
  for (const redemption of redemptions) {
    const actors = actorsByDay.get(redemption.day) ?? new Set<string>();
    actors.add(redemption.source);
    actorsByDay.set(redemption.day, actors);
  }

  // A client's deployment day counts as activity in its own right, so each one
  // joins the actor set as well as being reported as a deployment. Resolved once:
  // the daily counts, the per-client lookup and the feed all read from this list.
  const deployed = rawDeployments.map((row) => {
    const timestamp = clock(Number(row.published_block));
    return { address: hex(row.account), timestamp, day: dayIndex(timestamp) };
  });
  const deploymentsByDay = new Map<number, number>();
  const deploymentDayOf = new Map<string, number>();
  for (const client of deployed) {
    deploymentsByDay.set(client.day, (deploymentsByDay.get(client.day) ?? 0) + 1);
    deploymentDayOf.set(client.address, client.day);
    const actors = actorsByDay.get(client.day) ?? new Set<string>();
    actors.add(client.address);
    actorsByDay.set(client.day, actors);
  }

  const lastDay = dayIndex(clock(latestBlock));
  const activeUsers = activeUserSeries(actorsByDay, deploymentsByDay, lastDay);
  const weeks = weeklySeries(redemptions);
  const recent = redemptions.filter((redemption) => redemption.day > lastDay - WEEK_DAYS);
  const {
    series: relayerSeries,
    daily: relayerDaily,
    distribution: relayers,
  } = relayerBreakdown(redemptions, lastDay);
  const allClients = clientUsage(redemptions, lastDay - WEEK_DAYS + 1);

  // Both queries return oldest first, so the feeds are the tail, newest first.
  const deployments = deployed
    .slice(-DEPLOYMENT_LIMIT)
    .reverse()
    .map((client) => ({
      address: client.address,
      timestamp: new Date(client.timestamp * 1000).toISOString(),
    }));
  const recentRedemptions = redemptions
    .slice(-REDEMPTION_FEED_LIMIT)
    .reverse()
    .map((redemption) => ({
      timestamp: new Date(redemption.timestamp * 1000).toISOString(),
      client: redemption.source,
      relayer: redemption.destination,
      channelId: redemption.channelId,
    }));
  const currentProbability = timeline.at(-1)?.[1] ?? null;
  const currentPrice = priceTimeline.at(-1)?.[1] ?? null;
  const latest = activeUsers.at(-1);
  const hasUsage = redemptionRows.status === "fulfilled";
  const hasDeployments = deploymentRows.status === "fulfilled";
  let deployments7d = 0;
  for (let offset = 0; offset < WEEK_DAYS; offset += 1) {
    deployments7d += deploymentsByDay.get(lastDay - offset) ?? 0;
  }
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
    dailyUsers: dailyUserSeries(actorsByDay, deploymentDayOf, lastDay),
    hourly: hourlyDistribution(redemptions),
    recentRedemptions,
    ticket: {
      winProbability: currentProbability,
      priceWei: currentPrice?.toString() ?? null,
      valueWei:
        currentPrice !== null && currentProbability
          ? BigInt(Math.round(Number(currentPrice) / currentProbability)).toString()
          : null,
    },
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
      deployments7d: hasDeployments ? deployments7d : null,
      deployments30d: hasDeployments ? (latest?.deployments ?? null) : null,
      clientsDeployed: hasDeployments ? deployed.length : null,
    },
    warnings,
  };
}

/** Every metric unknown: the shape the page renders when a query yields nothing. */
const EMPTY_TOTALS: AnalyticsSnapshot["totals"] = {
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
};

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
    dailyUsers: [],
    hourly: [],
    recentRedemptions: [],
    ticket: { winProbability: null, priceWei: null, valueWei: null },
    totals: EMPTY_TOTALS,
    warnings: [message],
  };
}

/**
 * Runs the queries once and caches the outcome, successful or not.
 *
 * Failures are cached too, on a shorter clock: without that, an unreachable index
 * database would have every request re-run every query and wait out the statement
 * timeout, putting the most pressure on the database exactly when it is failing.
 */
async function refreshSnapshot(): Promise<AnalyticsSnapshot> {
  try {
    const value = await querySnapshot();
    cachedSnapshot = { expiresAt: Date.now() + SNAPSHOT_TTL_MS, value };
    return value;
  } catch (error) {
    const value = unavailable(
      error instanceof Error && error.message === "DATABASE_URL is not configured"
        ? error.message
        : "The Blokli index database is currently unavailable.",
    );
    cachedSnapshot = { expiresAt: Date.now() + FAILURE_TTL_MS, value };
    return value;
  } finally {
    refreshing = undefined;
  }
}

/**
 * The cached analytics snapshot, refreshing it when stale.
 *
 * Concurrent callers that arrive during a refresh share the one in-flight run. A
 * page view costs no database work of its own: without this, every request landing
 * in the window between expiry and the next snapshot would start its own full set
 * of queries, which is precisely when a burst of traffic arrives.
 */
export async function loadAnalytics(): Promise<AnalyticsSnapshot> {
  if (cachedSnapshot && cachedSnapshot.expiresAt > Date.now()) {
    return cachedSnapshot.value;
  }
  refreshing ??= refreshSnapshot();
  return refreshing;
}

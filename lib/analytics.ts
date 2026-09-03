import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { Pool, type QueryResultRow } from "pg";

import { resolveBlockClock, type BlockClock } from "./rpc";

/** Application payload carried by one HOPR packet (`HoprPacket::PAYLOAD_SIZE`). */
const PACKET_PAYLOAD_BYTES = 1038;
/** Gnosis block cadence, used to place blocks in time when no RPC is configured. */
const BLOCK_SECONDS = 5;
const DAY_SECONDS = 86_400;
const WEEK_DAYS = 7;
const MONTH_DAYS = 30;
const RELAYER_LIMIT = 12;

export type ActiveUserPoint = {
  date: string;
  weekly: number;
  monthly: number;
};

export type WeekPoint = {
  key: string;
  label: string;
  redemptions: number;
  megabytes: number;
  redeemedWei: string;
};

export type Relayer = {
  address: string;
  redemptions: number;
  redeemedWei: string;
  share: number;
};

export type AnalyticsSnapshot = {
  source: "live" | "degraded" | "unavailable";
  observedAt: string;
  timebase: "rpc" | "estimated";
  schemaVersion: string | null;
  blockNumber: number;
  ticketPriceWei: string | null;
  accounts: number | null;
  safes: number | null;
  openChannels: number | null;
  channelBalance: string | null;
  safeBalance: string | null;
  activeUsers: ActiveUserPoint[];
  weeks: WeekPoint[];
  relayers: Relayer[];
  totals: {
    weeklyActiveUsers: number | null;
    monthlyActiveUsers: number | null;
    redemptions7d: number | null;
    redemptionsTotal: number | null;
    megabytes7d: number | null;
    megabytesTotal: number | null;
    redeemedWeiTotal: string | null;
  };
  warnings: string[];
};

type SummaryRow = QueryResultRow & {
  schema_version: string;
  block_number: string;
  ticket_price: Buffer | null;
  accounts: string;
  safes: string;
  open_channels: string;
};

type RedemptionRow = QueryResultRow & {
  source: Buffer;
  destination: Buffer;
  published_block: string;
  tickets: string;
  balance_before: Buffer;
  balance_after: Buffer;
};

type AnnouncementRow = QueryResultRow & {
  account: Buffer;
  published_block: string;
};

type Redemption = {
  source: string;
  destination: string;
  block: number;
  day: number;
  amount: bigint;
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
 * Converts redeemed wxHOPR into relayed payload bytes.
 *
 * Each packet issues exactly one ticket priced at the network ticket price, and a
 * ticket's face value already carries the 1/winning-probability multiplier, so the
 * redeemed value divided by the ticket price is the expected number of packets paid
 * for. This counts one relay hop: a packet crossing several paid hops is counted
 * once per hop it pays for.
 */
function megabytes(redeemedWei: bigint, ticketPrice: bigint | null): number {
  if (!ticketPrice || ticketPrice === 0n) return 0;
  const scaledPackets = Number((redeemedWei * 1_000n) / ticketPrice) / 1_000;
  return (scaledPackets * PACKET_PAYLOAD_BYTES) / 1_000_000;
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
 * An account is active on a given day's window when it was the source of a channel
 * that saw a redemption inside the window, or when it announced inside the window.
 */
function activeUserSeries(
  actorsByDay: Map<number, Set<string>>,
  lastDay: number,
): ActiveUserPoint[] {
  const days = [...actorsByDay.keys()].sort((a, b) => a - b);
  if (!days.length) return [];
  const firstDay = days[0];

  const points: ActiveUserPoint[] = [];
  for (let day = firstDay; day <= lastDay; day += 1) {
    const weekly = new Set<string>();
    const monthly = new Set<string>();
    for (let offset = 0; offset < MONTH_DAYS; offset += 1) {
      const actors = actorsByDay.get(day - offset);
      if (!actors) continue;
      for (const actor of actors) {
        monthly.add(actor);
        if (offset < WEEK_DAYS) weekly.add(actor);
      }
    }
    points.push({ date: isoDate(day), weekly: weekly.size, monthly: monthly.size });
  }
  return points;
}

function weeklySeries(redemptions: Redemption[], ticketPrice: bigint | null): WeekPoint[] {
  const buckets = new Map<number, { redemptions: number; amount: bigint }>();
  for (const redemption of redemptions) {
    // Anchor each week to the Monday that contains it. Day 0 of the unix epoch was
    // a Thursday, so shift by 3 before flooring.
    const week = Math.floor((redemption.day + 3) / 7) * 7 - 3;
    const bucket = buckets.get(week) ?? { redemptions: 0, amount: 0n };
    bucket.redemptions += 1;
    bucket.amount += redemption.amount;
    buckets.set(week, bucket);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([week, bucket]) => ({
      key: isoDate(week),
      label: new Intl.DateTimeFormat("en", {
        day: "2-digit",
        month: "short",
        timeZone: "UTC",
      }).format(new Date(week * DAY_SECONDS * 1000)),
      redemptions: bucket.redemptions,
      megabytes: megabytes(bucket.amount, ticketPrice),
      redeemedWei: bucket.amount.toString(),
    }));
}

function relayerDistribution(recent: Redemption[]): Relayer[] {
  const buckets = new Map<string, { redemptions: number; amount: bigint }>();
  for (const redemption of recent) {
    const bucket = buckets.get(redemption.destination) ?? { redemptions: 0, amount: 0n };
    bucket.redemptions += 1;
    bucket.amount += redemption.amount;
    buckets.set(redemption.destination, bucket);
  }

  const total = recent.length || 1;
  return [...buckets.entries()]
    .map(([address, bucket]) => ({
      address,
      redemptions: bucket.redemptions,
      redeemedWei: bucket.amount.toString(),
      share: bucket.redemptions / total,
    }))
    .sort((a, b) => b.redemptions - a.redemptions)
    .slice(0, RELAYER_LIMIT);
}

async function querySnapshot(): Promise<AnalyticsSnapshot> {
  const db = database();
  const warnings: string[] = [];

  // The summary is the only query the page cannot render without; the rest degrade
  // to an empty panel so one broken relation never blanks the whole dashboard.
  const summaryResult = await db.query<SummaryRow>(await sql("summary"));
  const summary = summaryResult.rows[0];
  if (!summary) throw new Error("Blokli chain_info is not initialized");

  const [channelBalances, safeBalances, redemptionRows, announcementRows] =
    await Promise.allSettled([
      db.query<{ balance: Buffer }>(await sql("channel-balances")),
      db.query<{ balance: Buffer }>(await sql("safe-balances")),
      db.query<RedemptionRow>(await sql("redemptions")),
      db.query<AnnouncementRow>(await sql("announcements")),
    ]);

  const ticketPrice = summary.ticket_price ? fromBigEndian(summary.ticket_price) : null;
  if (!ticketPrice) {
    warnings.push("Ticket price is not indexed yet; data volume cannot be derived.");
  }

  const rawRedemptions =
    redemptionRows.status === "fulfilled" ? redemptionRows.value.rows : [];
  const rawAnnouncements =
    announcementRows.status === "fulfilled" ? announcementRows.value.rows : [];
  if (redemptionRows.status === "rejected") {
    warnings.push("Redemption history is unavailable; usage panels are empty.");
  }
  if (announcementRows.status === "rejected") {
    warnings.push("Announcements are unavailable; active users count redemptions only.");
  }

  const latestBlock = Number(summary.block_number);
  const blocks = [
    ...rawRedemptions.map((row) => Number(row.published_block)),
    ...rawAnnouncements.map((row) => Number(row.published_block)),
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
    return {
      source: hex(row.source),
      destination: hex(row.destination),
      block,
      day: dayIndex(clock(block)),
      amount: fromBigEndian(row.balance_before) - fromBigEndian(row.balance_after),
    };
  });

  const actorsByDay = new Map<number, Set<string>>();
  const addActor = (day: number, actor: string) => {
    const actors = actorsByDay.get(day) ?? new Set<string>();
    actors.add(actor);
    actorsByDay.set(day, actors);
  };
  for (const redemption of redemptions) addActor(redemption.day, redemption.source);
  for (const row of rawAnnouncements) {
    addActor(dayIndex(clock(Number(row.published_block))), hex(row.account));
  }

  const lastDay = dayIndex(clock(latestBlock));
  const activeUsers = activeUserSeries(actorsByDay, lastDay);
  const weeks = weeklySeries(redemptions, ticketPrice);
  const recent = redemptions.filter((redemption) => redemption.day > lastDay - WEEK_DAYS);
  const redeemedTotal = redemptions.reduce((total, row) => total + row.amount, 0n);
  const redeemedRecent = recent.reduce((total, row) => total + row.amount, 0n);
  const latest = activeUsers.at(-1);
  const hasUsage = redemptionRows.status === "fulfilled";

  return {
    source: warnings.length ? "degraded" : "live",
    observedAt: new Date().toISOString(),
    timebase,
    schemaVersion: summary.schema_version,
    blockNumber: latestBlock,
    ticketPriceWei: ticketPrice?.toString() ?? null,
    accounts: Number(summary.accounts),
    safes: Number(summary.safes),
    openChannels: Number(summary.open_channels),
    channelBalance:
      channelBalances.status === "fulfilled" ? sumBalances(channelBalances.value.rows) : null,
    safeBalance:
      safeBalances.status === "fulfilled" ? sumBalances(safeBalances.value.rows) : null,
    activeUsers,
    weeks,
    relayers: relayerDistribution(recent),
    totals: {
      weeklyActiveUsers: latest?.weekly ?? null,
      monthlyActiveUsers: latest?.monthly ?? null,
      redemptions7d: hasUsage ? recent.length : null,
      redemptionsTotal: hasUsage ? redemptions.length : null,
      megabytes7d: hasUsage ? megabytes(redeemedRecent, ticketPrice) : null,
      megabytesTotal: hasUsage ? megabytes(redeemedTotal, ticketPrice) : null,
      redeemedWeiTotal: hasUsage ? redeemedTotal.toString() : null,
    },
    warnings,
  };
}

function unavailable(message: string): AnalyticsSnapshot {
  return {
    source: "unavailable",
    observedAt: new Date().toISOString(),
    timebase: "estimated",
    schemaVersion: null,
    blockNumber: 0,
    ticketPriceWei: null,
    accounts: null,
    safes: null,
    openChannels: null,
    channelBalance: null,
    safeBalance: null,
    activeUsers: [],
    weeks: [],
    relayers: [],
    totals: {
      weeklyActiveUsers: null,
      monthlyActiveUsers: null,
      redemptions7d: null,
      redemptionsTotal: null,
      megabytes7d: null,
      megabytesTotal: null,
      redeemedWeiTotal: null,
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

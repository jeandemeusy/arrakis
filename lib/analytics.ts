import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { Pool, type QueryResultRow } from "pg";

import { resolveBlockTimestamps } from "./rpc";

export type ActivityPoint = {
  key: string;
  label: string;
  activeParticipants: number;
  redemptions: number;
  redeemedWei: string;
};

export type AnalyticsSnapshot = {
  source: "live" | "unavailable";
  axisMode: "time" | "block";
  observedAt: string;
  blokliUrl: string | null;
  schemaVersion: string | null;
  blockNumber: number;
  accounts: number | null;
  safes: number | null;
  openChannels: number | null;
  exits: number | null;
  channelBalance: string | null;
  safeBalance: string | null;
  activity: ActivityPoint[];
  warning: string | null;
};

type SummaryRow = QueryResultRow & {
  schema_version: string;
  block_number: string;
  accounts: string;
  safes: string;
  open_channels: string;
  exits: string;
};

type ActivityRow = QueryResultRow & {
  safe_address: Buffer;
  redeemed_amount: Buffer;
  published_block: string;
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
    statement_timeout: 15_000,
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

function sumBalances(rows: Array<{ balance: Buffer }>): string {
  return rows.reduce((total, row) => total + fromBigEndian(row.balance), 0n).toString();
}

function blockBuckets(rows: ActivityRow[]): ActivityPoint[] {
  if (!rows.length) return [];
  const first = Number(rows[0].published_block);
  const last = Number(rows.at(-1)?.published_block ?? first);
  const width = Math.max(1, Math.ceil((last - first + 1) / 12));
  return aggregate(rows, (row) => {
    const start = first + Math.floor((Number(row.published_block) - first) / width) * width;
    return {
      key: String(start).padStart(16, "0"),
      label: `#${new Intl.NumberFormat("en", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(start)}`,
    };
  });
}

function timeBuckets(rows: ActivityRow[], timestamps: Map<number, number>): ActivityPoint[] {
  return aggregate(rows, (row) => {
    const timestamp = timestamps.get(Number(row.published_block)) as number;
    const date = new Date(timestamp * 1000);
    const monday = new Date(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate() - ((date.getUTCDay() + 6) % 7),
      ),
    );
    return {
      key: monday.toISOString().slice(0, 10),
      label: new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", timeZone: "UTC" }).format(monday),
    };
  });
}

function aggregate(
  rows: ActivityRow[],
  bucket: (row: ActivityRow) => { key: string; label: string },
): ActivityPoint[] {
  const points = new Map<string, ActivityPoint & { participants: Set<string> }>();
  for (const row of rows) {
    const { key, label } = bucket(row);
    const point = points.get(key) ?? {
      key,
      label,
      activeParticipants: 0,
      redemptions: 0,
      redeemedWei: "0",
      participants: new Set<string>(),
    };
    point.participants.add(row.safe_address.toString("hex"));
    point.redemptions += 1;
    point.redeemedWei = (BigInt(point.redeemedWei) + fromBigEndian(row.redeemed_amount)).toString();
    points.set(key, point);
  }
  return [...points.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(-16)
    .map(({ participants, ...point }) => ({
      ...point,
      activeParticipants: participants.size,
    }));
}

async function querySnapshot(): Promise<AnalyticsSnapshot> {
  const db = database();
  const [summaryResult, channelBalances, safeBalances, activityResult] = await Promise.all([
    db.query<SummaryRow>(await sql("summary")),
    db.query<{ balance: Buffer }>(await sql("channel-balances")),
    db.query<{ balance: Buffer }>(await sql("safe-balances")),
    db.query<ActivityRow>(await sql("ticket-activity")),
  ]);
  const summary = summaryResult.rows[0];
  if (!summary) throw new Error("Blokli chain_info is not initialized");

  let axisMode: "time" | "block" = "block";
  let activity = blockBuckets(activityResult.rows);
  let warning: string | null = null;
  if (process.env.RPC_URL && activityResult.rows.length) {
    try {
      const timestamps = await resolveBlockTimestamps(
        process.env.RPC_URL,
        activityResult.rows.map((row) => Number(row.published_block)),
      );
      activity = timeBuckets(activityResult.rows, timestamps);
      axisMode = "time";
    } catch {
      warning = "RPC timestamps are unavailable; showing block-number buckets.";
    }
  }

  return {
    source: "live",
    axisMode,
    observedAt: new Date().toISOString(),
    blokliUrl: process.env.BLOKLI_URL ?? null,
    schemaVersion: summary.schema_version,
    blockNumber: Number(summary.block_number),
    accounts: Number(summary.accounts),
    safes: Number(summary.safes),
    openChannels: Number(summary.open_channels),
    exits: Number(summary.exits),
    channelBalance: sumBalances(channelBalances.rows),
    safeBalance: sumBalances(safeBalances.rows),
    activity,
    warning,
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
    return {
      source: "unavailable",
      axisMode: process.env.RPC_URL ? "time" : "block",
      observedAt: new Date().toISOString(),
      blokliUrl: process.env.BLOKLI_URL ?? null,
      schemaVersion: null,
      blockNumber: 0,
      accounts: null,
      safes: null,
      openChannels: null,
      exits: null,
      channelBalance: null,
      safeBalance: null,
      activity: [],
      warning:
        error instanceof Error &&
        error.message === "DATABASE_URL is not configured"
          ? error.message
          : "The Blokli index database is currently unavailable.",
    };
  }
}

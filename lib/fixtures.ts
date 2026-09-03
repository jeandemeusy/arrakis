import type {
  ActiveUserPoint,
  AnalyticsSnapshot,
  Client,
  DailyUserPoint,
  Deployment,
  HourPoint,
  RecentRedemption,
  Relayer,
  RelayerDayPoint,
  WeekPoint,
} from "./analytics";

/**
 * A synthetic snapshot for working on the UI without a database.
 *
 * Enabled with `DASHBOARD_FIXTURES=1`. The generator is seeded, so reloads render
 * the same numbers and a styling change is the only thing that moves between two
 * screenshots. It deliberately produces a long relayer tail, a wide client spread
 * and uneven daily activity, because those are the shapes that break layouts.
 *
 * This fabricates the finished snapshot rather than exercising the aggregation in
 * `analytics.ts`, so it validates rendering only — never treat agreement here as
 * evidence that the real derivations are correct.
 */

const DAY_SECONDS = 86_400;
const RELAYER_COUNT = 14;
const CLIENT_COUNT = 60;
const RECENT_DAYS = 30;
const WEEK_DAYS = 7;
const SEED = 0x5eed;

/** Deterministic PRNG (mulberry32) so the fixture never shifts between reloads. */
function random(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function address(next: () => number): string {
  let out = "0x";
  for (let i = 0; i < 40; i += 1) out += Math.floor(next() * 16).toString(16);
  return out;
}

function dayIndex(seconds: number): number {
  return Math.floor(seconds / DAY_SECONDS);
}

function isoDate(day: number): string {
  return new Date(day * DAY_SECONDS * 1000).toISOString().slice(0, 10);
}

function weekLabel(day: number): string {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(day * DAY_SECONDS * 1000));
}

export function fixtureSnapshot(): AnalyticsSnapshot {
  const next = random(SEED);
  const lastDay = dayIndex(Date.now() / 1000);
  const startDay = dayIndex(Date.UTC(2026, 0, 1) / 1000);
  const days = Math.max(1, lastDay - startDay + 1);

  const relayers = Array.from({ length: RELAYER_COUNT }, () => address(next));
  const clients = Array.from({ length: CLIENT_COUNT }, () => address(next));

  // Each client appears at some point in the window and stays around afterwards.
  const deployedOn = new Map<string, number>();
  clients.forEach((client, index) => {
    deployedOn.set(client, startDay + Math.floor((index / CLIENT_COUNT) * days * 0.9));
  });

  // One synthetic redemption stream drives every panel, so the totals agree with
  // the series the way they would with real data.
  type Row = { day: number; second: number; client: string; relayer: string };
  const rows: Row[] = [];
  for (let day = startDay; day <= lastDay; day += 1) {
    const ramp = Math.min(1, (day - startDay) / (days * 0.4));
    const wobble = 0.55 + 0.45 * Math.sin((day - startDay) / 9);
    const active = clients.filter((client) => (deployedOn.get(client) ?? 0) <= day);
    const count = Math.round(active.length * 0.35 * ramp * wobble * (0.6 + next()));
    for (let i = 0; i < count; i += 1) {
      // Traffic clusters in the working day rather than spreading evenly.
      const hour = Math.floor(6 + next() * 14);
      rows.push({
        day,
        second: day * DAY_SECONDS + hour * 3600 + Math.floor(next() * 3600),
        client: active[Math.floor(next() * active.length)],
        // A skewed pick gives the long tail the donut and stack need to be tested.
        relayer: relayers[Math.floor(next() ** 2 * relayers.length)],
      });
    }
  }

  const winProbability = 0.000004;
  const priceWei = 10_000_000_000_000n;
  const perRedemption = 650 / 2 ** 30 / winProbability;
  const volumeOf = (n: number) => n * perRedemption;

  // --- Active users: trailing windows over the day each client was seen.
  const seenByDay = new Map<number, Set<string>>();
  for (const row of rows) {
    const set = seenByDay.get(row.day) ?? new Set<string>();
    set.add(row.client);
    seenByDay.set(row.day, set);
  }
  for (const [client, day] of deployedOn) {
    const set = seenByDay.get(day) ?? new Set<string>();
    set.add(client);
    seenByDay.set(day, set);
  }

  const deployedPerDay = new Map<number, number>();
  for (const day of deployedOn.values()) {
    deployedPerDay.set(day, (deployedPerDay.get(day) ?? 0) + 1);
  }

  const activeUsers: ActiveUserPoint[] = [];
  for (let day = startDay; day <= lastDay; day += 1) {
    const weekly = new Set<string>();
    const monthly = new Set<string>();
    let deployments = 0;
    for (let offset = 0; offset < 31; offset += 1) {
      deployments += deployedPerDay.get(day - offset) ?? 0;
      for (const client of seenByDay.get(day - offset) ?? []) {
        monthly.add(client);
        if (offset < WEEK_DAYS) weekly.add(client);
      }
    }
    activeUsers.push({
      date: isoDate(day),
      weekly: weekly.size,
      monthly: monthly.size,
      deployments,
    });
  }

  // --- Weekly volume and redemptions, with running totals.
  const weekBuckets = new Map<number, { redemptions: number; tickets: number }>();
  for (const row of rows) {
    const week = Math.floor((row.day + 3) / 7) * 7 - 3;
    const bucket = weekBuckets.get(week) ?? { redemptions: 0, tickets: 0 };
    bucket.redemptions += 1;
    bucket.tickets += 30 + Math.floor(next() * 60);
    weekBuckets.set(week, bucket);
  }
  let cumulativeRedemptions = 0;
  let cumulativeGigabytes = 0;
  const weeks: WeekPoint[] = [...weekBuckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([week, bucket]) => {
      cumulativeRedemptions += bucket.redemptions;
      cumulativeGigabytes += volumeOf(bucket.redemptions);
      return {
        key: isoDate(week),
        label: weekLabel(week),
        redemptions: bucket.redemptions,
        tickets: bucket.tickets,
        gigabytes: volumeOf(bucket.redemptions),
        cumulativeRedemptions,
        cumulativeGigabytes,
      };
    });

  // --- Relayers: ordered by 30-day volume, share measured over 7 days.
  const recentRows = rows.filter((row) => row.day > lastDay - RECENT_DAYS);
  const weekRows = rows.filter((row) => row.day > lastDay - WEEK_DAYS);
  const byRelayer = new Map<string, number>();
  for (const row of recentRows) {
    byRelayer.set(row.relayer, (byRelayer.get(row.relayer) ?? 0) + 1);
  }
  const relayerSeries = [...byRelayer.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([relayer]) => relayer);
  const colorIndexOf = new Map(relayerSeries.map((relayer, index) => [relayer, index]));

  const hitsPerDay = new Map<number, Map<string, number>>();
  for (const row of recentRows) {
    const day = hitsPerDay.get(row.day) ?? new Map<string, number>();
    day.set(row.relayer, (day.get(row.relayer) ?? 0) + 1);
    hitsPerDay.set(row.day, day);
  }
  const relayerDaily: RelayerDayPoint[] = [];
  for (let day = lastDay - RECENT_DAYS + 1; day <= lastDay; day += 1) {
    const hits = hitsPerDay.get(day);
    const point: RelayerDayPoint = { date: isoDate(day) };
    for (const relayer of relayerSeries) point[relayer] = volumeOf(hits?.get(relayer) ?? 0);
    relayerDaily.push(point);
  }

  const weekByRelayer = new Map<string, number>();
  for (const row of weekRows) {
    weekByRelayer.set(row.relayer, (weekByRelayer.get(row.relayer) ?? 0) + 1);
  }
  const relayerDistribution: Relayer[] = [...weekByRelayer.entries()]
    .map(([relayer, hits]) => ({
      address: relayer,
      redemptions: hits,
      gigabytes: volumeOf(hits),
      share: hits / Math.max(1, weekRows.length),
      colorIndex: colorIndexOf.get(relayer) ?? 0,
    }))
    .sort((a, b) => b.redemptions - a.redemptions);

  // --- Per-client usage.
  const clientTotals = new Map<string, { week: number; all: number }>();
  for (const row of rows) {
    const bucket = clientTotals.get(row.client) ?? { week: 0, all: 0 };
    bucket.all += 1;
    if (row.day > lastDay - WEEK_DAYS) bucket.week += 1;
    clientTotals.set(row.client, bucket);
  }
  const clientList: Client[] = [...clientTotals.entries()]
    .map(([client, bucket]) => ({
      address: client,
      gigabytes7d: volumeOf(bucket.week),
      gigabytesTotal: volumeOf(bucket.all),
      redemptions7d: bucket.week,
      redemptionsTotal: bucket.all,
    }))
    .sort((a, b) => b.gigabytesTotal - a.gigabytesTotal);

  // --- Daily users over the recent window.
  const dailyUsers: DailyUserPoint[] = [];
  for (let day = lastDay - RECENT_DAYS + 1; day <= lastDay; day += 1) {
    let newClients = 0;
    let returning = 0;
    for (const client of seenByDay.get(day) ?? []) {
      if (deployedOn.get(client) === day) newClients += 1;
      else returning += 1;
    }
    dailyUsers.push({ date: isoDate(day), newClients, returning });
  }

  // --- Hour-of-day share of volume.
  const hours = Array.from({ length: 24 }, () => 0);
  for (const row of rows) hours[new Date(row.second * 1000).getUTCHours()] += 1;
  const hourTotal = hours.reduce((total, value) => total + value, 0) || 1;
  const hourly: HourPoint[] = hours.map((value, hour) => ({
    hour: `${String(hour).padStart(2, "0")}:00`,
    share: value / hourTotal,
  }));

  const deployments: Deployment[] = [...deployedOn.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 100)
    .map(([client, day]) => ({
      address: client,
      timestamp: new Date((day * DAY_SECONDS + 43_200) * 1000).toISOString(),
    }));

  const recentRedemptions: RecentRedemption[] = rows
    .slice(-100)
    .reverse()
    .map((row) => ({
      timestamp: new Date(row.second * 1000).toISOString(),
      client: row.client,
      relayer: row.relayer,
      channelId: address(next).slice(2).padEnd(64, "0"),
    }));

  const latest = activeUsers.at(-1);
  return {
    source: "live",
    observedAt: new Date().toISOString(),
    timebase: "rpc",
    winProbability: "historical",
    schemaVersion: "1.5.0-fixture",
    blockNumber: 48_060_000,
    accounts: CLIENT_COUNT + RELAYER_COUNT,
    safes: 80,
    openChannels: 132,
    channelBalance: (4200n * 10n ** 18n).toString(),
    safeBalance: (91_000n * 10n ** 18n).toString(),
    activeUsers,
    weeks,
    relayers: relayerDistribution,
    relayerDaily,
    relayerSeries,
    clients: clientList.slice(0, 50),
    clientCount: clientList.length,
    deployments,
    dailyUsers,
    hourly,
    recentRedemptions,
    ticket: {
      winProbability,
      priceWei: priceWei.toString(),
      valueWei: BigInt(Math.round(Number(priceWei) / winProbability)).toString(),
    },
    totals: {
      weeklyActiveUsers: latest?.weekly ?? null,
      monthlyActiveUsers: latest?.monthly ?? null,
      allTimeUsers: clientList.length,
      redemptions7d: weekRows.length,
      redemptionsTotal: rows.length,
      gigabytes7d: volumeOf(weekRows.length),
      gigabytesTotal: volumeOf(rows.length),
      ticketsTotal: weeks.reduce((total, week) => total + week.tickets, 0),
      relayers7d: weekByRelayer.size,
      deployments7d: [...deployedOn.values()].filter((day) => day > lastDay - WEEK_DAYS)
        .length,
      deployments30d: latest?.deployments ?? null,
      clientsDeployed: clients.length,
    },
    warnings: ["Fixture data — DASHBOARD_FIXTURES is enabled, nothing here is real."],
  };
}

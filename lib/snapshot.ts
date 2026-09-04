/**
 * Turns per-network datasets into the snapshot the page renders.
 *
 * Everything here is pure: the same builder produces a single network's view from
 * one dataset and the combined view from several, so the two can never drift apart.
 * Aggregation happens over redemptions that already carry their own network's
 * winning probability, which is why a combined volume is correct even when the
 * networks price traffic differently.
 */

export const DAY_SECONDS = 86_400;
/** Payload one redemption accounts for, before the winning-probability scale. */
export const GIGABYTES_PER_REDEMPTION = 650 / 2 ** 30;

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
/**
 * The redemption feed is the one unbounded list — a busy network has tens of
 * thousands — so it keeps a cap while clients and deployments are sent whole.
 * Every snapshot carries its own copy and the combined view carries them all
 * again, so this number is multiplied by the number of configured networks.
 */
const REDEMPTION_FEED_LIMIT = 500;

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
  cumulativeGigabytes: number;
};

export type Relayer = {
  /** Unique across networks, so it can key a chart series and a React list. */
  key: string;
  address: string;
  network: string;
  redemptions: number;
  gigabytes: number;
  share: number;
  /** Position in `relayerSeries`, so a relayer keeps one colour across panels. */
  colorIndex: number;
};

/** A charted relayer: the key names its series, the rest label it. */
export type RelayerSeries = {
  key: string;
  address: string;
  network: string;
};

/**
 * One day of relayed volume, keyed by relayer, for the stacked chart.
 *
 * A relayer that carried nothing that day is null rather than zero: recharts drops
 * null entries from the tooltip, so a quiet relayer does not pad the list with a
 * row of zeros.
 */
export type RelayerDayPoint = { date: string } & Record<
  string,
  number | string | null
>;

export type Client = {
  key: string;
  address: string;
  network: string;
  gigabytes7d: number;
  gigabytesTotal: number;
  redemptions7d: number;
  redemptionsTotal: number;
};

export type Deployment = {
  key: string;
  address: string;
  network: string;
  timestamp: string;
};

export type DailyUserPoint = {
  date: string;
  newClients: number;
  returning: number;
};

/**
 * Share of relayed volume by weekday and hour: seven rows of twenty-four.
 *
 * Row 0 is Monday. Sent as a bare grid rather than 168 labelled objects, which is
 * a fifth of the payload for the same information.
 */
export type Heatmap = number[][];

/**
 * One deployment cohort's retention.
 *
 * `retention[0]` is the share of the cohort that relayed traffic in the month it
 * was deployed, `[1]` the month after, and so on. Shorter for recent cohorts:
 * months that have not happened yet are absent rather than zero, so a young
 * cohort is not mistaken for a churned one.
 */
export type RetentionCohort = {
  month: string;
  label: string;
  size: number;
  retention: number[];
};

/** A contract the index watches, named by the events it is registered for. */
export type Contract = {
  key: string;
  address: string;
  network: string;
  role: string;
};

/**
 * Whether the queries behind one group of panels answered.
 *
 * An empty panel and a broken one look identical once the numbers are gone, and
 * they mean opposite things: one says the network was quiet, the other says the
 * dashboard is quietly lying by omission. Carrying the reason lets the tile say
 * which of the two it is.
 *
 * `partial` exists only in the combined view, where some networks answered and
 * others did not, so the figures are real but incomplete.
 */
export type PanelStatus = {
  state: 'ok' | 'partial' | 'failed';
  reason: string | null;
};

/** Panels are grouped by the query they depend on, not by where they are drawn. */
export type PanelKey = 'usage' | 'deployments' | 'ticket' | 'balances';
export type Panels = Record<PanelKey, PanelStatus>;

export const PANEL_KEYS: PanelKey[] = [
  'usage',
  'deployments',
  'ticket',
  'balances',
];

export function healthyPanels(): Panels {
  return {
    usage: { state: 'ok', reason: null },
    deployments: { state: 'ok', reason: null },
    ticket: { state: 'ok', reason: null },
    balances: { state: 'ok', reason: null },
  };
}

function failedPanels(reason: string): Panels {
  return {
    usage: { state: 'failed', reason },
    deployments: { state: 'failed', reason },
    ticket: { state: 'failed', reason },
    balances: { state: 'failed', reason },
  };
}

/**
 * One client's whole record, for the drill-down.
 *
 * The ranking table answers "who used the most"; it cannot answer "what did this
 * one do". Everything here is derived from redemptions already in memory, so the
 * drill-down costs no extra query — only payload, which is why the daily series
 * is clipped to the recent window rather than carrying every day since indexing.
 */
export type ClientDetail = {
  key: string;
  address: string;
  network: string;
  deployedAt: string | null;
  /**
   * When the client was first and last seen paying for traffic.
   *
   * A client leaves no trace of its own on chain: what is visible is a relay
   * redeeming a ticket the client issued. These are the bounds of that trace,
   * which is the closest thing to the client's own lifetime on record.
   */
  firstSeen: string | null;
  lastSeen: string | null;
  redemptions: number;
  tickets: number;
  gigabytes: number;
  /** Distinct days a relay redeemed at least one of this client's tickets. */
  activeDays: number;
  /** Volume per day over the recent window, zero-filled so the bars line up. */
  daily: Array<{ date: string; gigabytes: number }>;
  /** Relays this client paid, biggest first. */
  relayers: Array<{
    key: string;
    address: string;
    redemptions: number;
    gigabytes: number;
    share: number;
    /** Position in the shared relayer ordering, or -1 when it has no colour. */
    colorIndex: number;
  }>;
};

export type RecentRedemption = {
  key: string;
  timestamp: string;
  client: string;
  relayer: string;
  channelId: string;
  network: string;
};

export type AnalyticsSnapshot = {
  source: 'live' | 'degraded' | 'unavailable';
  observedAt: string;
  timebase: 'rpc' | 'estimated';
  winProbability: 'historical' | 'current' | 'assumed';
  /** Null in the combined view, where the networks disagree. */
  schemaVersion: string | null;
  blockNumber: number | null;
  accounts: number | null;
  safes: number | null;
  openChannels: number | null;
  channelBalance: string | null;
  safeBalance: string | null;
  activeUsers: ActiveUserPoint[];
  weeks: WeekPoint[];
  relayers: Relayer[];
  relayerDaily: RelayerDayPoint[];
  relayerSeries: RelayerSeries[];
  clients: Client[];
  clientCount: number;
  /** Keyed by client key, for the clients that have redemptions on record. */
  clientDetails: Record<string, ClientDetail>;
  deployments: Deployment[];
  dailyUsers: DailyUserPoint[];
  heatmap: Heatmap;
  retention: RetentionCohort[];
  recentRedemptions: RecentRedemption[];
  contracts: Contract[];
  /** Per-panel availability, so a tile can distinguish empty from broken. */
  panels: Panels;
  /**
   * Oracle values. Null in the combined view: each network sets its own price and
   * winning probability, so a single figure would be a fiction.
   */
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

/** A redemption, already timestamped and priced with its own network's oracle. */
export type Redemption = {
  network: string;
  channelId: string;
  source: string;
  destination: string;
  day: number;
  timestamp: number;
  tickets: number;
  gigabytes: number;
};

export type DeployedClient = {
  network: string;
  address: string;
  day: number;
  timestamp: number;
};

/** Everything one index database contributed, ready to aggregate. */
export type NetworkDataset = {
  network: string;
  label: string;
  lastDay: number;
  blockNumber: number;
  schemaVersion: string;
  accounts: number;
  safes: number;
  openChannels: number;
  channelBalance: bigint | null;
  safeBalance: bigint | null;
  redemptions: Redemption[];
  deployed: DeployedClient[];
  contracts: Contract[];
  ticket: {
    winProbability: number | null;
    priceWei: string | null;
    valueWei: string | null;
  };
  timebase: 'rpc' | 'estimated';
  winProbability: 'historical' | 'current' | 'assumed';
  panels: Panels;
  warnings: string[];
};

export function sum<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

export function dayIndex(timestamp: number): number {
  return Math.floor(timestamp / DAY_SECONDS);
}

export function isoDate(day: number): string {
  return new Date(day * DAY_SECONDS * 1000).toISOString().slice(0, 10);
}

/** Volume a redemption accounts for; a zero or unknown probability contributes none. */
export function redemptionVolume(probability: number): number {
  return probability > 0 ? GIGABYTES_PER_REDEMPTION / probability : 0;
}

/**
 * An identity is only unique within its own network, so combining several has to
 * key on both. The same address on two networks is two participants.
 */
function identity(network: string, address: string): string {
  return `${network} ${address}`;
}

function weekLabel(day: number): string {
  return new Intl.DateTimeFormat('en', {
    day: '2-digit',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(day * DAY_SECONDS * 1000));
}

/**
 * Daily snapshots of the trailing 7- and 30-day active-user counts.
 *
 * A client is active in a window when a redemption landed on one of its channels
 * inside that window, or when it was first deployed inside it. Counting
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
  for (
    let day = Math.max(days[0], SERIES_START_DAY);
    day <= lastDay;
    day += 1
  ) {
    const weekly = new Set<string>();
    const monthly = new Set<string>();
    let deployments = 0;
    for (let offset = 0; offset < MONTH_DAYS; offset += 1) {
      deployments += deploymentsByDay.get(day - offset) ?? 0;
      for (const actor of actorsByDay.get(day - offset) ?? []) {
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
  const buckets = new Map<
    number,
    { redemptions: number; tickets: number; gigabytes: number }
  >();
  for (const redemption of redemptions) {
    // Anchor each week to the Monday containing it. Unix day 0 was a Thursday,
    // so shift by three days before flooring to a week boundary.
    const week = Math.floor((redemption.day + 3) / 7) * 7 - 3;
    const bucket = buckets.get(week) ?? {
      redemptions: 0,
      tickets: 0,
      gigabytes: 0,
    };
    bucket.redemptions += 1;
    bucket.tickets += redemption.tickets;
    bucket.gigabytes += redemption.gigabytes;
    buckets.set(week, bucket);
  }

  let cumulativeGigabytes = 0;
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([week, bucket]) => {
      cumulativeGigabytes += bucket.gigabytes;
      return {
        key: isoDate(week),
        label: weekLabel(week),
        redemptions: bucket.redemptions,
        tickets: bucket.tickets,
        gigabytes: bucket.gigabytes,
        cumulativeGigabytes,
      };
    });
}

/**
 * Relayer breakdown: the ordering, the daily stack and the share of redemptions.
 *
 * The stacked chart, the donut and the legend all read from one list of relayers,
 * ordered by volume, so a colour means the same relayer everywhere. Every relayer
 * is charted individually — nothing is rolled into an aggregate bucket.
 */
function relayerBreakdown(
  redemptions: Redemption[],
  lastDay: number,
): {
  series: RelayerSeries[];
  daily: RelayerDayPoint[];
  distribution: Relayer[];
} {
  const firstDay = lastDay - RECENT_DAYS + 1;
  const window = redemptions.filter((redemption) => redemption.day >= firstDay);
  if (!window.length) return { series: [], daily: [], distribution: [] };

  const named = new Map<string, { address: string; network: string }>();
  const volumes = new Map<string, number>();
  const byDay = new Map<number, Map<string, number>>();
  for (const redemption of window) {
    const key = identity(redemption.network, redemption.destination);
    named.set(key, {
      address: redemption.destination,
      network: redemption.network,
    });
    volumes.set(key, (volumes.get(key) ?? 0) + redemption.gigabytes);
    const day = byDay.get(redemption.day) ?? new Map<string, number>();
    day.set(key, (day.get(key) ?? 0) + redemption.gigabytes);
    byDay.set(redemption.day, day);
  }

  // Ordered by volume over the stack's own window, which is the wider of the two,
  // so every relayer appearing in either panel has a place in this ordering.
  const series: RelayerSeries[] = [...volumes.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([key]) => ({
      key,
      address: named.get(key)?.address ?? key,
      network: named.get(key)?.network ?? '',
    }));
  const colorIndexOf = new Map(
    series.map((entry, index) => [entry.key, index]),
  );

  const daily: RelayerDayPoint[] = [];
  for (let day = firstDay; day <= lastDay; day += 1) {
    const values = byDay.get(day);
    const point: RelayerDayPoint = { date: isoDate(day) };
    for (const entry of series)
      point[entry.key] = values?.get(entry.key) ?? null;
    daily.push(point);
  }

  // The share breakdown answers "who is carrying traffic now", so it reads the
  // trailing week rather than the whole stack window.
  const recent = window.filter(
    (redemption) => redemption.day > lastDay - WEEK_DAYS,
  );
  const totals = new Map<string, { redemptions: number; gigabytes: number }>();
  for (const redemption of recent) {
    const key = identity(redemption.network, redemption.destination);
    const bucket = totals.get(key) ?? { redemptions: 0, gigabytes: 0 };
    bucket.redemptions += 1;
    bucket.gigabytes += redemption.gigabytes;
    totals.set(key, bucket);
  }
  const distribution = [...totals.entries()]
    .map(([key, bucket]) => ({
      key,
      address: named.get(key)?.address ?? key,
      network: named.get(key)?.network ?? '',
      redemptions: bucket.redemptions,
      gigabytes: bucket.gigabytes,
      share: bucket.redemptions / recent.length,
      colorIndex: colorIndexOf.get(key) ?? 0,
    }))
    .sort((a, b) => b.redemptions - a.redemptions);

  return { series, daily, distribution };
}

/**
 * New versus returning clients per day over the recent window.
 *
 * A client is new on the day it was first deployed and returning on any later day
 * a redemption lands on one of its channels, so the two bands never double-count
 * the same client.
 */
function dailyUserSeries(
  actorsByDay: Map<number, Set<string>>,
  deploymentDayOf: Map<string, number>,
  lastDay: number,
): DailyUserPoint[] {
  const points: DailyUserPoint[] = [];
  for (let day = lastDay - RECENT_DAYS + 1; day <= lastDay; day += 1) {
    let newClients = 0;
    let returning = 0;
    for (const actor of actorsByDay.get(day) ?? []) {
      if (deploymentDayOf.get(actor) === day) newClients += 1;
      else returning += 1;
    }
    points.push({ date: isoDate(day), newClients, returning });
  }
  return points;
}

/**
 * Share of relayed volume by weekday and hour, across the whole indexed history.
 *
 * A count per hour only shows that people use the network in the daytime. Split
 * by weekday it answers something sharper: whether the traffic is shaped like
 * working humans or runs flat around the clock.
 */
function heatmapDistribution(redemptions: Redemption[]): Heatmap {
  if (!redemptions.length) return [];
  const grid = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => 0),
  );
  for (const redemption of redemptions) {
    const at = new Date(redemption.timestamp * 1000);
    // getUTCDay is Sunday-first; the grid reads Monday-first.
    const weekday = (at.getUTCDay() + 6) % 7;
    grid[weekday][at.getUTCHours()] += redemption.gigabytes;
  }
  const total = grid.flat().reduce((sofar, value) => sofar + value, 0);
  if (total === 0) return [];
  return grid.map((row) => row.map((value) => value / total));
}

/** Calendar month of a day index, as a count of months since year zero. */
function monthIndex(day: number): number {
  const at = new Date(day * DAY_SECONDS * 1000);
  return at.getUTCFullYear() * 12 + at.getUTCMonth();
}

function monthLabel(index: number): { month: string; label: string } {
  const at = new Date(Date.UTC(Math.floor(index / 12), index % 12, 1));
  return {
    month: at.toISOString().slice(0, 7),
    label: new Intl.DateTimeFormat('en', {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(at),
  };
}

/**
 * Retention by deployment cohort.
 *
 * Active-user counts say how many clients are using the network; they cannot say
 * whether the same clients keep using it. A flat line is equally consistent with
 * a loyal base and with churn masked by new arrivals. Grouping clients by the
 * month they were deployed and asking which months each was active in separates
 * the two.
 */
function retentionCohorts(
  redemptions: Redemption[],
  deployed: DeployedClient[],
  lastDay: number,
): RetentionCohort[] {
  if (!deployed.length) return [];

  const activeMonths = new Map<string, Set<number>>();
  for (const redemption of redemptions) {
    const key = identity(redemption.network, redemption.source);
    const months = activeMonths.get(key) ?? new Set<number>();
    months.add(monthIndex(redemption.day));
    activeMonths.set(key, months);
  }

  const cohorts = new Map<number, string[]>();
  for (const client of deployed) {
    const month = monthIndex(client.day);
    cohorts.set(month, [
      ...(cohorts.get(month) ?? []),
      identity(client.network, client.address),
    ]);
  }

  const latest = monthIndex(lastDay);
  return [...cohorts.entries()]
    .filter(([month]) => month >= monthIndex(SERIES_START_DAY))
    .sort(([a], [b]) => a - b)
    .map(([month, members]) => ({
      ...monthLabel(month),
      size: members.length,
      retention: Array.from({ length: latest - month + 1 }, (_, offset) => {
        const active = members.filter((key) =>
          activeMonths.get(key)?.has(month + offset),
        );
        return active.length / members.length;
      }),
    }));
}

/** Per-client usage over both the recent window and all time. */
function clientUsage(
  redemptions: Redemption[],
  firstRecentDay: number,
): Client[] {
  const buckets = new Map<string, Client>();
  for (const redemption of redemptions) {
    const key = identity(redemption.network, redemption.source);
    const client = buckets.get(key) ?? {
      key,
      address: redemption.source,
      network: redemption.network,
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
    buckets.set(key, client);
  }
  return [...buckets.values()].sort(
    (a, b) => b.gigabytesTotal - a.gigabytesTotal,
  );
}

/**
 * Everything one client did, keyed by client, for the drill-down dialog.
 *
 * Built in the same pass as the rest of the snapshot because the redemptions are
 * already here: a per-client route would re-query the database for information
 * the server has in hand.
 */
function clientDetails(
  redemptions: Redemption[],
  deployed: DeployedClient[],
  colorIndexOf: Map<string, number>,
  lastDay: number,
): Record<string, ClientDetail> {
  const firstRecentDay = lastDay - RECENT_DAYS + 1;
  const deployedAtOf = new Map(
    deployed.map((client) => [
      identity(client.network, client.address),
      client.timestamp,
    ]),
  );

  type Draft = {
    address: string;
    network: string;
    redemptions: number;
    tickets: number;
    gigabytes: number;
    /** Null until a relay redeems against the client; some never do. */
    first: number | null;
    last: number | null;
    days: Set<number>;
    byDay: Map<number, number>;
    byRelayer: Map<
      string,
      { address: string; redemptions: number; gigabytes: number }
    >;
  };

  const blank = (network: string, address: string): Draft => ({
    address,
    network,
    redemptions: 0,
    tickets: 0,
    gigabytes: 0,
    first: null,
    last: null,
    days: new Set<number>(),
    byDay: new Map<number, number>(),
    byRelayer: new Map(),
  });

  const drafts = new Map<string, Draft>();
  // Seeded from the deployments, so a client nothing was ever redeemed against
  // still has a record. Its row opens like any other, and "nothing yet" is an
  // answer — a row that quietly behaves differently is not.
  for (const client of deployed) {
    const key = identity(client.network, client.address);
    if (!drafts.has(key))
      drafts.set(key, blank(client.network, client.address));
  }

  for (const redemption of redemptions) {
    const key = identity(redemption.network, redemption.source);
    let draft = drafts.get(key);
    if (!draft) {
      draft = blank(redemption.network, redemption.source);
      drafts.set(key, draft);
    }
    draft.redemptions += 1;
    draft.tickets += redemption.tickets;
    draft.gigabytes += redemption.gigabytes;
    draft.first =
      draft.first === null
        ? redemption.timestamp
        : Math.min(draft.first, redemption.timestamp);
    draft.last =
      draft.last === null
        ? redemption.timestamp
        : Math.max(draft.last, redemption.timestamp);
    draft.days.add(redemption.day);
    if (redemption.day >= firstRecentDay) {
      draft.byDay.set(
        redemption.day,
        (draft.byDay.get(redemption.day) ?? 0) + redemption.gigabytes,
      );
    }

    const relayerKey = identity(redemption.network, redemption.destination);
    const relayer = draft.byRelayer.get(relayerKey) ?? {
      address: redemption.destination,
      redemptions: 0,
      gigabytes: 0,
    };
    relayer.redemptions += 1;
    relayer.gigabytes += redemption.gigabytes;
    draft.byRelayer.set(relayerKey, relayer);
  }

  const details: Record<string, ClientDetail> = {};
  for (const [key, draft] of drafts) {
    const deployedAt = deployedAtOf.get(key);
    const daily: ClientDetail['daily'] = [];
    for (let day = firstRecentDay; day <= lastDay; day += 1) {
      daily.push({ date: isoDate(day), gigabytes: draft.byDay.get(day) ?? 0 });
    }
    details[key] = {
      key,
      address: draft.address,
      network: draft.network,
      deployedAt:
        deployedAt === undefined
          ? null
          : new Date(deployedAt * 1000).toISOString(),
      firstSeen:
        draft.first === null
          ? null
          : new Date(draft.first * 1000).toISOString(),
      lastSeen:
        draft.last === null ? null : new Date(draft.last * 1000).toISOString(),
      redemptions: draft.redemptions,
      tickets: draft.tickets,
      gigabytes: draft.gigabytes,
      activeDays: draft.days.size,
      daily,
      relayers: [...draft.byRelayer.entries()]
        .map(([relayerKey, relayer]) => ({
          key: relayerKey,
          address: relayer.address,
          redemptions: relayer.redemptions,
          gigabytes: relayer.gigabytes,
          share: draft.redemptions
            ? relayer.redemptions / draft.redemptions
            : 0,
          colorIndex: colorIndexOf.get(relayerKey) ?? -1,
        }))
        .sort((a, b) => b.gigabytes - a.gigabytes),
    };
  }
  return details;
}

/**
 * Folds each network's panel availability into one view.
 *
 * A panel only fails outright when every network failed it. When some answered
 * the figures are real but short, which is a different warning: `partial` keeps
 * the panel on screen and says what is missing from it.
 */
function mergePanels(datasets: NetworkDataset[]): Panels {
  const merged = healthyPanels();
  for (const key of PANEL_KEYS) {
    const failed = datasets.filter(
      (dataset) => dataset.panels[key].state !== 'ok',
    );
    if (!failed.length) continue;
    // Networks usually fail a panel for the same reason, so name it once and
    // list who it applies to rather than repeating the sentence per network.
    const byReason = new Map<string, string[]>();
    for (const dataset of failed) {
      const because = dataset.panels[key].reason ?? '';
      byReason.set(because, [...(byReason.get(because) ?? []), dataset.label]);
    }
    const reason =
      datasets.length > 1
        ? [...byReason]
            .map(([because, labels]) => `${labels.join(', ')}: ${because}`)
            .join(' ')
        : (failed[0].panels[key].reason ?? '');
    merged[key] = {
      state: failed.length === datasets.length ? 'failed' : 'partial',
      reason,
    };
  }
  return merged;
}

function totalOf(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
}

function bigTotalOf(values: Array<bigint | null>): string | null {
  const known = values.filter((value): value is bigint => value !== null);
  return known.length
    ? known.reduce((total, value) => total + value, 0n).toString()
    : null;
}

/**
 * Builds the rendered snapshot from one or more datasets.
 *
 * With several, identities are keyed by network so the same address on two
 * networks counts twice, and the oracle tiles are blanked because the networks do
 * not share a price or a winning probability.
 */
export function buildSnapshot(datasets: NetworkDataset[]): AnalyticsSnapshot {
  const combined = datasets.length > 1;
  const redemptions = datasets.flatMap((dataset) => dataset.redemptions);
  const deployed = datasets.flatMap((dataset) => dataset.deployed);
  const warnings = datasets.flatMap((dataset) =>
    combined
      ? dataset.warnings.map((warning) => `${dataset.label}: ${warning}`)
      : dataset.warnings,
  );
  const lastDay = Math.max(...datasets.map((dataset) => dataset.lastDay));

  const actorsByDay = new Map<number, Set<string>>();
  const addActor = (day: number, key: string) => {
    const actors = actorsByDay.get(day) ?? new Set<string>();
    actors.add(key);
    actorsByDay.set(day, actors);
  };
  for (const redemption of redemptions) {
    addActor(redemption.day, identity(redemption.network, redemption.source));
  }

  const deploymentsByDay = new Map<number, number>();
  const deploymentDayOf = new Map<string, number>();
  for (const client of deployed) {
    const key = identity(client.network, client.address);
    deploymentsByDay.set(
      client.day,
      (deploymentsByDay.get(client.day) ?? 0) + 1,
    );
    deploymentDayOf.set(key, client.day);
    addActor(client.day, key);
  }

  const activeUsers = activeUserSeries(actorsByDay, deploymentsByDay, lastDay);
  const {
    series: relayerSeries,
    daily: relayerDaily,
    distribution: relayers,
  } = relayerBreakdown(redemptions, lastDay);
  const colorIndexOf = new Map(
    relayerSeries.map((entry, index) => [entry.key, index]),
  );
  const allClients = clientUsage(redemptions, lastDay - WEEK_DAYS + 1);
  const recent = redemptions.filter(
    (redemption) => redemption.day > lastDay - WEEK_DAYS,
  );

  const deployments = [...deployed]
    .sort((a, b) => a.timestamp - b.timestamp)
    .reverse()
    .map((client) => ({
      key: identity(client.network, client.address),
      address: client.address,
      network: client.network,
      timestamp: new Date(client.timestamp * 1000).toISOString(),
    }));

  const recentRedemptions = [...redemptions]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-REDEMPTION_FEED_LIMIT)
    .reverse()
    .map((redemption, index) => ({
      key: `${redemption.network}-${index}`,
      timestamp: new Date(redemption.timestamp * 1000).toISOString(),
      client: redemption.source,
      relayer: redemption.destination,
      channelId: redemption.channelId,
      network: redemption.network,
    }));

  const latest = activeUsers.at(-1);
  const panels = mergePanels(datasets);
  const hasUsage = panels.usage.state !== 'failed';
  const hasDeployments = panels.deployments.state !== 'failed';
  let deployments7d = 0;
  for (let offset = 0; offset < WEEK_DAYS; offset += 1) {
    deployments7d += deploymentsByDay.get(lastDay - offset) ?? 0;
  }

  const single = datasets.length === 1 ? datasets[0] : undefined;
  return {
    source: warnings.length ? 'degraded' : 'live',
    observedAt: new Date().toISOString(),
    timebase: datasets.every((dataset) => dataset.timebase === 'rpc')
      ? 'rpc'
      : 'estimated',
    winProbability: datasets.every(
      (dataset) => dataset.winProbability === 'historical',
    )
      ? 'historical'
      : datasets.some((dataset) => dataset.winProbability === 'assumed')
        ? 'assumed'
        : 'current',
    schemaVersion: single?.schemaVersion ?? null,
    blockNumber: single?.blockNumber ?? null,
    accounts: totalOf(datasets.map((dataset) => dataset.accounts)),
    safes: totalOf(datasets.map((dataset) => dataset.safes)),
    openChannels: totalOf(datasets.map((dataset) => dataset.openChannels)),
    channelBalance: bigTotalOf(
      datasets.map((dataset) => dataset.channelBalance),
    ),
    safeBalance: bigTotalOf(datasets.map((dataset) => dataset.safeBalance)),
    activeUsers,
    weeks: weeklySeries(redemptions),
    relayers,
    relayerDaily,
    relayerSeries,
    clients: allClients,
    clientCount: allClients.length,
    clientDetails: clientDetails(redemptions, deployed, colorIndexOf, lastDay),
    deployments,
    dailyUsers: dailyUserSeries(actorsByDay, deploymentDayOf, lastDay),
    heatmap: heatmapDistribution(redemptions),
    retention: retentionCohorts(redemptions, deployed, lastDay),
    recentRedemptions,
    contracts: datasets
      .flatMap((dataset) => dataset.contracts)
      .sort(
        (a, b) =>
          a.role.localeCompare(b.role) || a.network.localeCompare(b.network),
      ),
    panels,
    // Each network prices traffic with its own oracle, so a combined figure would
    // be a fiction. The volumes above are still correct: every redemption was
    // priced with its own network's probability before it got here.
    ticket: single?.ticket ?? {
      winProbability: null,
      priceWei: null,
      valueWei: null,
    },
    totals: {
      weeklyActiveUsers: latest?.weekly ?? null,
      monthlyActiveUsers: latest?.monthly ?? null,
      allTimeUsers: hasUsage ? allClients.length : null,
      redemptions7d: hasUsage ? recent.length : null,
      redemptionsTotal: hasUsage ? redemptions.length : null,
      gigabytes7d: hasUsage ? sum(recent, (row) => row.gigabytes) : null,
      gigabytesTotal: hasUsage
        ? sum(redemptions, (row) => row.gigabytes)
        : null,
      ticketsTotal: hasUsage ? sum(redemptions, (row) => row.tickets) : null,
      relayers7d: hasUsage
        ? new Set(recent.map((row) => identity(row.network, row.destination)))
            .size
        : null,
      deployments7d: hasDeployments ? deployments7d : null,
      deployments30d: hasDeployments ? (latest?.deployments ?? null) : null,
      clientsDeployed: hasDeployments ? deployed.length : null,
    },
    warnings,
  };
}

/** Every metric unknown: the shape the page renders when nothing could be read. */
export const EMPTY_TOTALS: AnalyticsSnapshot['totals'] = {
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

export function unavailableSnapshot(message: string): AnalyticsSnapshot {
  return {
    source: 'unavailable',
    observedAt: new Date().toISOString(),
    timebase: 'estimated',
    winProbability: 'assumed',
    schemaVersion: null,
    blockNumber: null,
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
    clientDetails: {},
    deployments: [],
    dailyUsers: [],
    heatmap: [],
    retention: [],
    recentRedemptions: [],
    contracts: [],
    panels: failedPanels(message),
    ticket: { winProbability: null, priceWei: null, valueWei: null },
    totals: EMPTY_TOTALS,
    warnings: [message],
  };
}

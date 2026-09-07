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
 * How many feed rows a snapshot keeps. Each network already returns at most this
 * many, so the cap only matters when several are merged into the combined view.
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
  /** Client to exit. The only direction attributable to a participant. */
  gigabytes: number;
  /** Exit back to client, inferred — see `downstreamByRelayDay`. */
  downstreamGigabytes: number;
  /** Running total of both directions. */
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

/**
 * One row of the feed: a client paying a relay, newest first.
 *
 * Both when it happened and where: with no RPC configured a timestamp is
 * extrapolated from block height, which is a guess dressed as a fact, so the
 * block number travels alongside it and the table shows whichever one is
 * actually known.
 */
export type RecentRedemption = {
  key: string;
  timestamp: string;
  block: number;
  source: string;
  destination: string;
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
  /** The same relays, the same colours, the inferred return direction. */
  relayerDownstreamDaily: RelayerDayPoint[];
  relayerSeries: RelayerSeries[];
  clients: Client[];
  clientCount: number;
  /** Keyed by client key, for the clients that have redemptions on record. */
  clientDetails: Record<string, ClientDetail>;
  deployments: Deployment[];
  dailyUsers: DailyUserPoint[];
  heatmap: Heatmap;
  /**
   * The same grid for the return path, built from the exits' own redemptions
   * rather than the per-day estimate, because a heatmap needs the hour.
   */
  heatmapDownstream: Heatmap;
  /**
   * How much the two grids agree, 0 to 1.
   *
   * If a session's answer follows its request within seconds, the two should be
   * nearly the same picture and this should sit near 1. Worth stating as a
   * number: two shaded grids look alike long before they are alike, and this is
   * the closest thing on the page to a check that the exit set is right.
   */
  heatmapAgreement: number | null;
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
    /**
     * Both trailing windows, for every subject the headline row carries.
     *
     * The row states one window and each tile notes the shorter one, so the
     * figures have to exist in both. `30d` spans MONTH_DAYS entries, matching
     * how the active-user series counts a month.
     */
    redemptions30d: number | null;
    gigabytes7d: number | null;
    gigabytes30d: number | null;
    gigabytesTotal: number | null;
    /**
     * Downstream is inferred, not attributed: the exit pays for the return path
     * and its channel names no client, so these are network-wide only.
     */
    gigabytesDownstream7d: number | null;
    gigabytesDownstream30d: number | null;
    gigabytesDownstreamTotal: number | null;
    /** Downstream per unit of upstream. The check on the whole inference. */
    downstreamRatio: number | null;
    /** Downstream before the probe floor came off, so the correction is visible. */
    gigabytesDownstreamRaw: number | null;
    /** How much the floor actually removed. */
    probeFloorGigabytes: number | null;
    /** Probe volume the rate was calibrated from. */
    probeGigabytesTotal: number | null;
    /** Exits named in configuration. Zero means they were guessed instead. */
    exitsNamed: number | null;
    /** Exits actually seen paying a relay. Below `exitsNamed`, some went quiet. */
    exitsSeen: number | null;
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
  source: string;
  destination: string;
  day: number;
  timestamp: number;
  tickets: number;
  gigabytes: number;
  /** Whether the payer announced. Announced payers are relays and exits. */
  sourceAnnounced: boolean;
};

/**
 * Redemptions split by what the payment was for.
 *
 * Payment follows the sender of each hop and the destination of a packet is
 * never paid, so one VPN session leaves exactly two paid hops on chain: the
 * client paying a relay on the way out, and the exit paying a relay on the way
 * back. Those are `upstream` and `downstream`.
 *
 * `probe` is relay-to-relay traffic. Relays neither start VPN sessions nor
 * receive them, so a payment between two relays carries no VPN payload at all —
 * it is nodes measuring the network. That makes it useless as traffic and
 * valuable as a control: it is a clean sample of what probing costs per node,
 * which is the correction `downstreamByRelayDay` applies.
 */
type Traffic = {
  upstream: Keyed[];
  downstream: Keyed[];
  probe: Keyed[];
};

/**
 * Splits redemptions by direction.
 *
 * The relay set is derived first: a relay is only identifiable as the node a
 * client paid, so upstream defines it and everything else is read against it.
 *
 * Exits are named in configuration, and that is not a convenience. Nothing on
 * chain separates an exit from a relay — both announce — so the alternative is
 * identifying them by elimination, which breaks the moment an exit also relays
 * for a client: it joins the relay set, its return traffic is filed as probing,
 * and downstream understates itself with nothing to show for it.
 *
 * With no list configured the elimination heuristic still runs, so a deployment
 * that has not named its exits gets an estimate rather than nothing — carrying
 * that caveat. `exitsSeen` reports how many were actually observed paying, which
 * against a known list says whether any have gone quiet.
 */
function classify(
  redemptions: Keyed[],
  knownExits: Set<string>,
): Traffic & { exits: Set<string> } {
  const relays = new Set<string>();
  for (const redemption of redemptions) {
    if (!redemption.sourceAnnounced) relays.add(redemption.destinationKey);
  }

  const traffic: Traffic & { exits: Set<string> } = {
    upstream: [],
    downstream: [],
    probe: [],
    exits: new Set<string>(),
  };
  const named = knownExits.size > 0;
  for (const redemption of redemptions) {
    if (!redemption.sourceAnnounced) {
      traffic.upstream.push(redemption);
      continue;
    }
    const payer = redemption.sourceKey;
    const paid = redemption.destinationKey;

    // Membership, checked before anything else, is what makes a named exit
    // survive also being a relay.
    if (named && knownExits.has(payer)) {
      traffic.downstream.push(redemption);
      traffic.exits.add(payer);
      continue;
    }
    // Only hops terminating at a known relay can be part of a VPN session.
    if (!relays.has(paid)) continue;
    if (named || relays.has(payer)) {
      // Once the exits are named, everything else paying a relay is probing —
      // and a payer that never relays is the better calibration sample, since
      // it pays for its own probes and for nobody else's forwarding.
      traffic.probe.push(redemption);
    } else {
      traffic.downstream.push(redemption);
      traffic.exits.add(payer);
    }
  }
  return traffic;
}

/**
 * Downstream volume per day, with the probe floor taken out.
 *
 * The floor only applies when the exits were guessed. Named in configuration,
 * an exit paying a relay is the return path by definition — a measurement, not
 * an inference — and there is nothing to correct: subtracting a modelled probe
 * cost from a known quantity can only make it wrong.
 *
 * Guessed, the set is announced payers that are not relays, which is every node
 * on the network that probes without ever relaying. Then it matters. Every node
 * probes, exits included, so a guessed exit's channel carries return traffic and
 * probing mixed together. The probe bucket is probing and nothing else, which
 * gives a per-node-per-day probe rate measured rather than assumed; multiplying
 * it by the payers active that day estimates how much of their volume was
 * probing, and the rest is downstream.
 *
 * The rate is a low quantile of what payers spend, not their average, and that
 * distinction is the whole correction. Probes take several hops and only
 * forwarders are paid, so a relay pays for its own probes *and* for carrying
 * everyone else's, while an exit pays only the first hop of its own. Averaging
 * bills an exit for forwarding it never did, by roughly the mean hop count —
 * enough to wipe out the entire downstream figure. The quiet end of the
 * distribution is the payer doing least forwarding, which is the closest thing
 * to a node's own probing cost the chain exposes.
 */
const PROBE_QUANTILE = 0.1;

function downstreamByRelayDay(
  candidates: Keyed[],
  probes: Keyed[],
  applyFloor: boolean,
): { perRelay: Map<number, Map<string, number>>; floor: Map<number, number> } {
  const gather = (rows: Keyed[]) => {
    const volume = new Map<number, number>();
    const senders = new Map<number, Set<string>>();
    // What each payer spent, so the rate can be read off the quiet end.
    const bySender = new Map<number, Map<string, number>>();
    // Where the traffic landed, keyed by the relay that was paid.
    const arrivals = new Map<number, Map<string, number>>();
    for (const row of rows) {
      volume.set(row.day, (volume.get(row.day) ?? 0) + row.gigabytes);
      const sender = row.sourceKey;
      const set = senders.get(row.day) ?? new Set<string>();
      set.add(sender);
      senders.set(row.day, set);
      const spend = bySender.get(row.day) ?? new Map<string, number>();
      spend.set(sender, (spend.get(sender) ?? 0) + row.gigabytes);
      bySender.set(row.day, spend);
      const byRelay = arrivals.get(row.day) ?? new Map<string, number>();
      const relay = row.destinationKey;
      byRelay.set(relay, (byRelay.get(relay) ?? 0) + row.gigabytes);
      arrivals.set(row.day, byRelay);
    }
    return { volume, senders, bySender, arrivals };
  };

  const probed = gather(probes);
  const candidate = gather(candidates);

  const out = new Map<number, Map<string, number>>();
  const floors = new Map<number, number>();
  for (const [day, byRelay] of candidate.arrivals) {
    if (!applyFloor) {
      out.set(day, new Map(byRelay));
      floors.set(day, 0);
      continue;
    }
    const probeVolume = probed.volume.get(day) ?? 0;
    const spend = [...(probed.bySender.get(day)?.values() ?? [])].sort(
      (a, b) => a - b,
    );
    const perNode = spend.length
      ? spend[Math.floor(spend.length * PROBE_QUANTILE)]
      : 0;
    const floor = perNode * (candidate.senders.get(day)?.size ?? 0);
    floors.set(day, floor);
    // Nothing says where an exit's own probes land, so the relays' probes of
    // each other stand in for it: the floor is spread over relays in the same
    // proportion that observed probe traffic arrives at them.
    const landing = probed.arrivals.get(day);
    const adjusted = new Map<string, number>();
    let kept = 0;
    for (const [relay, volume] of byRelay) {
      const share =
        probeVolume > 0 ? (landing?.get(relay) ?? 0) / probeVolume : 0;
      const remaining = Math.max(0, volume - floor * share);
      adjusted.set(relay, remaining);
      kept += remaining;
    }

    // Clamping each relay on its own loses the excess wherever the floor
    // overshot, which would bias the network total upwards and leave the stack
    // no longer adding up to the figure beside it. Rescaling to the total the
    // day is actually owed puts that excess back on the relays with room for
    // it, so the two agree by construction.
    const dayVolume = candidate.volume.get(day) ?? 0;
    const owed = Math.max(0, dayVolume - floor);
    const scale = kept > 0 ? owed / kept : 0;
    for (const [relay, volume] of adjusted) adjusted.set(relay, volume * scale);
    out.set(day, adjusted);
  }
  return { perRelay: out, floor: floors };
}

/** Collapses the per-relay estimate to a daily network total. */
function totalByDay(byRelayDay: Map<number, Map<string, number>>) {
  const out = new Map<number, number>();
  for (const [day, byRelay] of byRelayDay) {
    let total = 0;
    for (const volume of byRelay.values()) total += volume;
    out.set(day, total);
  }
  return out;
}

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
  /** Client redemptions, already capped and newest first. */
  recentRedemptions: RecentRedemption[];
  deployed: DeployedClient[];
  contracts: Contract[];
  ticket: {
    winProbability: number | null;
    priceWei: string | null;
    valueWei: string | null;
  };
  timebase: 'rpc' | 'estimated';
  winProbability: 'historical' | 'current' | 'assumed';
  /** Configured exit addresses, lowercased. Empty falls back to elimination. */
  exits: string[];
  panels: Panels;
  warnings: string[];
};

export function sum<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

export function dayIndex(timestamp: number): number {
  return Math.floor(timestamp / DAY_SECONDS);
}

/**
 * Memoised, because the callers ask for the same handful of days over and over.
 *
 * The drill-down alone formats the recent window once per client, so a few
 * thousand clients means tens of thousands of `Date` constructions for thirty
 * distinct answers. One entry per day index ever rendered is bounded by the
 * length of the indexed history.
 */
const isoDates = new Map<number, string>();

export function isoDate(day: number): string {
  let value = isoDates.get(day);
  if (value === undefined) {
    value = new Date(day * DAY_SECONDS * 1000).toISOString().slice(0, 10);
    isoDates.set(day, value);
  }
  return value;
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

/**
 * A redemption with its participants' identities already resolved.
 *
 * Six of the passes below need the identity of a redemption's payer, its payee or
 * both — the classifier, the probe-floor gather, the relayer breakdown, the client
 * ranking, the retention cohorts, the active-user index and the drill-down. Each
 * was calling `identity` itself, so the same string was built from scratch half a
 * dozen times per row and thrown away every time. At a few hundred thousand
 * redemptions that is millions of transient allocations, and it showed up spread
 * across every one of those frames in the profile rather than in any single one.
 */
type Keyed = Redemption & { sourceKey: string; destinationKey: string };

/** A deployment with its identity resolved, for the same reason. */
type KeyedClient = DeployedClient & { key: string };

/**
 * Interns identities within one network.
 *
 * A network has a few dozen relays and some thousands of clients, so the distinct
 * identities number in the thousands however many redemptions there are. Built
 * once each and shared, they cost one string per participant instead of one per
 * mention.
 */
function interner(network: string) {
  const pool = new Map<string, string>();
  return (address: string): string => {
    let key = pool.get(address);
    if (key === undefined) {
      key = identity(network, address);
      pool.set(address, key);
    }
    return key;
  };
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

function weeklySeries(
  redemptions: Redemption[],
  downstream: Map<number, number>,
): WeekPoint[] {
  const buckets = new Map<
    number,
    {
      redemptions: number;
      tickets: number;
      gigabytes: number;
      downstreamGigabytes: number;
    }
  >();
  // Anchor each week to the Monday containing it. Unix day 0 was a Thursday, so
  // shift by three days before flooring to a week boundary.
  const weekOf = (day: number) => Math.floor((day + 3) / 7) * 7 - 3;
  const bucketOf = (week: number) => {
    const bucket = buckets.get(week) ?? {
      redemptions: 0,
      tickets: 0,
      gigabytes: 0,
      downstreamGigabytes: 0,
    };
    buckets.set(week, bucket);
    return bucket;
  };

  // Downstream is a per-day estimate rather than a set of rows, so it is folded
  // in by day; a week with only downstream still gets a bar.
  for (const [day, gigabytes] of downstream) {
    bucketOf(weekOf(day)).downstreamGigabytes += gigabytes;
  }

  for (const redemption of redemptions) {
    const bucket = bucketOf(weekOf(redemption.day));
    bucket.redemptions += 1;
    bucket.tickets += redemption.tickets;
    bucket.gigabytes += redemption.gigabytes;
  }

  let cumulativeGigabytes = 0;
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([week, bucket]) => {
      cumulativeGigabytes += bucket.gigabytes + bucket.downstreamGigabytes;
      return {
        key: isoDate(week),
        label: weekLabel(week),
        redemptions: bucket.redemptions,
        tickets: bucket.tickets,
        gigabytes: bucket.gigabytes,
        downstreamGigabytes: bucket.downstreamGigabytes,
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
  redemptions: Keyed[],
  downstream: Map<number, Map<string, number>>,
  lastDay: number,
): {
  series: RelayerSeries[];
  daily: RelayerDayPoint[];
  downstreamDaily: RelayerDayPoint[];
  distribution: Relayer[];
} {
  const firstDay = lastDay - RECENT_DAYS + 1;
  const window = redemptions.filter((redemption) => redemption.day >= firstDay);
  if (!window.length) {
    return { series: [], daily: [], downstreamDaily: [], distribution: [] };
  }

  const named = new Map<string, { address: string; network: string }>();
  const volumes = new Map<string, number>();
  const byDay = new Map<number, Map<string, number>>();
  for (const redemption of window) {
    const key = redemption.destinationKey;
    named.set(key, {
      address: redemption.destination,
      network: redemption.network,
    });
    volumes.set(key, (volumes.get(key) ?? 0) + redemption.gigabytes);
    const day = byDay.get(redemption.day) ?? new Map<string, number>();
    day.set(key, (day.get(key) ?? 0) + redemption.gigabytes);
    byDay.set(redemption.day, day);
  }

  // Relays that only appear downstream in this window still need a series, or
  // the second chart would silently drop them. They go after the upstream ones
  // so the existing ordering — and every colour that depends on it — is
  // untouched by the addition.
  const downstreamVolumes = new Map<string, number>();
  for (let day = firstDay; day <= lastDay; day += 1) {
    for (const [key, gigabytes] of downstream.get(day) ?? []) {
      downstreamVolumes.set(key, (downstreamVolumes.get(key) ?? 0) + gigabytes);
    }
  }

  // Ordered by volume over the stack's own window, which is the wider of the two,
  // so every relayer appearing in either panel has a place in this ordering.
  const order = [
    ...[...volumes.entries()].sort(([, a], [, b]) => b - a).map(([key]) => key),
    ...[...downstreamVolumes.entries()]
      .filter(([key]) => !volumes.has(key))
      .sort(([, a], [, b]) => b - a)
      .map(([key]) => key),
  ];
  const series: RelayerSeries[] = order.map((key) => ({
    key,
    address: named.get(key)?.address ?? key.slice(key.indexOf(' ') + 1),
    network: named.get(key)?.network ?? key.slice(0, key.indexOf(' ')),
  }));
  const colorIndexOf = new Map(
    series.map((entry, index) => [entry.key, index]),
  );

  const stack = (source: Map<number, Map<string, number>>) => {
    const points: RelayerDayPoint[] = [];
    for (let day = firstDay; day <= lastDay; day += 1) {
      const values = source.get(day);
      const point: RelayerDayPoint = { date: isoDate(day) };
      for (const entry of series) {
        const value = values?.get(entry.key) ?? null;
        // Zero and absent both mean "carried nothing"; null keeps the relay out
        // of the tooltip instead of padding it with a row of noughts.
        point[entry.key] = value ? value : null;
      }
      points.push(point);
    }
    return points;
  };

  const daily = stack(byDay);
  const downstreamDaily = stack(downstream);

  // The share breakdown reads the same window as the stack beside it. They share
  // one legend and one colour per relayer, so a relayer weighted over a week in
  // one panel and a month in the other would make that legend a lie.
  const totals = new Map<string, { redemptions: number; gigabytes: number }>();
  for (const redemption of window) {
    const key = redemption.destinationKey;
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
      share: bucket.redemptions / window.length,
      colorIndex: colorIndexOf.get(key) ?? 0,
    }))
    .sort((a, b) => b.redemptions - a.redemptions);

  return { series, daily, downstreamDaily, distribution };
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
    // Read arithmetically rather than through `Date`, which this used to
    // construct once per redemption — hundreds of thousands of objects to answer
    // two questions a division apart. Unix day 0 was a Thursday and the grid
    // reads Monday-first, so the weekday is the day index shifted by three.
    const weekday = (Math.floor(redemption.timestamp / DAY_SECONDS) + 3) % 7;
    const hour = Math.floor(redemption.timestamp / 3600) % 24;
    grid[weekday][hour] += redemption.gigabytes;
  }
  const total = grid.flat().reduce((sofar, value) => sofar + value, 0);
  if (total === 0) return [];
  return grid.map((row) => row.map((value) => value / total));
}

/**
 * Overlap between two distributions: one minus half their total variation.
 *
 * Both grids are normalised to sum to one, so what is left after taking out
 * where they differ is the area they share. Identical grids give 1, grids with
 * no hour in common give 0.
 */
function heatmapOverlap(a: Heatmap, b: Heatmap): number | null {
  if (!a.length || !b.length) return null;
  let difference = 0;
  for (let weekday = 0; weekday < a.length; weekday += 1) {
    for (let hour = 0; hour < a[weekday].length; hour += 1) {
      difference += Math.abs(a[weekday][hour] - b[weekday][hour]);
    }
  }
  return 1 - difference / 2;
}

/**
 * Calendar month of a day index, as a count of months since year zero.
 *
 * Memoised for the same reason as `isoDate`: the retention pass asks per
 * redemption and there are only ever as many answers as there are days.
 */
const monthsOfDay = new Map<number, number>();

function monthIndex(day: number): number {
  let month = monthsOfDay.get(day);
  if (month === undefined) {
    const at = new Date(day * DAY_SECONDS * 1000);
    month = at.getUTCFullYear() * 12 + at.getUTCMonth();
    monthsOfDay.set(day, month);
  }
  return month;
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
  redemptions: Keyed[],
  deployed: KeyedClient[],
  lastDay: number,
): RetentionCohort[] {
  if (!deployed.length) return [];

  const activeMonths = new Map<string, Set<number>>();
  for (const redemption of redemptions) {
    const months = activeMonths.get(redemption.sourceKey) ?? new Set<number>();
    months.add(monthIndex(redemption.day));
    activeMonths.set(redemption.sourceKey, months);
  }

  const cohorts = new Map<number, string[]>();
  for (const client of deployed) {
    const month = monthIndex(client.day);
    // Appended rather than rebuilt: copying the cohort to add one member made
    // this quadratic in the size of the cohort, which on a busy month is every
    // client deployed that month.
    const members = cohorts.get(month);
    if (members) members.push(client.key);
    else cohorts.set(month, [client.key]);
  }

  const latest = monthIndex(lastDay);
  return [...cohorts.entries()]
    .filter(([month]) => month >= monthIndex(SERIES_START_DAY))
    .sort(([a], [b]) => a - b)
    .map(([month, members]) => ({
      ...monthLabel(month),
      size: members.length,
      // Counted rather than filtered: the share is all that is wanted, and a
      // filter allocates a copy of the cohort for every month behind it.
      retention: Array.from({ length: latest - month + 1 }, (_, offset) => {
        let active = 0;
        for (const key of members) {
          if (activeMonths.get(key)?.has(month + offset)) active += 1;
        }
        return active / members.length;
      }),
    }));
}

/** Per-client usage over both the recent window and all time. */
function clientUsage(redemptions: Keyed[], firstRecentDay: number): Client[] {
  const buckets = new Map<string, Client>();
  for (const redemption of redemptions) {
    const key = redemption.sourceKey;
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
  redemptions: Keyed[],
  deployed: KeyedClient[],
  colorIndexOf: Map<string, number>,
  lastDay: number,
): Record<string, ClientDetail> {
  const firstRecentDay = lastDay - RECENT_DAYS + 1;
  const deployedAtOf = new Map(
    deployed.map((client) => [client.key, client.timestamp]),
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
    if (!drafts.has(client.key))
      drafts.set(client.key, blank(client.network, client.address));
  }

  for (const redemption of redemptions) {
    const key = redemption.sourceKey;
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

    const relayerKey = redemption.destinationKey;
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
      const labels = byReason.get(because);
      if (labels) labels.push(dataset.label);
      else byReason.set(because, [dataset.label]);
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
  // Identities are resolved once here, in the pass that was already copying every
  // redemption into one array, and read off the row everywhere below.
  const all: Keyed[] = [];
  const deployed: KeyedClient[] = [];
  for (const dataset of datasets) {
    const keyOf = interner(dataset.network);
    for (const row of dataset.redemptions) {
      all.push({
        ...row,
        sourceKey: keyOf(row.source),
        destinationKey: keyOf(row.destination),
      });
    }
    for (const row of dataset.deployed) {
      deployed.push({ ...row, key: keyOf(row.address) });
    }
  }
  // Everything that names a participant reads upstream only: it is the one
  // direction whose payer is the client itself. Downstream is real traffic with
  // no client in it, so it stays an aggregate.
  const knownExits = new Set(
    datasets.flatMap((dataset) =>
      dataset.exits.map((address) => identity(dataset.network, address)),
    ),
  );
  const {
    upstream: redemptions,
    downstream: candidates,
    probe: probes,
    exits,
  } = classify(all, knownExits);
  // Per network, never pooled. The probe rate is a quantile of what nodes spend,
  // and a small network's nodes spend less in absolute terms than a large one's —
  // pooled, the quiet end of one network sets the floor for the other, and the
  // combined figure stops matching the sum of its parts.
  const downstreamPerRelay = new Map<number, Map<string, number>>();
  const probeFloor = new Map<number, number>();
  for (const dataset of datasets) {
    const mine = (rows: Keyed[]) =>
      rows.filter((row) => row.network === dataset.network);
    const { perRelay, floor } = downstreamByRelayDay(
      mine(candidates),
      mine(probes),
      dataset.exits.length === 0,
    );
    for (const [day, byRelay] of perRelay) {
      const merged = downstreamPerRelay.get(day) ?? new Map<string, number>();
      for (const [relay, volume] of byRelay) merged.set(relay, volume);
      downstreamPerRelay.set(day, merged);
    }
    for (const [day, value] of floor) {
      probeFloor.set(day, (probeFloor.get(day) ?? 0) + value);
    }
  }
  const downstream = totalByDay(downstreamPerRelay);

  // Built from the exits' own rows rather than the per-day estimate, because the
  // estimate has no hour in it. With the exits named the two describe the same
  // volume anyway, since no probe floor is taken off.
  const upstreamHours = heatmapDistribution(redemptions);
  const downstreamHours = heatmapDistribution(candidates);

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
    addActor(redemption.day, redemption.sourceKey);
  }

  const deploymentsByDay = new Map<number, number>();
  const deploymentDayOf = new Map<string, number>();
  for (const client of deployed) {
    const key = client.key;
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
    downstreamDaily: relayerDownstreamDaily,
    distribution: relayers,
  } = relayerBreakdown(redemptions, downstreamPerRelay, lastDay);
  const colorIndexOf = new Map(
    relayerSeries.map((entry, index) => [entry.key, index]),
  );
  const allClients = clientUsage(redemptions, lastDay - WEEK_DAYS + 1);

  // Both trailing windows in one pass. Materialising them as filtered arrays and
  // reducing each twice over walked the whole history four times and kept two
  // copies of a third of it alive to do it.
  const weekFrom = lastDay - WEEK_DAYS + 1;
  const monthFrom = lastDay - MONTH_DAYS + 1;
  let redemptions7d = 0;
  let redemptions30d = 0;
  let gigabytes7d = 0;
  let gigabytes30d = 0;
  let upstreamTotal = 0;
  let ticketsTotal = 0;
  const relayers7d = new Set<string>();
  for (const redemption of redemptions) {
    upstreamTotal += redemption.gigabytes;
    ticketsTotal += redemption.tickets;
    if (redemption.day < monthFrom) continue;
    redemptions30d += 1;
    gigabytes30d += redemption.gigabytes;
    if (redemption.day < weekFrom) continue;
    redemptions7d += 1;
    gigabytes7d += redemption.gigabytes;
    relayers7d.add(redemption.destinationKey);
  }

  const deployments = [...deployed]
    .sort((a, b) => a.timestamp - b.timestamp)
    .reverse()
    .map((client) => ({
      key: client.key,
      address: client.address,
      network: client.network,
      timestamp: new Date(client.timestamp * 1000).toISOString(),
    }));

  // Queried rather than sliced off the arrays above, because the feed is the only
  // consumer that needs a channel id. Same client traffic either way.
  const recentRedemptions = datasets
    .flatMap((dataset) => dataset.recentRedemptions)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, REDEMPTION_FEED_LIMIT);

  const latest = activeUsers.at(-1);
  const panels = mergePanels(datasets);
  const hasUsage = panels.usage.state !== 'failed';
  const hasDeployments = panels.deployments.state !== 'failed';
  let deployments7d = 0;
  for (let offset = 0; offset < WEEK_DAYS; offset += 1) {
    deployments7d += deploymentsByDay.get(lastDay - offset) ?? 0;
  }

  const downstreamTotal = [...downstream.values()].reduce(
    (total, value) => total + value,
    0,
  );
  const downstreamOver = (days: number) => {
    let total = 0;
    for (let offset = 0; offset < days; offset += 1) {
      total += downstream.get(lastDay - offset) ?? 0;
    }
    return total;
  };

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
    weeks: weeklySeries(redemptions, downstream),
    relayers,
    relayerDaily,
    relayerDownstreamDaily,
    relayerSeries,
    clients: allClients,
    clientCount: allClients.length,
    clientDetails: clientDetails(redemptions, deployed, colorIndexOf, lastDay),
    deployments,
    dailyUsers: dailyUserSeries(actorsByDay, deploymentDayOf, lastDay),
    heatmap: upstreamHours,
    heatmapDownstream: downstreamHours,
    heatmapAgreement: heatmapOverlap(upstreamHours, downstreamHours),
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
      redemptions7d: hasUsage ? redemptions7d : null,
      redemptions30d: hasUsage ? redemptions30d : null,
      redemptionsTotal: hasUsage ? redemptions.length : null,
      gigabytes7d: hasUsage ? gigabytes7d : null,
      gigabytes30d: hasUsage ? gigabytes30d : null,
      gigabytesTotal: hasUsage ? upstreamTotal : null,
      gigabytesDownstream7d: hasUsage ? downstreamOver(WEEK_DAYS) : null,
      gigabytesDownstream30d: hasUsage ? downstreamOver(MONTH_DAYS) : null,
      gigabytesDownstreamTotal: hasUsage ? downstreamTotal : null,
      downstreamRatio:
        hasUsage && upstreamTotal > 0 ? downstreamTotal / upstreamTotal : null,
      gigabytesDownstreamRaw: hasUsage
        ? sum(candidates, (row) => row.gigabytes)
        : null,
      probeFloorGigabytes: hasUsage
        ? [...probeFloor.values()].reduce((total, value) => total + value, 0)
        : null,
      // Not fetched at all once the exits are named, and reporting zero would
      // read as "nobody probes" rather than "nobody asked".
      probeGigabytesTotal:
        hasUsage && knownExits.size === 0
          ? sum(probes, (row) => row.gigabytes)
          : null,
      exitsNamed: hasUsage ? knownExits.size : null,
      exitsSeen: hasUsage ? exits.size : null,
      ticketsTotal: hasUsage ? ticketsTotal : null,
      relayers7d: hasUsage ? relayers7d.size : null,
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
  redemptions30d: null,
  gigabytes7d: null,
  gigabytes30d: null,
  gigabytesTotal: null,
  gigabytesDownstream7d: null,
  gigabytesDownstream30d: null,
  gigabytesDownstreamTotal: null,
  downstreamRatio: null,
  gigabytesDownstreamRaw: null,
  probeFloorGigabytes: null,
  probeGigabytesTotal: null,
  exitsNamed: null,
  exitsSeen: null,
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
    relayerDownstreamDaily: [],
    relayerSeries: [],
    clients: [],
    clientCount: 0,
    clientDetails: {},
    deployments: [],
    dailyUsers: [],
    heatmap: [],
    heatmapDownstream: [],
    heatmapAgreement: null,
    retention: [],
    recentRedemptions: [],
    contracts: [],
    panels: failedPanels(message),
    ticket: { winProbability: null, priceWei: null, valueWei: null },
    totals: EMPTY_TOTALS,
    warnings: [message],
  };
}

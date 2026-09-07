import 'server-only';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Pool, type QueryResultRow } from 'pg';

import { COMBINED } from './constants';
import { fixtureDashboard } from './fixtures';
import {
  resolveNetworks,
  type NetworkConfig,
  type NetworkSummary,
} from './networks';
import { resolveBlockClock, type BlockClock } from './rpc';
import {
  buildSnapshot,
  dayIndex,
  healthyPanels,
  PANEL_KEYS,
  redemptionVolume,
  unavailableSnapshot,
  type AnalyticsSnapshot,
  type DeployedClient,
  type NetworkDataset,
  type PanelKey,
  type Redemption,
} from './snapshot';

export type { AnalyticsSnapshot } from './snapshot';
export { COMBINED } from './constants';

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
  source: Buffer;
  destination: Buffer;
  /** Whether the payer announced: an announced payer is a relay or an exit. */
  source_announced: boolean;
  published_block: string;
  tickets: string;
};

type FeedRow = QueryResultRow & {
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

type ContractRow = QueryResultRow & { address: Buffer; topics: string[] };
type WinProbRow = QueryResultRow & { block_number: string; win_prob: Buffer };
type TicketPriceRow = QueryResultRow & {
  block_number: string;
  ticket_price: Buffer;
};

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
  const value = await readFile(
    path.join(process.cwd(), 'sql', 'v1', `${name}.sql`),
    'utf8',
  );
  sqlCache.set(name, value);
  return value;
}

function fromBigEndian(bytes: Buffer): bigint {
  return bytes.reduce((value, byte) => (value << 8n) + BigInt(byte), 0n);
}

function hex(bytes: Buffer): string {
  return `0x${bytes.toString('hex')}`;
}

/**
 * Addresses, shared rather than copied.
 *
 * A network has a few dozen participants and hundreds of thousands of
 * redemptions, so `hex` otherwise allocates the same forty-two characters over
 * and over, and every one of them is retained for as long as the snapshot lives.
 * Interning collapses that to one string per participant.
 */
function interner() {
  const seen = new Map<string, string>();
  return (bytes: Buffer): string => {
    const key = bytes.toString('hex');
    let value = seen.get(key);
    if (value === undefined) {
      value = `0x${key}`;
      seen.set(key, value);
    }
    return value;
  };
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

/**
 * Event signature hashes to the role of the contract that emits them.
 *
 * Blokli registers each contract against the topics it watches, so the topics a
 * row carries name the contract without needing a deployment manifest.
 */
const CONTRACT_ROLES = new Map([
  [
    'ed22f34d154d253a7f6fd477439be59080a1554aa0d0642686d64223ab544c8a',
    'Channels',
  ],
  [
    '004c0177ad15bb302b4419e9ac96065d6f436e0f61972f97bbe272834c40f934',
    'Channels',
  ],
  [
    '197bba684a6afb7ba24f1d265605414b1d0051a6e295d6ff7b6e78e870d7a7f0',
    'Channels',
  ],
  [
    'c4df5ba16814838ab2618829d68f8623bb897302f24dbdba2279dbe45adb3d14',
    'Announcements',
  ],
  [
    '11d94653de52fc143887956fe4b5e4120a850b1300ece0533dee6bd8ff91f732',
    'Announcements',
  ],
  [
    'a4de30a528becadf82649d1395c0e30dd18ae35b5a96ce71e9295bb14bc9f3bc',
    'Announcements',
  ],
  [
    '776da40cbf2c223552661bd48502ceb72409b3362bb0c66d8989bd7e20e4497d',
    'Node safe registry',
  ],
  [
    '1eb3e9b31552ebe06015df6569e31abbec0e73a88c3ccdd9fead65c4378b4e50',
    'Node safe registry',
  ],
  [
    '2c906e9f9056ce9dab322be95fe710c2ecfa369bf6bf530bc81ced25caee90e1',
    'Service registry',
  ],
  [
    '38a84f1ca3cac973fcc30eeaccfd5a063993a9bd564530c4790ef60291c6b161',
    'Service registry',
  ],
  [
    'd4c5e06b1ae097ba02372652a7adaa6e4a8e00be527497a3ad0ebc3f761ef3fb',
    'Ticket price oracle',
  ],
  [
    '02728c4a80373f4765559dc3a046edea88186424827238bb46245668315d3800',
    'Winning probability oracle',
  ],
  [
    '06b541ddaa720db2b10a4d0cdac39b8d360425fc073085fac19bc82614677987',
    'wxHOPR token',
  ],
  [
    'f4caeb2d6ca8932a215a353d0703c326ec2d81fc68170f320eb2ab49e9df61f9',
    'wxHOPR token',
  ],
  [
    '83a5c31bfee49d254d95e3946d8e8434e5975382fa8b849182db9e251aaaaa26',
    'Node stake factory',
  ],
  ['141df868a6331af528e38c83b7aa03edc19be66e37ae67f9285bf4f8e3c6a1a8', 'Safe'],
  ['442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e', 'Safe'],
]);

function estimatedClock(latestBlock: number): BlockClock {
  const now = Math.floor(Date.now() / 1000);
  return (block) => now - (latestBlock - block) * BLOCK_SECONDS;
}

/** Reads one index database into the shape the snapshot builder consumes. */
async function queryNetwork(network: NetworkConfig): Promise<NetworkDataset> {
  const db = database(network);
  // Handed to the redemption query so it can leave the probe traffic in the
  // database. Empty means the exits are unknown and everything has to come back.
  const exitBytes = network.exits.map((exit) =>
    Buffer.from(exit.slice(2), 'hex'),
  );
  const warnings: string[] = [];
  const panels = healthyPanels();

  /**
   * Records a query failure once, against the panels it blanks.
   *
   * The same string is both the panel's reason and a methodology warning, so the
   * tile and the footnote can never disagree about what is missing.
   */
  const unavailable = (key: PanelKey, reason: string) => {
    if (panels[key].state !== 'ok') return;
    panels[key] = { state: 'failed', reason };
    warnings.push(reason);
  };

  // The summary is the only query a network cannot be rendered without; the rest
  // degrade to an empty panel so one broken relation never blanks the dashboard.
  const summaryResult = await db.query<SummaryRow>(await sql('summary'));
  const summary = summaryResult.rows[0];
  if (!summary) throw new Error('Blokli chain_info is not initialized');

  const [
    channelBalances,
    safeBalances,
    redemptionRows,
    feedRows,
    deploymentRows,
    winProbRows,
    priceRows,
    contractRows,
  ] = await Promise.allSettled([
    db.query<{ balance: Buffer }>(await sql('channel-balances')),
    db.query<{ balance: Buffer }>(await sql('safe-balances')),
    db.query<RedemptionRow>(await sql('redemptions'), [exitBytes]),
    db.query<FeedRow>(await sql('recent-redemptions')),
    db.query<DeploymentRow>(await sql('client-deployments')),
    db.query<WinProbRow>(await sql('win-prob-updates')),
    db.query<TicketPriceRow>(await sql('ticket-price-updates')),
    db.query<ContractRow>(await sql('contracts')),
  ]);

  const rawRedemptions =
    redemptionRows.status === 'fulfilled' ? redemptionRows.value.rows : [];
  if (redemptionRows.status === 'rejected') {
    unavailable(
      'usage',
      'Redemption history could not be read; usage panels are empty.',
    );
  }
  const rawDeployments =
    deploymentRows.status === 'fulfilled' ? deploymentRows.value.rows : [];
  if (deploymentRows.status === 'rejected') {
    unavailable(
      'deployments',
      'Client deployments could not be read; active users count redemptions only.',
    );
  }
  if (priceRows.status === 'rejected') {
    unavailable('ticket', 'Ticket price history could not be read.');
  }
  if (winProbRows.status === 'rejected') {
    unavailable('ticket', 'Winning probability history could not be read.');
  }
  if (
    channelBalances.status === 'rejected' ||
    safeBalances.status === 'rejected'
  ) {
    unavailable('balances', 'Channel and safe balances could not be read.');
  }

  // chain_info holds only the current winning probability. The raw log table, when
  // it lives in this database, carries the full oracle history instead.
  const currentWinProb = Number(summary.win_prob);
  const fallbackWinProb =
    Number.isFinite(currentWinProb) && currentWinProb > 0 ? currentWinProb : 1;
  const timeline: Array<[number, number]> =
    winProbRows.status === 'fulfilled'
      ? winProbRows.value.rows.map((row) => [
          Number(row.block_number),
          decodeWinProbability(row.win_prob),
        ])
      : [];

  let winProbability: NetworkDataset['winProbability'] = 'historical';
  if (!timeline.length) {
    winProbability =
      Number.isFinite(currentWinProb) && currentWinProb > 0
        ? 'current'
        : 'assumed';
    warnings.push(
      winProbability === 'current'
        ? 'Winning probability history is unavailable; volume uses the current value throughout.'
        : 'Winning probability is not indexed; volume assumes a probability of 1.',
    );
  }
  const probabilityAt = winProbabilityAt(timeline, fallbackWinProb);

  const priceTimeline: Array<[number, bigint]> =
    priceRows.status === 'fulfilled'
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

  let timebase: NetworkDataset['timebase'] = 'estimated';
  let clock = estimatedClock(latestBlock);
  if (network.rpcUrl) {
    try {
      clock = await resolveBlockClock(network.rpcUrl, firstBlock, latestBlock);
      timebase = 'rpc';
    } catch {
      warnings.push(
        'RPC timestamps are unavailable; dates are estimated from block height.',
      );
    }
  }

  const participant = interner();
  const redemptions: Redemption[] = rawRedemptions.map((row) => {
    const block = Number(row.published_block);
    const timestamp = clock(block);
    return {
      network: network.id,
      source: participant(row.source),
      destination: participant(row.destination),
      day: dayIndex(timestamp),
      timestamp,
      tickets: Number(row.tickets),
      gigabytes: redemptionVolume(probabilityAt(block)),
      sourceAnnounced: row.source_announced,
    };
  });

  // Its own query only so the bulk rows need not carry a channel id; it selects
  // the same client traffic the panels count.
  const feed = feedRows.status === 'fulfilled' ? feedRows.value.rows : [];
  const recentRedemptions = feed.map((row, index) => ({
    key: `${network.id}-${index}`,
    timestamp: new Date(
      clock(Number(row.published_block)) * 1000,
    ).toISOString(),
    source: participant(row.source),
    destination: participant(row.destination),
    channelId: row.channel_id,
    network: network.id,
  }));
  const deployed: DeployedClient[] = rawDeployments.map((row) => {
    const timestamp = clock(Number(row.published_block));
    return {
      network: network.id,
      address: participant(row.account),
      day: dayIndex(timestamp),
      timestamp,
    };
  });

  const contracts =
    contractRows.status === 'fulfilled'
      ? contractRows.value.rows.map((row) => {
          const address = hex(row.address);
          const role = row.topics
            .map((topic) => CONTRACT_ROLES.get(topic))
            .find(Boolean);
          return {
            key: `${network.id} ${address}`,
            address,
            network: network.id,
            role: role ?? 'Indexed contract',
          };
        })
      : [];

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
      channelBalances.status === 'fulfilled'
        ? sumBalances(channelBalances.value.rows)
        : null,
    safeBalance:
      safeBalances.status === 'fulfilled'
        ? sumBalances(safeBalances.value.rows)
        : null,
    redemptions,
    recentRedemptions,
    deployed,
    contracts,
    ticket: {
      winProbability: currentProbability,
      priceWei: currentPrice?.toString() ?? null,
      valueWei:
        currentPrice !== null && currentProbability
          ? BigInt(
              Math.round(Number(currentPrice) / currentProbability),
            ).toString()
          : null,
    },
    timebase,
    winProbability,
    exits: network.exits,
    panels,
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
    if (result.status === 'fulfilled') {
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
      : unavailableSnapshot('No index database could be read.');
    if (failures.length && datasets.length) {
      const reason = `Excluded from these totals: ${failures.join(', ')}.`;
      combined.source = 'degraded';
      combined.warnings = [...combined.warnings, reason];
      // A network that could not be read at all is missing from every panel, not
      // from one query's worth of them.
      for (const key of PANEL_KEYS) {
        if (combined.panels[key].state === 'ok') {
          combined.panels[key] = { state: 'partial', reason };
        }
      }
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
      error instanceof Error
        ? error.message
        : 'The dashboard configuration is invalid.';
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
  // `degraded` is the same data with a network reporting failed queries, for
  // working on the unavailable and partial tile states.
  const fixtures = process.env.DASHBOARD_FIXTURES;
  if (fixtures === '1' || fixtures === 'degraded') return fixtureDashboard();

  if (cached && cached.expiresAt > Date.now()) return cached.value;
  refreshing ??= refreshDashboard();
  return refreshing;
}

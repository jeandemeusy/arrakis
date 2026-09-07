import type { Dashboard } from './analytics';
import { COMBINED } from './constants';
import {
  buildSnapshot,
  dayIndex,
  healthyPanels,
  redemptionVolume,
  type AnalyticsSnapshot,
  type DeployedClient,
  type NetworkDataset,
  type Redemption,
} from './snapshot';

/**
 * Synthetic networks for working on the UI without a database.
 *
 * Enabled with `DASHBOARD_FIXTURES=1`, or `DASHBOARD_FIXTURES=degraded` to make
 * the second network report failed queries, which is the only way to see the
 * unavailable and partial tile states without breaking a real database. The generator is seeded, so reloads render
 * the same numbers and a styling change is the only thing that moves between two
 * screenshots. It deliberately produces a long relayer tail, a wide client spread
 * and uneven daily activity, because those are the shapes that break layouts.
 *
 * The generated redemptions go through the real `buildSnapshot`, so the fixture
 * exercises the aggregation rather than fabricating its output. What it does not
 * exercise is the SQL and the decoding in `analytics.ts`, which stay untested here.
 */

const DAY_SECONDS = 86_400;
const SEED = 0x5eed;
const LATEST_BLOCK = 48_060_000;

/** Two networks of different sizes and winning probabilities, as in production. */
const NETWORKS = [
  {
    id: 'jura',
    label: 'Jura',
    clients: 60,
    relayers: 14,
    exits: 4,
    winProbability: 0.000004,
  },
  {
    id: 'dev',
    label: 'Dev',
    clients: 18,
    relayers: 5,
    exits: 2,
    winProbability: 0.00002,
  },
] as const;

/**
 * Downstream volume as a multiple of upstream.
 *
 * Browsing is lopsided — a request is small and its answer is not — so a VPN
 * that came back symmetric would be the suspicious fixture, not this one.
 */
const DOWNSTREAM_RATIO = 8;
/** Probe hops each announced node pays for per day, traffic or no traffic. */
const PROBES_PER_NODE_DAY = 3;

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
  let out = '0x';
  for (let i = 0; i < 40; i += 1) out += Math.floor(next() * 16).toString(16);
  return out;
}

function channelId(next: () => number): string {
  let out = '';
  for (let i = 0; i < 64; i += 1) out += Math.floor(next() * 16).toString(16);
  return out;
}

/**
 * Whether a fixture network has a working RPC.
 *
 * Only the degraded fixture takes one away, and only from the second network.
 * The plain fixture keeps every clock RPC-resolved, because that is the healthy
 * deployment and `npm run dev:fixtures` should show the healthy page — a feed
 * quoting block numbers because the fixture quietly withheld an RPC is a
 * confusing default, however useful the branch is to have covered.
 */
function fixtureTimebase(network: string): 'rpc' | 'estimated' {
  return process.env.DASHBOARD_FIXTURES === 'degraded' && network === 'dev'
    ? 'estimated'
    : 'rpc';
}

/** Panels the fixture pretends could not be read, for styling the failure states. */
function fixturePanels(network: string) {
  const panels = healthyPanels();
  if (process.env.DASHBOARD_FIXTURES !== 'degraded' || network !== 'dev') {
    return panels;
  }
  panels.deployments = {
    state: 'failed',
    reason:
      'Client deployments could not be read; active users count redemptions only.',
  };
  panels.balances = {
    state: 'failed',
    reason: 'Channel and safe balances could not be read.',
  };
  // Usage too, because that is the shape production actually degrades into: a
  // whole network unreachable marks every panel, and it is the only way to see a
  // tile carrying both a flag and a control in its header.
  panels.usage = {
    state: 'failed',
    reason: 'Redemption history could not be read; usage panels are empty.',
  };
  return panels;
}

function dataset(
  config: (typeof NETWORKS)[number],
  next: () => number,
  lastDay: number,
  startDay: number,
): NetworkDataset {
  const panels = fixturePanels(config.id);
  const days = Math.max(1, lastDay - startDay + 1);
  const relayers = Array.from({ length: config.relayers }, () => address(next));
  const clients = Array.from({ length: config.clients }, () => address(next));
  // Exits announce, exactly as relays do. One of them also relays for clients,
  // which is the case that breaks identification by elimination: it lands in the
  // relay set, so its return traffic would be filed as probing and lost. Naming
  // the exits is what survives it, and this is the fixture that proves it.
  const exits = Array.from({ length: config.exits }, () => address(next));
  const relayPool = [...relayers, exits[0]];

  // Each client appears at some point in the window and stays around afterwards.
  const deployedOn = new Map<string, number>();
  clients.forEach((client, index) => {
    deployedOn.set(
      client,
      startDay + Math.floor((index / config.clients) * days * 0.9),
    );
  });

  // One client is deployed and nothing is ever redeemed against it. It is a
  // node that was set up and never used — and the only one that exercises the
  // empty client record.
  const idle = clients.at(-1);

  const perRedemption = redemptionVolume(config.winProbability);
  const redemptions: Redemption[] = [];
  for (let day = startDay; day <= lastDay; day += 1) {
    const ramp = Math.min(1, (day - startDay) / (days * 0.4));
    const wobble = 0.55 + 0.45 * Math.sin((day - startDay) / 9);
    const active = clients.filter(
      (client) => client !== idle && (deployedOn.get(client) ?? 0) <= day,
    );
    const count = Math.round(
      active.length * 0.35 * ramp * wobble * (0.6 + next()),
    );
    for (let i = 0; i < count; i += 1) {
      // Traffic clusters in the working day rather than spreading evenly.
      const hour = Math.floor(6 + next() * 14);
      const timestamp =
        day * DAY_SECONDS + hour * 3600 + Math.floor(next() * 3600);
      redemptions.push({
        network: config.id,
        source: active[Math.floor(next() * active.length)],
        // A skewed pick gives the long tail the donut and stack need to be tested.
        destination: relayPool[Math.floor(next() ** 2 * relayPool.length)],
        day,
        timestamp,
        tickets: 30 + Math.floor(next() * 60),
        gigabytes: perRedemption,
        sourceAnnounced: false,
      });
    }

    // The return path: the exit pays a relay, so it names no client.
    const returning = Math.round(
      count * DOWNSTREAM_RATIO * (0.8 + next() * 0.4),
    );
    for (let i = 0; i < returning; i += 1) {
      const hour = Math.floor(6 + next() * 14);
      redemptions.push({
        network: config.id,
        source: exits[Math.floor(next() * exits.length)],
        destination: relayers[Math.floor(next() ** 2 * relayers.length)],
        day,
        timestamp: day * DAY_SECONDS + hour * 3600 + Math.floor(next() * 3600),
        tickets: 30 + Math.floor(next() * 60),
        gigabytes: perRedemption,
        sourceAnnounced: true,
      });
    }

    // Probing: every announced node measures the network, indifferent to
    // whether anyone used the VPN. A relay's probes land in the calibration set;
    // an exit's land among the downstream candidates, which is precisely the
    // contamination the estimate has to subtract back out.
    //
    // Probes take one to three paid hops, and that asymmetry is the point: a
    // relay pays for its own probes AND for forwarding everyone else's, while
    // an exit only ever pays the first hop of its own. A per-node rate averaged
    // over relays therefore charges an exit for forwarding it never did. The
    // fixture has to generate the multi-hop case or it cannot catch that.
    for (const prober of [...relayers, ...exits]) {
      for (let i = 0; i < PROBES_PER_NODE_DAY; i += 1) {
        let payer = prober;
        const hops = 1 + Math.floor(next() * 3);
        for (let hop = 0; hop < hops; hop += 1) {
          const peer = relayers[Math.floor(next() * relayers.length)];
          if (peer === payer) break;
          redemptions.push({
            network: config.id,
            source: payer,
            destination: peer,
            day,
            timestamp: day * DAY_SECONDS + Math.floor(next() * DAY_SECONDS),
            tickets: 1 + Math.floor(next() * 4),
            gigabytes: perRedemption,
            sourceAnnounced: true,
          });
          payer = peer;
        }
      }
    }
  }

  // A failed query returns nothing, so the fixture must not carry the rows either.
  const deployed: DeployedClient[] =
    panels.deployments.state === 'ok'
      ? [...deployedOn.entries()].map(([client, day]) => ({
          network: config.id,
          address: client,
          day,
          timestamp: day * DAY_SECONDS + 43_200,
        }))
      : [];

  // The feed is its own query in production; here it is the tail of the client
  // traffic, exactly as that query would return it.
  const recentRedemptions = [...redemptions]
    .filter((redemption) => !redemption.sourceAnnounced)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 500)
    .map((redemption, index) => ({
      key: `${config.id}-${index}`,
      timestamp: new Date(redemption.timestamp * 1000).toISOString(),
      // Gnosis makes a block roughly every five seconds, so a day is ~17,280.
      block: LATEST_BLOCK - (lastDay - redemption.day) * 17_280,
      source: redemption.source,
      destination: redemption.destination,
      channelId: channelId(next),
      network: config.id,
    }));

  const priceWei = 10_000_000_000_000n;
  return {
    network: config.id,
    label: config.label,
    lastDay,
    blockNumber: LATEST_BLOCK,
    schemaVersion: '1.5.0-fixture',
    accounts: config.clients + config.relayers + config.exits,
    safes: config.clients,
    openChannels: config.clients * 2,
    channelBalance:
      panels.balances.state === 'ok'
        ? BigInt(config.clients) * 70n * 10n ** 18n
        : null,
    safeBalance:
      panels.balances.state === 'ok'
        ? BigInt(config.clients) * 1_500n * 10n ** 18n
        : null,
    redemptions,
    recentRedemptions,
    deployed,
    contracts: [
      { role: 'Channels' },
      { role: 'Announcements' },
      { role: 'Ticket price oracle' },
      { role: 'Winning probability oracle' },
      { role: 'Node safe registry' },
    ].map(({ role }) => {
      const addr = address(next);
      return {
        key: `${config.id} ${addr}`,
        address: addr,
        network: config.id,
        role,
      };
    }),
    ticket: {
      winProbability: config.winProbability,
      priceWei: priceWei.toString(),
      valueWei: BigInt(
        Math.round(Number(priceWei) / config.winProbability),
      ).toString(),
    },
    timebase: fixtureTimebase(config.id),
    winProbability: 'historical',
    // The fixture names its exits, as a real deployment should.
    exits,
    panels,
    warnings: [
      'Fixture data — DASHBOARD_FIXTURES is enabled, nothing here is real.',
      ...Object.values(panels)
        .map((panel) => panel.reason)
        .filter((reason): reason is string => reason !== null),
    ],
  };
}

/**
 * Built once and kept.
 *
 * The generator is seeded, so every call produces the same dashboard; with both
 * traffic directions and per-day probing it also produces a few hundred thousand
 * rows, and regenerating those on every page view made the fixture slower than
 * the database it stands in for.
 */
let built: Dashboard | undefined;

export function fixtureDashboard(): Dashboard {
  if (built) return built;
  const next = random(SEED);
  const lastDay = dayIndex(Date.now() / 1000);
  const startDay = dayIndex(Date.UTC(2026, 0, 1) / 1000);

  const datasets = NETWORKS.map((config) =>
    dataset(config, next, lastDay, startDay),
  );
  const snapshots: Record<string, AnalyticsSnapshot> = {};
  for (const set of datasets) snapshots[set.network] = buildSnapshot([set]);
  snapshots[COMBINED] = buildSnapshot(datasets);

  built = {
    networks: NETWORKS.map(({ id, label }) => ({ id, label })),
    snapshots,
    defaultNetwork: COMBINED,
  };
  return built;
}

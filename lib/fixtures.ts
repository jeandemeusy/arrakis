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
    winProbability: 0.000004,
  },
  {
    id: 'dev',
    label: 'Dev',
    clients: 18,
    relayers: 5,
    winProbability: 0.00002,
  },
] as const;

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

  // Each client appears at some point in the window and stays around afterwards.
  const deployedOn = new Map<string, number>();
  clients.forEach((client, index) => {
    deployedOn.set(
      client,
      startDay + Math.floor((index / config.clients) * days * 0.9),
    );
  });

  const perRedemption = redemptionVolume(config.winProbability);
  const redemptions: Redemption[] = [];
  for (let day = startDay; day <= lastDay; day += 1) {
    const ramp = Math.min(1, (day - startDay) / (days * 0.4));
    const wobble = 0.55 + 0.45 * Math.sin((day - startDay) / 9);
    const active = clients.filter(
      (client) => (deployedOn.get(client) ?? 0) <= day,
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
        channelId: channelId(next),
        source: active[Math.floor(next() * active.length)],
        // A skewed pick gives the long tail the donut and stack need to be tested.
        destination: relayers[Math.floor(next() ** 2 * relayers.length)],
        day,
        timestamp,
        tickets: 30 + Math.floor(next() * 60),
        gigabytes: perRedemption,
      });
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

  const priceWei = 10_000_000_000_000n;
  return {
    network: config.id,
    label: config.label,
    lastDay,
    blockNumber: LATEST_BLOCK,
    schemaVersion: '1.5.0-fixture',
    accounts: config.clients + config.relayers,
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
    timebase: 'rpc',
    winProbability: 'historical',
    panels,
    warnings: [
      'Fixture data — DASHBOARD_FIXTURES is enabled, nothing here is real.',
      ...Object.values(panels)
        .map((panel) => panel.reason)
        .filter((reason): reason is string => reason !== null),
    ],
  };
}

export function fixtureDashboard(): Dashboard {
  const next = random(SEED);
  const lastDay = dayIndex(Date.now() / 1000);
  const startDay = dayIndex(Date.UTC(2026, 0, 1) / 1000);

  const datasets = NETWORKS.map((config) =>
    dataset(config, next, lastDay, startDay),
  );
  const snapshots: Record<string, AnalyticsSnapshot> = {};
  for (const set of datasets) snapshots[set.network] = buildSnapshot([set]);
  snapshots[COMBINED] = buildSnapshot(datasets);

  return {
    networks: NETWORKS.map(({ id, label }) => ({ id, label })),
    snapshots,
    defaultNetwork: COMBINED,
  };
}

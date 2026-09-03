import type { Dashboard } from "./analytics";
import { COMBINED } from "./constants";
import {
  buildSnapshot,
  dayIndex,
  redemptionVolume,
  type AnalyticsSnapshot,
  type DeployedClient,
  type NetworkDataset,
  type Redemption,
} from "./snapshot";

/**
 * Synthetic networks for working on the UI without a database.
 *
 * Enabled with `DASHBOARD_FIXTURES=1`. The generator is seeded, so reloads render
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

/** Two networks of different sizes and winning probabilities, as in production. */
const NETWORKS = [
  { id: "jura", label: "Jura", clients: 60, relayers: 14, winProbability: 0.000004 },
  { id: "dev", label: "Dev", clients: 18, relayers: 5, winProbability: 0.00002 },
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
  let out = "0x";
  for (let i = 0; i < 40; i += 1) out += Math.floor(next() * 16).toString(16);
  return out;
}

function channelId(next: () => number): string {
  let out = "";
  for (let i = 0; i < 64; i += 1) out += Math.floor(next() * 16).toString(16);
  return out;
}

function dataset(
  config: (typeof NETWORKS)[number],
  next: () => number,
  lastDay: number,
  startDay: number,
): NetworkDataset {
  const days = Math.max(1, lastDay - startDay + 1);
  const relayers = Array.from({ length: config.relayers }, () => address(next));
  const clients = Array.from({ length: config.clients }, () => address(next));

  // Each client appears at some point in the window and stays around afterwards.
  const deployedOn = new Map<string, number>();
  clients.forEach((client, index) => {
    deployedOn.set(client, startDay + Math.floor((index / config.clients) * days * 0.9));
  });

  const perRedemption = redemptionVolume(config.winProbability);
  const redemptions: Redemption[] = [];
  for (let day = startDay; day <= lastDay; day += 1) {
    const ramp = Math.min(1, (day - startDay) / (days * 0.4));
    const wobble = 0.55 + 0.45 * Math.sin((day - startDay) / 9);
    const active = clients.filter((client) => (deployedOn.get(client) ?? 0) <= day);
    const count = Math.round(active.length * 0.35 * ramp * wobble * (0.6 + next()));
    for (let i = 0; i < count; i += 1) {
      // Traffic clusters in the working day rather than spreading evenly.
      const hour = Math.floor(6 + next() * 14);
      redemptions.push({
        network: config.id,
        channelId: channelId(next),
        source: active[Math.floor(next() * active.length)],
        // A skewed pick gives the long tail the donut and stack need to be tested.
        destination: relayers[Math.floor(next() ** 2 * relayers.length)],
        day,
        timestamp: day * DAY_SECONDS + hour * 3600 + Math.floor(next() * 3600),
        tickets: 30 + Math.floor(next() * 60),
        gigabytes: perRedemption,
      });
    }
  }

  const deployed: DeployedClient[] = [...deployedOn.entries()].map(([client, day]) => ({
    network: config.id,
    address: client,
    day,
    timestamp: day * DAY_SECONDS + 43_200,
  }));

  const priceWei = 10_000_000_000_000n;
  return {
    network: config.id,
    label: config.label,
    lastDay,
    blockNumber: 48_060_000,
    schemaVersion: "1.5.0-fixture",
    accounts: config.clients + config.relayers,
    safes: config.clients,
    openChannels: config.clients * 2,
    channelBalance: BigInt(config.clients) * 70n * 10n ** 18n,
    safeBalance: BigInt(config.clients) * 1_500n * 10n ** 18n,
    redemptions,
    deployed,
    ticket: {
      winProbability: config.winProbability,
      priceWei: priceWei.toString(),
      valueWei: BigInt(Math.round(Number(priceWei) / config.winProbability)).toString(),
    },
    timebase: "rpc",
    winProbability: "historical",
    hasUsage: true,
    hasDeployments: true,
    warnings: ["Fixture data — DASHBOARD_FIXTURES is enabled, nothing here is real."],
  };
}

export function fixtureDashboard(): Dashboard {
  const next = random(SEED);
  const lastDay = dayIndex(Date.now() / 1000);
  const startDay = dayIndex(Date.UTC(2026, 0, 1) / 1000);

  const datasets = NETWORKS.map((config) => dataset(config, next, lastDay, startDay));
  const snapshots: Record<string, AnalyticsSnapshot> = {};
  for (const set of datasets) snapshots[set.network] = buildSnapshot([set]);
  snapshots[COMBINED] = buildSnapshot(datasets);

  return {
    networks: NETWORKS.map(({ id, label }) => ({ id, label })),
    snapshots,
    defaultNetwork: COMBINED,
  };
}

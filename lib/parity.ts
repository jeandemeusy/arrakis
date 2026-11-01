import 'server-only';

import { queryNetwork } from './analytics';
import type { NetworkConfig } from './networks';
import { blockClock, timeOf } from './query/clock';
import { listExits } from './query/exits';
import { getQuery } from './query/store';
import { GNOSIS_VPN } from './seed/gnosis-vpn';
import {
  buildSnapshot,
  type AnalyticsSnapshot,
  type NetworkDataset,
} from './snapshot';
import { finalizeConfig } from './viz/config';
import { runVisualization } from './viz/run';
import { asText } from './viz/text';

/**
 * Checks the saved-query dashboard against the snapshot it replaces.
 *
 * The old figures come from lib/snapshot.ts exactly as the current page
 * computes them, with one change: the exits are the ones configured in the
 * application database, the same set the saved queries read, since the two
 * can only agree about the same exits. The new figures come from the bundled
 * dashboard's own chart definitions, run over the stored results — so what
 * is checked is what the installed dashboard shows.
 *
 * Every line says how the two compare: `match` (equal, or equal to floating-
 * point rounding), `close` (within 1%, or timestamps within a minute — the
 * two sides sample block times independently), `differs`, or `expected` for
 * a definition that changed on purpose, which says why.
 */

export type Status = 'match' | 'close' | 'differs' | 'expected';

export type ParityLine = {
  area: string;
  metric: string;
  old: string;
  new: string;
  status: Status;
  note?: string;
};

type Row = Record<string, unknown>;

const RANGES = [
  { old: '7d', var: '7d', days: 7 },
  { old: '30d', var: '31d', days: 31 },
  { old: '90d', var: '90d', days: 90 },
  { old: 'all', var: 'all', days: null },
] as const;

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function show(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (Number.isInteger(value)) return String(value);
  return Math.abs(value) < 0.01 ? value.toExponential(6) : value.toFixed(6);
}

/** How two figures compare: exactly for counts, to a tolerance for volumes. */
export function compare(
  a: number | null,
  b: number | null,
  exact = false,
): Status {
  if (a === null || b === null) return a === b ? 'match' : 'differs';
  if (a === b) return 'match';
  if (exact) return 'differs';
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  const relative = Math.abs(a - b) / scale;
  if (relative < 1e-9) return 'match';
  return relative < 0.01 ? 'close' : 'differs';
}

function worst(statuses: Status[]): Status {
  for (const status of ['differs', 'close', 'expected'] as const) {
    if (statuses.includes(status)) return status;
  }
  return 'match';
}

export async function newRows(
  key: string,
  targets: NetworkConfig[],
  vars: Record<string, string | undefined>,
): Promise<Row[]> {
  const definition = GNOSIS_VPN.visualizations.find(
    (entry) => entry.key === key,
  );
  if (!definition) throw new Error(`No chart ${key} in the bundle`);
  const query = await getQuery(definition.query);
  if (!query) throw new Error(`Query ${definition.query} is not installed`);
  const data = await runVisualization({
    query,
    config: finalizeConfig(definition.type, definition.config),
    targets,
    vars,
  });
  if (data.pending)
    throw new Error(`${definition.query} has no stored result yet`);
  return data.rows.map((row) =>
    Object.fromEntries(
      data.columns.map((column, index) => [column.name, row[index]]),
    ),
  );
}

/** The old snapshot, with the exits the saved queries use. */
export async function oldSnapshot(
  targets: NetworkConfig[],
): Promise<AnalyticsSnapshot> {
  const datasets: NetworkDataset[] = [];
  for (const network of targets) {
    const exits = (await listExits(network.id)).map((exit) =>
      exit.address.toLowerCase(),
    );
    // The clock the stored results were dated with, so a block falls on the
    // same second — and the same day and hour — on both sides.
    const clock = await blockClock(network);
    datasets.push(
      await queryNetwork(
        { ...network, exits },
        {
          at: (block) => timeOf(clock, block),
          timebase: clock.timebase,
        },
      ),
    );
  }
  return buildSnapshot(datasets);
}

/** Compares two keyed series point by point. */
function series(
  area: string,
  metric: string,
  old: Map<string, number>,
  now: Map<string, number>,
  exact = false,
): ParityLine {
  const keys = new Set([...old.keys(), ...now.keys()]);
  const statuses: Status[] = [];
  let mismatched = 0;
  let largest = 0;
  for (const key of keys) {
    const a = old.get(key) ?? 0;
    const b = now.get(key) ?? 0;
    const status = compare(a, b, exact);
    statuses.push(status);
    if (status !== 'match') {
      mismatched += 1;
      largest = Math.max(largest, Math.abs(a - b));
    }
  }
  return {
    area,
    metric,
    old: `${old.size} points`,
    new: `${now.size} points`,
    status: worst(statuses),
    note: mismatched
      ? `${mismatched} of ${keys.size} differ, by up to ${show(largest)}`
      : undefined,
  };
}

function figure(
  area: string,
  metric: string,
  a: number | null,
  b: number | null,
  exact = false,
): ParityLine {
  return {
    area,
    metric,
    old: show(a),
    new: show(b),
    status: compare(a, b, exact),
  };
}

function seconds(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const at = Date.parse(String(value));
  return Number.isNaN(at) ? null : at / 1000;
}

function moment(
  area: string,
  metric: string,
  a: string | null,
  b: unknown,
): ParityLine {
  const left = a === null ? null : seconds(a);
  const right = seconds(b);
  const status: Status =
    left === null || right === null
      ? left === right
        ? 'match'
        : 'differs'
      : Math.abs(left - right) < 1
        ? 'match'
        : Math.abs(left - right) <= 60
          ? 'close'
          : 'differs';
  return {
    area,
    metric,
    old: a ?? '—',
    new: right === null ? '—' : new Date(right * 1000).toISOString(),
    status,
  };
}

export async function checkParity(
  targets: NetworkConfig[],
  options: { clients?: number } = {},
): Promise<ParityLine[]> {
  const lines: ParityLine[] = [];
  const old = await oldSnapshot(targets);
  const single = targets.length === 1;
  const base = { network: single ? targets[0].id : 'all' };
  const rows = (key: string, vars: Record<string, string | undefined> = {}) =>
    newRows(key, targets, { ...base, direction: 'upstream', ...vars });
  const one = async (
    key: string,
    column: string,
    vars: Record<string, string | undefined> = {},
  ) => (await rows(key, vars))[0]?.[column];

  // Headline figures, at every range.
  const totals = old.totals;
  const byRange = {
    redemptions: [
      totals.redemptions7d,
      totals.redemptions30d,
      totals.redemptions90d,
      totals.redemptionsTotal,
    ],
    upstream: [
      totals.gigabytes7d,
      totals.gigabytes30d,
      totals.gigabytes90d,
      totals.gigabytesTotal,
    ],
    downstream: [
      totals.gigabytesDownstream7d,
      totals.gigabytesDownstream30d,
      totals.gigabytesDownstream90d,
      totals.gigabytesDownstreamTotal,
    ],
    deployments: [
      totals.deployments7d,
      totals.deployments30d,
      totals.deployments90d,
      totals.clientsDeployed,
    ],
  };
  for (const [at, range] of RANGES.entries()) {
    const vars = { range: range.var };
    lines.push(
      figure(
        'Headline',
        `Redemptions · ${range.old}`,
        byRange.redemptions[at],
        num(await one('gnosis-vpn/redemptions', 'redemptions', vars)),
        true,
      ),
      figure(
        'Headline',
        `Data relayed · ${range.old}`,
        (byRange.upstream[at] ?? 0) + (byRange.downstream[at] ?? 0),
        num(await one('gnosis-vpn/data-relayed', 'gigabytes', vars)),
      ),
      figure(
        'Headline',
        `New clients · ${range.old}`,
        byRange.deployments[at],
        num(await one('gnosis-vpn/new-clients', 'clients', vars)),
        true,
      ),
    );
  }
  lines.push(
    figure(
      'Headline',
      'Monthly active users',
      totals.monthlyActiveUsers,
      num(await one('gnosis-vpn/monthly-active-users', 'users')),
      true,
    ),
  );
  const channels = (await rows('gnosis-vpn/active-channels'))[0] ?? {};
  lines.push(
    figure(
      'Headline',
      'Active channels',
      old.openChannels,
      num(channels.channels),
      true,
    ),
    {
      area: 'Headline',
      metric: 'Channel balance (wei)',
      old: old.channelBalance ?? '—',
      new: asText(channels.wei) || '—',
      status: old.channelBalance === asText(channels.wei) ? 'match' : 'differs',
    },
  );

  // The return path.
  lines.push(
    figure(
      'Return path',
      'Downstream ÷ upstream, all time',
      totals.downstreamRatio,
      num(await one('gnosis-vpn/downstream-ratio', 'ratio')),
    ),
    figure(
      'Return path',
      'Exits seen',
      totals.exitsSeen,
      num(await one('gnosis-vpn/exits-seen', 'exits')),
      true,
    ),
    figure(
      'Return path',
      'Direction agreement',
      old.heatmapAgreement,
      num(await one('gnosis-vpn/direction-agreement', 'agreement')),
    ),
  );
  if (!totals.exitsNamed) {
    lines.push({
      area: 'Return path',
      metric: 'Exits configured',
      old: '0',
      new: '0',
      status: 'expected',
      note: 'No exits configured for this view: the old page guessed them, the new one shows no downstream. Configure them on the Exits page, /settings/networks.',
    });
  }

  // Ticket parameters, per network only.
  if (single) {
    const ticket = (await rows('gnosis-vpn/winning-probability'))[0] ?? {};
    lines.push(
      figure(
        'Tickets',
        'Winning probability',
        old.ticket.winProbability,
        num(ticket.win_probability),
      ),
      figure(
        'Tickets',
        'Ticket price (wei)',
        num(old.ticket.priceWei),
        num(ticket.ticket_price),
      ),
      figure(
        'Tickets',
        'Ticket value (wei)',
        num(old.ticket.valueWei),
        num(ticket.ticket_value),
      ),
    );
  }

  // Monthly active users, every day of the series.
  {
    const now = await rows('gnosis-vpn/active-users', { range: 'all' });
    const oldSeries = new Map(
      old.activeUsers.map((point) => [point.date, point.monthly]),
    );
    const newSeries = new Map(
      now.map((row) => [String(row.day), num(row.monthly) ?? 0]),
    );
    // The new series ends at the last day anyone was active, the old one at
    // the last indexed day: trailing quiet days are compared as what they
    // are, a window still counting earlier activity, only where both exist.
    const last = [...newSeries.keys()].sort().at(-1) ?? '';
    for (const key of oldSeries.keys()) {
      if (key > last) oldSeries.delete(key);
    }
    lines.push(
      series(
        'Users',
        'Monthly active users, per day',
        oldSeries,
        newSeries,
        true,
      ),
    );
  }

  // New and returning users per day, over the last 90 days.
  {
    const now = await rows('gnosis-vpn/daily-users', { range: '90d' });
    for (const kind of ['new', 'returning'] as const) {
      const oldSeries = new Map(
        old.dailyUsers
          .map((point): [string, number] => [
            point.date,
            kind === 'new' ? point.newClients : point.returning,
          ])
          .filter(([, value]) => value > 0),
      );
      const newSeries = new Map(
        now
          .filter((row) => row.kind === kind)
          .map((row) => [String(row.day), num(row.clients) ?? 0]),
      );
      lines.push(
        series(
          'Users',
          `Daily users, ${kind}, last 90 days`,
          oldSeries,
          newSeries,
          true,
        ),
      );
    }
    lines.push({
      area: 'Users',
      metric: 'Daily users, all time',
      old: '90 days',
      new: 'all days',
      status: 'expected',
      note: 'The old panel stopped at 90 days whatever the range; the new one follows it.',
    });
  }

  // Data volume per period.
  for (const range of RANGES) {
    const now = await rows('gnosis-vpn/volume', { range: range.var });
    const newSeries = (direction: string) =>
      new Map(
        now
          .filter((row) => row.direction === direction)
          .map((row) => [String(row.period), num(row.gigabytes) ?? 0]),
      );
    if (range.old === 'all') {
      lines.push(
        series(
          'Volume',
          'Upstream per week, all time',
          new Map(old.weeks.map((week) => [week.key, week.gigabytes])),
          newSeries('upstream'),
        ),
        series(
          'Volume',
          'Downstream per week, all time',
          new Map(
            old.weeks.map((week) => [week.key, week.downstreamGigabytes]),
          ),
          newSeries('downstream'),
        ),
      );
      continue;
    }
    if (range.old === '90d') {
      lines.push({
        area: 'Volume',
        metric: 'Volume per week, 90d',
        old: 'whole weeks',
        new: 'clipped to the range',
        status: 'expected',
        note: 'The old chart kept the first week whole; the new one counts only days in the range. Totals are compared under Headline.',
      });
      continue;
    }
    const days = range.days;
    const daily = (points: typeof old.relayerDaily) =>
      new Map(
        points
          .slice(-days)
          .map((point): [string, number] => [
            point.date,
            old.relayerSeries.reduce(
              (sum, entry) => sum + Number(point[entry.key] ?? 0),
              0,
            ),
          ]),
      );
    const drop = (map: Map<string, number>) =>
      new Map([...map].filter(([, value]) => value !== 0));
    lines.push(
      series(
        'Volume',
        `Upstream per day, ${range.old}`,
        drop(daily(old.relayerDaily)),
        newSeries('upstream'),
      ),
      series(
        'Volume',
        `Downstream per day, ${range.old}`,
        drop(daily(old.relayerDownstreamDaily)),
        newSeries('downstream'),
      ),
    );
  }

  // Hour-of-week shares.
  for (const range of RANGES) {
    for (const direction of ['upstream', 'downstream'] as const) {
      const grid = (
        direction === 'upstream' ? old.heatmaps : old.heatmapsDownstream
      )[range.old];
      const oldCells = new Map<string, number>();
      grid.forEach((row, weekday) =>
        row.forEach((share, hour) => {
          if (share) oldCells.set(`${weekday + 1}|${hour}`, share);
        }),
      );
      const now = await rows('gnosis-vpn/hours', {
        range: range.var,
        direction,
      });
      const newCells = new Map(
        now
          .map((row): [string, number] => [
            `${String(row.weekday)}|${String(row.hour)}`,
            num(row.share) ?? 0,
          ])
          .filter(([, share]) => share !== 0),
      );
      lines.push(
        series(
          'Hours',
          `${direction} share by weekday and hour, ${range.old}`,
          oldCells,
          newCells,
        ),
      );
    }
  }

  // Retention cohorts.
  {
    const now = await rows('gnosis-vpn/retention');
    const oldCells = new Map<string, number>();
    for (const cohort of old.retention) {
      cohort.retention.forEach((share, offset) =>
        oldCells.set(`${cohort.month} · ${cohort.size}|${offset}`, share),
      );
    }
    const newCells = new Map(
      now.map((row) => [
        `${String(row.cohort)}|${String(row.month)}`,
        num(row.share) ?? 0,
      ]),
    );
    lines.push(series('Users', 'Cohort retention', oldCells, newCells));
  }

  // Relayers, over 90 days — the old panels never looked further back.
  {
    const now = await rows('gnosis-vpn/relayer-share', { range: '90d' });
    const oldShare = new Map(
      old.relayers
        .slice(0, 20)
        .map((relayer) => [relayer.address, relayer.gigabytes]),
    );
    const others = old.relayers
      .slice(20)
      .reduce((total, relayer) => total + relayer.gigabytes, 0);
    if (others > 0) oldShare.set('Other relayers', others);
    lines.push(
      series(
        'Relayers',
        'Upstream volume per relay, top 20, 90d',
        oldShare,
        new Map(now.map((row) => [String(row.relay), num(row.gigabytes) ?? 0])),
      ),
    );
    for (const direction of ['upstream', 'downstream'] as const) {
      const points =
        direction === 'upstream'
          ? old.relayerDaily
          : old.relayerDownstreamDaily;
      const oldCells = new Map<string, number>();
      for (const point of points) {
        for (const entry of old.relayerSeries) {
          const value = Number(point[entry.key] ?? 0);
          if (value) oldCells.set(`${point.date}|${entry.address}`, value);
        }
      }
      const newCells = new Map(
        (
          await rows('gnosis-vpn/relayer-daily', { range: '90d', direction })
        ).map((row) => [
          `${String(row.day)}|${String(row.relay)}`,
          num(row.gigabytes) ?? 0,
        ]),
      );
      lines.push(
        series(
          'Relayers',
          `${direction} volume per relay per day, 90d`,
          oldCells,
          newCells,
        ),
      );
    }
    lines.push({
      area: 'Relayers',
      metric: 'Relay panels, all time',
      old: '90 days',
      new: 'all time',
      status: 'expected',
      note: 'The old relay panels showed 90 days at "all time"; the new ones follow the range.',
    });
  }

  // The client ranking at every range.
  const clientKey = (network: unknown, address: unknown) =>
    `${single ? targets[0].id : String(network)} ${String(address)}`;
  for (const range of RANGES) {
    const pick = (client: AnalyticsSnapshot['clients'][number]) =>
      ({
        '7d': [client.redemptions7d, client.gigabytes7d],
        '30d': [client.redemptions30d, client.gigabytes30d],
        '90d': [client.redemptions90d, client.gigabytes90d],
        all: [client.redemptionsTotal, client.gigabytesTotal],
      })[range.old];
    const oldRanked = old.clients.filter((client) => pick(client)[1] > 0);
    const now = await rows('gnosis-vpn/top-clients', { range: range.var });
    lines.push(
      figure(
        'Clients',
        `Clients with usage · ${range.old}`,
        oldRanked.length,
        now.length,
        true,
      ),
      series(
        'Clients',
        `Upstream volume per client · ${range.old}`,
        new Map(oldRanked.map((client) => [client.key, pick(client)[1]])),
        new Map(
          now.map((row) => [
            clientKey(row.network, row.payer),
            num(row.gigabytes) ?? 0,
          ]),
        ),
      ),
      series(
        'Clients',
        `Redemptions per client · ${range.old}`,
        new Map(oldRanked.map((client) => [client.key, pick(client)[0]])),
        new Map(
          now.map((row) => [
            clientKey(row.network, row.payer),
            num(row.redemptions) ?? 0,
          ]),
        ),
        true,
      ),
    );
  }

  // Deployments, the feed and the contracts: the same rows.
  {
    const now = await rows('gnosis-vpn/deployments');
    const oldSet = new Set(old.deployments.map((row) => row.key));
    const newSet = new Set(
      now.map((row) => clientKey(row.network, row.client)),
    );
    const missing = [...oldSet].filter((key) => !newSet.has(key)).length;
    const extra = [...newSet].filter((key) => !oldSet.has(key)).length;
    lines.push({
      area: 'Tables',
      metric: 'Client deployments',
      old: `${oldSet.size} rows`,
      new: `${newSet.size} rows`,
      status: missing || extra ? 'differs' : 'match',
      note: missing || extra ? `${missing} missing, ${extra} extra` : undefined,
    });
    const feed = await rows('gnosis-vpn/feed');
    const feedKey = (block: unknown, source: unknown, destination: unknown) =>
      `${String(block)}|${String(source)}|${String(destination)}`;
    const oldFeed = new Set(
      old.recentRedemptions.map((row) =>
        feedKey(row.block, row.source, row.destination),
      ),
    );
    const newFeed = new Set(
      feed.map((row) => feedKey(row.block, row.client, row.relay)),
    );
    const feedMissing = [...oldFeed].filter((key) => !newFeed.has(key)).length;
    lines.push({
      area: 'Tables',
      metric: 'Redemption feed',
      old: `${oldFeed.size} rows`,
      new: `${newFeed.size} rows`,
      status:
        feedMissing || oldFeed.size !== newFeed.size ? 'differs' : 'match',
      note: feedMissing
        ? `${feedMissing} of the old rows are missing`
        : undefined,
    });
    const contracts = await rows('gnosis-vpn/contracts');
    const oldContracts = new Set(
      old.contracts.map((row) => `${row.role}|${row.address}`),
    );
    const newContracts = new Set(
      contracts.map((row) => `${String(row.role)}|${String(row.contract)}`),
    );
    const contractMissing = [...oldContracts].filter(
      (key) => !newContracts.has(key),
    ).length;
    lines.push({
      area: 'Tables',
      metric: 'Indexed contracts',
      old: `${oldContracts.size} rows`,
      new: `${newContracts.size} rows`,
      status:
        contractMissing || oldContracts.size !== newContracts.size
          ? 'differs'
          : 'match',
    });
  }

  // A few clients' own records: the busiest, and one that never redeemed.
  if (single) {
    const network = targets[0].id;
    const busiest = old.clients.slice(0, options.clients ?? 3);
    const quiet = old.deployments.find(
      (row) => !old.clients.some((client) => client.key === row.key),
    );
    const picked = [
      ...busiest.map((client) => client.address),
      ...(quiet ? [quiet.address] : []),
    ];
    for (const address of picked) {
      const detail = old.clientDetails[`${network} ${address}`] ?? null;
      const vars = { client: address };
      const area = `Client ${address.slice(0, 10)}…`;
      const redemptions =
        (await rows('gnosis-vpn-client/redemptions', vars))[0] ?? {};
      lines.push(
        figure(
          area,
          'Redemptions',
          detail?.redemptions ?? 0,
          num(redemptions.redemptions) ?? 0,
          true,
        ),
        figure(
          area,
          'Tickets',
          detail?.tickets ?? 0,
          num(redemptions.tickets) ?? 0,
          true,
        ),
        figure(
          area,
          'Upstream volume',
          detail?.gigabytes ?? 0,
          num(await one('gnosis-vpn-client/volume', 'gigabytes', vars)) ?? 0,
        ),
        figure(
          area,
          'Active days',
          detail?.activeDays ?? 0,
          num(await one('gnosis-vpn-client/active-days', 'days', vars)) ?? 0,
          true,
        ),
        moment(
          area,
          'Deployed',
          detail?.deployedAt ?? null,
          await one('gnosis-vpn-client/deployed', 'deployed_at', vars),
        ),
        moment(
          area,
          'First seen',
          detail?.firstSeen ?? null,
          await one('gnosis-vpn-client/first-seen', 'redeemed_at', vars),
        ),
        moment(
          area,
          'Last seen',
          detail?.lastSeen ?? null,
          await one('gnosis-vpn-client/last-seen', 'redeemed_at', vars),
        ),
      );
      const daily = await rows('gnosis-vpn-client/daily', vars);
      lines.push(
        series(
          area,
          'Upstream volume per day, 90 days',
          new Map(
            (detail?.daily ?? [])
              .filter((point) => point.gigabytes !== 0)
              .map((point) => [point.date, point.gigabytes]),
          ),
          new Map(
            daily.map((row) => [String(row.day), num(row.gigabytes) ?? 0]),
          ),
        ),
      );
      const relays = await rows('gnosis-vpn-client/relays', vars);
      lines.push(
        series(
          area,
          'Share of redemptions per relay',
          new Map(
            (detail?.relayers ?? []).map((relayer) => [
              relayer.address,
              relayer.share,
            ]),
          ),
          new Map(
            relays.map((row) => [String(row.relay), num(row.share) ?? 0]),
          ),
        ),
      );
    }
  }
  return lines;
}

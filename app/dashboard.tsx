'use client';

import { useMemo, useState } from 'react';
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Database, ExternalLink, ShieldCheck } from 'lucide-react';

import type { Dashboard as DashboardPayload } from '@/lib/analytics';
import { COMBINED } from '@/lib/constants';

const AXIS = { fill: '#8a877f', fontSize: 11 };
const GRID = '#e6e2d8';
const CURSOR = { fill: '#f2eee5' };
const TOOLTIP = {
  background: '#fffdf8',
  border: '1px solid #d9d5cb',
  borderRadius: 2,
  fontSize: 12,
};
const YELLOW = '#ffd84d';
const INK = '#17191c';
const PLUM = '#8d4f68';
const LEGEND_PREVIEW = 5;
const MEDALS = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];

// Constructing an Intl formatter is expensive and these run per tick and per row.
const INTEGER = new Intl.NumberFormat('en-US');
const PERCENT = new Intl.NumberFormat('en', {
  style: 'percent',
  maximumFractionDigits: 1,
});
const DECIMAL = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
const FIXED_2 = new Intl.NumberFormat('en', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const COMPACT = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const SIGNIFICANT_2 = new Intl.NumberFormat('en', {
  maximumSignificantDigits: 2,
});
const DAY = new Intl.DateTimeFormat('en', {
  day: '2-digit',
  month: 'short',
  timeZone: 'UTC',
});
// The snapshot is cached for a minute, so the time it was taken is worth showing.
const OBSERVED = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
  timeZoneName: 'short',
});
const TIMESTAMP = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'UTC',
  hour12: false,
});

/**
 * A colour per relayer, ordered by volume.
 *
 * Relayers are ranked, so the palette is a ramp rather than a wheel of unrelated
 * hues: it interpolates across hand-picked anchors, warm to cool, all muted to sit
 * on the paper ground. Neighbouring ranks stay distinguishable while the chart
 * still reads as one object — which a hue-per-category rainbow does not.
 */
const RELAYER_RAMP = [
  [255, 216, 77], // brand yellow
  [201, 139, 58], // ochre
  [178, 90, 77], // terracotta
  [141, 79, 104], // plum
  [95, 107, 134], // slate
  [122, 133, 138], // stone
] as const;

function relayerColor(index: number, total: number) {
  const step = total > 1 ? Math.min(1, index / (total - 1)) : 0;
  const scaled = step * (RELAYER_RAMP.length - 1);
  const low = Math.floor(scaled);
  const high = Math.min(RELAYER_RAMP.length - 1, low + 1);
  const blend = scaled - low;
  const channel = (i: number) =>
    Math.round(
      RELAYER_RAMP[low][i] +
        (RELAYER_RAMP[high][i] - RELAYER_RAMP[low][i]) * blend,
    );
  return `rgb(${channel(0)} ${channel(1)} ${channel(2)})`;
}

function medal(index: number) {
  return MEDALS[index] ?? String(index + 1);
}

function count(input: number | null) {
  return input === null ? '—' : INTEGER.format(input);
}

function percent(share: number) {
  return PERCENT.format(share);
}

/** Volume arrives in gigabytes; step down so small numbers stay readable. */
function volume(input: number | null) {
  if (input === null) return '—';
  const [value, unit] =
    input >= 1
      ? [input, 'GB']
      : input >= 0.001
        ? [input * 1000, 'MB']
        : [input * 1e6, 'KB'];
  return `${DECIMAL.format(value)} ${unit}`;
}

/** The ranking tables quote usage in megabytes, matching the published tables. */
function megabytes(gigabytes: number) {
  return FIXED_2.format(gigabytes * 1000);
}

function compactToken(input: string | null) {
  if (!input) return '—';
  const number = Number(BigInt(input) / 1_000_000_000_000_000n) / 1_000;
  if (!Number.isFinite(number)) return input;
  return `${COMPACT.format(number)} wxHOPR`;
}

/** wxHOPR has 18 decimals; these amounts are small, so show significant digits. */
function token(wei: string | null, digits = 6) {
  if (wei === null) return '—';
  const value = Number(BigInt(wei)) / 1e18;
  if (!Number.isFinite(value)) return '—';
  return `${new Intl.NumberFormat('en', { maximumSignificantDigits: digits }).format(value)} wxHOPR`;
}

function probability(value: number | null) {
  return value === null ? '—' : SIGNIFICANT_2.format(value);
}

function shortAddress(address: string) {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

// Recharts hands both tick and tooltip labels through as ReactNode.
function formatDay(value: unknown) {
  if (typeof value !== 'string') return '';
  return DAY.format(new Date(`${value}T00:00:00Z`));
}

function formatTimestamp(value: string) {
  return TIMESTAMP.format(new Date(value)).replace(',', '');
}

/** Overlay shown in place of a chart or table that has nothing to render. */
function Empty({ when, children }: { when: boolean; children: string }) {
  if (!when) return null;
  return <div className="empty-overlay">{children}</div>;
}

function Metric({
  eyebrow,
  figure,
  note,
}: {
  eyebrow: string;
  figure: string;
  note: string;
}) {
  return (
    <div className="metric">
      <span>{eyebrow}</span>
      <strong>{figure}</strong>
      <p>{note}</p>
    </div>
  );
}

export default function Dashboard({ dashboard }: { dashboard: DashboardPayload }) {
  const [scope, setScope] = useState<'weekly' | 'all'>('weekly');
  const [allRelayers, setAllRelayers] = useState(false);
  const [network, setNetwork] = useState(dashboard.defaultNetwork);

  // Every network's snapshot is already on the page, so switching is instant.
  const data =
    dashboard.snapshots[network] ?? dashboard.snapshots[dashboard.defaultNetwork];
  const combined = network === COMBINED;
  const labelOf = (id: string) =>
    dashboard.networks.find((entry) => entry.id === id)?.label ?? id;
  const live = data.source !== 'unavailable';

  // Recharts colours pie slices from a `fill` on each datum, avoiding <Cell>.
  const relayerSlices = useMemo(
    () =>
      data.relayers.map((relayer) => ({
        ...relayer,
        fill: relayerColor(relayer.colorIndex, data.relayerSeries.length),
      })),
    [data.relayers, data.relayerSeries.length],
  );

  const rankedClients = useMemo(() => {
    const ranked = [...data.clients].sort((a, b) =>
      scope === 'weekly'
        ? b.gigabytes7d - a.gigabytes7d
        : b.gigabytesTotal - a.gigabytesTotal,
    );
    return ranked.filter((client) =>
      scope === 'weekly' ? client.gigabytes7d > 0 : client.gigabytesTotal > 0,
    );
  }, [data.clients, scope]);

  return (
    <main>
      <header className="topbar">
        <a
          className="brand"
          href="#top"
          aria-label="Gnosis VPN network intelligence home"
        >
          <span className="brand-mark">
            <span />
          </span>
          <span>
            GNOSIS<span className="brand-light">VPN</span>
          </span>
        </a>
        <nav aria-label="Dashboard navigation">
          <a href="#users">Active users</a>
          <a href="#usage">Usage</a>
          <a href="#activity">Activity</a>
          <a href="#relayers">Relayers</a>
          <a href="#ticket">Tickets</a>
          <a href="#clients">Clients</a>
          <a href="#methodology">Methodology</a>
        </nav>
        <a
          className="source-link"
          href="https://github.com/hoprnet/blokli"
          target="_blank"
          rel="noreferrer"
        >
          Blokli source <ExternalLink size={13} />
        </a>
      </header>

      <section className="intro" id="top">
        <div>
          <div className="status-line">
            <span
              className={
                data.source === 'live' ? 'live-dot' : 'unavailable-dot'
              }
            />
            {data.source === 'live'
              ? 'LIVE · BLOKLI INDEX DATA'
              : data.source === 'degraded'
                ? 'PARTIAL · SOME SERIES UNAVAILABLE'
                : 'DATA SOURCE UNAVAILABLE'}
          </div>
          {dashboard.networks.length > 1 && (
            <div className="network-switch" role="tablist" aria-label="Network">
              <button
                type="button"
                role="tab"
                aria-selected={combined}
                className={combined ? 'active' : ''}
                onClick={() => setNetwork(COMBINED)}
              >
                All networks
              </button>
              {dashboard.networks.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={network === entry.id}
                  className={network === entry.id ? 'active' : ''}
                  onClick={() => setNetwork(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          )}
          <h1>
            Private access.
            <br />
            Public proof.
          </h1>
        </div>
        <div className="intro-copy">
          <p>
            Gnosis VPN client usage measured directly from Gnosis Chain. Every
            figure below counts traffic paid for by VPN clients.
          </p>
          <dl className="asof">
            <dt>Last indexed block</dt>
            <dd>{data.blockNumber ? `#${count(data.blockNumber)}` : '—'}</dd>
            <dt>Observed</dt>
            <dd>{OBSERVED.format(new Date(data.observedAt))}</dd>
          </dl>
        </div>
      </section>

      <section className="headline-grid" aria-label="Headline metrics">
        <div className="mau-card">
          <div className="metric-kicker">MONTHLY ACTIVE USERS</div>
          <div className="mau-number">
            {count(data.totals.monthlyActiveUsers)}
          </div>
          <div className="mau-footer">
            <span>
              {count(data.totals.weeklyActiveUsers)} weekly active
            </span>
            <small>Trailing 30 and 7 days</small>
          </div>
        </div>
        <Metric
          eyebrow="REDEMPTIONS · 7 DAYS"
          figure={count(data.totals.redemptions7d)}
          note={`${count(data.totals.redemptionsTotal)} since indexing began`}
        />
        <Metric
          eyebrow="DATA RELAYED · 7 DAYS"
          figure={volume(data.totals.gigabytes7d)}
          note={`${volume(data.totals.gigabytesTotal)} cumulative`}
        />
        <Metric
          eyebrow="NEW CLIENTS · 30 DAYS"
          figure={count(data.totals.deployments30d)}
          note={`${count(data.totals.deployments7d)} in the last 7 days`}
        />
      </section>

      <section className="section" id="users">
        <div className="section-heading">
          <div>
            <span className="section-index">01</span>
            <h2>Unique active users</h2>
          </div>
          <p>
            A user is a VPN client that either settled tickets on one of its
            channels inside the window or was first deployed inside it.
          </p>
        </div>
        <div className="chart-card main-chart">
          <div className="chart-title">
            <div>
              <span>SINCE 01 JAN 2026</span>
              <h3>Monthly and weekly active users</h3>
            </div>
            <div className="legend">
              <i className="actual" />
              30-day <i className="target" />
              7-day <i className="new-client" />
              New clients
            </div>
          </div>
          <ResponsiveContainer width="100%" height={330}>
            <ComposedChart
              data={data.activeUsers}
              margin={{ top: 24, right: 18, left: -18, bottom: 0 }}
            >
              <defs>
                <linearGradient id="fillMonthly" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={YELLOW} stopOpacity={0.45} />
                  <stop offset="100%" stopColor={YELLOW} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                vertical={false}
                stroke={GRID}
                strokeDasharray="2 5"
              />
              <XAxis
                dataKey="date"
                axisLine={false}
                tickLine={false}
                tick={AXIS}
                minTickGap={48}
                tickFormatter={formatDay}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={AXIS}
                allowDecimals={false}
              />
              <Tooltip labelFormatter={formatDay} contentStyle={TOOLTIP} />
              <Area
                type="monotone"
                dataKey="monthly"
                name="30-day active"
                stroke={YELLOW}
                fill="url(#fillMonthly)"
                strokeWidth={3}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="weekly"
                name="7-day active"
                stroke="#9b978d"
                strokeWidth={1.5}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="deployments"
                name="New clients (30d)"
                stroke={PLUM}
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
          <Empty when={!data.activeUsers.length}>
            The series appears once the index database reports client
            redemptions.
          </Empty>
          <p className="chart-note">
            Each point counts distinct clients over the preceding 30 and 7 days.
          </p>
        </div>
      </section>

      <section className="section" id="usage">
        <div className="section-heading">
          <div>
            <span className="section-index">02</span>
            <h2>Relayed traffic</h2>
          </div>
          <p>Each packets is assumed to have an average size of 650 bytes.</p>
        </div>
        <div className="chart-card service-chart">
          <div className="chart-title">
            <div>
              <span>PER WEEK AND CUMULATIVE</span>
              <h3>Data volume</h3>
            </div>
            <div className="legend">
              <i className="actual" />
              Weekly <i className="cumulative" />
              Cumulative
            </div>
            <div className="axis-badge">
              {data.winProbability === 'historical'
                ? 'WIN PROB · HISTORICAL'
                : data.winProbability === 'current'
                  ? 'WIN PROB · CURRENT'
                  : 'WIN PROB · ASSUMED 1'}
            </div>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart
              data={data.weeks}
              margin={{ top: 20, right: 6, left: -20, bottom: 0 }}
            >
              <CartesianGrid vertical={false} stroke={GRID} />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={AXIS}
                minTickGap={24}
              />
              <YAxis
                yAxisId="left"
                axisLine={false}
                tickLine={false}
                tick={AXIS}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                axisLine={false}
                tickLine={false}
                tick={AXIS}
              />
              <Tooltip
                cursor={CURSOR}
                contentStyle={TOOLTIP}
                formatter={(input: unknown) => volume(Number(input))}
              />
              <Bar
                yAxisId="left"
                dataKey="gigabytes"
                name="Volume this week"
                fill={YELLOW}
                radius={[2, 2, 0, 0]}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="cumulativeGigabytes"
                name="Cumulative volume"
                stroke={INK}
                strokeWidth={2}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
          <Empty when={!data.weeks.length}>
            No client redemptions have been indexed yet.
          </Empty>
        </div>
        <div className="network-stats network-stats-row">
          <Metric
            eyebrow="TOTAL REDEMPTIONS"
            figure={count(data.totals.redemptionsTotal)}
            note={`${count(data.totals.ticketsTotal)} tickets settled across them`}
          />
          <Metric
            eyebrow="TOTAL DATA RELAYED"
            figure={volume(data.totals.gigabytesTotal)}
            note="Client traffic since indexing began"
          />
          <Metric
            eyebrow="ACTIVE CHANNELS"
            figure={count(data.openChannels)}
            note={`${compactToken(data.channelBalance)} allocated`}
          />
        </div>
      </section>

      <section className="section" id="activity">
        <div className="section-heading">
          <div>
            <span className="section-index">03</span>
            <h2>Daily activity</h2>
          </div>
          <p>
            Who showed up each day, and when during the day the network carries
            traffic.
          </p>
        </div>
        <div className="chart-split">
          <div className="chart-card service-chart">
            <div className="chart-title">
              <div>
                <span>LAST 30 DAYS</span>
                <h3>Daily users</h3>
              </div>
              <div className="legend">
                <i className="actual" />
                Returning <i className="new-client" />
                New
              </div>
            </div>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart
                data={data.dailyUsers}
                margin={{ top: 20, right: 10, left: -24, bottom: 0 }}
              >
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  tick={AXIS}
                  minTickGap={40}
                  tickFormatter={formatDay}
                />
                <YAxis
                  allowDecimals={false}
                  axisLine={false}
                  tickLine={false}
                  tick={AXIS}
                />
                <Tooltip
                  cursor={CURSOR}
                  labelFormatter={formatDay}
                  contentStyle={TOOLTIP}
                />
                <Bar
                  dataKey="returning"
                  name="Returning"
                  stackId="users"
                  fill={YELLOW}
                />
                <Bar
                  dataKey="newClients"
                  name="New"
                  stackId="users"
                  fill={PLUM}
                />
              </BarChart>
            </ResponsiveContainer>
            <Empty when={!data.dailyUsers.length}>
              No client activity in the last 30 days.
            </Empty>
          </div>
          <div className="chart-card service-chart">
            <div className="chart-title">
              <div>
                <span>ALL INDEXED HISTORY</span>
                <h3>Usage distribution over the day</h3>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart
                data={data.hourly}
                margin={{ top: 20, right: 10, left: -18, bottom: 0 }}
              >
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis
                  dataKey="hour"
                  axisLine={false}
                  tickLine={false}
                  tick={AXIS}
                  minTickGap={24}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={AXIS}
                  tickFormatter={(input: unknown) => percent(Number(input))}
                />
                <Tooltip
                  cursor={CURSOR}
                  contentStyle={TOOLTIP}
                  formatter={(input: unknown) => percent(Number(input))}
                />
                <Bar
                  dataKey="share"
                  name="Share of volume"
                  fill={PLUM}
                  radius={[2, 2, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
            <Empty when={!data.hourly.length}>
              No volume has been indexed yet.
            </Empty>
            <p className="chart-note">
              Share of relayed volume by hour, UTC. Block timestamps are{' '}
              {data.timebase === 'rpc'
                ? 'RPC resolved'
                : 'estimated from block height'}
              .
            </p>
          </div>
        </div>
      </section>

      <section className="section" id="relayers">
        <div className="section-heading">
          <div>
            <span className="section-index">04</span>
            <h2>Redemptions by relayer</h2>
          </div>
          <p>
            Which relays carried client traffic, and how the load is shared.
          </p>
        </div>
        <div className="chart-split">
          <div className="chart-card service-chart">
            <div className="chart-title">
              <div>
                <span>LAST 7 DAYS</span>
                <h3>Share of redemptions</h3>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={relayerSlices}
                  dataKey="redemptions"
                  nameKey="address"
                  innerRadius="55%"
                  outerRadius="82%"
                  paddingAngle={1}
                  stroke="none"
                  isAnimationActive={false}
                />
                <Tooltip
                  contentStyle={TOOLTIP}
                  formatter={(input: unknown, name: unknown) =>
                    [
                      `${INTEGER.format(Number(input))} redemptions`,
                      typeof name === 'string' ? shortAddress(name) : '',
                    ] as [string, string]
                  }
                />
              </PieChart>
            </ResponsiveContainer>
            <Empty when={!data.relayers.length}>
              No client redemptions were indexed in the last 7 days.
            </Empty>
          </div>
          <div className="chart-card service-chart">
            <div className="chart-title">
              <div>
                <span>LAST 30 DAYS</span>
                <h3>Estimated daily volume per relayer</h3>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart
                data={data.relayerDaily}
                margin={{ top: 20, right: 10, left: -18, bottom: 0 }}
              >
                <CartesianGrid vertical={false} stroke={GRID} />
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  tick={AXIS}
                  minTickGap={40}
                  tickFormatter={formatDay}
                />
                <YAxis axisLine={false} tickLine={false} tick={AXIS} />
                <Tooltip
                  cursor={CURSOR}
                  labelFormatter={formatDay}
                  contentStyle={TOOLTIP}
                  itemSorter={(item) => -Number(item.value ?? 0)}
                  formatter={(input: unknown, name: unknown) =>
                    [
                      volume(Number(input)),
                      typeof name === 'string' ? shortAddress(name) : '',
                    ] as [string, string]
                  }
                />
                {data.relayerSeries.map((relayer, index) => (
                  <Bar
                    key={relayer}
                    dataKey={relayer}
                    stackId="relayers"
                    fill={relayerColor(index, data.relayerSeries.length)}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
            <Empty when={!data.relayerDaily.length}>
              No client redemptions were indexed in the last 30 days.
            </Empty>
            <p className="chart-note">
              Volume is an estimate derived from redemptions seen on chain.
            </p>
          </div>
        </div>
        <div className="relayer-legend">
          <ol className="relayer-key">
            {(allRelayers
              ? relayerSlices
              : relayerSlices.slice(0, LEGEND_PREVIEW)
            ).map((relayer) => (
              <li key={relayer.key}>
                <i style={{ background: relayer.fill }} />
                <code>{shortAddress(relayer.address)}</code>
                {combined && <em className="row-network">{labelOf(relayer.network)}</em>}
                <strong>{percent(relayer.share)}</strong>
              </li>
            ))}
          </ol>
          {relayerSlices.length > LEGEND_PREVIEW && (
            <button
              type="button"
              className="legend-toggle"
              aria-expanded={allRelayers}
              onClick={() => setAllRelayers((open) => !open)}
            >
              {allRelayers
                ? 'Show fewer'
                : `Show all ${relayerSlices.length} relayers`}
            </button>
          )}
        </div>
      </section>

      <section className="section" id="ticket">
        <div className="section-heading">
          <div>
            <span className="section-index">05</span>
            <h2>Ticket parameters</h2>
          </div>
          <p>
            The oracle values that convert redemptions into traffic, as they
            stand now.
          </p>
        </div>
        <div className="network-stats network-stats-row">
          <Metric
            eyebrow="WINNING PROBABILITY"
            figure={probability(data.ticket.winProbability)}
            note="Current network minimum"
          />
          <Metric
            eyebrow="TICKET PRICE"
            figure={token(data.ticket.priceWei)}
            note="Cost of relaying one packet, one hop"
          />
          <Metric
            eyebrow="TICKET VALUE"
            figure={token(data.ticket.valueWei, 4)}
            note="Price ÷ probability, for one remaining hop"
          />
        </div>
      </section>

      <section className="section" id="clients">
        <div className="section-heading">
          <div>
            <span className="section-index">06</span>
            <h2>Clients</h2>
          </div>
          <p>
            Who used the network and when each client first appeared. Volume is
            only an estimation based on the redemptions seen on chain.
          </p>
        </div>
        <div className="chart-split table-split">
          <div className="chart-card table-card">
            <div className="chart-title">
              <div>
                <span>USAGE PER CLIENT</span>
                <h3>
                  {scope === 'weekly'
                    ? 'Weekly most active users'
                    : 'Most active users'}
                </h3>
              </div>
              <div
                className="tab-switch"
                role="tablist"
                aria-label="Ranking window"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={scope === 'weekly'}
                  className={scope === 'weekly' ? 'active' : ''}
                  onClick={() => setScope('weekly')}
                >
                  Weekly
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={scope === 'all'}
                  className={scope === 'all' ? 'active' : ''}
                  onClick={() => setScope('all')}
                >
                  All time
                </button>
              </div>
            </div>
            <div className="table-scroll">
              <table className="rank-table">
                <colgroup>
                  <col className="rank" />
                  <col />
                  <col className="count" />
                  <col className="usage" />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">rank</th>
                    <th scope="col">client</th>
                    <th scope="col" className="numeric">
                      redemptions
                    </th>
                    <th scope="col" className="numeric">
                      usage (MB)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rankedClients.map((client, index) => (
                    <tr key={client.key}>
                      <td>{medal(index)}</td>
                      <td>
                        <code>{client.address}</code>
                        {combined && <em className="row-network">{labelOf(client.network)}</em>}
                      </td>
                      <td className="numeric">
                        {count(
                          scope === 'weekly'
                            ? client.redemptions7d
                            : client.redemptionsTotal,
                        )}
                      </td>
                      <td className="numeric">
                        {megabytes(
                          scope === 'weekly'
                            ? client.gigabytes7d
                            : client.gigabytesTotal,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Empty when={!rankedClients.length}>
              No client usage has been indexed for this window.
            </Empty>
            <p className="chart-note">
              Showing {rankedClients.length} of {data.clientCount} clients with
              usage.
            </p>
          </div>
          <div className="chart-card table-card">
            <div className="chart-title">
              <div>
                <span>EDGE NODE KEY-BINDINGS</span>
                <h3>Client deployments</h3>
              </div>
              <div className="axis-badge">
                {data.timebase === 'rpc'
                  ? 'TIME · RPC RESOLVED'
                  : 'TIME · ESTIMATED'}
              </div>
            </div>
            <div className="table-scroll">
              <table className="rank-table">
                <colgroup>
                  <col className="timestamp" />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">timestamp</th>
                    <th scope="col">client</th>
                  </tr>
                </thead>
                <tbody>
                  {data.deployments.map((deployment) => (
                    <tr key={deployment.key}>
                      <td className="timestamp">
                        {formatTimestamp(deployment.timestamp)}
                      </td>
                      <td>
                        <code>{deployment.address}</code>
                        {combined && (
                          <em className="row-network">{labelOf(deployment.network)}</em>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Empty when={!data.deployments.length}>
              No client deployments have been indexed.
            </Empty>
            <p className="chart-note">
              Showing the {data.deployments.length} most recent of{' '}
              {count(data.totals.clientsDeployed)} clients deployed.
            </p>
          </div>
        </div>
      </section>

      <section className="section" id="redemptions">
        <div className="section-heading">
          <div>
            <span className="section-index">07</span>
            <h2>Most recent redemptions</h2>
          </div>
          <p>Latest redemptions per channel, newest first.</p>
        </div>
        <div className="chart-card table-card">
          <div className="chart-title">
            <div>
              <span>LATEST REDEMPTIONS PER CHANNEL</span>
              <h3>Redemption feed</h3>
            </div>
            <div className="axis-badge">
              {count(data.totals.redemptionsTotal)} total
            </div>
          </div>
          <div className="table-scroll">
            <table className="rank-table">
              <colgroup>
                <col className="timestamp" />
                <col />
                <col />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">timestamp</th>
                  <th scope="col">client</th>
                  <th scope="col">relayer</th>
                  <th scope="col">channel</th>
                </tr>
              </thead>
              <tbody>
                {data.recentRedemptions.map((redemption) => (
                  <tr key={redemption.key}>
                    <td className="timestamp">
                      {formatTimestamp(redemption.timestamp)}
                    </td>
                    <td>
                      <code>{shortAddress(redemption.client)}</code>
                    </td>
                    <td>
                      <code>{shortAddress(redemption.relayer)}</code>
                    </td>
                    <td>
                      <code>{shortAddress(`0x${redemption.channelId}`)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Empty when={!data.recentRedemptions.length}>
            No redemptions have been indexed.
          </Empty>
        </div>
      </section>

      <section className="methodology" id="methodology">
        <div className="method-title">
          <Database size={18} />
          <span>DATA PROVENANCE</span>
        </div>
        <h2>Designed to be cited.</h2>
        <div className="method-grid">
          <div>
            <span>01</span>
            <h3>Client traffic only</h3>
            <p>
              Relays announce themselves on chain. A channel sourced by an
              account that never announced is a VPN client paying for its own
              sessions, so only those channels are counted.
            </p>
          </div>
          <div>
            <span>02</span>
            <h3>Redemptions</h3>
            <p>
              Blokli appends a channel state row per on-chain event, and only
              TicketRedeemed advances the ticket index. A row whose index
              advances is a redemption; the increment is the tickets it settled.
            </p>
          </div>
          <div>
            <span>03</span>
            <h3>Data volume</h3>
            <p>
              Each redemption accounts for 650 / (2<sup>30</sup> &times; p) GB,
              where p is the winning probability from the oracle&rsquo;s update
              history at that block. Redemptions predating the first update are
              excluded.
            </p>
          </div>
        </div>
        {data.warnings.length > 0 && (
          <ul className="data-warning">
            {data.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
        <div className="integrity">
          <ShieldCheck size={16} />
          <span>
            {live
              ? 'POSTGRESQL → BACKEND → PUBLIC DASHBOARD'
              : 'DATABASE CONNECTION PENDING'}
          </span>
          <code>Schema {data.schemaVersion ?? 'unavailable'}</code>
        </div>
      </section>

      <footer>
        <span>GNOSIS VPN × HOPR</span>
        <p>On-chain network intelligence powered by Blokli.</p>
        <a href="#top">Back to top ↑</a>
      </footer>
    </main>
  );
}

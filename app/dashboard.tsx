'use client';

import { useMemo, useRef, useState } from 'react';
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
import {
  ChevronLeft,
  ChevronRight,
  Database,
  ExternalLink,
  ShieldCheck,
} from 'lucide-react';

import type { Dashboard as DashboardPayload } from '@/lib/analytics';
import { COMBINED } from '@/lib/constants';
import { Tile, type LegendEntry } from './tile';

const AXIS = { fill: '#8a877f', fontSize: 11 };
const GRID = '#e6e2d8';
const CURSOR = { fill: '#f2eee5' };
const TOOLTIP = {
  background: '#fffdf8',
  border: '1px solid #d9d5cb',
  borderRadius: 2,
  fontSize: 12,
};
/**
 * Addresses are fixed-width, so listing them whole in a monospace tooltip puts
 * every volume at the same offset and the column reads as a column.
 */
const ADDRESS_TOOLTIP = {
  ...TOOLTIP,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
};
const YELLOW = '#ffd84d';
const INK = '#17191c';
const PLUM = '#8d4f68';
const EXPLORER = 'https://gnosisscan.io/address/';
const PAGE_SIZE = 50;

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

/**
 * Search matches any field the row displays, case-insensitively, so pasting a
 * partial address finds it wherever it appears.
 */
function matches(query: string, ...fields: string[]) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => field.toLowerCase().includes(needle));
}

function formatTimestamp(value: string) {
  return TIMESTAMP.format(new Date(value)).replace(',', '');
}

/**
 * Page controls for a table.
 *
 * The page is clamped by the caller rather than reset, so switching network or
 * ranking window while deep in a list lands on the last available page instead of
 * an empty one.
 */
/**
 * The pages to offer, with gaps closed by an ellipsis.
 *
 * Always shows the first and last page and the ones either side of the current
 * one, so the control keeps a stable width however deep the list runs.
 */
function pageList(page: number, pages: number): Array<number | null> {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index);
  const wanted = new Set([0, pages - 1, page - 1, page, page + 1]);
  const shown = [...wanted]
    .filter((n) => n >= 0 && n < pages)
    .sort((a, b) => a - b);
  return shown.flatMap((n, index) =>
    index > 0 && n - shown[index - 1] > 1 ? [null, n] : [n],
  );
}

function Pager({
  page,
  pages,
  onChange,
  label,
}: {
  page: number;
  pages: number;
  onChange: (page: number) => void;
  label: string;
}) {
  if (pages <= 1) return null;
  return (
    <nav className="pager" aria-label={label}>
      <button
        type="button"
        className="pager-step"
        onClick={() => onChange(page - 1)}
        disabled={page === 0}
        aria-label="Previous page"
      >
        <ChevronLeft size={14} aria-hidden="true" />
      </button>
      {pageList(page, pages).map((entry, index) =>
        entry === null ? (
          <span key={`gap-${index}`} className="pager-gap">
            …
          </span>
        ) : (
          <button
            key={entry}
            type="button"
            className={entry === page ? 'pager-page active' : 'pager-page'}
            aria-current={entry === page ? 'page' : undefined}
            onClick={() => onChange(entry)}
          >
            {entry + 1}
          </button>
        ),
      )}
      <button
        type="button"
        className="pager-step"
        onClick={() => onChange(page + 1)}
        disabled={page >= pages - 1}
        aria-label="Next page"
      >
        <ChevronRight size={14} aria-hidden="true" />
      </button>
    </nav>
  );
}

/**
 * An address, linked to its page on the block explorer.
 *
 * Styled as the surrounding text rather than as a link: in a table of addresses,
 * two hundred underlined blue strings would read as noise. The cursor and a
 * darkening on hover carry the affordance instead.
 */
function AddressLink({ address }: { address: string }) {
  return (
    <a
      className="address"
      href={`${EXPLORER}${address}`}
      target="_blank"
      rel="noreferrer"
      aria-label={`${address} on Gnosisscan, opens in a new tab`}
    >
      <code>{address}</code>
    </a>
  );
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Blends the paper ground towards plum by share, so an empty hour is the card's
 * own background and a busy one is solid.
 */
function heatColor(intensity: number) {
  const from = [244, 241, 232];
  const to = [141, 79, 104];
  const at = (i: number) => Math.round(from[i] + (to[i] - from[i]) * intensity);
  return `rgb(${at(0)} ${at(1)} ${at(2)})`;
}

/**
 * Volume by weekday and hour, drawn as SVG rather than with a chart library.
 *
 * Recharts has no heatmap, and hand-drawing it keeps the tile's PNG export
 * working: that export looks for an `<svg>` inside the tile, so a grid of divs
 * would render on the page but produce an empty image.
 */
function Heatmap({
  grid,
  total,
  height = 250,
}: {
  grid: number[][];
  total: number | null;
  height?: number;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    label: string;
    share: number;
  } | null>(null);

  if (!grid.length) return <div style={{ height }} />;
  const peak = Math.max(...grid.flat());
  const left = 34;
  const top = 16;
  const cell = 26;
  const gap = 2;
  const width = left + 24 * cell;
  const full = top + 7 * cell + 20;

  const show = (
    event: { clientX: number; clientY: number },
    label: string,
    share: number,
  ) => {
    const box = frame.current?.getBoundingClientRect();
    if (!box) return;
    setHover({
      x: event.clientX - box.left,
      y: event.clientY - box.top,
      label,
      share,
    });
  };

  return (
    <div
      className="chart-hover"
      ref={frame}
      onMouseLeave={() => setHover(null)}
    >
      <svg
        viewBox={`0 0 ${width} ${full}`}
        width="100%"
        height={height}
        preserveAspectRatio="xMidYMid meet"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an <svg> cannot be an <img>
        role="img"
        aria-label="Share of relayed volume by weekday and hour, UTC"
      >
        {grid.map((row, weekday) =>
          row.map((share, hour) => (
            <rect
              key={`${weekday}-${hour}`}
              x={left + hour * cell}
              y={top + weekday * cell}
              width={cell - gap}
              height={cell - gap}
              fill={heatColor(peak > 0 ? share / peak : 0)}
              onMouseMove={(event) =>
                show(
                  event,
                  `${WEEKDAYS[weekday]} ${String(hour).padStart(2, '0')}:00 UTC`,
                  share,
                )
              }
            />
          )),
        )}
        {WEEKDAYS.map((day, index) => (
          <text
            key={day}
            x={left - 10}
            y={top + index * cell + (cell - gap) / 2}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize="10"
            fill="#8a877f"
          >
            {day}
          </text>
        ))}
        {[0, 6, 12, 18].map((hour) => (
          <text
            key={hour}
            x={left + hour * cell}
            y={full - 6}
            fontSize="10"
            fill="#8a877f"
          >
            {String(hour).padStart(2, '0')}:00
          </text>
        ))}
      </svg>
      {hover && (
        <div className="chart-tip" style={{ left: hover.x, top: hover.y }}>
          <p className="chart-tip-label">{hover.label}</p>
          <p style={{ color: PLUM }}>Share : {percent(hover.share)}</p>
          {total !== null && (
            <p className="chart-tip-note">
              {volume(hover.share * total)} relayed
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Cohort retention as a shaded triangle.
 *
 * A table of percentages needed a full-width section to say what a grid says in
 * a quarter of the space: the shape is the point. The exact figure is a hover
 * away — a real tooltip rather than the SVG `<title>` the browser shows after a
 * second's delay and cannot style.
 */
function CohortGrid({
  cohorts,
  height = 250,
}: {
  cohorts: DashboardPayload['snapshots'][string]['retention'];
  height?: number;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    label: string;
    share: number;
    active: number;
    size: number;
  } | null>(null);

  if (!cohorts.length) return <div style={{ height }} />;
  const months = Math.max(...cohorts.map((cohort) => cohort.retention.length));
  const left = 74;
  const top = 18;
  const cell = 22;
  const gap = 2;
  const width = left + months * cell;
  const full = top + cohorts.length * cell + 4;

  const show = (
    event: { clientX: number; clientY: number },
    cell: { label: string; share: number; active: number; size: number },
  ) => {
    const box = frame.current?.getBoundingClientRect();
    if (!box) return;
    setHover({
      x: event.clientX - box.left,
      y: event.clientY - box.top,
      ...cell,
    });
  };

  return (
    <div
      className="chart-hover"
      ref={frame}
      onMouseLeave={() => setHover(null)}
    >
      <svg
        viewBox={`0 0 ${width} ${full}`}
        width="100%"
        height={height}
        preserveAspectRatio="xMidYMid meet"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an <svg> cannot be an <img>
        role="img"
        aria-label="Share of each deployment cohort still relaying traffic, by month"
      >
        {Array.from({ length: months }, (_, offset) => (
          <text
            key={offset}
            x={left + offset * cell + (cell - gap) / 2}
            y={top - 6}
            textAnchor="middle"
            fontSize="9"
            fill="#8a877f"
          >
            {offset}
          </text>
        ))}
        {cohorts.map((cohort, row) => (
          <g key={cohort.month}>
            <text
              x={left - 10}
              y={top + row * cell + (cell - gap) / 2}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize="10"
              fill="#8a877f"
            >
              {`${cohort.label.replace(' 20', " '")} · ${cohort.size}`}
            </text>
            {cohort.retention.map((share, offset) => (
              <rect
                key={offset}
                x={left + offset * cell}
                y={top + row * cell}
                width={cell - gap}
                height={cell - gap}
                fill={heatColor(share)}
                onMouseMove={(event) =>
                  show(event, {
                    label: `${cohort.label} · month ${offset}`,
                    share,
                    active: Math.round(share * cohort.size),
                    size: cohort.size,
                  })
                }
              />
            ))}
          </g>
        ))}
      </svg>
      {hover && (
        <div className="chart-tip" style={{ left: hover.x, top: hover.y }}>
          <p className="chart-tip-label">{hover.label}</p>
          <p style={{ color: PLUM }}>Retention : {percent(hover.share)}</p>
          <p className="chart-tip-note">
            {count(hover.active)} of {count(hover.size)} clients
          </p>
        </div>
      )}
    </div>
  );
}

/** Overlay shown in place of a chart or table that has nothing to render. */
function Empty({ when, children }: { when: boolean; children: string }) {
  if (!when) return null;
  return <div className="empty-overlay">{children}</div>;
}

/** A number is a tile like any other: same header, same controls. */
function Metric({
  id,
  label,
  figure,
  note,
  span,
  expanded,
  onExpand,
}: {
  id: string;
  label: string;
  figure: string;
  note: string;
  span: 3 | 4;
  expanded: string | null;
  onExpand: (id: string | null) => void;
}) {
  return (
    <Tile
      id={id}
      className={`metric span-${span}`}
      title={label}
      figure={figure}
      note={<p>{note}</p>}
      noteText={note}
      expanded={expanded}
      onExpand={onExpand}
    />
  );
}

export default function Dashboard({
  dashboard,
}: {
  dashboard: DashboardPayload;
}) {
  const [scope, setScope] = useState<'weekly' | 'all'>('weekly');
  const [clientPage, setClientPage] = useState(0);
  const [deploymentPage, setDeploymentPage] = useState(0);
  const [feedPage, setFeedPage] = useState(0);
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const [clientQuery, setClientQuery] = useState('');
  const [deploymentQuery, setDeploymentQuery] = useState('');
  const [feedQuery, setFeedQuery] = useState('');
  const [network, setNetwork] = useState(dashboard.defaultNetwork);

  // Every network's snapshot is already on the page, so switching is instant.
  const data =
    dashboard.snapshots[network] ??
    dashboard.snapshots[dashboard.defaultNetwork];
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

  // Series are keyed by network+address to stay unique; labels must resolve back
  // to the plain address rather than slicing the composite key.
  const addressOfSeries = useMemo(
    () =>
      new Map(data.relayerSeries.map((entry) => [entry.key, entry.address])),
    [data.relayerSeries],
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

  // Defined as data once: the card header renders it, the dialog renders it, and
  // the PNG export paints it. Three surfaces, one source.
  const activeUsersLegend: LegendEntry[] = [
    { color: YELLOW, label: '30-day active' },
    { color: '#9b978d', label: '7-day active' },
    { color: PLUM, label: 'New clients (30d)', dashed: true },
  ];
  const volumeLegend: LegendEntry[] = [
    { color: YELLOW, label: 'Weekly' },
    { color: INK, label: 'Cumulative' },
  ];
  const dailyUsersLegend: LegendEntry[] = [
    { color: YELLOW, label: 'Returning' },
    { color: PLUM, label: 'New' },
  ];
  const relayerLegend: LegendEntry[] = relayerSlices.map((relayer) => ({
    color: relayer.fill,
    label: shortAddress(relayer.address),
  }));

  const rankOf = new Map(
    rankedClients.map((client, index) => [client.key, index + 1]),
  );
  const visibleClients = rankedClients.filter((client) =>
    matches(clientQuery, client.address, client.network),
  );
  const visibleDeployments = data.deployments.filter((row) =>
    matches(
      deploymentQuery,
      row.address,
      row.network,
      formatTimestamp(row.timestamp),
    ),
  );
  const visibleRedemptions = data.recentRedemptions.filter((row) =>
    matches(
      feedQuery,
      row.client,
      row.relayer,
      `0x${row.channelId}`,
      row.network,
      formatTimestamp(row.timestamp),
    ),
  );

  const clientRows = () => [
    ['rank', 'client', 'network', 'redemptions', 'usage_mb'],
    ...visibleClients.map((client) => [
      String(rankOf.get(client.key) ?? 0),
      client.address,
      client.network,
      String(
        scope === 'weekly' ? client.redemptions7d : client.redemptionsTotal,
      ),
      (
        (scope === 'weekly' ? client.gigabytes7d : client.gigabytesTotal) * 1000
      ).toFixed(2),
    ]),
  ];
  const deploymentRows = () => [
    ['timestamp', 'client', 'network'],
    ...visibleDeployments.map((row) => [
      row.timestamp,
      row.address,
      row.network,
    ]),
  ];
  const feedRows = () => [
    ['timestamp', 'client', 'relayer', 'channel', 'network'],
    ...visibleRedemptions.map((row) => [
      row.timestamp,
      row.client,
      row.relayer,
      `0x${row.channelId}`,
      row.network,
    ]),
  ];

  // One row per contract, one column per network: the same role deployed twice is
  // a comparison, not two unrelated rows.
  const contractNetworks = [
    ...new Set(data.contracts.map((row) => row.network)),
  ];
  const contractRoles = [
    ...new Set(data.contracts.map((row) => row.role)),
  ].sort();

  // The oldest cohort has the most months behind it and so sets the export width.
  const cohortWidth = Math.max(
    0,
    ...data.retention.map((c) => c.retention.length),
  );
  const retentionRows = () => [
    [
      'cohort',
      'clients',
      ...Array.from({ length: cohortWidth }, (_, i) => `month_${i}`),
    ],
    ...data.retention.map((cohort) => [
      cohort.month,
      String(cohort.size),
      ...Array.from({ length: cohortWidth }, (_, i) =>
        cohort.retention[i] === undefined ? '' : cohort.retention[i].toFixed(4),
      ),
    ]),
  ];

  const pagesOf = (total: number) => Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clip = (page: number, total: number) =>
    Math.min(page, pagesOf(total) - 1);
  const clientAt = clip(clientPage, visibleClients.length);
  const deploymentAt = clip(deploymentPage, visibleDeployments.length);
  const feedAt = clip(feedPage, visibleRedemptions.length);
  const pageOf = <T,>(rows: T[], page: number) =>
    rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <main>
      <a className="skip-link" href="#top">
        Skip to content
      </a>
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
          Blokli source <ExternalLink size={13} aria-hidden="true" />
          <span className="sr-only">(opens in a new tab)</span>
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
            <fieldset className="network-switch">
              <legend className="sr-only">Network</legend>
              <button
                type="button"
                aria-pressed={combined}
                className={combined ? 'active' : ''}
                onClick={() => setNetwork(COMBINED)}
              >
                All networks
              </button>
              {dashboard.networks.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={network === entry.id}
                  className={network === entry.id ? 'active' : ''}
                  onClick={() => setNetwork(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </fieldset>
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

      <section
        className="headline-grid tile-grid"
        aria-label="Headline metrics"
      >
        <Tile
          id="monthly-active-users"
          className="metric mau-card span-3"
          title="MONTHLY ACTIVE USERS"
          figure={count(data.totals.monthlyActiveUsers)}
          note={
            <div className="mau-footer">
              <span>{count(data.totals.weeklyActiveUsers)} weekly active</span>
              <small>Trailing 30 and 7 days</small>
            </div>
          }
          noteText={`${count(data.totals.weeklyActiveUsers)} weekly active · trailing 30 and 7 days`}
          expanded={enlarged}
          onExpand={setEnlarged}
        />
        <Metric
          id="redemptions-7-days"
          span={3}
          label="REDEMPTIONS · 7 DAYS"
          figure={count(data.totals.redemptions7d)}
          note={`${count(data.totals.redemptionsTotal)} since indexing began`}
          expanded={enlarged}
          onExpand={setEnlarged}
        />
        <Metric
          id="data-relayed-7-days"
          span={3}
          label="DATA RELAYED · 7 DAYS"
          figure={volume(data.totals.gigabytes7d)}
          note={`${volume(data.totals.gigabytesTotal)} cumulative`}
          expanded={enlarged}
          onExpand={setEnlarged}
        />
        <Metric
          id="new-clients-30-days"
          span={3}
          label="NEW CLIENTS · 30 DAYS"
          figure={count(data.totals.deployments30d)}
          note={`${count(data.totals.deployments7d)} in the last 7 days`}
          expanded={enlarged}
          onExpand={setEnlarged}
        />
      </section>

      <section className="section" id="usage">
        <div className="section-heading">
          <div>
            <span className="section-index">01</span>
            <h2>Users and traffic</h2>
          </div>
          <p>
            A user is a VPN client — an account that bound a key but never
            announced an address, so it is not relay infrastructure. Volume is
            derived from the redemptions those clients settled, priced at the
            winning probability in force at each block.
          </p>
        </div>
        <div className="tile-grid">
          <Tile
            id="active-users"
            className="main-chart span-6"
            eyebrow="SINCE 01 JAN 2026"
            title="Monthly and weekly active users"
            legend={activeUsersLegend}
            note={
              <>
                <Empty when={!data.activeUsers.length}>
                  The series appears once the index database reports client
                  redemptions.
                </Empty>
                <p className="chart-note">
                  Each point counts distinct clients over the preceding 30 and 7
                  days.
                </p>
              </>
            }
            expanded={enlarged}
            onExpand={setEnlarged}
            chart={
              <ResponsiveContainer width="100%" height={250}>
                <ComposedChart
                  data={data.activeUsers}
                  margin={{ top: 24, right: 18, left: -18, bottom: 0 }}
                >
                  <defs>
                    <linearGradient
                      id="fillMonthly"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
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
            }
          />
          <Tile
            id="volume"
            className="service-chart span-6"
            eyebrow="PER WEEK AND CUMULATIVE"
            title="Data volume"
            legend={volumeLegend}
            note={
              <>
                <Empty when={!data.weeks.length}>
                  No client redemptions have been indexed yet.
                </Empty>
              </>
            }
            expanded={enlarged}
            onExpand={setEnlarged}
            chart={
              <ResponsiveContainer width="100%" height={250}>
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
            }
          />
        </div>
        <div className="tile-grid">
          <Metric
            id="total-redemptions"
            span={4}
            label="TOTAL REDEMPTIONS"
            figure={count(data.totals.redemptionsTotal)}
            note={`${count(data.totals.ticketsTotal)} tickets settled across them`}
            expanded={enlarged}
            onExpand={setEnlarged}
          />
          <Metric
            id="total-data-relayed"
            span={4}
            label="TOTAL DATA RELAYED"
            figure={volume(data.totals.gigabytesTotal)}
            note="Client traffic since indexing began"
            expanded={enlarged}
            onExpand={setEnlarged}
          />
          <Metric
            id="active-channels"
            span={4}
            label="ACTIVE CHANNELS"
            figure={count(data.openChannels)}
            note={`${compactToken(data.channelBalance)} allocated`}
            expanded={enlarged}
            onExpand={setEnlarged}
          />
        </div>
      </section>

      <section className="section" id="activity">
        <div className="section-heading">
          <div>
            <span className="section-index">02</span>
            <h2>Daily activity</h2>
          </div>
          <p>
            Who showed up each day, and when during the day the network carries
            traffic.
          </p>
        </div>
        <div className="tile-grid">
          <Tile
            id="daily-users"
            className="service-chart span-4"
            eyebrow="LAST 30 DAYS"
            title="Daily users"
            legend={dailyUsersLegend}
            note={
              <>
                <Empty when={!data.dailyUsers.length}>
                  No client activity in the last 30 days.
                </Empty>
              </>
            }
            expanded={enlarged}
            onExpand={setEnlarged}
            chart={
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
            }
          />
          <Tile
            id="retention"
            className="service-chart span-4"
            eyebrow="BY DEPLOYMENT MONTH"
            title="Cohort retention"
            rows={retentionRows}
            note={
              <>
                <Empty when={!data.retention.length}>
                  No client deployments have been indexed.
                </Empty>
                <p className="chart-note">
                  Read a row left to right: it follows the clients deployed that
                  month, and each square is the share of them relaying traffic
                  that many months later. Month 0 is the month they were
                  deployed, so it is an activation rate; darker is a higher
                  share. A row is short because those months have not happened
                  yet, not because the clients left.
                </p>
              </>
            }
            expanded={enlarged}
            onExpand={setEnlarged}
            chart={<CohortGrid cohorts={data.retention} />}
          />
          <Tile
            id="hourly"
            className="service-chart span-4"
            eyebrow="ALL INDEXED HISTORY"
            title="When traffic is relayed"
            note={
              <>
                <Empty when={!data.heatmap.length}>
                  No volume has been indexed yet.
                </Empty>
                <p className="chart-note">
                  Share of relayed volume by weekday and hour, UTC. Block
                  timestamps are{' '}
                  {data.timebase === 'rpc'
                    ? 'RPC resolved'
                    : 'estimated from block height'}
                  .
                </p>
              </>
            }
            expanded={enlarged}
            onExpand={setEnlarged}
            chart={
              <Heatmap grid={data.heatmap} total={data.totals.gigabytesTotal} />
            }
          />
        </div>
      </section>

      <section className="section" id="relayers">
        <div className="section-heading">
          <div>
            <span className="section-index">03</span>
            <h2>Redemptions by relayer</h2>
          </div>
          <p>
            Which relays carried client traffic, and how the load is shared.
          </p>
        </div>
        <div className="tile-grid">
          <Tile
            id="share"
            className="service-chart span-4"
            eyebrow="LAST 7 DAYS"
            title="Share of redemptions"
            legend={relayerLegend}
            showLegend={false}
            note={
              <>
                <Empty when={!data.relayers.length}>
                  No client redemptions were indexed in the last 7 days.
                </Empty>
              </>
            }
            expanded={enlarged}
            onExpand={setEnlarged}
            chart={
              <ResponsiveContainer width="100%" height={250}>
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
                    contentStyle={ADDRESS_TOOLTIP}
                    formatter={(input: unknown, name: unknown) =>
                      [
                        `${INTEGER.format(Number(input))} redemptions`,
                        typeof name === 'string' ? name : '',
                      ] as [string, string]
                    }
                  />
                </PieChart>
              </ResponsiveContainer>
            }
          />
          <Tile
            id="relayer-volume"
            className="service-chart span-8"
            eyebrow="LAST 30 DAYS"
            title="Estimated daily volume per relayer"
            legend={relayerLegend}
            showLegend={false}
            note={
              <>
                <Empty when={!data.relayerDaily.length}>
                  No client redemptions were indexed in the last 30 days.
                </Empty>
                <p className="chart-note">
                  Volume is an estimate derived from redemptions seen on chain.
                </p>
              </>
            }
            expanded={enlarged}
            onExpand={setEnlarged}
            chart={
              <ResponsiveContainer width="100%" height={250}>
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
                    contentStyle={ADDRESS_TOOLTIP}
                    itemSorter={(item) => -Number(item.value ?? 0)}
                    formatter={(input: unknown, name: unknown) =>
                      [
                        volume(Number(input)),
                        typeof name === 'string'
                          ? (addressOfSeries.get(name) ?? name)
                          : '',
                      ] as [string, string]
                    }
                  />
                  {data.relayerSeries.map((entry, index) => (
                    <Bar
                      key={entry.key}
                      dataKey={entry.key}
                      stackId="relayers"
                      fill={relayerColor(index, data.relayerSeries.length)}
                      isAnimationActive={false}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            }
          />
        </div>
      </section>

      <section className="section" id="ticket">
        <div className="section-heading">
          <div>
            <span className="section-index">04</span>
            <h2>Ticket parameters</h2>
          </div>
          <p>
            The oracle values that convert redemptions into traffic, as they
            stand now.
          </p>
        </div>
        <div className="tile-grid">
          <Metric
            id="winning-probability"
            span={4}
            label="WINNING PROBABILITY"
            figure={probability(data.ticket.winProbability)}
            note="Current network minimum"
            expanded={enlarged}
            onExpand={setEnlarged}
          />
          <Metric
            id="ticket-price"
            span={4}
            label="TICKET PRICE"
            figure={token(data.ticket.priceWei)}
            note="Cost of relaying one packet, one hop"
            expanded={enlarged}
            onExpand={setEnlarged}
          />
          <Metric
            id="ticket-value"
            span={4}
            label="TICKET VALUE"
            figure={token(data.ticket.valueWei, 4)}
            note="Price ÷ probability, for one remaining hop"
            expanded={enlarged}
            onExpand={setEnlarged}
          />
        </div>
      </section>

      <section className="section" id="clients">
        <div className="section-heading">
          <div>
            <span className="section-index">05</span>
            <h2>Clients</h2>
          </div>
          <p>
            Who used the network and when each client first appeared. Volume is
            only an estimation based on the redemptions seen on chain.
          </p>
        </div>
        <div className="tile-grid">
          <Tile
            id="clients-table"
            className="table-card span-6"
            rows={clientRows}
            rowCount={visibleClients.length}
            search={{
              value: clientQuery,
              onChange: setClientQuery,
              placeholder: 'Search...',
            }}
            eyebrow="USAGE PER CLIENT"
            title={
              scope === 'weekly'
                ? 'Weekly most active users'
                : 'Most active users'
            }
            badge={
              <fieldset className="tab-switch">
                <legend className="sr-only">Ranking window</legend>
                <button
                  type="button"
                  aria-pressed={scope === 'weekly'}
                  className={scope === 'weekly' ? 'active' : ''}
                  onClick={() => setScope('weekly')}
                >
                  Weekly
                </button>
                <button
                  type="button"
                  aria-pressed={scope === 'all'}
                  className={scope === 'all' ? 'active' : ''}
                  onClick={() => setScope('all')}
                >
                  All time
                </button>
              </fieldset>
            }
            note={
              <>
                <Empty when={!rankedClients.length}>
                  No client usage has been indexed for this window.
                </Empty>
                <p className="chart-note">
                  {count(rankedClients.length)} of {count(data.clientCount)}{' '}
                  clients had usage in this window.
                </p>
              </>
            }
            footer={
              <Pager
                page={clientAt}
                pages={pagesOf(rankedClients.length)}
                onChange={setClientPage}
                label="Most active users pages"
              />
            }
            expanded={enlarged}
            onExpand={setEnlarged}
          >
            <div className="table-scroll">
              <table className="rank-table">
                <caption className="sr-only">
                  {scope === 'weekly'
                    ? 'Most active clients over the last seven days'
                    : 'Most active clients since indexing began'}
                </caption>
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
                  {pageOf(visibleClients, clientAt).map((client) => {
                    const rank = rankOf.get(client.key) ?? 0;
                    return (
                      <tr key={client.key}>
                        <td
                          className={
                            rank <= 3 ? 'rank-number leading' : 'rank-number'
                          }
                        >
                          {rank}
                        </td>
                        <td>
                          <AddressLink address={client.address} />
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
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Tile>
          <Tile
            id="deployments-table"
            className="table-card span-6"
            rows={deploymentRows}
            rowCount={visibleDeployments.length}
            search={{
              value: deploymentQuery,
              onChange: setDeploymentQuery,
              placeholder: 'Search...',
            }}
            eyebrow="EDGE NODE KEY-BINDINGS"
            title="Client deployments"
            note={
              <>
                <Empty when={!data.deployments.length}>
                  No client deployments have been indexed.
                </Empty>
              </>
            }
            footer={
              <Pager
                page={deploymentAt}
                pages={pagesOf(data.deployments.length)}
                onChange={setDeploymentPage}
                label="Client deployment pages"
              />
            }
            expanded={enlarged}
            onExpand={setEnlarged}
          >
            <div className="table-scroll">
              <table className="rank-table">
                <caption className="sr-only">
                  Client deployments, newest first
                </caption>
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
                  {pageOf(visibleDeployments, deploymentAt).map(
                    (deployment) => (
                      <tr key={deployment.key}>
                        <td className="timestamp">
                          {formatTimestamp(deployment.timestamp)}
                        </td>
                        <td>
                          <AddressLink address={deployment.address} />
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          </Tile>
        </div>
      </section>

      <section className="section" id="redemptions">
        <div className="section-heading">
          <div>
            <span className="section-index">06</span>
            <h2>Most recent redemptions</h2>
          </div>
          <p>Latest redemptions per channel, newest first.</p>
        </div>
        <Tile
          id="feed-table"
          className="table-card span-12"
          rows={feedRows}
          rowCount={visibleRedemptions.length}
          search={{
            value: feedQuery,
            onChange: setFeedQuery,
            placeholder: 'Search...',
          }}
          eyebrow="LATEST REDEMPTIONS PER CHANNEL"
          title="Redemption feed"
          note={
            <>
              <Empty when={!data.recentRedemptions.length}>
                No redemptions have been indexed.
              </Empty>
              <p className="chart-note">
                The feed keeps the most recent{' '}
                {count(data.recentRedemptions.length)} of{' '}
                {count(data.totals.redemptionsTotal)} redemptions.
              </p>
            </>
          }
          footer={
            <Pager
              page={feedAt}
              pages={pagesOf(data.recentRedemptions.length)}
              onChange={setFeedPage}
              label="Redemption feed pages"
            />
          }
          expanded={enlarged}
          onExpand={setEnlarged}
        >
          <div className="table-scroll">
            <table className="rank-table feed-table">
              <caption className="sr-only">
                Most recent redemptions, newest first
              </caption>
              <thead>
                <tr>
                  <th scope="col">timestamp</th>
                  <th scope="col">client</th>
                  <th scope="col">relayer</th>
                  <th scope="col">channel</th>
                </tr>
              </thead>
              <tbody>
                {pageOf(visibleRedemptions, feedAt).map((redemption) => (
                  <tr key={redemption.key}>
                    <td className="timestamp">
                      {formatTimestamp(redemption.timestamp)}
                    </td>
                    <td>
                      <AddressLink address={redemption.client} />
                    </td>
                    <td>
                      <AddressLink address={redemption.relayer} />
                    </td>
                    <td>
                      <code>{`0x${redemption.channelId}`}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Tile>
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
        {data.contracts.length > 0 && (
          <details className="contracts">
            <summary>{count(contractRoles.length)} contracts indexed</summary>
            <table>
              <thead>
                <tr>
                  <th scope="col">contract</th>
                  {contractNetworks.map((id) => (
                    <th key={id} scope="col">
                      {contractNetworks.length > 1 ? labelOf(id) : 'address'}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {contractRoles.map((role) => (
                  <tr key={role}>
                    <th scope="row">{role}</th>
                    {contractNetworks.map((id) => {
                      const match = data.contracts.find(
                        (row) => row.role === role && row.network === id,
                      );
                      return (
                        <td key={id}>
                          {match ? (
                            <AddressLink address={match.address} />
                          ) : (
                            <span className="absent">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
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

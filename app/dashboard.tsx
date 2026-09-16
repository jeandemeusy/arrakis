'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamicImport from 'next/dynamic';
import Image from 'next/image';
import {
  ChevronLeft,
  ChevronRight,
  Database,
  ExternalLink,
  Menu,
  ShieldCheck,
  X,
} from 'lucide-react';

import type {
  PublicDashboard as DashboardPayload,
  PublicSnapshot,
} from '@/lib/analytics';
import {
  DECIMAL,
  INTEGER,
  heatColor,
  relayerColor,
  volume,
} from './chart-theme';
import { StyleSwitch, usePalette } from './style';

/**
 * The charts, fetched only once the page is interactive.
 *
 * Recharts is 424KB of a roughly 1MB bundle and nothing above the fold needs it:
 * the headline figures are numbers and the tables are HTML. Split out, it no
 * longer sits on the critical path, at the cost of the charts appearing a moment
 * after the rest. `ssr: false` because a chart has no layout to contribute
 * server-side anyway — ResponsiveContainer measures its box in the browser — so
 * server-rendering it only inflated the HTML with markup that was replaced on
 * hydration.
 *
 * Each placeholder reserves the height its chart will take, so nothing below it
 * moves when the bundle lands.
 */
const reserve = (height: number) => {
  const Placeholder = () => <div style={{ height }} />;
  return Placeholder;
};

const ActiveUsersChart = dynamicImport(
  () => import('./charts').then((module) => module.ActiveUsersChart),
  { ssr: false, loading: reserve(250) },
);
const VolumeChart = dynamicImport(
  () => import('./charts').then((module) => module.VolumeChart),
  { ssr: false, loading: reserve(250) },
);
const DailyUsersChart = dynamicImport(
  () => import('./charts').then((module) => module.DailyUsersChart),
  { ssr: false, loading: reserve(250) },
);
const RelayerShareChart = dynamicImport(
  () => import('./charts').then((module) => module.RelayerShareChart),
  { ssr: false, loading: reserve(250) },
);
const RelayerStackChart = dynamicImport(
  () => import('./charts').then((module) => module.RelayerStackChart),
  { ssr: false, loading: reserve(250) },
);
const ClientDailyChart = dynamicImport(
  () => import('./charts').then((module) => module.ClientDailyChart),
  { ssr: false, loading: reserve(170) },
);

import type { ClientDetail, PanelStatus } from '@/lib/snapshot';
import { COMBINED } from '@/lib/constants';
import { Tile, type LegendEntry } from './tile';

/**
 * Addresses are fixed-width, so listing them whole in a monospace tooltip puts
 * every volume at the same offset and the column reads as a column.
 */
const EXPLORER = 'https://gnosisscan.io/address/';

/*
 * Two vocabularies, used the same way everywhere on the page.
 *
 * Direction is always `upstream` (client to exit, paid by the client) or
 * `downstream` (exit back to client, paid by the exit) — never "up"/"down",
 * "pushed" or "sent". A figure with no direction on it covers both.
 *
 * Windows are always `LAST 7 DAYS`, `LAST 30 DAYS` or `ALL TIME` — never
 * "weekly", "total", "trailing" or "since indexing began". A figure with no
 * window on it is the current state, like a balance or an oracle value.
 */
const PAGE_SIZE = 50;

// Constructing an Intl formatter is expensive and these run per tick and per row.
const PERCENT = new Intl.NumberFormat('en', {
  style: 'percent',
  maximumFractionDigits: 1,
});
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
// The client timeline is read as a shape, not a log, so it drops the seconds.
const MOMENT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  hour12: false,
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

function observedAt(value: string) {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - Date.parse(value)) / 1000),
  );
  if (seconds < 60) return 'updated just now';
  if (seconds < 3600) return `updated ${Math.floor(seconds / 60)}m ago`;
  return `updated ${Math.floor(seconds / 3600)}h ago`;
}

/**
 * A colour per relayer, ordered by volume.
 *
 * Relayers are ranked, so the palette is a ramp rather than a wheel of unrelated
 * hues: it interpolates across hand-picked anchors, warm to cool, all muted to sit
 * on the paper ground. Neighbouring ranks stay distinguishable while the chart
 * still reads as one object — which a hue-per-category rainbow does not.
 */
function count(input: number | null) {
  return input === null ? '—' : INTEGER.format(input);
}

/**
 * Packets paid for, rounded to the nearest ten thousand.
 *
 * The count comes from ticket-index jumps rather than from packets themselves,
 * so its last digits are precision it has not earned. Rounding says the figure
 * is an estimate before the label has to.
 */
function packets(input: number | null) {
  if (input === null) return '—';
  return INTEGER.format(Math.round(input / 10_000) * 10_000);
}

function percent(share: number) {
  return PERCENT.format(share);
}

/** Volume arrives in gigabytes; step down so small numbers stay readable. */
/** Adds two figures either of which may be unknown, rather than reading null as 0. */
function plus(a: number | null, b: number | null) {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/** A multiple, as in "8.4× upstream". */
function multiple(value: number | null) {
  return value === null ? '—' : `${DECIMAL.format(value)}×`;
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

/**
 * Search matches any field the row displays, case-insensitively, so pasting a
 * partial address finds it wherever it appears.
 *
 * The needle arrives trimmed and lowercased, and every caller skips the filter
 * outright when it is empty. Both matter, and the second one especially: fields
 * are passed by value, so an empty-query early return inside this function was
 * still paying to format a timestamp for every row of every table on every
 * render — including every keystroke in an unrelated search box.
 */
function matches(needle: string, ...fields: string[]) {
  return fields.some((field) => field.toLowerCase().includes(needle));
}

/** The trimmed, lowercased needle a search box is asking for, or none. */
function needleOf(query: string) {
  return query.trim().toLowerCase();
}

function formatTimestamp(value: string) {
  return TIMESTAMP.format(new Date(value)).replace(',', '');
}

function formatMoment(value: string) {
  return MOMENT.format(new Date(value)).replace(',', '');
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

/** Mirrors `identity` in the snapshot builder: a client is only unique per network. */
function clientKey(network: string, address: string) {
  return `${network} ${address}`;
}

/**
 * A client address, opening its drill-down.
 *
 * A relayer or a contract address goes straight to the block explorer, because
 * that is the only thing there is to say about it. A client has a record on this
 * page — what it relayed, when, and through whom — so its address opens that
 * instead, and the explorer link moves inside the dialog rather than away.
 */
function ClientCell({
  address,
  network,
  known,
  onOpen,
}: {
  address: string;
  network: string;
  known: boolean;
  onOpen: (key: string) => void;
}) {
  if (!known) return <AddressLink address={address} />;
  return (
    <button
      type="button"
      className="address address-button"
      onClick={() => onOpen(clientKey(network, address))}
      aria-label={`Open the record for client ${address}`}
    >
      <code>{address}</code>
    </button>
  );
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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
  direction,
  height = 250,
}: {
  grid: number[][];
  total: number | null;
  direction: string;
  height?: number;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const palette = usePalette();
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
        aria-label={`Share of ${direction} volume by weekday and hour, UTC`}
      >
        {grid.map((row, weekday) =>
          row.map((share, hour) => (
            <rect
              key={`${weekday}-${hour}`}
              x={left + hour * cell}
              y={top + weekday * cell}
              width={cell - gap}
              height={cell - gap}
              fill={heatColor(palette, peak > 0 ? share / peak : 0)}
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
            fill={palette.axis.fill}
            fontWeight={palette.axis.fontWeight}
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
            fill={palette.axis.fill}
            fontWeight={palette.axis.fontWeight}
          >
            {String(hour).padStart(2, '0')}:00
          </text>
        ))}
      </svg>
      {hover && (
        <div className="chart-tip" style={{ left: hover.x, top: hover.y }}>
          <p className="chart-tip-label">{hover.label}</p>
          <p style={{ color: palette.accent2 }}>
            Share : {percent(hover.share)}
          </p>
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
  const palette = usePalette();
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

  // A young dashboard has three columns and a viewBox a fifth the width of the
  // card. Scaled to fill it, the squares come out the size of a thumb and the
  // labels bigger than the tile's own title. Capping the scale keeps a cell the
  // same size whatever the grid's shape — which is the point of a grid read by
  // comparing squares. The cap lifts when the tile is enlarged.
  const maxCell = height > 300 ? 52 : 34;
  const scale = maxCell / cell;

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
        style={{
          display: 'block',
          margin: '0 auto',
          maxWidth: width * scale,
          maxHeight: full * scale,
        }}
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
            fill={palette.axis.fill}
            fontWeight={palette.axis.fontWeight}
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
              fill={palette.axis.fill}
              fontWeight={palette.axis.fontWeight}
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
                fill={heatColor(palette, share)}
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
          <p style={{ color: palette.accent2 }}>
            Retention : {percent(hover.share)}
          </p>
          <p className="chart-tip-note">
            {count(hover.active)} of {count(hover.size)} clients
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * One client's whole record, opened from any table that lists it.
 *
 * The ranking tables answer "who used the most". They cannot answer "what did
 * this one actually do", which is the question anyone investigating a client has
 * next: when it arrived, whether it kept going, and which relays it paid.
 *
 * The record is fetched on the click that opens the dialog, out of the snapshot
 * the server already has in hand, so it costs a round trip and no query. The
 * dialog opens on the click rather than on the reply — `pending` is that gap —
 * because opening only once the data lands reads as a click that did nothing.
 */
function ClientDialog({
  detail,
  pending,
  failed,
  networkLabel,
  relayerCount,
  onClose,
}: {
  detail: ClientDetail | null;
  pending: boolean;
  failed: boolean;
  networkLabel: string | null;
  relayerCount: number;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const palette = usePalette();
  const open = detail !== null || pending || failed;

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  const peak = detail
    ? Math.max(...detail.daily.map((point) => point.gigabytes))
    : 0;

  return (
    <dialog
      ref={dialog}
      className="modal client-modal"
      aria-label="Client record"
      onClose={onClose}
    >
      <div className="modal-head">
        <h2>Client record</h2>
        <button type="button" onClick={onClose} aria-label="Close">
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      {(pending || failed) && (
        <div className="modal-body client-body">
          <p className="client-quiet">
            {failed
              ? 'This record could not be read. Close and try again.'
              : 'Loading the record…'}
          </p>
        </div>
      )}

      {/* Mounted only while open, so the page carries one dialog and not one per row. */}
      {detail && (
        <div className="modal-body client-body">
          <div className="client-id">
            <code>{detail.address}</code>
            {networkLabel && (
              <span className="client-network">{networkLabel}</span>
            )}
            <a
              href={`${EXPLORER}${detail.address}`}
              target="_blank"
              rel="noreferrer"
            >
              Gnosisscan <ExternalLink size={12} aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </div>

          <dl className="client-stats">
            <div>
              <dt>Upstream</dt>
              <dd>{volume(detail.gigabytes)}</dd>
            </div>
            <div>
              <dt>Active days</dt>
              <dd>{count(detail.activeDays)}</dd>
            </div>
          </dl>

          <ol className="client-timeline">
            {[
              { label: 'Deployed', at: detail.deployedAt },
              { label: 'First seen', at: detail.firstSeen },
              { label: 'Last seen', at: detail.lastSeen },
            ].map((step) => (
              <li key={step.label}>
                <span className="timeline-mark" aria-hidden="true" />
                <span className="timeline-label">{step.label}</span>
                {step.at ? (
                  <time dateTime={step.at}>{formatMoment(step.at)}</time>
                ) : (
                  <span className="absent">not indexed</span>
                )}
              </li>
            ))}
          </ol>

          <h3>Upstream volume · last 30 days</h3>
          {peak > 0 ? (
            <ClientDailyChart points={detail.daily} />
          ) : (
            <p className="client-quiet">
              No upstream traffic in the last 30 days.
            </p>
          )}

          <h3>Relays paid</h3>
          {detail.relayers.length === 0 && (
            <p className="client-quiet">No relays paid yet.</p>
          )}
          {detail.relayers.length > 0 && (
            <div className="table-scroll client-relays">
              <table className="rank-table">
                <caption className="sr-only">
                  Relays this client paid, by volume
                </caption>
                <thead>
                  <tr>
                    <th scope="col">relay</th>
                    <th scope="col" className="numeric">
                      redemptions
                    </th>
                    <th scope="col" className="numeric">
                      share
                    </th>
                    <th scope="col" className="numeric">
                      upstream (MB)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {detail.relayers.map((relayer) => (
                    <tr key={relayer.key}>
                      <td>
                        <span
                          className="swatch"
                          style={{
                            background:
                              relayer.colorIndex >= 0
                                ? relayerColor(
                                    palette,
                                    relayer.colorIndex,
                                    relayerCount,
                                  )
                                : // A relay outside the charted roster has no
                                  // colour to carry, so it takes the style's
                                  // own neutral rather than a series colour.
                                  'var(--swatch-unknown)',
                          }}
                        />
                        <AddressLink address={relayer.address} />
                      </td>
                      <td className="numeric">{count(relayer.redemptions)}</td>
                      <td className="numeric">{percent(relayer.share)}</td>
                      <td className="numeric">
                        {megabytes(relayer.gigabytes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </dialog>
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
  status,
  expanded,
  onExpand,
}: {
  id: string;
  label: string;
  figure: string;
  note: string;
  span: 3 | 4;
  status?: PanelStatus;
  expanded: string | null;
  onExpand: (id: string | null) => void;
}) {
  return (
    <Tile
      id={id}
      className={`metric span-${span}`}
      title={label}
      status={status}
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
  const [flow, setFlow] = useState<'upstream' | 'downstream'>('upstream');
  const [hours, setHours] = useState<'upstream' | 'downstream'>('upstream');
  const [clientPage, setClientPage] = useState(0);
  const [deploymentPage, setDeploymentPage] = useState(0);
  const [feedPage, setFeedPage] = useState(0);
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const [clientQuery, setClientQuery] = useState('');
  const [deploymentQuery, setDeploymentQuery] = useState('');
  const [feedQuery, setFeedQuery] = useState('');
  const [network, setNetwork] = useState(dashboard.defaultNetwork);
  const [snapshots, setSnapshots] = useState(dashboard.snapshots);
  const [loadingNetwork, setLoadingNetwork] = useState<string | null>(null);
  const palette = usePalette();
  /** The client key whose record is open, and that record once it has arrived. */
  const [inspected, setInspected] = useState<string | null>(null);
  const [fetched, setFetched] = useState<{
    key: string;
    network: string;
    /** Null once the request has been made and failed. */
    detail: ClientDetail | null;
  } | null>(null);

  // Every network's snapshot is already on the page, so switching is instant.
  const data = snapshots[network] ?? snapshots[dashboard.defaultNetwork];
  const combined = network === COMBINED;
  const labelOf = (id: string) =>
    dashboard.networks.find((entry) => entry.id === id)?.label ?? id;
  const live = data.source !== 'unavailable';
  const panels = data.panels;
  // Named exits make downstream a measurement; guessed ones make it an estimate,
  // and the page should not claim the same confidence for both.
  const namedExits = (data.totals.exitsNamed ?? 0) > 0;

  const selectNetwork = useCallback(
    async (next: string, history: 'push' | 'replace' = 'push') => {
      if (next === network || loadingNetwork !== null) return;
      const setAddress = () => {
        const url = new URL(window.location.href);
        if (next === dashboard.defaultNetwork) url.searchParams.delete('network');
        else url.searchParams.set('network', next);
        window.history[history === 'push' ? 'pushState' : 'replaceState'](
          null,
          '',
          url,
        );
      };
      if (snapshots[next]) {
        setNetwork(next);
        setInspected(null);
        setAddress();
        return;
      }
      setLoadingNetwork(next);
      try {
        const response = await fetch(
          `/api/v1/dashboard?network=${encodeURIComponent(next)}`,
        );
        if (!response.ok) throw new Error(`Responded with ${response.status}`);
        const snapshot = (await response.json()) as PublicSnapshot;
        setSnapshots((current) => ({ ...current, [next]: snapshot }));
        setNetwork(next);
        setInspected(null);
        setAddress();
      } finally {
        setLoadingNetwork(null);
      }
    },
    [dashboard.defaultNetwork, loadingNetwork, network, snapshots],
  );

  useEffect(() => {
    const syncFromAddress = () => {
      const requested = new URL(window.location.href).searchParams.get('network');
      if (
        requested &&
        dashboard.networks.some((entry) => entry.id === requested)
      ) {
        void selectNetwork(requested, 'replace');
      }
    };
    syncFromAddress();
    window.addEventListener('popstate', syncFromAddress);
    return () => window.removeEventListener('popstate', syncFromAddress);
  }, [dashboard.networks, selectNetwork]);

  // Which rows open a drill-down.
  //
  // The record itself is fetched, but the affordance has to be decided before the
  // click. `clientDetails` is keyed by exactly the clients that appear in
  // `clients` — one bucket per redemption payer — together with every deployment,
  // which are the same two inputs it is built from, so the set is derivable here
  // and costs no payload of its own.
  const knownClients = useMemo(
    () =>
      new Set([
        ...data.clients.map((client) => client.key),
        ...data.deployments.map((row) => row.key),
      ]),
    [data.clients, data.deployments],
  );

  // Switching network drops the drill-down: the client keys are per network, so
  // the open record would either vanish or, worse, name a different participant.
  //
  // Fetched rather than read out of the payload. One record per client is most of
  // a snapshot and the dialog shows one at a time, so the page ships without them
  // and asks for the one a click needs — served from the same cached snapshot the
  // page was rendered from, so it costs no query.
  useEffect(() => {
    if (inspected === null) return;
    const aborted = new AbortController();
    fetch(
      `/api/v1/client?network=${encodeURIComponent(network)}&key=${encodeURIComponent(inspected)}`,
      { signal: aborted.signal },
    )
      .then(async (response) => {
        // 404 is not a failure: switching network keeps the key but changes which
        // snapshot it is asked of, and there it names a different participant or
        // none. Drop the inspection, which is what the dialog did when it read
        // the map straight off the payload and found nothing.
        if (response.status === 404) return 'missing' as const;
        if (!response.ok) throw new Error(`Responded with ${response.status}`);
        return (await response.json()) as ClientDetail;
      })
      .then((detail) => {
        if (detail === 'missing') setInspected(null);
        else setFetched({ key: inspected, network, detail });
      })
      .catch(() => {
        if (aborted.signal.aborted) return;
        // Recorded rather than swallowed, so the dialog says the record could not
        // be read instead of waiting on one that is never coming.
        setFetched({ key: inspected, network, detail: null });
      });
    return () => aborted.abort();
  }, [inspected, network]);

  // What arrived is only shown while it still answers what is being asked. Held
  // alongside its subject rather than cleared on the way out, so no state has to
  // be reset from inside the effect — and reopening the same client is served
  // from the browser's cache anyway.
  const answered =
    inspected !== null &&
    fetched?.key === inspected &&
    fetched.network === network;
  const inspecting = answered ? fetched.detail : null;
  /** Asked and answered with a failure, as opposed to still waiting. */
  const inspectFailed = answered && fetched.detail === null;

  // The ring stays readable because the long tail is one intentional slice,
  // while hovering preserves every address where it is actually needed.
  const relayerSlices = useMemo(() => {
    const leaders = data.relayers.slice(0, 20).map((relayer) => ({
      address: relayer.address,
      gigabytes: relayer.gigabytes,
      fill: relayerColor(
        palette,
        relayer.colorIndex,
        data.relayerSeries.length,
      ),
    }));
    const tail = data.relayers.slice(20);
    const other = tail.reduce((total, relayer) => total + relayer.gigabytes, 0);
    if (other > 0)
      leaders.push({
        address: 'Other relayers',
        gigabytes: other,
        fill: palette.seriesNeutral,
      });
    return leaders;
  }, [data.relayers, data.relayerSeries.length, palette]);

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
    { color: palette.accent, label: 'Active, last 30 days' },
    { color: palette.seriesNeutral, label: 'Active, last 7 days' },
    {
      color: palette.accent2,
      label: 'New clients, last 30 days',
      dashed: true,
      align: 'right',
    },
  ];
  const volumeLegend: LegendEntry[] = [
    { color: palette.accent, label: 'Upstream' },
    {
      color: palette.accent2,
      label: namedExits ? 'Downstream' : 'Downstream (inferred)',
    },
  ];
  const dailyUsersLegend: LegendEntry[] = [
    { color: palette.accent, label: 'Returning' },
    { color: palette.accent2, label: 'New' },
  ];
  const relayerLegend: LegendEntry[] = data.relayers.map((relayer) => ({
    color: relayerColor(palette, relayer.colorIndex, data.relayerSeries.length),
    label: shortAddress(relayer.address),
  }));

  const hourGrid = hours === 'upstream' ? data.heatmap : data.heatmapDownstream;
  // With no RPC the clock is extrapolated from block height, so the feed shows
  // the block it actually knows rather than a timestamp it inferred.
  const timed = data.timebase === 'rpc';

  const relayerFlow =
    flow === 'upstream' ? data.relayerDaily : data.relayerDownstreamDaily;

  const rankOf = useMemo(
    () =>
      new Map(rankedClients.map((client, index) => [client.key, index + 1])),
    [rankedClients],
  );

  // An unfiltered table is the common case and returns the list it was given, so
  // no row is touched at all until someone types. Memoised because these run on
  // every render otherwise, and a keystroke in one search box is a render for all
  // three tables.
  const visibleClients = useMemo(() => {
    const needle = needleOf(clientQuery);
    if (!needle) return rankedClients;
    return rankedClients.filter((client) =>
      matches(needle, client.address, client.network),
    );
  }, [rankedClients, clientQuery]);

  const visibleDeployments = useMemo(() => {
    const needle = needleOf(deploymentQuery);
    if (!needle) return data.deployments;
    return data.deployments.filter((row) =>
      matches(needle, row.address, row.network, formatTimestamp(row.timestamp)),
    );
  }, [data.deployments, deploymentQuery]);

  const visibleRedemptions = useMemo(() => {
    const needle = needleOf(feedQuery);
    if (!needle) return data.recentRedemptions;
    return data.recentRedemptions.filter((row) =>
      matches(
        needle,
        row.source,
        row.destination,
        `0x${row.channelId}`,
        row.network,
        timed ? formatTimestamp(row.timestamp) : String(row.block),
      ),
    );
  }, [data.recentRedemptions, feedQuery, timed]);

  const clientRows = () => [
    ['rank', 'client', 'network', 'redemptions', 'upstream_mb'],
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
    ['block', 'timestamp', 'source', 'destination', 'channel', 'network'],
    ...visibleRedemptions.map((row) => [
      String(row.block),
      row.timestamp,
      row.source,
      row.destination,
      `0x${row.channelId}`,
      row.network,
    ]),
  ];

  // One row per contract, one column per network: the same role deployed twice is
  // a comparison, not two unrelated rows.
  const contractNetworks = useMemo(
    () => [...new Set(data.contracts.map((row) => row.network))],
    [data.contracts],
  );
  const contractRoles = useMemo(
    () => [...new Set(data.contracts.map((row) => row.role))].sort(),
    [data.contracts],
  );

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
    <main id="top">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Gnosis VPN home">
          <Image src="/gnosis-owl.svg" alt="" width={230} height={230} />
        </a>
        <nav aria-label="Dashboard navigation">
          <a href="#usage">Usage</a>
          <a href="#activity">Activity</a>
          <a href="#relayers">Relayers</a>
          <a href="#ticket">Tickets</a>
          <a href="#clients">Clients</a>
          <a href="#methodology">Methodology</a>
        </nav>
        <div className="topbar-end">
          <span className={`freshness ${data.source}`}>
            <i aria-hidden="true" />
            {observedAt(data.observedAt)}
            {data.timebase === 'estimated' && ' · estimated time'}
          </span>
          <StyleSwitch />
          <details className="mobile-nav">
            <summary aria-label="Open dashboard navigation">
              <Menu size={18} aria-hidden="true" />
            </summary>
            <nav aria-label="Dashboard navigation">
              <a href="#usage">Usage</a>
              <a href="#activity">Activity</a>
              <a href="#relayers">Relayers</a>
              <a href="#ticket">Tickets</a>
              <a href="#clients">Clients</a>
              <a href="#methodology">Methodology</a>
            </nav>
          </details>
        </div>
      </header>

      {dashboard.networks.length > 1 && (
        <section className="intro">
          <fieldset className="network-switch">
            <legend className="sr-only">Network</legend>
            <button
              type="button"
              aria-pressed={combined}
              className={combined ? 'active' : ''}
              onClick={() => void selectNetwork(COMBINED)}
            >
              {loadingNetwork === COMBINED ? 'Loading…' : 'All networks'}
            </button>
            {dashboard.networks.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={network === entry.id}
                className={network === entry.id ? 'active' : ''}
                onClick={() => void selectNetwork(entry.id)}
              >
                {loadingNetwork === entry.id ? 'Loading…' : entry.label}
              </button>
            ))}
          </fieldset>
        </section>
      )}

      <section
        id="main-content"
        className="headline-grid tile-grid"
        aria-label="Headline metrics"
      >
        <Tile
          id="monthly-active-users"
          status={panels.usage}
          className="metric mau-card span-3"
          title="MONTHLY ACTIVE USERS"
          figure={count(data.totals.monthlyActiveUsers)}
          note={
            <div className="mau-footer">
              <span>
                {count(data.totals.weeklyActiveUsers)} in the last 7 days
              </span>
              <small>Distinct clients, last 30 days</small>
            </div>
          }
          noteText={`${count(data.totals.weeklyActiveUsers)} in the last 7 days · distinct clients, last 30 days`}
          expanded={enlarged}
          onExpand={setEnlarged}
        />
        <Metric
          id="redemptions-7-days"
          status={panels.usage}
          span={3}
          label="REDEMPTIONS · LAST 30 DAYS"
          figure={count(data.totals.redemptions30d)}
          note={`${count(data.totals.redemptions7d)} in the last 7 days`}
          expanded={enlarged}
          onExpand={setEnlarged}
        />
        <Metric
          id="data-relayed-7-days"
          status={panels.usage}
          span={3}
          label="DATA RELAYED · LAST 30 DAYS"
          figure={volume(
            plus(data.totals.gigabytes30d, data.totals.gigabytesDownstream30d),
          )}
          note={`${volume(plus(data.totals.gigabytes7d, data.totals.gigabytesDownstream7d))} in the last 7 days`}
          expanded={enlarged}
          onExpand={setEnlarged}
        />
        <Metric
          id="new-clients-30-days"
          status={panels.deployments}
          span={3}
          label="NEW CLIENTS · LAST 30 DAYS"
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
            announced an address, so it is not relay infrastructure. Upstream
            volume is derived from the redemptions on client channels, priced at
            the winning probability in force at each block; downstream is
            inferred network-wide, because the exit pays for the return path.
          </p>
        </div>
        <div className="tile-grid">
          <Tile
            id="active-users"
            status={panels.usage}
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
                  Each point counts distinct clients over the last 30 and last 7
                  days.
                </p>
              </>
            }
            expanded={enlarged}
            onExpand={setEnlarged}
            chart={<ActiveUsersChart points={data.activeUsers} />}
          />
          <Tile
            id="volume"
            status={panels.usage}
            className="service-chart span-6"
            eyebrow="PER WEEK"
            title="Data volume"
            legend={volumeLegend}
            note={
              <>
                <Empty when={!data.weeks.length}>
                  No client redemptions have been indexed yet.
                </Empty>
                <p className="chart-note">
                  Upstream is paid for by the client and attributable to it.
                  Downstream is paid for by the exit, whose channels name no
                  client, so it is never attributable to one. All time it runs{' '}
                  {multiple(data.totals.downstreamRatio)} upstream.{' '}
                  {namedExits
                    ? `Measured rather than inferred: the exits are named in configuration, and ${count(data.totals.exitsSeen)} of ${count(data.totals.exitsNamed)} of them were seen paying a relay.`
                    : 'No exits are configured, so they are inferred from relays paid by announced nodes that never relay for a client, less the probe traffic relays pay each other.'}
                </p>
              </>
            }
            expanded={enlarged}
            onExpand={setEnlarged}
            chart={<VolumeChart weeks={data.weeks} />}
          />
        </div>
        <div className="tile-grid">
          <Metric
            id="total-redemptions"
            status={panels.usage}
            span={4}
            label="REDEMPTIONS · ALL TIME"
            figure={count(data.totals.redemptionsTotal)}
            note={`An estimated ${packets(data.totals.ticketsTotal)} packets paid for`}
            expanded={enlarged}
            onExpand={setEnlarged}
          />
          <Metric
            id="total-data-relayed"
            status={panels.usage}
            span={4}
            label="DATA RELAYED · ALL TIME"
            figure={volume(
              plus(
                data.totals.gigabytesTotal,
                data.totals.gigabytesDownstreamTotal,
              ),
            )}
            note={`${volume(data.totals.gigabytesTotal)} upstream · ${volume(data.totals.gigabytesDownstreamTotal)} downstream`}
            expanded={enlarged}
            onExpand={setEnlarged}
          />
          <Metric
            id="active-channels"
            status={panels.balances}
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
            status={panels.usage}
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
            chart={<DailyUsersChart points={data.dailyUsers} />}
          />
          <Tile
            id="retention"
            status={panels.deployments}
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
            status={panels.usage}
            className="service-chart span-4"
            eyebrow="ALL TIME"
            title="When VPN is used"
            badge={
              <fieldset className="tab-switch">
                <legend className="sr-only">Traffic direction</legend>
                <button
                  type="button"
                  aria-pressed={hours === 'upstream'}
                  className={hours === 'upstream' ? 'active' : ''}
                  onClick={() => setHours('upstream')}
                >
                  Upstream
                </button>
                <button
                  type="button"
                  aria-pressed={hours === 'downstream'}
                  className={hours === 'downstream' ? 'active' : ''}
                  onClick={() => setHours('downstream')}
                >
                  Downstream
                </button>
              </fieldset>
            }
            note={
              <>
                <Empty when={!hourGrid.length}>
                  No volume has been indexed yet.
                </Empty>
                <p className="chart-note">
                  Share of {hours} volume by weekday and hour, UTC. Block
                  timestamps are{' '}
                  {data.timebase === 'rpc'
                    ? 'RPC resolved'
                    : 'estimated from block height'}
                  .{' '}
                  {data.heatmapAgreement !== null &&
                    `The two directions agree ${percent(data.heatmapAgreement)}: an answer follows its request within seconds, so one session should shade both grids the same way.`}
                </p>
              </>
            }
            expanded={enlarged}
            onExpand={setEnlarged}
            chart={
              <Heatmap
                grid={hourGrid}
                total={
                  hours === 'upstream'
                    ? data.totals.gigabytesTotal
                    : data.totals.gigabytesDownstreamTotal
                }
                direction={hours}
              />
            }
          />
        </div>
      </section>

      <section className="section" id="relayers">
        <div className="section-heading">
          <div>
            <span className="section-index">03</span>
            <h2>Data volume by relayer</h2>
          </div>
          <p>Estimated client traffic carried by each relay.</p>
        </div>
        <div className="tile-grid">
          <Tile
            id="share"
            status={panels.usage}
            className="service-chart span-4"
            eyebrow="LAST 30 DAYS · UPSTREAM"
            title="Relayer concentration"
            showLegend={false}
            note={
              <>
                <Empty when={!data.relayers.length}>
                  No client data volume was indexed in the last 30 days.
                </Empty>
              </>
            }
            expanded={enlarged}
            onExpand={setEnlarged}
            chart={<RelayerShareChart slices={relayerSlices} />}
          />
          <Tile
            id="relayer-volume"
            status={panels.usage}
            className="service-chart span-8"
            eyebrow="LAST 30 DAYS"
            title="Estimated daily volume per relayer"
            legend={relayerLegend}
            showLegend={false}
            badge={
              <fieldset className="tab-switch">
                <legend className="sr-only">Traffic direction</legend>
                <button
                  type="button"
                  aria-pressed={flow === 'upstream'}
                  className={flow === 'upstream' ? 'active' : ''}
                  onClick={() => setFlow('upstream')}
                >
                  Upstream
                </button>
                <button
                  type="button"
                  aria-pressed={flow === 'downstream'}
                  className={flow === 'downstream' ? 'active' : ''}
                  onClick={() => setFlow('downstream')}
                >
                  Downstream
                </button>
              </fieldset>
            }
            note={
              <>
                <Empty when={!relayerFlow.length}>
                  No client redemptions were indexed in the last 30 days.
                </Empty>
                <p className="chart-note">
                  {flow === 'upstream'
                    ? 'Client traffic, split by the relay each client paid.'
                    : namedExits
                      ? 'The return path, split by the relay each exit paid. No client appears in these channels, so it is a relay breakdown and never a client one.'
                      : 'The return path, split by the relay each exit paid. The exits are inferred rather than configured, and the probe floor is spread across relays in proportion to the probe traffic they already receive.'}
                </p>
              </>
            }
            expanded={enlarged}
            onExpand={setEnlarged}
            chart={
              <RelayerStackChart
                points={relayerFlow}
                series={data.relayerSeries}
                addressOf={addressOfSeries}
              />
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
            status={panels.ticket}
            span={4}
            label="WINNING PROBABILITY"
            figure={probability(data.ticket.winProbability)}
            note="Current network minimum"
            expanded={enlarged}
            onExpand={setEnlarged}
          />
          <Metric
            id="ticket-price"
            status={panels.ticket}
            span={4}
            label="TICKET PRICE"
            figure={token(data.ticket.priceWei)}
            note="Cost of relaying one packet, one hop"
            expanded={enlarged}
            onExpand={setEnlarged}
          />
          <Metric
            id="ticket-value"
            status={panels.ticket}
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
            upstream only — the traffic the client itself paid for — and is
            estimated from the redemptions seen on chain.
          </p>
        </div>
        <div className="tile-grid">
          <Tile
            id="clients-table"
            status={panels.usage}
            className="table-card span-6"
            rows={clientRows}
            rowCount={visibleClients.length}
            search={{
              value: clientQuery,
              onChange: setClientQuery,
              placeholder: 'Search...',
            }}
            eyebrow="UPSTREAM VOLUME PER CLIENT"
            title="Most active users"
            badge={
              <fieldset className="tab-switch">
                <legend className="sr-only">Ranking window</legend>
                <button
                  type="button"
                  aria-pressed={scope === 'weekly'}
                  className={scope === 'weekly' ? 'active' : ''}
                  onClick={() => setScope('weekly')}
                >
                  Last 7 days
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
                    ? 'Most active clients over the last 7 days'
                    : 'Most active clients, all time'}
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
                      upstream (MB)
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
                          <ClientCell
                            address={client.address}
                            network={client.network}
                            known={knownClients.has(client.key)}
                            onOpen={setInspected}
                          />
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
            status={panels.deployments}
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
                          <ClientCell
                            address={deployment.address}
                            network={deployment.network}
                            known={knownClients.has(deployment.key)}
                            onOpen={setInspected}
                          />
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
          <p>
            The latest redemption on each client channel, newest first. Upstream
            only — a downstream redemption is paid by an exit and names no
            client, so it has no row here.
          </p>
        </div>
        <Tile
          id="feed-table"
          status={panels.usage}
          className="table-card span-12"
          rows={feedRows}
          rowCount={visibleRedemptions.length}
          search={{
            value: feedQuery,
            onChange: setFeedQuery,
            placeholder: 'Search...',
          }}
          eyebrow="UPSTREAM REDEMPTIONS PER CHANNEL"
          title="Redemption feed"
          note={
            <>
              <Empty when={!data.recentRedemptions.length}>
                No redemptions have been indexed.
              </Empty>
              <p className="chart-note">
                The most recent {count(data.recentRedemptions.length)} of{' '}
                {count(data.totals.redemptionsTotal)} client redemptions.
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
                  <th scope="col">{timed ? 'timestamp' : 'block'}</th>
                  <th scope="col">source</th>
                  <th scope="col">destination</th>
                  <th scope="col">channel</th>
                </tr>
              </thead>
              <tbody>
                {pageOf(visibleRedemptions, feedAt).map((redemption) => (
                  <tr key={redemption.key}>
                    <td className="timestamp">
                      {timed
                        ? formatTimestamp(redemption.timestamp)
                        : `#${count(redemption.block)}`}
                    </td>
                    <td>
                      <ClientCell
                        address={redemption.source}
                        network={redemption.network}
                        known={knownClients.has(
                          clientKey(redemption.network, redemption.source),
                        )}
                        onOpen={setInspected}
                      />
                    </td>
                    <td>
                      <AddressLink address={redemption.destination} />
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
            <h3>VPN traffic paths</h3>
            <p>
              Client-to-relayer channels are counted directly as upstream
              traffic. The return path, paid by exits to relayers, is shown as
              downstream traffic; it is measured when exits are configured and
              otherwise estimated after excluding relay probe traffic.
            </p>
          </div>
          <div>
            <span>02</span>
            <h3>Redemptions</h3>
            <p>
              Blokli appends a channel state row per on-chain event, and only
              TicketRedeemed advances the ticket index. A row whose index
              advances is a redemption. The jump is not the tickets redeemed: a
              client numbers a ticket for every packet it sends and only winning
              tickets are redeemed, so the gap estimates the packets paid for in
              between.
            </p>
          </div>
          <div>
            <span>03</span>
            <h3>Data volume</h3>
            <p>
              Each redemption accounts for 650 / (2<sup>30</sup> &times; p) GB,
              where p is the winning probability from the oracle&rsquo;s update
              history at that block. Direction follows the payer: a client
              paying a relay is upstream. An announced payer that never relays
              for a client is an exit paying the return path — downstream, less
              the probe traffic relays pay each other, and never attributable to
              a client.
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
        </div>
      </section>

      <ClientDialog
        detail={inspecting}
        pending={inspected !== null && !answered}
        failed={inspectFailed}
        networkLabel={
          dashboard.networks.length > 1 && inspecting
            ? labelOf(inspecting.network)
            : null
        }
        relayerCount={data.relayerSeries.length}
        onClose={() => setInspected(null)}
      />

      <footer>
        <div className="footer-signature">
          <span>GNOSIS VPN × HOPR</span>
          <span className="footer-byline">Data indexed by Blokli</span>
        </div>
        <a
          className="source-link"
          href="https://github.com/hoprnet/blokli"
          target="_blank"
          rel="noreferrer"
        >
          Source <ExternalLink size={13} aria-hidden="true" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
        <a href="#top">Back to top ↑</a>
      </footer>
    </main>
  );
}

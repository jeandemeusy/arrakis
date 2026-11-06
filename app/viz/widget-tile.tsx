'use client';

import type { Encoding, Options, VisualizationConfig, VisualizationType } from '@/lib/viz/config';
import { asText } from '@/lib/viz/text';

import { Tile, type Freshness, type PanelStatus } from '../tile';
import { ago } from '../(studio)/time';
import { WhyValue } from './why-value';
import {
  Missing,
  VisualizationBody,
  numberFigure,
  type Column,
} from './visualization';

/**
 * A visualization in the dashboard's own tile: the same header, enlarge and
 * download controls, failure and partial flags as every panel on the page.
 */

export type WidgetPayload =
  | {
      state: 'ok';
      data: {
        queryVersion?: number | null;
        columns: Column[];
        rows: unknown[][];
        truncated: boolean;
        pending: boolean;
        networks: Array<{
          id: string;
          status: 'ready' | 'pending' | 'failed';
          stale: boolean;
          finishedAt: string | null;
          lastAttempt: { status: string; error: string | null } | null;
        }>;
      };
    }
  | { state: 'error'; error: { status: number; message: string } }
  | { state: 'loading' };

export type ChartSpec = {
  type: VisualizationType;
  encoding: Encoding;
  options: Options;
};

function statusOf(payload: WidgetPayload): PanelStatus | undefined {
  if (payload.state === 'error')
    return { state: 'failed', reason: payload.error.message };
  if (payload.state !== 'ok') return undefined;
  const { networks } = payload.data;
  const missing = networks.filter((network) => network.status !== 'ready');
  if (payload.data.pending) {
    const failure = networks.find((network) => network.lastAttempt?.error)
      ?.lastAttempt?.error;
    return {
      state: failure ? 'failed' : 'pending',
      reason:
        failure ?? 'No saved result yet. Run the query to load data.',
    };
  }
  if (missing.length) {
    return {
      state: 'partial',
      reason: `No data from ${missing.map((network) => network.id).join(', ')}.`,
    };
  }
  return undefined;
}

const WHEN = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** How fresh the stored result behind a tile is: its newest run, and whether it is behind. */
function freshnessOf(payload: WidgetPayload): Freshness | undefined {
  if (payload.state !== 'ok') return undefined;
  const { networks } = payload.data;
  const finished = networks
    .map((network) => network.finishedAt)
    .filter((at): at is string => Boolean(at))
    .sort()
    .at(-1);
  if (!finished) return undefined;
  const failed = networks.some(
    (network) => network.lastAttempt?.status === 'failed',
  );
  const stale = networks.some((network) => network.stale);
  const at = WHEN.format(new Date(finished));
  return {
    state: failed ? 'failed' : stale ? 'stale' : 'fresh',
    label: `${failed ? 'Failed · ' : stale ? 'Stale · ' : ''}${ago(finished)}`,
    title: failed
      ? `The last run failed; showing the result from ${at}`
      : stale
        ? `Stored ${at}; its query changed since, and it reruns shortly`
        : `Stored ${at}`,
  };
}

/** The chart as an element Tile can clone at a larger height when enlarged. */
function Chart({
  spec,
  columns,
  rows,
  height = 260,
  onSelect,
}: {
  spec: ChartSpec;
  columns: Column[];
  rows: unknown[][];
  height?: number;
  onSelect?: (row: Record<string, unknown>) => void;
}) {
  return (
    <VisualizationBody
      type={spec.type}
      encoding={spec.encoding}
      options={spec.options}
      columns={columns}
      rows={rows}
      height={height}
      onSelect={onSelect}
    />
  );
}

export function WidgetTile({
  id,
  title,
  spec,
  payload,
  width,
  height,
  note,
  expanded,
  onExpand,
  onSelect,
  source,
  subtitle,
  busy,
  detailVars,
  detailConfig,
  detailChart,
  detailNetwork,
  detailSources,
}: {
  id: string;
  title: string;
  source?: { href: string; label: string; resultsHref?: string };
  /** The query it is drawn from, shown muted after the title. */
  subtitle?: string;
  /**
   * `running`: its query is being run right now; `updating`: its chart is
   * being recomputed for new variables. Either shows in place of its age.
   */
  busy?: 'running' | 'updating';
  detailVars?: Record<string, string | undefined>;
  detailConfig?: VisualizationConfig;
  detailChart?: { id: string; updatedAt: string };
  detailNetwork?: string;
  detailSources?: string;
  spec: ChartSpec;
  payload: WidgetPayload;
  width: number;
  height: number;
  note?: string;
  expanded: string | null;
  onExpand: (id: string | null) => void;
  onSelect?: (row: Record<string, unknown>) => void;
}) {
  const status = statusOf(payload);
  const data = payload.state === 'ok' ? payload.data : null;
  const columns = data?.columns ?? [];
  const rows = data?.rows ?? [];
  const details = <WhyValue data={data} title={title} query={subtitle} source={source} vars={detailVars ?? {}} config={detailConfig} chart={spec.type === 'number' ? detailChart : undefined} network={detailNetwork} sources={detailSources} busy={busy} />;
  const csv = data
    ? () => [
        columns.map((column) => column.name),
        ...rows.map((row) => row.map(asText)),
      ]
    : undefined;
  // Its own last run can say it is running too, before the page next asks.
  const running =
    busy === 'running' ||
    (payload.state === 'ok' &&
      payload.data.networks.some(
        (network) => network.lastAttempt?.status === 'running',
      ));
  const className = `span-${width}${busy === 'updating' ? ' is-updating' : ''}`;
  const freshness: Freshness | undefined = running
    ? {
        state: 'running',
        label: 'Running…',
        title: 'Its query is being run now; the chart redraws when it is done',
      }
    : busy === 'updating'
      ? {
          state: 'updating',
          label: 'Updating…',
          title: 'Recomputing this chart for the new selection',
        }
      : freshnessOf(payload);

  if (spec.type === 'number') {
    const { figure, note: derived } = numberFigure(
      spec.encoding,
      spec.options,
      columns,
      rows,
    );
    const text = [data && !rows.length ? 'No matching data. Try another filter or range.' : derived, note].filter(Boolean).join(' · ');
    return (
      <Tile
        id={id}
        className={`metric ${className}`}
        title={title}
        status={status}
        figure={payload.state === 'loading' ? '…' : figure}
        note={text ? <p>{text}</p> : undefined}
        noteText={text}
        rows={csv}
        source={source}
        details={details}
        subtitle={subtitle}
        freshness={freshness}
        menu
        expanded={expanded}
        onExpand={onExpand}
      />
    );
  }

  const body =
    payload.state === 'loading' ? (
      <Missing message="Loading…" height={height} />
    ) : data && !rows.length ? (
      <Missing message="No matching data. Try another filter or range." height={height} />
    ) : (
      <Chart
        spec={spec}
        columns={columns}
        rows={rows}
        height={height}
        onSelect={onSelect}
      />
    );
  const isTable = spec.type === 'table';
  return (
    <Tile
      id={id}
      className={`${isTable ? 'table-card' : 'service-chart'} ${className}`}
      title={title}
      status={status}
      chart={isTable ? undefined : body}
      rows={csv}
      rowCount={isTable ? rows.length : undefined}
      note={note ? <p className="tile-note">{note}</p> : undefined}
      source={source}
      details={details}
      subtitle={subtitle}
      freshness={freshness}
      menu
      expanded={expanded}
      onExpand={onExpand}
    >
      {isTable ? body : undefined}
    </Tile>
  );
}

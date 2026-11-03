'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import {
  Area,
  Bar,
  Brush,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type {
  AxisOptions,
  Encoding,
  Options,
  SeriesMark,
  VisualizationType,
} from '@/lib/viz/config';

import { heatColor } from '../chart-theme';
import { usePalette } from '../style';
import {
  formatCategory,
  formatTableText,
  formatValue,
  toNumber,
} from './format';
import { pivot, shareSeries, type DrawnSeries } from './series';
import './viz.css';
import { asText } from '@/lib/viz/text';

/**
 * Draws a visualization's rows as its chart type.
 *
 * Rows come from the server already shaped by the visualization's steps; this
 * only maps columns to marks, as `encoding` says. Colours, rules and type all
 * come from the active palette, so a chart here looks like the dashboard's own
 * charts in either visual style.
 */

export type Column = { name: string; type: string };

export type VisualizationProps = {
  type: VisualizationType;
  encoding: Encoding;
  options: Options;
  columns: Column[];
  rows: unknown[][];
  height: number;
  /** Clicked row, for click-through; undefined when the chart is not linked. */
  onSelect?: (row: Record<string, unknown>) => void;
};

function index(columns: Column[], name: string | undefined): number {
  return name ? columns.findIndex((column) => column.name === name) : -1;
}

export function Missing({
  message,
  height,
}: {
  message: string;
  height: number;
}) {
  return (
    <div className="viz-missing" style={{ minHeight: Math.min(height, 160) }}>
      <p>{message}</p>
    </div>
  );
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Tooltip rows beyond this are summed into one "and N more" line. */
const TOOLTIP_ROWS = 12;

type TipEntry = { dataKey?: unknown; value?: unknown };

function ChartTooltip({
  active,
  payload,
  label,
  series,
  xType,
  formatOf,
  total,
  percent,
}: {
  active?: boolean;
  payload?: TipEntry[];
  label?: unknown;
  series: DrawnSeries[];
  xType?: string;
  formatOf: (entry: DrawnSeries) => Options['format'];
  total: boolean;
  percent: boolean;
}) {
  const palette = usePalette();
  if (!active || !payload?.length) return null;
  const byKey = new Map(series.map((entry) => [entry.dataKey, entry]));
  const rows = payload
    .map((item) => ({
      entry: byKey.get(String(item.dataKey)),
      value: toNumber(item.value),
    }))
    .filter(
      (row): row is { entry: DrawnSeries; value: number } =>
        row.entry !== undefined && row.value !== null,
    );
  // With many series the largest matter: list them first.
  if (rows.length > TOOLTIP_ROWS) rows.sort((a, b) => b.value - a.value);
  const shown = rows.slice(0, TOOLTIP_ROWS);
  const rest = rows.slice(TOOLTIP_ROWS);
  const sum = rows.reduce((acc, row) => acc + row.value, 0);
  const format = (entry: DrawnSeries | undefined, value: number) =>
    percent
      ? formatValue(value, 'percent')
      : formatValue(value, entry ? formatOf(entry) : undefined);
  return (
    <div className="viz-tip" style={palette.tooltip}>
      <p className="viz-tip-label">{formatCategory(label, xType)}</p>
      <ul>
        {shown.map(({ entry, value }) => (
          <li key={entry.dataKey}>
            <i style={{ background: entry.color }} />
            <span>{entry.label}</span>
            <b>{format(entry, value)}</b>
          </li>
        ))}
        {rest.length > 0 && (
          <li className="viz-tip-more">
            <i />
            <span>and {rest.length} more</span>
            <b>
              {format(
                rest[0].entry,
                rest.reduce((acc, row) => acc + row.value, 0),
              )}
            </b>
          </li>
        )}
        {total && rows.length > 1 && (
          <li className="viz-tip-total">
            <i />
            <span>Total</span>
            <b>{format(rows[0].entry, sum)}</b>
          </li>
        )}
      </ul>
    </div>
  );
}

/** The legend: every series, click one to hide or show it, or all at once. */
function Legend({
  series,
  off,
  onToggle,
  onAll,
}: {
  series: DrawnSeries[];
  off: Set<string>;
  onToggle: (key: string) => void;
  onAll: () => void;
}) {
  const allOn = series.every((entry) => !off.has(entry.key));
  return (
    <ul className="viz-legend" aria-label="Series; scroll for more">
      {series.length > 5 && (
        <li className="viz-legend-info">
          {series.length} series · scroll for more
        </li>
      )}
      {series.length > 2 && (
        <li>
          <button type="button" aria-pressed={allOn} onClick={onAll}>
            <i className="all" />
            <span>All</span>
          </button>
        </li>
      )}
      {series.map((entry) => (
        <li key={entry.key}>
          <button
            type="button"
            aria-pressed={!off.has(entry.key)}
            title={entry.label}
            onClick={() => onToggle(entry.key)}
          >
            <i style={{ background: entry.color }} />
            <span>{entry.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function axisLabel(
  title: string | undefined,
  side: 'left' | 'right' | 'bottom',
  palette: ReturnType<typeof usePalette>,
) {
  if (!title) return undefined;
  return side === 'bottom'
    ? {
        value: title,
        position: 'insideBottom' as const,
        offset: -2,
        fill: palette.axis.fill,
        fontSize: 11,
      }
    : {
        value: title,
        angle: side === 'left' ? -90 : 90,
        position:
          side === 'left' ? ('insideLeft' as const) : ('insideRight' as const),
        style: { textAnchor: 'middle' as const },
        fill: palette.axis.fill,
        fontSize: 11,
      };
}

function domainOf(axis: AxisOptions | undefined, percent: boolean) {
  if (percent) return [0, 1] as [number, number];
  const low = axis?.min ?? (axis?.log || axis?.zero === false ? 'auto' : 0);
  const high = axis?.max ?? 'auto';
  return [low, high] as [number | 'auto', number | 'auto'];
}

const Cartesian = memo(function Cartesian({
  type,
  encoding,
  options,
  columns,
  rows,
  height,
  onSelect,
}: VisualizationProps) {
  const palette = usePalette();
  const fallback = (
    type === 'line' || type === 'area' ? type : 'bar'
  ) as SeriesMark;
  const shaped = useMemo(
    () => pivot(columns, rows, encoding, options, palette, fallback),
    [columns, rows, encoding, options, palette, fallback],
  );
  // Series switched off from the legend: this view only, never saved.
  const [off, setOff] = useState<Set<string>>(() => new Set());
  const pivoted = typeof shaped === 'string' ? null : shaped;
  const series = useMemo(() => pivoted?.series ?? [], [pivoted]);
  const drawn = useMemo(
    () => series.filter((entry) => !entry.hidden && !off.has(entry.key)),
    [series, off],
  );
  const percent = Boolean(options.normalize);
  const log = (side: 'left' | 'right') =>
    !percent &&
    Boolean((side === 'left' ? options.yAxis : options.rightAxis)?.log);
  const data = useMemoData(
    pivoted?.data ?? NO_POINTS,
    drawn,
    percent,
    log('left'),
    log('right'),
  );
  if (typeof shaped === 'string')
    return <Missing message={shaped} height={height} />;
  const { xType } = shaped;
  const stacked = Boolean(options.stacked) || percent;
  const rightUsed = drawn.some((entry) => entry.axis === 'right');

  const xAt = index(columns, encoding.x);
  const select = onSelect
    ? (point: { payload?: Record<string, unknown> } | undefined) => {
        if (!point?.payload) return;
        const x = point.payload.x;
        const row = rows.find((candidate) => candidate[xAt] === x);
        if (row)
          onSelect(
            Object.fromEntries(
              columns.map((column, at) => [column.name, row[at]]),
            ),
          );
      }
    : undefined;

  const tickFormat = (side: 'left' | 'right') => {
    if (percent && side === 'left') return 'percent' as const;
    const axis = side === 'left' ? options.yAxis : options.rightAxis;
    if (axis?.format) return axis.format;
    return options.format === 'gigabytes' || options.format === 'percent'
      ? options.format
      : 'compact';
  };
  const formatOf = (entry: DrawnSeries) =>
    (entry.axis === 'right' ? options.rightAxis?.format : undefined) ??
    options.format;
  const legendShown =
    options.legend ?? series.filter((entry) => !entry.hidden).length > 1;
  const margin = {
    top: 16,
    right: rightUsed ? 4 : 12,
    left: options.yAxis?.title ? 8 : 0,
    bottom: options.xAxis?.title ? 14 : 0,
  };
  const yAxis = (side: 'left' | 'right') => {
    const axis = side === 'left' ? options.yAxis : options.rightAxis;
    return (
      <YAxis
        yAxisId={side}
        orientation={side}
        axisLine={false}
        tickLine={false}
        tick={palette.axis}
        width={axis?.title ? 76 : 64}
        scale={log(side) ? 'log' : 'auto'}
        domain={domainOf(axis, percent && side === 'left')}
        allowDataOverflow={axis?.min !== undefined || axis?.max !== undefined}
        label={axisLabel(axis?.title, side, palette)}
        tickFormatter={(value: number) => formatValue(value, tickFormat(side))}
      />
    );
  };
  const valueLabel = (entry: DrawnSeries) =>
    options.dataLabels ? (
      <LabelList
        dataKey={entry.dataKey}
        position={entry.mark === 'bar' && stacked ? 'inside' : 'top'}
        fontSize={10}
        fill={palette.axis.fill}
        formatter={(value: unknown) =>
          percent
            ? formatValue(value, 'percent')
            : formatValue(value, 'compact')
        }
      />
    ) : null;

  const chart = (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart
        data={data}
        margin={margin}
        onClick={select ? (state) => select(state as never) : undefined}
      >
        <CartesianGrid
          vertical={false}
          yAxisId="left"
          stroke={palette.grid}
          strokeDasharray={palette.gridDash ?? '2 5'}
        />
        <XAxis
          dataKey="x"
          axisLine={false}
          tickLine={false}
          tick={palette.axis}
          minTickGap={32}
          reversed={Boolean(options.xAxis?.reverse)}
          label={axisLabel(options.xAxis?.title, 'bottom', palette)}
          tickFormatter={(value: unknown) => formatCategory(value, xType)}
        />
        {yAxis('left')}
        {rightUsed && yAxis('right')}
        <Tooltip
          cursor={palette.cursor}
          content={
            <ChartTooltip
              series={drawn}
              xType={xType}
              formatOf={formatOf}
              total={Boolean(options.tooltipTotal)}
              percent={percent}
            />
          }
        />
        {drawn.map((entry) => {
          const common = {
            dataKey: entry.dataKey,
            name: entry.dataKey,
            yAxisId: entry.axis,
            isAnimationActive: false,
          };
          if (entry.mark === 'bar')
            return (
              <Bar
                key={entry.key}
                {...common}
                stackId={stacked ? `bar-${entry.axis}` : undefined}
                fill={entry.color}
                stroke={palette.barStroke}
                strokeWidth={palette.barStrokeWidth}
                radius={stacked ? 0 : palette.barRadius}
                cursor={select ? 'pointer' : undefined}
                onClick={select ? (point) => select(point as never) : undefined}
              >
                {valueLabel(entry)}
              </Bar>
            );
          if (entry.mark === 'area')
            return (
              <Area
                key={entry.key}
                {...common}
                stackId={stacked ? `area-${entry.axis}` : undefined}
                type={options.step ? 'stepAfter' : 'monotone'}
                stroke={entry.color}
                fill={entry.color}
                fillOpacity={palette.areaOpacity}
                strokeWidth={palette.lineWidth}
                dot={false}
              >
                {valueLabel(entry)}
              </Area>
            );
          return (
            <Line
              key={entry.key}
              {...common}
              type={options.step ? 'stepAfter' : 'monotone'}
              stroke={entry.color}
              strokeWidth={palette.lineWidth}
              dot={false}
              connectNulls
            >
              {valueLabel(entry)}
            </Line>
          );
        })}
        {options.xAxis?.brush && data.length > 2 && (
          <Brush
            dataKey="x"
            height={22}
            travellerWidth={8}
            stroke={palette.muted}
            fill={palette.surface}
            tickFormatter={(value: unknown) => formatCategory(value, xType)}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );

  if (!legendShown) return chart;
  const shownSeries = series.filter((entry) => !entry.hidden);
  return (
    <div
      className={`viz-cartesian legend-${options.legendPosition ?? 'auto'}`}
      style={{ '--viz-height': `${height}px` } as React.CSSProperties}
    >
      <div className="viz-cartesian-body">
        <div className="viz-plot">{chart}</div>
        <Legend
          series={shownSeries}
          off={off}
          onToggle={(key) => {
            const next = new Set(off);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            setOff(next);
          }}
          onAll={() =>
            setOff(
              shownSeries.every((entry) => !off.has(entry.key))
                ? new Set(shownSeries.map((entry) => entry.key))
                : new Set(),
            )
          }
        />
      </div>
    </div>
  );
});

const NO_POINTS: Array<Record<string, unknown>> = [];

/**
 * The points as drawn: shares of each point's total when normalized, and no
 * zeros or negatives on a log scale (which has no place for them).
 */
function useMemoData(
  data: Array<Record<string, unknown>>,
  drawn: DrawnSeries[],
  percent: boolean,
  logLeft: boolean,
  logRight: boolean,
) {
  return useMemo(() => {
    if (!percent && !logLeft && !logRight) return data;
    return data.map((point) => {
      const out: Record<string, unknown> = { ...point };
      if (percent) {
        const left = drawn.filter((entry) => entry.axis === 'left');
        const sum = left.reduce(
          (acc, entry) => acc + Math.abs(toNumber(point[entry.dataKey]) ?? 0),
          0,
        );
        for (const entry of left) {
          const value = toNumber(point[entry.dataKey]);
          out[entry.dataKey] = value === null || sum === 0 ? null : value / sum;
        }
      }
      for (const entry of drawn) {
        const log = entry.axis === 'left' ? logLeft : logRight;
        if (!log) continue;
        const value = toNumber(out[entry.dataKey]);
        if (value !== null && value <= 0) out[entry.dataKey] = null;
      }
      return out;
    });
  }, [data, drawn, percent, logLeft, logRight]);
}

/** Each label's share of the total, as horizontal bars, largest first. */
function Share({
  encoding,
  options,
  columns,
  rows,
  height,
  onSelect,
}: VisualizationProps) {
  const palette = usePalette();
  const xAt = index(columns, encoding.x);
  const yAt = index(columns, encoding.y?.[0] ?? encoding.value);
  if (xAt < 0 || yAt < 0) {
    return (
      <Missing
        message="Choose a label column (x) and a value column (y)."
        height={height}
      />
    );
  }
  // Labels are series here: they take the same colours, names and hiding.
  const styles = new Map(
    shareSeries(columns, rows, encoding, options, palette).map((entry) => [
      entry.key,
      entry,
    ]),
  );
  const entries = rows
    .map((row) => ({
      row,
      label: row[xAt],
      value: toNumber(row[yAt]) ?? 0,
      style: styles.get(asText(row[xAt] ?? 'null'))!,
    }))
    .sort((a, b) => b.value - a.value)
    .filter((entry) => entry.style && !entry.style.hidden);
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  return (
    <ol className="viz-share" style={{ maxHeight: height }}>
      {entries.map((entry) => {
        const share = total > 0 ? entry.value / total : 0;
        const content = (
          <>
            <span
              className="viz-share-label"
              title={String(entry.label as string)}
            >
              {entry.style.label}
            </span>
            <span className="viz-share-bar">
              <i
                style={{
                  width: `${Math.max(share * 100, 0.5)}%`,
                  background: entry.style.color,
                }}
              />
            </span>
            <span className="viz-share-value">
              {formatValue(share, 'percent')}
              <small>{formatValue(entry.value, options.format)}</small>
            </span>
          </>
        );
        return (
          <li key={String(entry.label as string)}>
            {onSelect ? (
              <button
                type="button"
                onClick={() =>
                  onSelect(
                    Object.fromEntries(
                      columns.map((column, i) => [column.name, entry.row[i]]),
                    ),
                  )
                }
              >
                {content}
              </button>
            ) : (
              content
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Slices past this are folded into one, so a pie stays readable. */
const PIE_SLICES = 10;

type Slice = {
  key: string;
  label: string;
  value: number;
  color: string;
  /** The row it came from, for click-through; none for the folded rest. */
  row: unknown[] | null;
};

/**
 * Each label's share of the total as a pie, or a ring with the total in its
 * middle. Labels are series, as in a share chart: they take the same names,
 * colours and hiding, and the legend hides one for the moment.
 */
function PieView({
  encoding,
  options,
  columns,
  rows,
  height,
  onSelect,
}: VisualizationProps) {
  const palette = usePalette();
  const [off, setOff] = useState<Set<string>>(() => new Set());
  const xAt = index(columns, encoding.x);
  const yAt = index(columns, encoding.y?.[0] ?? encoding.value);
  if (xAt < 0 || yAt < 0) {
    return (
      <Missing
        message="Choose a label column (x) and a value column (y)."
        height={height}
      />
    );
  }
  const styles = new Map(
    shareSeries(columns, rows, encoding, options, palette).map((entry) => [
      entry.key,
      entry,
    ]),
  );
  const byKey = new Map<string, Slice>();
  for (const row of rows) {
    const key = asText(row[xAt] ?? 'null');
    const style = styles.get(key);
    if (!style || style.hidden) continue;
    const value = toNumber(row[yAt]) ?? 0;
    const known = byKey.get(key);
    if (known) known.value += value;
    else
      byKey.set(key, {
        key,
        label: style.label,
        value,
        // Picked or stable colours stand; the rest are dealt below.
        color: style.picked || options.stableColors ? style.color : '',
        row,
      });
  }
  let slices = [...byKey.values()]
    .filter((slice) => slice.value > 0)
    .sort((a, b) => b.value - a.value);
  // Few slices, each its own colour: the style's distinct swatches in turn,
  // rather than a ramp spread over every label the result has.
  slices.forEach((slice, at) => {
    slice.color ||= palette.categorical[at % palette.categorical.length];
  });
  if (slices.length > PIE_SLICES) {
    const rest = slices.slice(PIE_SLICES - 1);
    slices = [
      ...slices.slice(0, PIE_SLICES - 1),
      {
        key: '\u0000others',
        label: `${rest.length} others`,
        value: rest.reduce((sum, slice) => sum + slice.value, 0),
        color: palette.seriesNeutral,
        row: null,
      },
    ];
  }
  if (!slices.length)
    return <Missing message="Nothing to share out." height={height} />;
  const shown = slices.filter((slice) => !off.has(slice.key));
  const total = shown.reduce((sum, slice) => sum + slice.value, 0);
  const share = (value: number) =>
    formatValue(total > 0 ? value / total : 0, 'percent');
  const donut = Boolean(options.donut);
  const labels = Boolean(options.dataLabels);
  const select = (slice: Slice | undefined) => {
    if (!onSelect || !slice?.row) return;
    const row = slice.row;
    onSelect(
      Object.fromEntries(columns.map((column, i) => [column.name, row[i]])),
    );
  };

  const chart = (
    <div className="viz-pie" style={{ height }}>
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie
            // Each slice carries its own fill.
            data={shown.map((slice) => ({ ...slice, fill: slice.color }))}
            className={onSelect ? 'viz-pie-linked' : undefined}
            dataKey="value"
            nameKey="label"
            innerRadius={donut ? '60%' : 0}
            outerRadius={labels ? '76%' : '90%'}
            paddingAngle={donut && shown.length > 1 ? 1.5 : 0}
            stroke={palette.barStroke ?? palette.surface}
            strokeWidth={palette.barStroke ? palette.barStrokeWidth : 1}
            isAnimationActive={false}
            labelLine={false}
            label={
              labels
                ? (props: {
                    cx: number;
                    cy: number;
                    midAngle?: number;
                    outerRadius: number;
                    percent?: number;
                  }) => {
                    const percent = props.percent ?? 0;
                    if (percent < 0.03) return null;
                    const angle = (-(props.midAngle ?? 0) * Math.PI) / 180;
                    const radius = props.outerRadius + 14;
                    const x = props.cx + radius * Math.cos(angle);
                    const y = props.cy + radius * Math.sin(angle);
                    return (
                      <text
                        x={x}
                        y={y}
                        fill={palette.axis.fill}
                        fontSize={11}
                        fontWeight={palette.axis.fontWeight}
                        textAnchor={x > props.cx ? 'start' : 'end'}
                        dominantBaseline="central"
                      >
                        {formatValue(percent, 'percent')}
                      </text>
                    );
                  }
                : false
            }
            onClick={(_, at) => select(shown[at])}
          />
          <Tooltip
            content={({ active, payload }) => {
              const slice = active
                ? (payload?.[0]?.payload as Slice | undefined)
                : undefined;
              if (!slice) return null;
              return (
                <div className="viz-tip" style={palette.tooltip}>
                  <ul>
                    <li>
                      <i style={{ background: slice.color }} />
                      <span>{slice.label}</span>
                      <b>{formatValue(slice.value, options.format)}</b>
                    </li>
                    <li className="viz-tip-total">
                      <i />
                      <span>Share</span>
                      <b>{share(slice.value)}</b>
                    </li>
                  </ul>
                </div>
              );
            }}
          />
        </PieChart>
      </ResponsiveContainer>
      {donut && (
        <div className="viz-pie-centre" aria-hidden="true">
          <strong>{formatValue(total, options.format ?? 'compact')}</strong>
          <span>total</span>
        </div>
      )}
    </div>
  );

  if (slices.length < 2) return chart;
  return (
    <div
      className={`viz-cartesian legend-${options.legendPosition ?? 'auto'}`}
      style={{ '--viz-height': `${height}px` } as React.CSSProperties}
    >
      <div className="viz-cartesian-body">
        <div className="viz-plot">{chart}</div>
        <ul
          className="viz-legend viz-pie-legend"
          aria-label="Slices; scroll for more"
        >
          {slices.length > 5 && (
            <li className="viz-legend-info">
              {slices.length} slices · scroll for more
            </li>
          )}
          {slices.map((slice) => (
            <li key={slice.key}>
              <button
                type="button"
                aria-pressed={!off.has(slice.key)}
                title={slice.label}
                onClick={() => {
                  const next = new Set(off);
                  if (next.has(slice.key)) next.delete(slice.key);
                  else next.add(slice.key);
                  setOff(next);
                }}
              >
                <i style={{ background: slice.color }} />
                <span>{slice.label}</span>
                {!off.has(slice.key) && <small>{share(slice.value)}</small>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

type Hover = { x: number; y: number; label: string; value: string };

/** A shaded grid: rows × columns, darker where the value is larger. */
function Grid({
  encoding,
  options,
  columns,
  rows,
  height,
  cohort,
}: VisualizationProps & { cohort: boolean }) {
  const palette = usePalette();
  const frame = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const xAt = index(columns, encoding.x);
  const rowAt = index(columns, encoding.row);
  const valueAt = index(columns, encoding.value ?? encoding.y?.[0]);
  if (xAt < 0 || rowAt < 0 || valueAt < 0) {
    return (
      <Missing
        message={`Choose ${cohort ? 'a cohort (row), an offset (x)' : 'a row and a column (x)'} and a value.`}
        height={height}
      />
    );
  }
  const sortKey = (value: unknown) =>
    toNumber(value) ?? String(value as string);
  const order = (values: unknown[]) =>
    [...new Set(values.map((value) => String(value as string)))].sort(
      (a, b) => {
        const left = sortKey(a);
        const right = sortKey(b);
        return typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left).localeCompare(String(right));
      },
    );
  // An hour-of-week grid shows every hour and every weekday, not just the
  // ones that happened to have rows.
  const hours =
    /hour/i.test(encoding.x ?? '') &&
    rows.every((row) => /^\d{1,2}$/.test(asText(row[xAt])));
  const xs = hours
    ? Array.from({ length: 24 }, (_, hour) => String(hour))
    : order(rows.map((row) => row[xAt]));
  const weekdayRows =
    /week|dow|weekday/i.test(encoding.row ?? '') &&
    rows.every((row) => /^[1-7]$/.test(asText(row[rowAt])));
  const ys = weekdayRows
    ? ['1', '2', '3', '4', '5', '6', '7']
    : order(rows.map((row) => row[rowAt]));
  const cells = new Map<string, number>();
  for (const row of rows) {
    cells.set(
      `${String(row[rowAt] as string)}|${String(row[xAt] as string)}`,
      toNumber(row[valueAt]) ?? 0,
    );
  }
  const peak = Math.max(0, ...cells.values());
  const weekdays = weekdayRows;
  const rowLabel = (y: string) =>
    weekdays ? WEEKDAYS[Number(y) - 1] : formatCategory(y, columns[rowAt].type);
  // Cohort labels are often dates (or other long bucket names). The previous
  // fixed gutter only left room for a short label, so SVG clipped the beginning
  // of longer cohorts. Reserve space from the actual labels, with a cap so one
  // unusual value cannot squeeze the grid out of view.
  const longestRowLabel = Math.max(...ys.map((y) => rowLabel(y).length));
  const left = cohort
    ? Math.min(180, Math.max(74, longestRowLabel * 7 + 16))
    : 40;
  const top = 18;
  const cell = 22;
  const gap = 2;
  const width = left + xs.length * cell;
  const full = top + ys.length * cell + 4;
  const labelEvery = Math.max(1, Math.ceil(xs.length / 12));

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
        style={{ display: 'block', margin: '0 auto', maxWidth: width * 2 }}
        preserveAspectRatio="xMidYMid meet"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an <svg> cannot be an <img>
        role="img"
        aria-label={`${encoding.value ?? 'value'} by ${encoding.row} and ${encoding.x}`}
      >
        {xs.map((x, at) =>
          at % labelEvery === 0 ? (
            <text
              key={x}
              x={left + at * cell + (cell - gap) / 2}
              y={top - 6}
              textAnchor="middle"
              fontSize="9"
              fill={palette.axis.fill}
              fontWeight={palette.axis.fontWeight}
            >
              {formatCategory(x, columns[xAt].type)}
            </text>
          ) : null,
        )}
        {ys.map((y, rowIndex) => (
          <g key={y}>
            <text
              x={left - 8}
              y={top + rowIndex * cell + (cell - gap) / 2}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize="10"
              fill={palette.axis.fill}
              fontWeight={palette.axis.fontWeight}
            >
              {rowLabel(y)}
            </text>
            {xs.map((x, at) => {
              const value = cells.get(`${y}|${x}`);
              if (value === undefined && cohort) return null;
              const intensity = cohort
                ? Math.min(1, value ?? 0)
                : peak > 0
                  ? (value ?? 0) / peak
                  : 0;
              return (
                <rect
                  key={x}
                  x={left + at * cell}
                  y={top + rowIndex * cell}
                  width={cell - gap}
                  height={cell - gap}
                  fill={heatColor(palette, intensity)}
                  onMouseMove={(event) => {
                    const box = frame.current?.getBoundingClientRect();
                    if (!box) return;
                    setHover({
                      x: event.clientX - box.left,
                      y: event.clientY - box.top,
                      label: `${rowLabel(y)} · ${formatCategory(x, columns[xAt].type)}`,
                      value: formatValue(
                        value ?? 0,
                        options.format ?? (cohort ? 'percent' : 'number'),
                      ),
                    });
                  }}
                />
              );
            })}
          </g>
        ))}
      </svg>
      {hover && (
        <div className="chart-tip" style={{ left: hover.x, top: hover.y }}>
          <p className="chart-tip-label">{hover.label}</p>
          <p style={{ color: palette.accent2 }}>{hover.value}</p>
        </div>
      )}
    </div>
  );
}

function Table({
  options,
  columns,
  rows,
  height,
  onSelect,
}: VisualizationProps) {
  const [page, setPage] = useState(0);
  const [overflow, setOverflow] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [capacity, setCapacity] = useState<number | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const shown = options.columns?.length
    ? options.columns
        .map((name) => ({ name, at: index(columns, name) }))
        .filter((entry) => entry.at >= 0)
    : columns.map((column, at) => ({ name: column.name, at }));
  const size = Math.max(
    1,
    Math.min(
      options.pageSize ?? 100,
      capacity ?? Math.floor((height - 100) / 30),
    ),
  );
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(page, pages - 1);
  const numeric = (at: number) =>
    ['integer', 'bigint', 'float', 'numeric'].includes(columns[at].type);
  useEffect(() => {
    const node = tableRef.current;
    if (!node) return;
    const measure = () => {
      setOverflow(node.scrollWidth > node.clientWidth + 1);
      const rowHeight = node
        .querySelector('tbody tr')
        ?.getBoundingClientRect().height;
      if (!rowHeight) return;
      const header =
        node.querySelector('thead')?.getBoundingClientRect().height ?? 0;
      const hint =
        node.querySelector('.viz-table-scroll-hint')?.getBoundingClientRect()
          .height ?? 0;
      const pager =
        node.querySelector('.viz-table-pager')?.getBoundingClientRect()
          .height ?? 28;
      setCapacity(
        Math.max(
          1,
          Math.floor((height - header - hint - pager - 4) / rowHeight),
        ),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.querySelector('table'))
      observer.observe(node.querySelector('table')!);
    measure();
    return () => observer.disconnect();
  }, [columns, rows, current, size, height, overflow]);
  return (
    <div
      className={`viz-table${overflow ? ' has-horizontal-overflow' : ''}`}
      ref={tableRef}
      style={{ maxHeight: height }}
    >
      {overflow && (
        <div className="viz-table-scroll-hint">
          Scroll horizontally to see all columns →
        </div>
      )}
      <table>
        <thead>
          <tr>
            {shown.map((entry) => {
              const display = options.tableColumns?.[entry.name];
              const align =
                display?.align ?? (numeric(entry.at) ? 'right' : 'left');
              const size = display?.width
                ? { width: display.width, minWidth: display.width }
                : undefined;
              return (
                <th
                  key={entry.name}
                  scope="col"
                  className={`align-${align}`}
                  style={size}
                >
                  {options.labels?.[entry.name] ?? entry.name}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.slice(current * size, (current + 1) * size).map((row, at) => (
            <tr
              key={current * size + at}
              className={onSelect ? 'selectable' : undefined}
              onClick={
                onSelect
                  ? () =>
                      onSelect(
                        Object.fromEntries(
                          columns.map((column, i) => [column.name, row[i]]),
                        ),
                      )
                  : undefined
              }
            >
              {shown.map((entry) => {
                const value = row[entry.at];
                const type = columns[entry.at].type;
                const format = options.formats?.[entry.name];
                const display = options.tableColumns?.[entry.name];
                const raw = asText(value);
                const full = display?.text
                  ? raw
                  : /^0x[0-9a-f]{16,}$/i.test(raw)
                    ? raw
                    : format || numeric(entry.at)
                      ? formatValue(value, format ?? options.format)
                      : formatCategory(value, type);
                const text = formatTableText(full, display);
                const align =
                  display?.align ?? (numeric(entry.at) ? 'right' : 'left');
                const size = display?.width
                  ? { width: display.width, minWidth: display.width }
                  : undefined;
                return (
                  <td
                    key={entry.name}
                    className={[
                      `align-${align}`,
                      type === 'bytes' || display?.monospace ? 'mono' : '',
                      display?.width ? 'fixed' : '',
                    ].join(' ')}
                    style={size}
                    title={text !== full || display?.width ? full : undefined}
                    onCopy={(event) => {
                      if (text === full) return;
                      event.clipboardData.setData('text/plain', full);
                      event.preventDefault();
                    }}
                  >
                    {onSelect &&
                    entry ===
                      (shown.find((column) =>
                        /^0x[0-9a-f]{40,}$/i.test(asText(row[column.at])),
                      ) ?? shown[0]) ? (
                      <button
                        type="button"
                        className="viz-row-link"
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelect(
                            Object.fromEntries(
                              columns.map((column, i) => [column.name, row[i]]),
                            ),
                          );
                        }}
                        aria-label={`Open record for ${full}`}
                      >
                        {text}
                      </button>
                    ) : (
                      text
                    )}
                    {/^0x[0-9a-f]{40,}$/i.test(raw) && (
                      <button
                        type="button"
                        className="viz-copy"
                        aria-label={
                          copyError === raw
                            ? 'Copy failed'
                            : copied === raw
                              ? 'Copied address'
                              : `Copy ${entry.name}`
                        }
                        title={
                          copyError === raw
                            ? 'Copy failed; select the value to copy it'
                            : copied === raw
                              ? 'Copied'
                              : 'Copy full value'
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          void (async () => {
                            try {
                              await navigator.clipboard.writeText(raw);
                              setCopyError(null);
                              setCopied(raw);
                            } catch {
                              setCopied(null);
                              setCopyError(raw);
                            }
                          })();
                        }}
                      >
                        <Copy size={12} aria-hidden="true" />
                      </button>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {pages > 1 && (
        <div className="viz-table-pager">
          <button
            type="button"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            Previous
          </button>
          <span>
            {current + 1} / {pages}
          </span>
          <button
            type="button"
            disabled={current >= pages - 1}
            onClick={() => setPage(current + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

/** The figure of a number tile: the first row of y[0], formatted. */
const TILE_DAY = new Intl.DateTimeFormat('en', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const TILE_TIME = new Intl.DateTimeFormat('en', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

export function numberFigure(
  encoding: Encoding,
  options: Options,
  columns: Column[],
  rows: unknown[][],
): { figure: string; note: string } {
  const at = index(columns, encoding.y?.[0] ?? columns[0]?.name);
  const noteAt = index(columns, encoding.note);
  const row = rows[0];
  const temporal = (column: Column | undefined) =>
    column !== undefined &&
    ['date', 'timestamp', 'timestamptz'].includes(column.type);
  // A moment reads as its day, large, with the time of day in the note: a
  // whole timestamp does not fit a tile's figure.
  const moment =
    row && at >= 0 && row[at] !== null && temporal(columns[at])
      ? new Date(asText(row[at]))
      : null;
  const figure = moment
    ? Number.isNaN(moment.getTime())
      ? asText(row?.[at])
      : TILE_DAY.format(moment)
    : row && at >= 0
      ? formatValue(row[at], options.format)
      : '—';
  const noteFormat = encoding.note
    ? options.formats?.[encoding.note]
    : undefined;
  const note = [
    moment && columns[at].type !== 'date' && !Number.isNaN(moment.getTime())
      ? `${TILE_TIME.format(moment)} UTC`
      : '',
    noteAt >= 0 && row
      ? noteFormat
        ? formatValue(row[noteAt], noteFormat)
        : formatCategory(row[noteAt], columns[noteAt].type)
      : '',
    options.caption ?? '',
  ]
    .filter(Boolean)
    .join(' · ');
  return { figure, note };
}

export function VisualizationBody(props: VisualizationProps) {
  const { type, columns, rows, height } = props;
  if (!columns.length)
    return <Missing message="No data stored yet." height={height} />;
  switch (type) {
    case 'number': {
      const { figure, note } = numberFigure(
        props.encoding,
        props.options,
        columns,
        rows,
      );
      return (
        <div
          className="viz-number"
          style={{ minHeight: Math.min(height, 140) }}
        >
          <strong>{figure}</strong>
          {note && <p>{note}</p>}
        </div>
      );
    }
    case 'line':
    case 'area':
    case 'bar':
      return <Cartesian {...props} />;
    case 'share':
      return <Share {...props} />;
    case 'pie':
      return <PieView {...props} />;
    case 'heatmap':
      return <Grid {...props} cohort={false} />;
    case 'cohort':
      return <Grid {...props} cohort />;
    case 'table':
      return <Table {...props} />;
    default:
      return (
        <Missing
          message={`Unknown chart type ${String(type)}`}
          height={height}
        />
      );
  }
}

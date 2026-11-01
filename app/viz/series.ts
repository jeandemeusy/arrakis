import type { Encoding, Options, SeriesMark } from '@/lib/viz/config';
import { asText } from '@/lib/viz/text';

import { relayerColor, type Palette } from '../chart-theme';
import { formatCategory, toNumber } from './format';

/**
 * The series of a line, area or bar chart, and how each is drawn.
 *
 * Shared by the chart and by the editor's series table, so the colour, label
 * and order the editor lists are the ones the chart draws.
 */

export type Column = { name: string; type: string };

export type DrawnSeries = {
  /** The series' own key: a split value, or a y column. Options are keyed by it. */
  key: string;
  /** The key in the pivoted data. */
  dataKey: string;
  label: string;
  color: string;
  /** Whether the colour is one picked for it rather than the default. */
  picked: boolean;
  mark: SeriesMark;
  axis: 'left' | 'right';
  hidden: boolean;
};

export type Pivoted = {
  data: Array<Record<string, unknown>>;
  series: DrawnSeries[];
  xType?: string;
};

function index(columns: Column[], name: string | undefined): number {
  return name ? columns.findIndex((column) => column.name === name) : -1;
}

/** A small, stable hash of a series key, for its colour slot. */
function slot(key: string, size: number): number {
  let hash = 2166136261;
  for (let at = 0; at < key.length; at++) {
    hash ^= key.charCodeAt(at);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % size;
}

/**
 * Default colours for series keys in drawing order: by position (the chart's
 * accents for one or two series, the palette ramp for more), or by name.
 */
export function defaultColors(
  keys: string[],
  palette: Palette,
  stable: boolean | undefined,
): string[] {
  if (stable) {
    return keys.map(
      (key) => palette.categorical[slot(key, palette.categorical.length)],
    );
  }
  if (keys.length === 1) return [palette.accent];
  if (keys.length === 2) return [palette.accent, palette.accent2];
  return keys.map((_, at) => relayerColor(palette, at, keys.length));
}

/** `keys` with the ones `order` names moved first, in that order. */
export function ordered(keys: string[], order: string[] | undefined): string[] {
  if (!order?.length) return keys;
  const known = new Set(keys);
  const first = order.filter((key) => known.has(key));
  const named = new Set(first);
  return [...first, ...keys.filter((key) => !named.has(key))];
}

/** Every series as it will be drawn, with its options applied. */
export function styleSeries(
  keys: string[],
  options: Options,
  palette: Palette,
  fallbackMark: SeriesMark,
  labelOf: (key: string) => string = (key) => key,
): DrawnSeries[] {
  const sorted = ordered(keys, options.order);
  const colors = defaultColors(sorted, palette, options.stableColors);
  return sorted.map((key, at) => {
    const style = options.series?.[key] ?? {};
    return {
      key,
      dataKey: `s:${key}`,
      label: style.label ?? labelOf(key),
      color: style.color ?? colors[at],
      picked: Boolean(style.color),
      mark: style.mark ?? fallbackMark,
      axis: style.axis ?? 'left',
      hidden: Boolean(style.hidden),
    };
  });
}

/**
 * Wide rows for recharts: one object per x value, one key per series.
 *
 * With `series` set, long rows (x, series, value) are pivoted so each distinct
 * series value becomes its own key; series are ordered by their total, largest
 * first (or in the order rows bring them, with `seriesOrder: 'rows'`), then by
 * `options.order`.
 */
export function pivot(
  columns: Column[],
  rows: unknown[][],
  encoding: Encoding,
  options: Options,
  palette: Palette,
  fallbackMark: SeriesMark,
): Pivoted | string {
  const xAt = index(columns, encoding.x);
  if (xAt < 0)
    return `Choose an x column${encoding.x ? `; "${encoding.x}" is not in the result` : ''}.`;
  const ys = (encoding.y ?? []).map((name) => ({
    name,
    at: index(columns, name),
  }));
  if (!ys.length) return 'Choose at least one y column.';
  const missing = ys.find((entry) => entry.at < 0);
  if (missing) return `"${missing.name}" is not in the result.`;
  const xType = columns[xAt].type;

  const seriesAt = index(columns, encoding.series);
  if (encoding.series && seriesAt < 0)
    return `"${encoding.series}" is not in the result.`;

  const byX = new Map<string, Record<string, unknown>>();
  const totals = new Map<string, number>();
  for (const row of rows) {
    const x = String(row[xAt] as string);
    const point = byX.get(x) ?? { x: row[xAt] };
    byX.set(x, point);
    if (seriesAt >= 0) {
      const key = asText(row[seriesAt] ?? 'null');
      const value = toNumber(row[ys[0].at]) ?? 0;
      point[`s:${key}`] =
        ((point[`s:${key}`] as number | undefined) ?? 0) + value;
      totals.set(key, (totals.get(key) ?? 0) + value);
    } else {
      for (const y of ys) point[`s:${y.name}`] = toNumber(row[y.at]);
    }
  }
  const keys =
    seriesAt >= 0
      ? options.seriesOrder === 'rows'
        ? [...totals.keys()]
        : [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key)
      : ys.map((y) => y.name);
  return {
    data: [...byX.values()],
    series: styleSeries(keys, options, palette, fallbackMark, (key) =>
      seriesAt >= 0 ? formatCategory(key) : key,
    ),
    xType,
  };
}

/**
 * The series a chart of this type draws from these rows, styled: for the
 * editor's series table. A share chart's series are its labels.
 */
export function seriesOf(
  type: string,
  encoding: Encoding,
  options: Options,
  columns: Column[],
  rows: unknown[][],
  palette: Palette,
): DrawnSeries[] {
  if (type === 'line' || type === 'area' || type === 'bar') {
    const shaped = pivot(columns, rows, encoding, options, palette, type);
    return typeof shaped === 'string' ? [] : shaped.series;
  }
  if (type === 'share')
    return shareSeries(columns, rows, encoding, options, palette);
  return [];
}

/** A share chart's labels, largest first, as series. */
export function shareSeries(
  columns: Column[],
  rows: unknown[][],
  encoding: Encoding,
  options: Options,
  palette: Palette,
): DrawnSeries[] {
  const xAt = index(columns, encoding.x);
  const yAt = index(columns, encoding.y?.[0] ?? encoding.value);
  if (xAt < 0 || yAt < 0) return [];
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = asText(row[xAt] ?? 'null');
    totals.set(key, (totals.get(key) ?? 0) + (toNumber(row[yAt]) ?? 0));
  }
  const keys = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);
  // Shares are always largest first: `order` does not apply.
  return styleSeries(
    keys,
    { ...options, order: undefined },
    palette,
    'bar',
    (key) => formatCategory(key, columns[xAt].type),
  );
}

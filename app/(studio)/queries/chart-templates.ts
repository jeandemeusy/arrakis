import type { Builder, Unit } from '@/lib/viz/builder';
import type { Options, VisualizationType } from '@/lib/viz/config';

import { NUMERIC, TEMPORAL, type ScopeColumn } from './step-editor';

/**
 * Starting points for a new chart, read off the result's own columns, and
 * the small adjustments that keep a simple chart drawable when its type
 * changes. Nothing here is required: every template is an ordinary builder
 * the form then edits.
 */

export type Template = {
  id: string;
  title: string;
  /** One line, in the result's own column names. */
  description: string;
  type: VisualizationType;
  builder: Builder;
  options?: Options;
};

const COUNT = { fn: 'count' as const, as: 'count' };

/** The time column a chart most likely means: a day if there is one. */
export function timeColumn(columns: ScopeColumn[]): ScopeColumn | undefined {
  const temporal = columns.filter((column) => TEMPORAL.includes(column.type));
  return (
    temporal.find((column) => column.type === 'date') ??
    temporal.find((column) => column.type === 'timestamptz') ??
    temporal[0]
  );
}

/** A column with an exact moment, for hour-of-day charts. */
function momentColumn(columns: ScopeColumn[]): ScopeColumn | undefined {
  return columns.find(
    (column) => column.type === 'timestamptz' || column.type === 'timestamp',
  );
}

/** A column worth grouping by: text, not the network, not an id-like hash. */
export function categoryColumn(
  columns: ScopeColumn[],
): ScopeColumn | undefined {
  const text = columns.filter(
    (column) =>
      (column.type === 'text' || column.type === 'boolean') &&
      column.name !== 'network',
  );
  const named = text.find((column) =>
    /kind|type|direction|status|role|category|label|name/i.test(column.name),
  );
  return (
    named ?? text[0] ?? columns.find((column) => column.name === 'network')
  );
}

/** `block`, `deployed_block`, `block_number`: a position on the chain. */
const BLOCKISH = /(^|_)block(_number)?$/i;

/**
 * The block column a chart most likely plots over, when the result has no
 * time column: `block` itself if there is one, else another block-like
 * number that is not the head.
 */
export function blockColumn(columns: ScopeColumn[]): ScopeColumn | undefined {
  const blocks = columns.filter(
    (column) => NUMERIC.includes(column.type) && BLOCKISH.test(column.name),
  );
  return (
    blocks.find((column) => column.name === 'block') ??
    blocks.find((column) => !/^head/i.test(column.name))
  );
}

/** The column holding where a block window ends: the head block. */
function headColumn(columns: ScopeColumn[]): ScopeColumn | undefined {
  return columns.find(
    (column) => NUMERIC.includes(column.type) && /^head(_block)?$/i.test(column.name),
  );
}

export function numberColumn(columns: ScopeColumn[]): ScopeColumn | undefined {
  return columns.find(
    (column) => NUMERIC.includes(column.type) && !BLOCKISH.test(column.name),
  );
}

export function templates(columns: ScopeColumn[]): Template[] {
  const time = timeColumn(columns);
  const moment = momentColumn(columns);
  const category = categoryColumn(columns);
  const out: Template[] = [];
  // Without a time column, a block column is the axis: windows count blocks
  // back from the head, and bins are round block ranges.
  const block = time ? undefined : blockColumn(columns);
  const head = headColumn(columns);
  const blockWindow = block
    ? { column: block.name, ...(head ? { anchor: head.name } : {}) }
    : undefined;
  const value = numberColumn(columns);
  if (block && value) {
    // A result that already holds one value per block (a rolling count, a
    // balance) is plotted as it is, point by point.
    out.push({
      id: 'block-series',
      title: `${value.name} over blocks`,
      description: `${value.name} at each ${block.name}, as a line.`,
      type: 'line',
      builder: {
        window: blockWindow,
        groups: [{ column: block.name }],
        measures: [{ fn: 'max', columns: [value.name], as: value.name }],
      },
    });
  }
  if (block) {
    out.push({
      id: 'block-trend',
      title: 'Trend over blocks',
      description: `Rows per block range, by ${block.name}.`,
      type: 'bar',
      builder: {
        window: blockWindow,
        groups: [{ column: block.name, unit: 'auto' }],
        measures: [COUNT],
      },
    });
  }
  if (time) {
    out.push({
      id: 'trend',
      title: 'Trend over time',
      description: `Rows per day — or per week over long ranges — by ${time.name}.`,
      type: 'bar',
      builder: {
        window: { column: time.name },
        groups: [{ column: time.name, unit: 'auto' }],
        measures: [COUNT],
      },
    });
  }
  out.push({
    id: 'total',
    title: 'Single number',
    description: time
      ? `How many rows in the dashboard's range, by ${time.name}.`
      : block
        ? `How many rows in the dashboard's block window, by ${block.name}.`
        : 'How many rows there are.',
    type: 'number',
    builder: {
      ...(time
        ? { window: { column: time.name } }
        : blockWindow
          ? { window: blockWindow }
          : {}),
      measures: [COUNT],
    },
  });
  if (category) {
    out.push({
      id: 'top',
      title: 'Top 10',
      description: `The ten most common ${category.name} values, and the rest.`,
      type: 'share',
      builder: {
        ...(time ? { window: { column: time.name } } : {}),
        groups: [{ column: category.name }],
        measures: [COUNT],
        top: { n: 10 },
      },
    });
  }
  if (category) {
    out.push({
      id: 'donut',
      title: 'Share as a donut',
      description: `How rows split by ${category.name}, as a ring.`,
      type: 'pie',
      builder: {
        ...(time ? { window: { column: time.name } } : {}),
        groups: [{ column: category.name }],
        measures: [COUNT],
        top: { n: 7 },
      },
      options: { donut: true },
    });
  }
  const amount = numberColumn(columns);
  const second = amount
    ? { fn: 'sum' as const, columns: [amount.name], as: `total_${amount.name}` }
    : category
      ? {
          fn: 'count_distinct' as const,
          columns: [category.name],
          as: `distinct_${category.name}`,
        }
      : null;
  if (time && second) {
    out.push({
      id: 'combo',
      title: 'Columns and a line',
      description: `Rows per day as columns, and ${
        amount ? `the sum of ${amount.name}` : `distinct ${category!.name}`
      } as a line on its own axis.`,
      type: 'bar',
      builder: {
        window: { column: time.name },
        groups: [{ column: time.name, unit: 'auto' }],
        measures: [COUNT, second],
      },
      options: {
        legend: true,
        series: { [second.as]: { mark: 'line', axis: 'right' } },
      },
    });
  }
  if (time && category) {
    out.push({
      id: 'breakdown',
      title: 'Breakdown over time',
      description: `Rows per day, stacked by ${category.name}.`,
      type: 'bar',
      builder: {
        window: { column: time.name },
        groups: [{ column: time.name, unit: 'auto' }],
        split: { column: category.name, top: 8 },
        measures: [COUNT],
      },
      options: { stacked: true },
    });
  }
  if (moment) {
    out.push({
      id: 'hours',
      title: 'Hour × weekday',
      description: `When rows happen, as a share of the week, by ${moment.name}.`,
      type: 'heatmap',
      builder: {
        ...(time ? { window: { column: time.name } } : {}),
        groups: [
          { column: moment.name, unit: 'hour_of_day' },
          { column: moment.name, unit: 'day_of_week' },
        ],
        measures: [COUNT],
        share: { of: 'count' },
      },
    });
  }
  out.push({
    id: 'rows',
    title: 'Table of rows',
    description: time
      ? `The latest rows, newest first by ${time.name}.`
      : 'The rows as they are.',
    type: 'table',
    builder: time
      ? { sort: [{ column: time.name, desc: true }], limit: 500 }
      : block
        ? { sort: [{ column: block.name, desc: true }], limit: 500 }
        : { limit: 500 },
  });
  // Any type, from nothing: the type bar above the form picks the rest.
  out.push({
    id: 'blank',
    title: 'Blank chart',
    description: 'Pick the type and fields yourself.',
    type: 'line',
    builder: adaptBuilder('line', { measures: [COUNT] }, columns),
  });
  return out;
}

/**
 * Keeps a simple chart drawable when its type changes: a chart that plots
 * over something gets a time axis, a grid gets hour and weekday, a share
 * gets a category. What the chart already has is kept.
 */
export function adaptBuilder(
  type: VisualizationType,
  builder: Builder,
  columns: ScopeColumn[],
): Builder {
  const next: Builder = { ...builder };
  if (!next.measures?.length && type !== 'table') next.measures = [COUNT];
  const groups = next.groups ?? [];
  const time = timeColumn(columns);
  const block = time ? undefined : blockColumn(columns);
  const moment = momentColumn(columns);
  const category = categoryColumn(columns);
  const axis = (column: ScopeColumn): { column: string; unit?: Unit } =>
    TEMPORAL.includes(column.type) || column === block
      ? { column: column.name, unit: 'auto' }
      : { column: column.name };
  switch (type) {
    case 'line':
    case 'area':
    case 'bar': {
      const fallback = time ?? block ?? category;
      if (!groups.length && fallback) next.groups = [axis(fallback)];
      break;
    }
    case 'share':
    case 'pie':
      if (!groups.length || groups[0].unit) {
        if (category) next.groups = [{ column: category.name }];
      }
      break;
    case 'heatmap':
      if (groups.length < 2 && moment) {
        next.groups = [
          { column: moment.name, unit: 'hour_of_day' },
          { column: moment.name, unit: 'day_of_week' },
        ];
      }
      break;
    default:
      break;
  }
  return next;
}

/** Default output names for a measure, unique among the others. */
export function measureName(
  fn: string,
  columns: string[] | undefined,
  taken: string[],
): string {
  const base =
    fn === 'count'
      ? 'count'
      : fn === 'count_distinct'
        ? `distinct_${(columns ?? []).filter((c) => c !== 'network').join('_') || 'values'}`
        : `${fn}_${columns?.[0] ?? 'value'}`;
  let name = base.replace(/[^a-z0-9_]/g, '_').slice(0, 50);
  let at = 2;
  while (taken.includes(name)) name = `${base}_${at++}`;
  return name;
}

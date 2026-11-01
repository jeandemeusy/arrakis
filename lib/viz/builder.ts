import { badRequest } from '../api/errors';
import type { Encoding, Format, Options, VisualizationType } from './config';
import type { Measure, Step, ValueRef } from './transform';

/**
 * The chart builder: a chart described the way people say it.
 *
 *   Show   the sum of gigabytes                       measures
 *   over   the day (or week, for long ranges)         groups
 *   split  by direction                               split
 *   for    rows where direction = upstream            filters
 *   within the dashboard's range                      window
 *
 * plus a few extras — a trailing window, top N, share of the total, a rank.
 * It compiles to the transform steps every chart runs on (transform.ts), and
 * to the axes: which column is x, which is y, what splits the series. So the
 * builder never maps axes by hand and never names an intermediate column it
 * then has to pick again; a chart that outgrows it turns into its steps.
 *
 * Shared by the browser, which compiles as the form changes, and the server,
 * which compiles again on save so a stored chart always matches its builder.
 */

export type Unit =
  | 'auto'
  | 'hour'
  | 'day'
  | 'week'
  | 'month'
  | 'hour_of_day'
  | 'day_of_week';

export type Dimension = {
  column: string;
  /** For a time column: how to bucket it. Absent uses the values as they are. */
  unit?: Unit;
  /** The output column's name; defaults from the unit (`day`, `weekday`…). */
  as?: string;
};

export type BuilderFilter = {
  column: string;
  operator: Extract<Step, { op: 'filter' }>['operator'];
  value?: ValueRef;
  optional?: boolean;
};

export type BuilderMeasure = Measure & {
  /** Table header and legend text, when the column name will not do. */
  label?: string;
  format?: Format;
};

export type Builder = {
  filters?: BuilderFilter[];
  /**
   * The time window. `var` names the dashboard range variable (default
   * `range`); `fixed` pins one (`31d`, `90d`); `from` never goes before a date.
   */
  window?: { column: string; var?: string; fixed?: string; from?: string };
  /** x first; a heatmap's rows second; a table may group by several. */
  groups?: Dimension[];
  /** Lines, areas and bars: one series per value of this column. */
  split?: Dimension & {
    /** Keep the N largest series and fold the rest into "Others". */
    top?: number;
    /** `size`: largest first (default); `az`/`za`: by name, which fixes colours. */
    order?: 'size' | 'az' | 'za';
  };
  measures?: BuilderMeasure[];
  /** Each point counts its trailing N days — distinct users over a month. */
  rolling?: number;
  /** After grouping: keep only groups matching these. */
  having?: BuilderFilter[];
  /** Keep the N largest categories on x and fold the rest. */
  top?: { n: number; others?: string };
  /** A measure as a share of its total, in a new column (`share`). */
  share?: { of: string; as?: string };
  /** A 1, 2, 3… column ordered by a measure, largest first. */
  rank?: { by: string; as?: string };
  sort?: Array<{ column: string; desc?: boolean }>;
  limit?: number;
};

export type Compiled = {
  steps: Step[];
  encoding: Encoding;
  /** Derived options, laid over the chart's own (stacked, caption, …). */
  options: Partial<Options>;
};

const UNIT_NAMES: Record<Unit, string> = {
  auto: 'period',
  hour: 'hour',
  day: 'day',
  week: 'week',
  month: 'month',
  hour_of_day: 'hour',
  day_of_week: 'weekday',
};

export const UNIT_LABELS: Record<Unit, string> = {
  auto: 'Day or week, by range',
  hour: 'Hour',
  day: 'Day',
  week: 'Week',
  month: 'Month',
  hour_of_day: 'Hour of day (0–23)',
  day_of_week: 'Day of week',
};

/** The output name a dimension gets. */
export function dimensionName(dimension: Dimension): string {
  if (dimension.as) return dimension.as;
  if (!dimension.unit) return dimension.column;
  const name = UNIT_NAMES[dimension.unit];
  return name === dimension.column
    ? `${dimension.column}_${dimension.unit}`
    : name;
}

/** Which groups a chart type draws, and whether it can split or roll. */
export function shapeOf(type: VisualizationType): {
  groups: number;
  split: boolean;
  measures: 'one' | 'many';
} {
  switch (type) {
    case 'number':
      return { groups: 0, split: false, measures: 'many' };
    case 'line':
    case 'area':
    case 'bar':
      return { groups: 1, split: true, measures: 'many' };
    case 'share':
      return { groups: 1, split: false, measures: 'one' };
    case 'heatmap':
      return { groups: 2, split: false, measures: 'one' };
    case 'table':
      return { groups: 4, split: false, measures: 'many' };
    case 'cohort':
      return { groups: 2, split: false, measures: 'one' };
  }
}

const SUMMABLE = new Set(['count', 'sum']);

export function compileBuilder(
  type: VisualizationType,
  builder: Builder,
): Compiled {
  const shape = shapeOf(type);
  const steps: Step[] = [];
  const dims = (builder.groups ?? []).slice(0, shape.groups);
  const split = shape.split ? builder.split : undefined;
  const measures = builder.measures ?? [];
  const raw = measures.length === 0;
  if (raw && type !== 'table') {
    throw badRequest('Choose what to show: a count, a sum or another measure');
  }
  const names = dims.map(dimensionName);
  const splitName = split ? dimensionName(split) : undefined;
  const first = measures[0]?.as;
  const rolling =
    builder.rolling && dims.length && !raw && shape.split
      ? builder.rolling
      : undefined;

  for (const filter of builder.filters ?? []) {
    steps.push({ op: 'filter', ...filter });
  }
  const window = builder.window;
  const range = (column: string): Step => ({
    op: 'range',
    column,
    anchor: 'now',
    ...(window?.fixed
      ? { window: window.fixed }
      : { var: window?.var ?? 'range' }),
  });
  const from = (column: string): Step => ({
    op: 'filter',
    column,
    operator: '>=',
    value: { literal: window?.from ?? '' },
  });
  // A trailing window reads the days before the plotted range, so the range
  // applies after it; otherwise it narrows the rows first, which is cheaper.
  if (window && !rolling) {
    steps.push(range(window.column));
    if (window.from) steps.push(from(window.column));
  }
  for (const dimension of [...dims, ...(split ? [split] : [])]) {
    if (!dimension.unit) continue;
    steps.push({
      op: 'bucket',
      column: dimension.column,
      unit: dimension.unit,
      as: dimensionName(dimension),
      ...(dimension.unit === 'auto' && window?.var ? { var: window.var } : {}),
    });
  }
  const plain: Measure[] = measures.map(({ fn, columns, as }) => ({
    fn,
    ...(columns?.length ? { columns } : {}),
    as,
  }));
  if (rolling) {
    steps.push({
      op: 'rolling',
      time: names[0],
      days: rolling,
      fill: true,
      ...(splitName ? { groupBy: [splitName] } : {}),
      measures: plain,
    });
    if (window?.from) steps.push(from(names[0]));
    if (window) steps.push(range(names[0]));
  } else if (!raw) {
    steps.push({
      op: 'aggregate',
      groupBy: [...names, ...(splitName ? [splitName] : [])],
      measures: plain,
    });
  }
  for (const filter of builder.having ?? []) {
    steps.push({ op: 'filter', ...filter });
  }
  const summed = measures
    .filter((measure) => SUMMABLE.has(measure.fn))
    .map((measure) => measure.as);
  if (builder.top && names[0] && first) {
    steps.push({
      op: 'top',
      column: names[0],
      by: first,
      n: builder.top.n,
      others: builder.top.others ?? 'Others',
      sum: summed.length ? summed : [first],
    });
  }
  if (split?.top && splitName && first) {
    steps.push({
      op: 'top',
      column: splitName,
      by: first,
      n: split.top,
      others: 'Others',
      sum: summed.length ? summed : [first],
    });
  }
  const shareName = builder.share ? (builder.share.as ?? 'share') : undefined;
  if (builder.share && shareName) {
    const total = `${builder.share.of}_total`;
    steps.push(
      { op: 'window', as: total, fn: 'sum', column: builder.share.of },
      {
        op: 'compute',
        as: shareName,
        left: builder.share.of,
        operator: '/',
        right: total,
      },
    );
  }
  const rankName = builder.rank ? (builder.rank.as ?? 'rank') : undefined;
  if (builder.rank && rankName) {
    steps.push({
      op: 'window',
      as: rankName,
      fn: 'row_number',
      orderBy: [
        { column: builder.rank.by, desc: true },
        ...names.map((column) => ({ column })),
      ],
    });
  }

  // Order: as asked; else time runs left to right, categories largest first.
  const timeLike =
    Boolean(rolling) ||
    Boolean(dims[0]?.unit) ||
    (dims[0] !== undefined && dims[0].column === window?.column);
  let sort = builder.sort?.length ? builder.sort : undefined;
  if (!sort && rankName) sort = [{ column: rankName }];
  if (!sort && names[0] && timeLike) {
    sort = [
      { column: names[0] },
      ...(splitName && split?.order && split.order !== 'size'
        ? [{ column: splitName, desc: split.order === 'za' }]
        : []),
      ...names.slice(1).map((column) => ({ column })),
    ];
  }
  if (!sort && first && names.length && type !== 'heatmap') {
    sort = [{ column: shareName ?? first, desc: true }];
  }
  if (sort) steps.push({ op: 'sort', by: sort });
  if (builder.limit) steps.push({ op: 'limit', n: builder.limit });

  // The axes follow from the shape.
  const plotted = shareName ?? first;
  let encoding: Encoding = {};
  switch (type) {
    case 'number':
      encoding = {
        y: first ? [first] : [],
        ...(measures[1] ? { note: measures[1].as } : {}),
      };
      break;
    case 'line':
    case 'area':
    case 'bar':
      encoding = {
        x: names[0],
        y: splitName ? [first ?? ''] : measures.map((measure) => measure.as),
        ...(splitName ? { series: splitName } : {}),
      };
      break;
    case 'share':
      encoding = { x: names[0], y: plotted ? [plotted] : [] };
      break;
    case 'heatmap':
    case 'cohort':
      encoding = { x: names[0], row: names[1], value: plotted };
      break;
    case 'table':
      encoding = {};
      break;
  }

  const formats: Record<string, Format> = {};
  const labels: Record<string, string> = {};
  for (const measure of measures) {
    if (measure.format) formats[measure.as] = measure.format;
    if (measure.label) labels[measure.as] = measure.label;
  }
  if (shareName) formats[shareName] = 'percent';
  const options: Partial<Options> = {
    format:
      shareName && plotted === shareName ? 'percent' : measures[0]?.format,
    formats: Object.keys(formats).length ? formats : undefined,
    labels: Object.keys(labels).length ? labels : undefined,
    seriesOrder:
      split?.order === 'az' || split?.order === 'za' ? 'rows' : undefined,
  };
  if (type === 'table' && !raw) {
    options.columns = [
      ...(rankName ? [rankName] : []),
      ...names,
      ...measures.map((measure) => measure.as),
      ...(shareName ? [shareName] : []),
    ];
  }
  return { steps, encoding, options };
}

function record(input: unknown, where: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw badRequest(`${where} must be an object`);
  }
  return input as Record<string, unknown>;
}

function text(
  input: unknown,
  where: string,
  required = true,
): string | undefined {
  if (input === undefined || input === null || input === '') {
    if (required) throw badRequest(`${where} is required`);
    return undefined;
  }
  if (typeof input !== 'string') throw badRequest(`${where} must be text`);
  return input.slice(0, 200);
}

function count(input: unknown, where: string, max: number): number | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  const value = Number(input);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw badRequest(`${where} must be a whole number from 1 to ${max}`);
  }
  return value;
}

const UNITS = Object.keys(UNIT_NAMES) as Unit[];

function dimension(input: unknown, where: string): Dimension {
  const raw = record(input, where);
  const unit = text(raw.unit, `${where}.unit`, false) as Unit | undefined;
  if (unit && !UNITS.includes(unit)) {
    throw badRequest(`${where}.unit must be one of ${UNITS.join(', ')}`);
  }
  const as = text(raw.as, `${where}.as`, false);
  return {
    column: text(raw.column, `${where}.column`) ?? '',
    ...(unit ? { unit } : {}),
    ...(as ? { as } : {}),
  };
}

function filters(input: unknown, where: string): BuilderFilter[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) throw badRequest(`${where} must be a list`);
  return input.slice(0, 20).map((entry, at) => {
    const raw = record(entry, `${where}[${at}]`);
    const value = raw.value;
    if (value !== undefined && (typeof value !== 'object' || value === null)) {
      throw badRequest(`${where}[${at}].value must be { literal } or { var }`);
    }
    return {
      column: text(raw.column, `${where}[${at}].column`) ?? '',
      operator: text(
        raw.operator,
        `${where}[${at}].operator`,
      ) as BuilderFilter['operator'],
      ...(value !== undefined ? { value: value as ValueRef } : {}),
      ...(raw.optional ? { optional: true } : {}),
    };
  });
}

/** Checks a builder from untrusted input. Columns are checked when it runs. */
export function parseBuilder(input: unknown): Builder {
  const raw = record(input, 'builder');
  const out: Builder = {};
  out.filters = filters(raw.filters, 'builder.filters');
  out.having = filters(raw.having, 'builder.having');
  if (raw.window !== undefined && raw.window !== null) {
    const window = record(raw.window, 'builder.window');
    out.window = { column: text(window.column, 'builder.window.column') ?? '' };
    const name = text(window.var, 'builder.window.var', false);
    const fixed = text(window.fixed, 'builder.window.fixed', false);
    const since = text(window.from, 'builder.window.from', false);
    if (name) out.window.var = name;
    if (fixed) out.window.fixed = fixed;
    if (since) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(since))
        throw badRequest('builder.window.from must be a date, YYYY-MM-DD');
      out.window.from = since;
    }
  }
  if (raw.groups !== undefined && raw.groups !== null) {
    if (!Array.isArray(raw.groups))
      throw badRequest('builder.groups must be a list');
    out.groups = raw.groups
      .slice(0, 4)
      .map((entry, at) => dimension(entry, `builder.groups[${at}]`));
  }
  if (raw.split !== undefined && raw.split !== null) {
    const split = record(raw.split, 'builder.split');
    const order = text(split.order, 'builder.split.order', false);
    if (order && !['size', 'az', 'za'].includes(order))
      throw badRequest('builder.split.order must be size, az or za');
    const top = count(split.top, 'builder.split.top', 50);
    out.split = {
      ...dimension(split, 'builder.split'),
      ...(top ? { top } : {}),
      ...(order ? { order: order as 'size' | 'az' | 'za' } : {}),
    };
  }
  if (raw.measures !== undefined && raw.measures !== null) {
    if (!Array.isArray(raw.measures))
      throw badRequest('builder.measures must be a list');
    out.measures = raw.measures.slice(0, 8).map((entry, at) => {
      const measure = record(entry, `builder.measures[${at}]`);
      const fn = text(
        measure.fn,
        `builder.measures[${at}].fn`,
      ) as Measure['fn'];
      if (
        !['count', 'count_distinct', 'sum', 'avg', 'min', 'max'].includes(fn)
      ) {
        throw badRequest(`builder.measures[${at}].fn is not a measure`);
      }
      const columns = Array.isArray(measure.columns)
        ? measure.columns.filter(
            (column): column is string => typeof column === 'string',
          )
        : undefined;
      const label = text(measure.label, `builder.measures[${at}].label`, false);
      const format = text(
        measure.format,
        `builder.measures[${at}].format`,
        false,
      );
      return {
        fn,
        ...(columns?.length ? { columns } : {}),
        as: text(measure.as, `builder.measures[${at}].as`) ?? '',
        ...(label ? { label } : {}),
        ...(format ? { format: format as Format } : {}),
      };
    });
  }
  const rolling = count(raw.rolling, 'builder.rolling', 3650);
  if (rolling) out.rolling = rolling;
  if (raw.top !== undefined && raw.top !== null) {
    const top = record(raw.top, 'builder.top');
    const others = text(top.others, 'builder.top.others', false);
    out.top = {
      n: count(top.n, 'builder.top.n', 500) ?? 10,
      ...(others ? { others } : {}),
    };
  }
  if (raw.share !== undefined && raw.share !== null) {
    const share = record(raw.share, 'builder.share');
    const as = text(share.as, 'builder.share.as', false);
    out.share = {
      of: text(share.of, 'builder.share.of') ?? '',
      ...(as ? { as } : {}),
    };
  }
  if (raw.rank !== undefined && raw.rank !== null) {
    const rank = record(raw.rank, 'builder.rank');
    const as = text(rank.as, 'builder.rank.as', false);
    out.rank = {
      by: text(rank.by, 'builder.rank.by') ?? '',
      ...(as ? { as } : {}),
    };
  }
  if (Array.isArray(raw.sort) && raw.sort.length) {
    out.sort = raw.sort.slice(0, 4).map((entry, at) => {
      const sort = record(entry, `builder.sort[${at}]`);
      return {
        column: text(sort.column, `builder.sort[${at}].column`) ?? '',
        ...(sort.desc ? { desc: true } : {}),
      };
    });
  }
  const limit = count(raw.limit, 'builder.limit', 50_000);
  if (limit) out.limit = limit;
  // Drop what is empty, so stored builders stay small and comparable.
  for (const key of Object.keys(out) as Array<keyof Builder>) {
    const value = out[key];
    if (value === undefined || (Array.isArray(value) && !value.length))
      delete out[key];
  }
  return out;
}

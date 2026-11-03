import { badRequest } from '../api/errors';
import { compileBuilder, parseBuilder, type Builder } from './builder';
import { parseSteps, type Step } from './transform';

/**
 * What a visualization is: a chart type, the steps that shape its rows, and how
 * the shaped columns map onto the chart.
 *
 * Shared by server and browser: the editor builds these, the server validates
 * and runs them, the renderer reads `encoding` and `options`.
 */

export const VISUALIZATION_TYPES = [
  'number',
  'line',
  'area',
  'bar',
  'share',
  'pie',
  'heatmap',
  'cohort',
  'table',
] as const;

export type VisualizationType = (typeof VISUALIZATION_TYPES)[number];

export const FORMATS = [
  'number',
  'compact',
  'decimal',
  'percent',
  'gigabytes',
  'token',
] as const;

export type Format = (typeof FORMATS)[number];

export type Encoding = {
  /** The category or time axis; the label of a share; a heatmap's columns. */
  x?: string;
  /** The plotted values; the number tile's figure is the first row of y[0]. */
  y?: string[];
  /** Splits long-form rows into one series per value of this column. */
  series?: string;
  /** A heatmap's rows; a cohort grid's cohort. */
  row?: string;
  /** The cell value of a heatmap or cohort grid. */
  value?: string;
  /** Number tile: a second column read from the same row, shown as its note. */
  note?: string;
};

export type Options = {
  format?: Format;
  /** Stacks bar and area series rather than drawing them side by side. */
  stacked?: boolean;
  /** Text after a number tile's figure, or a fixed note under it. */
  caption?: string;
  /** Table: the columns to show, in order; all when empty. */
  columns?: string[];
  /** Table rows per page. */
  pageSize?: number;
  /** Line: draw the series as steps of a staircase. */
  step?: boolean;
  /**
   * Split series: `total` puts the largest first (the default, right for
   * many categories such as relays); `rows` keeps the order they first
   * appear in, so a sort step fixes which comes first and takes which colour.
   */
  seriesOrder?: 'total' | 'rows';
  /** Per-column formats, over `format`: a table's columns, a number's note. */
  formats?: Record<string, Format>;
  /** Table headers to show instead of column names. */
  labels?: Record<string, string>;
  /** Per-table-column display rules. Unset keeps the original automatic view. */
  tableColumns?: Record<string, TableColumnOptions>;

  // How a line, area or bar chart is drawn. All optional: a chart without
  // them looks as it always has.

  /** The legend beside the chart; shown by default when there are two series or more. */
  legend?: boolean;
  /** Where to place a chart legend; auto adapts to the available width. */
  legendPosition?: 'auto' | 'side' | 'below';
  /** The tooltip ends with the sum of the series at that point. */
  tooltipTotal?: boolean;
  /** Stacks every point to 100%, so the chart shows shares rather than amounts. */
  normalize?: boolean;
  /** The value written on each bar or point; a pie's slices, their share. */
  dataLabels?: boolean;
  /** Pie: a ring with the total in its middle, rather than a full disc. */
  donut?: boolean;
  /**
   * Colours by series name rather than by position, so a series — a relay —
   * keeps its colour across charts and as others come and go.
   */
  stableColors?: boolean;
  /** Per series, by its key: a split value, or a y column's name. */
  series?: Record<string, SeriesStyle>;
  /** Series to draw first, in this order; the rest follow in their usual order. */
  order?: string[];
  xAxis?: AxisOptions;
  yAxis?: AxisOptions;
  /** The axis on the right, for series set to `axis: 'right'`. */
  rightAxis?: AxisOptions;
};

export type TableColumnOptions = {
  /** A text display keeps identifiers literal rather than applying a number format. */
  text?: boolean;
  align?: 'left' | 'center' | 'right';
  /** Fixed pixel width; the surrounding table scrolls when it no longer fits. */
  width?: number;
  monospace?: boolean;
  condensed?: boolean;
};

export const SERIES_MARKS = ['bar', 'line', 'area'] as const;
export type SeriesMark = (typeof SERIES_MARKS)[number];

export type SeriesStyle = {
  /** Shown in the legend and tooltip instead of the key. */
  label?: string;
  /** `#rrggbb`. */
  color?: string;
  /** Drawn as this instead of the chart's own type: a line over bars, say. */
  mark?: SeriesMark;
  axis?: 'left' | 'right';
  /** Left out of the chart (still in the data). */
  hidden?: boolean;
};

export type AxisOptions = {
  title?: string;
  /** Values axes: a logarithmic scale. */
  log?: boolean;
  /** Values axes: start from zero (the default) or fit the data. */
  zero?: boolean;
  min?: number;
  max?: number;
  /** Values axes: how ticks are written; the chart's format by default. */
  format?: Format;
  /** Category axis: right to left. */
  reverse?: boolean;
  /** Category axis: a range selector under the chart. */
  brush?: boolean;
};

export type VisualizationConfig = {
  steps: Step[];
  encoding: Encoding;
  options: Options;
  /**
   * Hand-written SQL instead of steps: `{{result}}` is the stored result,
   * `{{name}}` a dashboard variable (text). Runs as a role that can read
   * result tables and nothing else.
   */
  sql?: string;
  /**
   * The chart as the simple editor describes it (builder.ts). When present,
   * `steps`, `encoding` and the derived options are compiled from it.
   */
  builder?: Builder;
};

function strings(input: unknown, where: string): string[] | undefined {
  if (input === undefined || input === null) return undefined;
  if (
    !Array.isArray(input) ||
    !input.every((entry) => typeof entry === 'string')
  ) {
    throw badRequest(`${where} must be a list of column names`);
  }
  return input as string[];
}

function string(input: unknown, where: string): string | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  if (typeof input !== 'string') throw badRequest(`${where} must be a string`);
  return input;
}

const COLOR = /^#[0-9a-f]{6}$/i;

function flag(input: unknown): boolean | undefined {
  return input === undefined || input === null ? undefined : Boolean(input);
}

function parseAxis(input: unknown, where: string): AxisOptions | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input))
    throw badRequest(`${where} must be an object`);
  const raw = input as Record<string, unknown>;
  const axis: AxisOptions = {};
  const title = string(raw.title, `${where}.title`);
  if (title) axis.title = title.slice(0, 80);
  for (const key of ['log', 'zero', 'reverse', 'brush'] as const) {
    const value = flag(raw[key]);
    if (value !== undefined) axis[key] = value;
  }
  for (const key of ['min', 'max'] as const) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '')
      continue;
    const value = Number(raw[key]);
    if (!Number.isFinite(value))
      throw badRequest(`${where}.${key} must be a number`);
    axis[key] = value;
  }
  const format = string(raw.format, `${where}.format`);
  if (format) {
    if (!FORMATS.includes(format as Format))
      throw badRequest(`${where}.format must be one of ${FORMATS.join(', ')}`);
    axis.format = format as Format;
  }
  return Object.keys(axis).length ? axis : undefined;
}

/** The drawing options of line, area and bar charts, into `options`. */
function parseDrawing(raw: Record<string, unknown>, options: Options) {
  if (raw.legendPosition !== undefined && raw.legendPosition !== null) {
    if (typeof raw.legendPosition !== 'string' || !['auto', 'side', 'below'].includes(raw.legendPosition))
      throw badRequest('options.legendPosition must be auto, side, or below');
    options.legendPosition = raw.legendPosition as Options['legendPosition'];
  }
  for (const key of [
    'legend',
    'tooltipTotal',
    'normalize',
    'dataLabels',
    'stableColors',
    'donut',
  ] as const) {
    const value = flag(raw[key]);
    if (value !== undefined) options[key] = value;
  }
  if (raw.series !== undefined && raw.series !== null) {
    if (typeof raw.series !== 'object' || Array.isArray(raw.series))
      throw badRequest('options.series must map series to their style');
    const series: Record<string, SeriesStyle> = {};
    const entries = Object.entries(raw.series as Record<string, unknown>);
    if (entries.length > 500) throw badRequest('options.series is too long');
    for (const [key, value] of entries) {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw badRequest(`options.series.${key} must be an object`);
      const entry = value as Record<string, unknown>;
      const style: SeriesStyle = {};
      const label = string(entry.label, `options.series.${key}.label`);
      if (label?.trim()) style.label = label.trim().slice(0, 80);
      const color = string(entry.color, `options.series.${key}.color`);
      if (color) {
        if (!COLOR.test(color))
          throw badRequest(`options.series.${key}.color must be #rrggbb`);
        style.color = color.toLowerCase();
      }
      const mark = string(entry.mark, `options.series.${key}.mark`);
      if (mark) {
        if (!SERIES_MARKS.includes(mark as SeriesMark))
          throw badRequest(
            `options.series.${key}.mark must be one of ${SERIES_MARKS.join(', ')}`,
          );
        style.mark = mark as SeriesMark;
      }
      if (entry.axis === 'right') style.axis = 'right';
      else if (
        entry.axis !== undefined &&
        entry.axis !== null &&
        entry.axis !== 'left'
      )
        throw badRequest(`options.series.${key}.axis must be left or right`);
      if (entry.hidden) style.hidden = true;
      if (Object.keys(style).length) series[key] = style;
    }
    if (Object.keys(series).length) options.series = series;
  }
  const order = strings(raw.order, 'options.order');
  if (order?.length) options.order = order.slice(0, 500);
  for (const key of ['xAxis', 'yAxis', 'rightAxis'] as const) {
    const axis = parseAxis(raw[key], `options.${key}`);
    if (axis) options[key] = axis;
  }
}

export function parseType(input: unknown): VisualizationType {
  if (!VISUALIZATION_TYPES.includes(input as VisualizationType)) {
    throw badRequest(`type must be one of ${VISUALIZATION_TYPES.join(', ')}`);
  }
  return input as VisualizationType;
}

export function parseConfig(input: unknown): VisualizationConfig {
  const raw =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const encodingIn =
    typeof raw.encoding === 'object' && raw.encoding !== null
      ? (raw.encoding as Record<string, unknown>)
      : {};
  const optionsIn =
    typeof raw.options === 'object' && raw.options !== null
      ? (raw.options as Record<string, unknown>)
      : {};
  const encoding: Encoding = {};
  for (const key of ['x', 'series', 'row', 'value', 'note'] as const) {
    const value = string(encodingIn[key], `encoding.${key}`);
    if (value) encoding[key] = value;
  }
  const y = strings(encodingIn.y, 'encoding.y');
  if (y?.length) encoding.y = y;

  const options: Options = {};
  const format = string(optionsIn.format, 'options.format');
  if (format) {
    if (!FORMATS.includes(format as Format)) {
      throw badRequest(`options.format must be one of ${FORMATS.join(', ')}`);
    }
    options.format = format as Format;
  }
  if (optionsIn.stacked !== undefined)
    options.stacked = Boolean(optionsIn.stacked);
  if (optionsIn.step !== undefined) options.step = Boolean(optionsIn.step);
  if (optionsIn.seriesOrder !== undefined && optionsIn.seriesOrder !== null) {
    if (optionsIn.seriesOrder !== 'total' && optionsIn.seriesOrder !== 'rows')
      throw badRequest('options.seriesOrder must be total or rows');
    options.seriesOrder = optionsIn.seriesOrder;
  }
  const caption = string(optionsIn.caption, 'options.caption');
  if (caption) options.caption = caption.slice(0, 300);
  const columns = strings(optionsIn.columns, 'options.columns');
  if (columns?.length) options.columns = columns;
  if (optionsIn.pageSize !== undefined) {
    const size = Number(optionsIn.pageSize);
    if (!Number.isInteger(size) || size < 5 || size > 500) {
      throw badRequest('options.pageSize must be from 5 to 500');
    }
    options.pageSize = size;
  }
  const record = (input: unknown, where: string): Record<string, string> => {
    if (input === undefined || input === null) return {};
    if (typeof input !== 'object' || Array.isArray(input))
      throw badRequest(`${where} must map column names to text`);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      input as Record<string, unknown>,
    )) {
      if (typeof value !== 'string')
        throw badRequest(`${where}.${key} must be text`);
      if (value.trim()) out[key] = value.trim().slice(0, 80);
    }
    return out;
  };
  const formats = record(optionsIn.formats, 'options.formats');
  for (const [column, value] of Object.entries(formats)) {
    if (!FORMATS.includes(value as Format)) {
      throw badRequest(
        `options.formats.${column} must be one of ${FORMATS.join(', ')}`,
      );
    }
  }
  if (Object.keys(formats).length)
    options.formats = formats as Record<string, Format>;
  const labels = record(optionsIn.labels, 'options.labels');
  if (Object.keys(labels).length) options.labels = labels;
  if (optionsIn.tableColumns !== undefined && optionsIn.tableColumns !== null) {
    if (
      typeof optionsIn.tableColumns !== 'object' ||
      Array.isArray(optionsIn.tableColumns)
    )
      throw badRequest(
        'options.tableColumns must map columns to their display',
      );
    const tableColumns: Record<string, TableColumnOptions> = {};
    for (const [column, value] of Object.entries(
      optionsIn.tableColumns as Record<string, unknown>,
    )) {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw badRequest(`options.tableColumns.${column} must be an object`);
      const entry = value as Record<string, unknown>;
      const display: TableColumnOptions = {};
      if (entry.text) display.text = true;
      if (entry.monospace) display.monospace = true;
      if (typeof entry.condensed === 'boolean')
        display.condensed = entry.condensed;
      if (
        entry.align !== undefined &&
        entry.align !== null &&
        entry.align !== ''
      ) {
        if (
          typeof entry.align !== 'string' ||
          !['left', 'center', 'right'].includes(entry.align)
        )
          throw badRequest(
            `options.tableColumns.${column}.align must be left, center or right`,
          );
        display.align = entry.align as TableColumnOptions['align'];
      }
      if (
        entry.width !== undefined &&
        entry.width !== null &&
        entry.width !== ''
      ) {
        const width = Number(entry.width);
        if (!Number.isInteger(width) || width < 40 || width > 1_000)
          throw badRequest(
            `options.tableColumns.${column}.width must be from 40 to 1000`,
          );
        display.width = width;
      }
      if (Object.keys(display).length) tableColumns[column] = display;
    }
    if (Object.keys(tableColumns).length) options.tableColumns = tableColumns;
  }
  parseDrawing(optionsIn, options);

  const sql = string(raw.sql, 'sql');
  if (sql && sql.length > 50_000) throw badRequest('sql is too long');
  const builder =
    !sql && raw.builder !== undefined && raw.builder !== null
      ? parseBuilder(raw.builder)
      : undefined;
  return {
    steps: parseSteps(raw.steps),
    encoding,
    options,
    ...(sql ? { sql } : {}),
    ...(builder ? { builder } : {}),
  };
}

/**
 * A config ready to store or run: a builder's steps, axes and derived
 * options compiled for the chart type, over what the chart sets itself
 * (stacked, caption, page size…). Configs without a builder pass through.
 */
export function finalizeConfig(
  type: VisualizationType,
  config: VisualizationConfig,
): VisualizationConfig {
  if (!config.builder) return config;
  const compiled = compileBuilder(type, config.builder);
  const options: Options = { ...config.options };
  // The builder decides the plotted format and the series order; headers and
  // per-column formats it sets are laid over any the chart has of its own.
  for (const key of ['format', 'seriesOrder'] as const) {
    const value = compiled.options[key];
    if (value === undefined) delete options[key];
    else (options as Record<string, unknown>)[key] = value;
  }
  for (const key of ['formats', 'labels'] as const) {
    const merged = { ...options[key], ...compiled.options[key] };
    if (Object.keys(merged).length)
      (options as Record<string, unknown>)[key] = merged;
    else delete options[key];
  }
  if (compiled.options.columns && !options.columns)
    options.columns = compiled.options.columns;
  else if (type !== 'table') delete options.columns;
  return {
    steps: compiled.steps,
    encoding: compiled.encoding,
    options,
    builder: config.builder,
  };
}

/**
 * The dashboard variables a chart reads: what its steps filter on or take
 * their window from, and the `{{name}}`s of its SQL. A chart that reads none
 * of a changed variable keeps its data, so the page only redraws, and only
 * says it is updating, what can change.
 */
export function variablesOf(config: VisualizationConfig): Set<string> {
  const names = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      const entry = value as Record<string, unknown>;
      if (typeof entry.var === 'string' && Object.keys(entry).length === 1)
        names.add(entry.var);
      Object.values(entry).forEach(walk);
    }
  };
  for (const step of config.steps) {
    if (step.op === 'range' && step.window === undefined)
      names.add(step.var ?? 'range');
    if (step.op === 'bucket' && step.unit === 'auto')
      names.add(step.var ?? 'range');
    walk(step);
  }
  if (config.sql) {
    for (const match of config.sql.matchAll(
      /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi,
    ))
      if (match[1] !== 'result') names.add(match[1]);
  }
  return names;
}

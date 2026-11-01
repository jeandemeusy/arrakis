import { badRequest } from '../api/errors';
import { STORAGE_TYPE, type ColumnType } from '../query/columns';
import { asText } from './text';

/**
 * Transform steps: how a visualization shapes a stored result.
 *
 * A result is raw rows — every redemption, every deployment — and each chart
 * wants a different aggregate of them: volume per day, distinct users over a
 * trailing week, a relay's share, an hour-of-week grid. The steps say how,
 * declaratively, and `buildSql` turns them into one SQL statement over the
 * result table, a CTE per step. Editors configure steps in the UI; they never
 * write this SQL, so every identifier is checked against the columns the
 * previous step produced and every value travels as a bind parameter.
 *
 * Steps run in order. Each one sees the columns the one before it produced,
 * which is tracked here alongside the SQL so a step naming a column that no
 * longer exists fails with a message instead of a database error.
 */

export type ValueRef =
  | { literal: string | number | boolean | null }
  | { var: string };

export type Measure = {
  fn: 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max';
  /** Empty for count(*); several for a count of distinct combinations. */
  columns?: string[];
  as: string;
};

export type Step =
  | {
      op: 'filter';
      column: string;
      operator:
        | '='
        | '!='
        | '>'
        | '>='
        | '<'
        | '<='
        | 'contains'
        | 'in'
        | 'is_null'
        | 'not_null';
      value?: ValueRef;
      /** Skip the step when the variable it reads is unset, rather than match nothing. */
      optional?: boolean;
    }
  | {
      op: 'range';
      column: string;
      /**
       * The variable holding the window: `7d`, `30d`, `12h`, `6m` or `all` for
       * a date or time column; a count such as `500000` for a number column
       * (the last 500,000 blocks).
       */
      var?: string;
      /** A fixed window instead of a variable's, e.g. `31d` for a monthly figure. */
      window?: string;
      /**
       * Count back from the newest row (default) or from now. A number column
       * has no now: it counts back from its newest value, or from the value in
       * `anchorColumn` — the chain's head block, say, carried on every row.
       */
      anchor?: 'latest' | 'now';
      anchorColumn?: string;
    }
  | {
      op: 'bucket';
      column: string;
      /**
       * `auto` is by day for a range variable of up to 31 days and by week
       * beyond, so one chart reads well at every range a dashboard offers. On
       * a number column it bins: `size` wide, or for `auto` about forty bins
       * over the window (a round 1, 2 or 5 × 10ⁿ), each named by its start.
       */
      unit:
        | 'auto'
        | 'hour'
        | 'day'
        | 'week'
        | 'month'
        | 'hour_of_day'
        | 'day_of_week';
      as: string;
      /** The range variable `auto` reads; `range` when unset. */
      var?: string;
      /** A fixed window `auto` reads instead of the variable. */
      window?: string;
      /** A number column's bin width. */
      size?: number;
    }
  | {
      op: 'compute';
      as: string;
      left: string;
      operator: '+' | '-' | '*' | '/' | 'days_between' | 'months_between';
      right: string | { literal: number };
    }
  | {
      op: 'window';
      as: string;
      fn:
        | 'min'
        | 'max'
        | 'sum'
        | 'count'
        | 'first_value'
        | 'row_number'
        | 'rank';
      column?: string;
      partitionBy?: string[];
      orderBy?: Array<{ column: string; desc?: boolean }>;
    }
  | { op: 'aggregate'; groupBy: string[]; measures: Measure[] }
  | {
      op: 'rolling';
      /** A date column; the window is `days` days ending on each date. */
      time: string;
      days: number;
      groupBy?: string[];
      measures: Measure[];
      /** Emit every date between the first and the last, not only those with rows. */
      fill?: boolean;
    }
  | {
      op: 'top';
      column: string;
      by: string;
      n: number;
      others?: string;
      /** Columns summed when the long tail is folded into `others`. */
      sum: string[];
    }
  | { op: 'sort'; by: Array<{ column: string; desc?: boolean }> }
  | { op: 'limit'; n: number };

export type Column = { name: string; type: ColumnType };

export type Base = {
  /** SQL for the starting relation; its columns are `columns`. */
  sql: string;
  columns: Column[];
};

export type Built = { sql: string; values: unknown[]; columns: Column[] };

export const MAX_ROWS = 50_000;
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const NUMERIC: ColumnType[] = ['integer', 'bigint', 'float', 'numeric'];
const TEMPORAL: ColumnType[] = ['date', 'timestamp', 'timestamptz'];
const RANGE = /^(\d{1,4})(h|d|w|m)$/;

export function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** How many days a range spans, or null for `all` and anything unreadable. */
export function rangeDays(value: unknown): number | null {
  const match = RANGE.exec(asText(value ?? ''));
  if (!match) return null;
  const amount = Number(match[1]);
  return { h: amount / 24, d: amount, w: amount * 7, m: amount * 31 }[
    match[2] as 'h' | 'd' | 'w' | 'm'
  ];
}

const COUNT = /^\d{1,15}$/;

/**
 * Parses a range variable over a number column — how many units back, e.g.
 * `500000` blocks — or null for `all`.
 */
export function rangeCount(value: unknown): number | null {
  if (
    value === undefined ||
    value === null ||
    value === '' ||
    value === 'all'
  ) {
    return null;
  }
  const text = asText(value).trim();
  if (!COUNT.test(text) || Number(text) < 1)
    throw badRequest(
      `A range over a number column must be a whole count, like 500000, or all; got ${text}`,
    );
  return Number(text);
}

/** The smallest round width (1, 2 or 5 × 10ⁿ) at least `raw`. */
export function niceSize(raw: number): number {
  if (!(raw > 1)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const step of [1, 2, 5, 10]) {
    if (step * power >= raw) return step * power;
  }
  return 10 * power;
}

/** Parses a range variable into a PostgreSQL interval, or null for `all`. */
export function rangeInterval(value: unknown): string | null {
  if (
    value === undefined ||
    value === null ||
    value === '' ||
    value === 'all'
  ) {
    return null;
  }
  const match = RANGE.exec(asText(value));
  if (!match)
    throw badRequest(
      `Range must look like 7d, 12h, 6m or all; got ${asText(value)}`,
    );
  const amount = Number(match[1]);
  const unit = { h: 'hours', d: 'days', w: 'weeks', m: 'months' }[
    match[2] as 'h' | 'd' | 'w' | 'm'
  ];
  return `${amount} ${unit}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Checks the shape of a steps array from untrusted input. */
export function parseSteps(input: unknown): Step[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw badRequest('steps must be an array');
  if (input.length > 40) throw badRequest('At most 40 steps');
  return input.map((raw, index) => {
    if (!isObject(raw) || typeof raw.op !== 'string') {
      throw badRequest(`steps[${index}] needs an op`);
    }
    // Structure is checked here; columns and names when the SQL is built,
    // where the columns in scope are known.
    return raw as unknown as Step;
  });
}

type Scope = Column[];

function find(scope: Scope, name: unknown, where: string): Column {
  if (typeof name !== 'string')
    throw badRequest(`${where}: a column is required`);
  const column = scope.find((entry) => entry.name === name);
  if (!column) {
    throw badRequest(
      `${where}: no column "${name}"; available: ${scope.map((entry) => entry.name).join(', ')}`,
    );
  }
  return column;
}

function fresh(scope: Scope, name: unknown, where: string): string {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw badRequest(
      `${where}: "${String(name)}" is not a valid column name (lowercase letters, digits, _)`,
    );
  }
  if (scope.some((entry) => entry.name === name)) {
    throw badRequest(`${where}: column "${name}" already exists`);
  }
  return name;
}

function measureSql(
  measure: Measure,
  scope: Scope,
  where: string,
  prefix = '',
): { sql: string; column: Column } {
  const columns = (measure.columns ?? []).map((name) =>
    find(scope, name, where),
  );
  const ref = (column: Column) => `${prefix}${quote(column.name)}`;
  let sql: string;
  let type: ColumnType;
  switch (measure.fn) {
    case 'count':
      sql = columns.length
        ? `count(${columns.length > 1 ? `(${columns.map(ref).join(', ')})` : ref(columns[0])})`
        : 'count(*)';
      type = 'bigint';
      break;
    case 'count_distinct':
      if (!columns.length)
        throw badRequest(`${where}: count_distinct needs a column`);
      sql = `count(DISTINCT ${columns.length > 1 ? `(${columns.map(ref).join(', ')})` : ref(columns[0])})`;
      type = 'bigint';
      break;
    case 'sum':
    case 'avg':
    case 'min':
    case 'max': {
      if (columns.length !== 1)
        throw badRequest(`${where}: ${measure.fn} needs one column`);
      const [column] = columns;
      if (
        (measure.fn === 'sum' || measure.fn === 'avg') &&
        !NUMERIC.includes(column.type)
      ) {
        throw badRequest(
          `${where}: ${measure.fn} needs a numeric column; "${column.name}" is ${column.type}`,
        );
      }
      sql = `${measure.fn}(${ref(column)})`;
      type =
        measure.fn === 'sum' || measure.fn === 'avg'
          ? column.type === 'float'
            ? 'float'
            : 'numeric'
          : column.type;
      break;
    }
    default:
      throw badRequest(
        `${where}: unknown measure ${String((measure as Measure).fn)}`,
      );
  }
  return { sql, column: { name: measure.as, type } };
}

function measuresOf(input: unknown, where: string): Measure[] {
  if (!Array.isArray(input) || !input.length) {
    throw badRequest(`${where}: at least one measure is needed`);
  }
  return input as Measure[];
}

function namesOf(input: unknown, where: string): string[] {
  if (input === undefined) return [];
  if (
    !Array.isArray(input) ||
    !input.every((entry) => typeof entry === 'string')
  ) {
    throw badRequest(`${where}: expected a list of columns`);
  }
  return input as string[];
}

/**
 * Builds the statement for `steps` over `base`.
 *
 * `vars` are the dashboard's variables at render time (range, a selected
 * client, …). They are bound, never interpolated.
 */
export function buildSql(
  base: Base,
  steps: Step[],
  vars: Record<string, string | undefined>,
): Built {
  const values: unknown[] = [];
  const bind = (value: unknown, cast: string) => {
    values.push(value);
    return `$${values.length}::${cast}`;
  };
  const ctes: string[] = [`s0 AS (${base.sql})`];
  let scope: Scope = base.columns;
  let current = 's0';
  // The most recent sort. SQL does not promise that one CTE's ORDER BY survives
  // into the next, so it is re-applied wherever order matters: a later limit,
  // and the final select.
  let order: Array<{ column: string; desc?: boolean }> = [];
  const orderSql = () => {
    const live = order.filter((entry) =>
      scope.some((c) => c.name === entry.column),
    );
    return live.length
      ? ` ORDER BY ${live.map((entry) => `${quote(entry.column)}${entry.desc ? ' DESC' : ''} NULLS LAST`).join(', ')}`
      : '';
  };

  const add = (sql: string, next: Scope) => {
    const name = `s${ctes.length}`;
    ctes.push(`${name} AS (${sql})`);
    current = name;
    scope = next;
  };
  const all = () => scope.map((column) => quote(column.name)).join(', ');

  const valueOf = (ref: ValueRef | undefined, where: string): unknown => {
    if (!ref) return null;
    if ('var' in ref) return vars[ref.var] ?? null;
    if ('literal' in ref) return ref.literal;
    throw badRequest(`${where}: value must be {literal} or {var}`);
  };

  steps.forEach((step, index) => {
    const where = `Step ${index + 1} (${step.op})`;
    switch (step.op) {
      case 'filter': {
        const column = find(scope, step.column, where);
        const col = quote(column.name);
        const raw = valueOf(step.value, where);
        if (step.operator === 'is_null' || step.operator === 'not_null') {
          add(
            `SELECT * FROM ${current} WHERE ${col} IS ${step.operator === 'is_null' ? '' : 'NOT '}NULL`,
            scope,
          );
          return;
        }
        if (raw === null || raw === '') {
          if (step.optional) return;
          // A required filter with nothing to compare against matches nothing,
          // rather than silently showing everything.
          add(`SELECT * FROM ${current} WHERE FALSE`, scope);
          return;
        }
        if (step.operator === 'contains') {
          const text =
            column.type === 'bytes'
              ? `'0x' || encode(${col}, 'hex')`
              : `${col}::text`;
          add(
            `SELECT * FROM ${current} WHERE ${text} ILIKE '%' || ${bind(asText(raw), 'text')} || '%'`,
            scope,
          );
          return;
        }
        const convert = (value: unknown) => {
          if (column.type === 'bytes') {
            const hex = String(value).trim().toLowerCase();
            if (!/^0x([0-9a-f]{2})*$/.test(hex)) {
              throw badRequest(`${where}: "${hex}" is not 0x-prefixed hex`);
            }
            return Buffer.from(hex.slice(2), 'hex');
          }
          return value;
        };
        const cast = STORAGE_TYPE[column.type];
        if (step.operator === 'in') {
          const list = (Array.isArray(raw) ? raw : asText(raw).split(','))
            .map((entry) => (typeof entry === 'string' ? entry.trim() : entry))
            .filter((entry) => entry !== '')
            .map(convert);
          add(
            `SELECT * FROM ${current} WHERE ${col} = ANY (${bind(list, `${cast}[]`)})`,
            scope,
          );
          return;
        }
        const operators = ['=', '!=', '>', '>=', '<', '<='];
        if (!operators.includes(step.operator)) {
          throw badRequest(
            `${where}: unknown operator ${String(step.operator)}`,
          );
        }
        const sqlOperator = step.operator === '!=' ? '<>' : step.operator;
        add(
          `SELECT * FROM ${current} WHERE ${col} ${sqlOperator} ${bind(convert(raw), cast)}`,
          scope,
        );
        return;
      }

      case 'range': {
        const column = find(scope, step.column, where);
        const col = quote(column.name);
        if (NUMERIC.includes(column.type)) {
          const count = rangeCount(step.window ?? vars[step.var ?? 'range']);
          if (count === null) return;
          const anchor = step.anchorColumn
            ? quote(find(scope, step.anchorColumn, where).name)
            : `(SELECT max(${col}) FROM ${current})`;
          // The newest value and the count-1 before it: 10 blocks back from
          // 100 is 91 to 100.
          add(
            `SELECT * FROM ${current} WHERE ${col} > ${anchor} - ${bind(count, 'numeric')}`,
            scope,
          );
          return;
        }
        if (!TEMPORAL.includes(column.type)) {
          throw badRequest(
            `${where}: "${column.name}" is ${column.type}, not a date, a time or a number`,
          );
        }
        const interval = rangeInterval(
          step.window ?? vars[step.var ?? 'range'],
        );
        if (!interval) return;
        const anchor =
          step.anchor === 'now'
            ? column.type === 'date'
              ? 'current_date'
              : 'now()'
            : `(SELECT max(${col}) FROM ${current})`;
        // Dates count whole days: 7d is the newest day and the six before it,
        // matching how the dashboard has always counted a week.
        const condition =
          column.type === 'date'
            ? `${col} > (${anchor} - ${bind(interval, 'interval')})::date`
            : `${col} > ${anchor} - ${bind(interval, 'interval')}`;
        add(`SELECT * FROM ${current} WHERE ${condition}`, scope);
        return;
      }

      case 'bucket': {
        const column = find(scope, step.column, where);
        const as = fresh(scope, step.as, where);
        const col = quote(column.name);
        if (NUMERIC.includes(column.type)) {
          let width: string;
          if (step.size !== undefined) {
            const size = Number(step.size);
            if (!(size > 0) || !Number.isFinite(size))
              throw badRequest(`${where}: size must be a positive number`);
            width = bind(size, 'numeric');
          } else if (step.unit === 'auto') {
            const count = rangeCount(step.window ?? vars[step.var ?? 'range']);
            // Without a window, about forty bins over whatever the rows span.
            width =
              count !== null
                ? bind(niceSize(count / 40), 'numeric')
                : `(SELECT CASE
                       WHEN span <= 40 THEN 1
                       ELSE p * CASE
                         WHEN span / 40 <= p THEN 1
                         WHEN span / 40 <= 2 * p THEN 2
                         WHEN span / 40 <= 5 * p THEN 5
                         ELSE 10 END
                     END
                   FROM (SELECT span, power(10, floor(log(10, GREATEST(span / 40, 1)))) AS p
                         FROM (SELECT (max(${col}) - min(${col}))::numeric AS span FROM ${current}) AS r) AS w)`;
          } else {
            throw badRequest(
              `${where}: a number column bins by size or auto, not ${String(step.unit)}`,
            );
          }
          const whole = column.type === 'integer' || column.type === 'bigint';
          add(
            `SELECT *, (floor(${col}::numeric / ${width}) * ${width})${whole ? '::bigint' : ''} AS ${quote(as)} FROM ${current}`,
            [...scope, { name: as, type: whole ? 'bigint' : 'numeric' }],
          );
          return;
        }
        if (!TEMPORAL.includes(column.type)) {
          throw badRequest(
            `${where}: "${column.name}" is ${column.type}, not a date, a time or a number`,
          );
        }
        const ts = column.type === 'date' ? `${col}::timestamp` : col;
        let expression: string;
        let type: ColumnType;
        const unit =
          step.unit === 'auto'
            ? (rangeDays(step.window ?? vars[step.var ?? 'range']) ??
                Infinity) <= 31
              ? 'day'
              : 'week'
            : step.unit;
        switch (unit) {
          case 'hour':
            expression = `date_trunc('hour', ${ts})`;
            type = column.type === 'timestamptz' ? 'timestamptz' : 'timestamp';
            break;
          case 'day':
          case 'week':
          case 'month':
            expression = `date_trunc('${unit}', ${ts})::date`;
            type = 'date';
            break;
          case 'hour_of_day':
            expression = `extract(hour FROM ${ts})::integer`;
            type = 'integer';
            break;
          case 'day_of_week':
            // ISO: Monday is 1, Sunday is 7.
            expression = `extract(isodow FROM ${ts})::integer`;
            type = 'integer';
            break;
          default:
            throw badRequest(
              `${where}: unknown unit ${String((step as { unit: unknown }).unit)}`,
            );
        }
        add(`SELECT *, ${expression} AS ${quote(as)} FROM ${current}`, [
          ...scope,
          { name: as, type },
        ]);
        return;
      }

      case 'compute': {
        const as = fresh(scope, step.as, where);
        const left = find(scope, step.left, where);
        const rightSql =
          typeof step.right === 'string'
            ? quote(find(scope, step.right, where).name)
            : bind(Number(step.right?.literal), 'numeric');
        const l = quote(left.name);
        let expression: string;
        let type: ColumnType;
        switch (step.operator) {
          case '+':
          case '-':
          case '*':
            expression = `(${l})::numeric ${step.operator} (${rightSql})::numeric`;
            type = 'numeric';
            break;
          case '/':
            expression = `(${l})::numeric / NULLIF((${rightSql})::numeric, 0)`;
            type = 'numeric';
            break;
          case 'days_between':
            expression = `(${l})::date - (${rightSql})::date`;
            type = 'integer';
            break;
          case 'months_between':
            expression =
              `((extract(year FROM ${l}) - extract(year FROM ${rightSql})) * 12 + ` +
              `extract(month FROM ${l}) - extract(month FROM ${rightSql}))::integer`;
            type = 'integer';
            break;
          default:
            throw badRequest(
              `${where}: unknown operator ${String((step as { operator: unknown }).operator)}`,
            );
        }
        add(`SELECT *, ${expression} AS ${quote(as)} FROM ${current}`, [
          ...scope,
          { name: as, type },
        ]);
        return;
      }

      case 'window': {
        const as = fresh(scope, step.as, where);
        const partition = namesOf(step.partitionBy, where).map((name) =>
          quote(find(scope, name, where).name),
        );
        const order = (step.orderBy ?? []).map(
          (entry) =>
            `${quote(find(scope, entry.column, where).name)}${entry.desc ? ' DESC' : ''}`,
        );
        const over = `OVER (${partition.length ? `PARTITION BY ${partition.join(', ')}` : ''}${
          order.length ? ` ORDER BY ${order.join(', ')}` : ''
        }${
          // Running sums and counts need an ordered frame; first_value and
          // min/max over the whole partition need the default, unbounded one.
          order.length && ['min', 'max', 'first_value'].includes(step.fn)
            ? ' ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING'
            : ''
        })`;
        let expression: string;
        let type: ColumnType;
        if (step.fn === 'row_number' || step.fn === 'rank') {
          expression = `${step.fn}() ${over}`;
          type = 'bigint';
        } else if (step.fn === 'count') {
          expression = `count(*) ${over}`;
          type = 'bigint';
        } else {
          const column = find(scope, step.column, where);
          if (step.fn === 'sum' && !NUMERIC.includes(column.type)) {
            throw badRequest(`${where}: sum needs a numeric column`);
          }
          expression = `${step.fn}(${quote(column.name)}) ${over}`;
          type = step.fn === 'sum' ? 'numeric' : column.type;
        }
        add(`SELECT *, ${expression} AS ${quote(as)} FROM ${current}`, [
          ...scope,
          { name: as, type },
        ]);
        return;
      }

      case 'aggregate': {
        order = [];
        const groups = namesOf(step.groupBy, where).map((name) =>
          find(scope, name, where),
        );
        const measures = measuresOf(step.measures, where).map((measure) => {
          fresh(groups, measure.as, where);
          return measureSql(measure, scope, where);
        });
        const keys = groups.map((column) => quote(column.name));
        add(
          `SELECT ${[...keys, ...measures.map((m) => `${m.sql} AS ${quote(m.column.name)}`)].join(', ')} FROM ${current}${
            keys.length ? ` GROUP BY ${keys.join(', ')}` : ''
          }`,
          [...groups, ...measures.map((m) => m.column)],
        );
        return;
      }

      case 'rolling': {
        order = [];
        const time = find(scope, step.time, where);
        if (time.type !== 'date') {
          throw badRequest(
            `${where}: rolling windows need a date column; bucket "${time.name}" by day first`,
          );
        }
        const days = Number(step.days);
        if (!Number.isInteger(days) || days < 1 || days > 3_650) {
          throw badRequest(`${where}: days must be from 1 to 3650`);
        }
        const groups = namesOf(step.groupBy, where).map((name) =>
          find(scope, name, where),
        );
        const measures = measuresOf(step.measures, where).map((measure) => {
          fresh([...groups, time], measure.as, where);
          return measureSql(measure, scope, where, 's.');
        });
        const t = quote(time.name);
        const keys = groups.map((column) => quote(column.name));
        const anchors = step.fill
          ? `SELECT ${keys.length ? `g.*, ` : ''}d::date AS ${t}
             FROM generate_series((SELECT min(${t}) FROM ${current}), (SELECT max(${t}) FROM ${current}), interval '1 day') AS d
             ${keys.length ? `CROSS JOIN (SELECT DISTINCT ${keys.join(', ')} FROM ${current}) AS g` : ''}`
          : `SELECT DISTINCT ${[...keys, t].join(', ')} FROM ${current}`;
        const joinKeys = keys
          .map((key) => ` AND s.${key} IS NOT DISTINCT FROM a.${key}`)
          .join('');
        add(
          `SELECT ${[...keys.map((key) => `a.${key}`), `a.${t}`, ...measures.map((m) => `${m.sql} AS ${quote(m.column.name)}`)].join(', ')}
           FROM (${anchors}) AS a
           LEFT JOIN ${current} AS s
             ON s.${t} > a.${t} - ${days} AND s.${t} <= a.${t}${joinKeys}
           GROUP BY ${[...keys.map((key) => `a.${key}`), `a.${t}`].join(', ')}`,
          [...groups, time, ...measures.map((m) => m.column)],
        );
        return;
      }

      case 'top': {
        order = [];
        const column = find(scope, step.column, where);
        const by = find(scope, step.by, where);
        const n = Number(step.n);
        if (!Number.isInteger(n) || n < 1 || n > 500) {
          throw badRequest(`${where}: n must be from 1 to 500`);
        }
        const summed = namesOf(step.sum, where).map((name) =>
          find(scope, name, where),
        );
        if (!summed.some((entry) => entry.name === by.name)) summed.push(by);
        for (const entry of summed) {
          if (!NUMERIC.includes(entry.type)) {
            throw badRequest(
              `${where}: "${entry.name}" is not numeric and cannot be summed`,
            );
          }
        }
        const keep = scope.filter(
          (entry) =>
            entry.name !== column.name &&
            !summed.some((s) => s.name === entry.name),
        );
        const col = quote(column.name);
        // Bytes read as 0x-hex, the way they read everywhere else, rather
        // than PostgreSQL's own \x escape form.
        const asLabel =
          column.type === 'bytes'
            ? `'0x' || encode(${col}, 'hex')`
            : `${col}::text`;
        const label = `CASE WHEN ${col} IN (
             SELECT ${col} FROM ${current} GROUP BY ${col}
             ORDER BY sum(${quote(by.name)}) DESC NULLS LAST LIMIT ${n}
           ) THEN ${asLabel} ELSE ${bind(step.others ?? 'Others', 'text')} END`;
        const keepCols = keep.map((entry) => quote(entry.name));
        add(
          `SELECT ${[`${label} AS ${col}`, ...keepCols, ...summed.map((entry) => `sum(${quote(entry.name)}) AS ${quote(entry.name)}`)].join(', ')}
           FROM ${current}
           GROUP BY ${[label, ...keepCols].join(', ')}`,
          [
            { name: column.name, type: 'text' },
            ...keep,
            ...summed.map((entry) => ({
              name: entry.name,
              type: (entry.type === 'float'
                ? 'float'
                : 'numeric') as ColumnType,
            })),
          ],
        );
        return;
      }

      case 'sort': {
        if (!Array.isArray(step.by) || !step.by.length) {
          throw badRequest(`${where}: choose at least one column`);
        }
        for (const entry of step.by) find(scope, entry.column, where);
        order = step.by.map((entry) => ({
          column: entry.column,
          desc: Boolean(entry.desc),
        }));
        add(`SELECT * FROM ${current}${orderSql()}`, scope);
        return;
      }

      case 'limit': {
        const n = Number(step.n);
        if (!Number.isInteger(n) || n < 1 || n > MAX_ROWS) {
          throw badRequest(`${where}: n must be from 1 to ${MAX_ROWS}`);
        }
        add(`SELECT * FROM ${current}${orderSql()} LIMIT ${n}`, scope);
        return;
      }

      default:
        throw badRequest(`${where}: unknown step`);
    }
  });

  return {
    sql: `WITH ${ctes.join(',\n')}\nSELECT ${all()} FROM ${current}${orderSql()} LIMIT ${MAX_ROWS + 1}`,
    values,
    columns: scope,
  };
}

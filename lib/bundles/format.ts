import { badRequest } from '../api/errors';
import { segments } from '../query/scan';

/**
 * A bundle: dashboards, the charts on them and the queries behind those
 * charts, as one JSON file another Arrakis can import.
 *
 * Exported from any dashboard, imported from a file or a URL. Everything in it
 * is what the studio would have created by hand — queries with their SQL,
 * charts with their config, dashboards with their layout — so an imported
 * dashboard is edited like any other. Charts carry a key that stays the same
 * from one export to the next, so importing a newer version of a bundle
 * updates what the last import created instead of duplicating it.
 */

export const BUNDLE_FORMAT = 'arrakis-bundle';
export const BUNDLE_VERSION = 1;

export type BundleQuery = {
  slug: string;
  title: string;
  description: string;
  kind: 'query' | 'fragment';
  sql: string;
  parameters: unknown[];
  /** Seconds between scheduled refreshes; queries only. */
  refreshSeconds?: number | null;
  /** `hidden` for figures that only mean something per data source. */
  combine?: 'concat' | 'hidden';
  timeoutSeconds?: number | null;
  rowLimit?: number | null;
};

/** A list the queries read: created empty if missing; values stay local. */
export type BundleList = {
  name: string;
  type: 'text' | 'number' | 'bytes';
  description: string;
};

export type BundleChart = {
  /** Stable across exports: what a later import of the same bundle updates. */
  key: string;
  query: string;
  title: string;
  description: string;
  type: string;
  config: unknown;
};

export type BundleWidget =
  | {
      kind: 'visualization';
      chart: string;
      width: number;
      height: number;
      options: Record<string, unknown>;
    }
  | {
      kind: 'text';
      text: string;
      width: number;
      height: number;
      options: Record<string, unknown>;
    };

export type BundleDashboard = {
  slug: string;
  title: string;
  description: string;
  visibility: 'private' | 'unlisted' | 'public';
  variables: unknown[];
  widgets: BundleWidget[];
};

export type Bundle = {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  /** A slug: what the imported items are marked with. */
  name: string;
  title: string;
  description: string;
  exportedAt?: string;
  /** The lists its queries read, by definition: their values stay local. */
  lists: BundleList[];
  /** Fragments before the queries that use them. */
  queries: BundleQuery[];
  charts: BundleChart[];
  /** The first is the bundle's main dashboard. */
  dashboards: BundleDashboard[];
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

type Raw = Record<string, unknown>;

function object(input: unknown, where: string): Raw {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw badRequest(`${where} must be an object`);
  return input as Raw;
}

function list(input: unknown, where: string, max: number): unknown[] {
  if (!Array.isArray(input)) throw badRequest(`${where} must be a list`);
  if (input.length > max)
    throw badRequest(`${where} has more than ${max} entries`);
  return input;
}

function text(
  raw: Raw,
  key: string,
  where: string,
  options: { required?: boolean; max: number },
): string {
  const value = raw[key];
  if (value === undefined || value === null) {
    if (options.required) throw badRequest(`${where}.${key} is required`);
    return '';
  }
  if (typeof value !== 'string')
    throw badRequest(`${where}.${key} must be text`);
  if (value.length > options.max)
    throw badRequest(
      `${where}.${key} is longer than ${options.max} characters`,
    );
  if (options.required && !value.trim())
    throw badRequest(`${where}.${key} must not be empty`);
  return value;
}

function slug(raw: Raw, key: string, where: string): string {
  const value = text(raw, key, where, { required: true, max: 80 });
  if (!SLUG.test(value))
    throw badRequest(
      `${where}.${key} must be lowercase letters, digits and dashes`,
    );
  return value;
}

function optionalNumber(raw: Raw, key: string, where: string): number | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw badRequest(`${where}.${key} must be a number`);
  return value;
}

function oneOf<T extends string>(
  raw: Raw,
  key: string,
  where: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (!values.includes(value as T))
    throw badRequest(`${where}.${key} must be one of ${values.join(', ')}`);
  return value as T;
}

/**
 * Checks a bundle's shape, so an import fails on a bad file with a message
 * that says where, rather than halfway through installing it. What each item
 * means (valid SQL, a drawable chart) is checked by the same store functions
 * the studio uses, as the import creates it.
 */
export function parseBundle(input: unknown): Bundle {
  const raw = object(input, 'bundle');
  if (raw.format !== BUNDLE_FORMAT)
    throw badRequest(
      `Not an Arrakis bundle: "format" must be "${BUNDLE_FORMAT}"`,
    );
  if (raw.version !== BUNDLE_VERSION)
    throw badRequest(
      `This Arrakis reads bundle version ${BUNDLE_VERSION}; the file is version ${String(raw.version)}`,
    );

  const lists = (
    raw.lists === undefined ? [] : list(raw.lists, 'lists', 100)
  ).map((entry, at) => {
    const where = `lists[${at}]`;
    const item = object(entry, where);
    const name = text(item, 'name', where, { required: true, max: 63 });
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name))
      throw badRequest(`${where}.name must be letters, digits and _`);
    return {
      name,
      type: oneOf(
        item,
        'type',
        where,
        ['text', 'number', 'bytes'] as const,
        'text',
      ),
      description: text(item, 'description', where, { max: 2_000 }),
    } satisfies BundleList;
  });

  const queries = list(raw.queries, 'queries', 500).map((entry, at) => {
    const where = `queries[${at}]`;
    const query = object(entry, where);
    const kind = oneOf(
      query,
      'kind',
      where,
      ['query', 'fragment'] as const,
      'query',
    );
    return {
      slug: slug(query, 'slug', where),
      title: text(query, 'title', where, { required: true, max: 200 }),
      description: text(query, 'description', where, { max: 5_000 }),
      kind,
      sql: text(query, 'sql', where, { required: true, max: 200_000 }),
      parameters:
        query.parameters === undefined
          ? []
          : list(query.parameters, `${where}.parameters`, 50),
      refreshSeconds:
        kind === 'query'
          ? optionalNumber(query, 'refreshSeconds', where)
          : null,
      combine: oneOf(
        query,
        'combine',
        where,
        ['concat', 'hidden'] as const,
        'concat',
      ),
      timeoutSeconds: optionalNumber(query, 'timeoutSeconds', where),
      rowLimit:
        kind === 'query' ? optionalNumber(query, 'rowLimit', where) : null,
    } satisfies BundleQuery;
  });
  const querySlugs = new Set(queries.map((query) => query.slug));
  if (querySlugs.size !== queries.length)
    throw badRequest('Two queries in the bundle have the same slug');

  const charts = list(raw.charts, 'charts', 1_000).map((entry, at) => {
    const where = `charts[${at}]`;
    const chart = object(entry, where);
    const query = slug(chart, 'query', where);
    if (!querySlugs.has(query))
      throw badRequest(
        `${where} is drawn from "${query}", which the bundle does not contain`,
      );
    return {
      key: text(chart, 'key', where, { required: true, max: 120 }),
      query,
      title: text(chart, 'title', where, { required: true, max: 200 }),
      description: text(chart, 'description', where, { max: 2_000 }),
      type: text(chart, 'type', where, { required: true, max: 40 }),
      config: object(chart.config ?? {}, `${where}.config`),
    } satisfies BundleChart;
  });
  const chartKeys = new Set(charts.map((chart) => chart.key));
  if (chartKeys.size !== charts.length)
    throw badRequest('Two charts in the bundle have the same key');

  const dashboards = list(raw.dashboards, 'dashboards', 50).map((entry, at) => {
    const where = `dashboards[${at}]`;
    const dashboard = object(entry, where);
    return {
      slug: slug(dashboard, 'slug', where),
      title: text(dashboard, 'title', where, { required: true, max: 200 }),
      description: text(dashboard, 'description', where, { max: 5_000 }),
      visibility: oneOf(
        dashboard,
        'visibility',
        where,
        ['private', 'unlisted', 'public'] as const,
        'private',
      ),
      variables:
        dashboard.variables === undefined
          ? []
          : list(dashboard.variables, `${where}.variables`, 50),
      widgets: list(dashboard.widgets, `${where}.widgets`, 100).map(
        (item, index) => {
          const at2 = `${where}.widgets[${index}]`;
          const widget = object(item, at2);
          const size = {
            width: optionalNumber(widget, 'width', at2) ?? 6,
            height: optionalNumber(widget, 'height', at2) ?? 280,
            options: object(widget.options ?? {}, `${at2}.options`),
          };
          if (widget.kind === 'text') {
            return {
              kind: 'text' as const,
              text: text(widget, 'text', at2, { max: 20_000 }),
              ...size,
            };
          }
          const chart = text(widget, 'chart', at2, {
            required: true,
            max: 120,
          });
          if (!chartKeys.has(chart))
            throw badRequest(
              `${at2} shows chart "${chart}", which the bundle does not contain`,
            );
          return { kind: 'visualization' as const, chart, ...size };
        },
      ),
    } satisfies BundleDashboard;
  });
  if (!dashboards.length)
    throw badRequest('A bundle needs at least one dashboard');

  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    name: slug(raw, 'name', 'bundle'),
    title: text(raw, 'title', 'bundle', { required: true, max: 200 }),
    description: text(raw, 'description', 'bundle', { max: 5_000 }),
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : undefined,
    lists,
    queries,
    charts,
    dashboards,
  };
}

/** The `{{> slug}}` fragments a query's SQL names, outside comments and strings. */
export function fragmentsNamed(sql: string): string[] {
  const code = segments(sql)
    .filter((segment) => segment.code)
    .map((segment) => segment.text)
    .join(' ');
  return [
    ...new Set(
      [...code.matchAll(/\{\{\s*>\s*([a-z0-9][a-z0-9-]*)/g)].map(
        (match) => match[1],
      ),
    ),
  ];
}

/** The lists a query's SQL reads, outside comments and strings. */
export function listsNamed(sql: string): string[] {
  const code = segments(sql)
    .filter((segment) => segment.code)
    .map((segment) => segment.text)
    .join(' ');
  return [
    ...new Set(
      [
        ...code.matchAll(/\{\{\s*(?:list:([a-z_][a-z0-9_]*)|(exits))\s*\}\}/g),
      ].map((match) => match[1] ?? match[2]),
    ),
  ];
}

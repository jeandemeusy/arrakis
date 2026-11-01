import 'server-only';

import { HttpError, badRequest, notFound } from '../api/errors';
import type { Principal } from '../auth/session';
import { appDb, transaction } from '../db/app';
import {
  finalizeConfig,
  parseConfig,
  parseType,
  type VisualizationConfig,
  type VisualizationType,
} from './config';
import { asText } from './text';

/**
 * Visualizations, dashboards and their widgets.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const VAR_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export type Visualization = {
  id: string;
  query: string;
  queryTitle: string;
  queryVisibility: 'private' | 'unlisted' | 'public';
  title: string;
  description: string;
  type: VisualizationType;
  config: VisualizationConfig;
  createdBy: string | null;
  updatedAt: string;
};

type VisualizationRow = {
  id: string;
  query: string;
  query_title: string;
  query_visibility: Visualization['queryVisibility'];
  title: string;
  description: string;
  type: VisualizationType;
  config: VisualizationConfig;
  created_by: string | null;
  updated_at: Date;
};

const SELECT_VISUALIZATION = `
  SELECT v.id, q.slug AS query, q.title AS query_title,
         q.visibility AS query_visibility, v.title, v.description, v.type,
         v.config, u.username AS created_by, v.updated_at
  FROM visualizations v
  JOIN queries q ON q.id = v.query_id
  LEFT JOIN users u ON u.id = v.created_by
`;

function toVisualization(row: VisualizationRow): Visualization {
  return {
    id: row.id,
    query: row.query,
    queryTitle: row.query_title,
    queryVisibility: row.query_visibility,
    title: row.title,
    description: row.description,
    type: row.type,
    config: row.config,
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function getVisualization(
  id: string,
): Promise<Visualization | null> {
  if (!UUID.test(id)) return null;
  const db = await appDb();
  const { rows } = await db.query<VisualizationRow>(
    `${SELECT_VISUALIZATION} WHERE v.id = $1 AND v.archived_at IS NULL`,
    [id],
  );
  return rows[0] ? toVisualization(rows[0]) : null;
}

export async function listVisualizations(filter: {
  query?: string;
  editor: boolean;
}): Promise<Visualization[]> {
  const db = await appDb();
  const conditions = ['v.archived_at IS NULL', 'q.archived_at IS NULL'];
  const values: unknown[] = [];
  if (filter.query) {
    values.push(filter.query);
    conditions.push(`q.slug = $${values.length}`);
  }
  if (!filter.editor) conditions.push(`q.visibility <> 'private'`);
  const { rows } = await db.query<VisualizationRow>(
    `${SELECT_VISUALIZATION} WHERE ${conditions.join(' AND ')}
     ORDER BY q.slug, v.created_at`,
    values,
  );
  return rows.map(toVisualization);
}

function title(input: unknown, required: boolean): string | undefined {
  if (input === undefined && !required) return undefined;
  if (typeof input !== 'string' || !input.trim()) {
    throw badRequest('title is required');
  }
  return input.trim().slice(0, 200);
}

function description(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'string')
    throw badRequest('description must be a string');
  return input.slice(0, 2_000);
}

export async function createVisualization(
  querySlug: string,
  input: Record<string, unknown>,
  principal: Principal,
): Promise<Visualization> {
  const db = await appDb();
  const { rows: queries } = await db.query<{ id: string; kind: string }>(
    'SELECT id, kind FROM queries WHERE slug = $1 AND archived_at IS NULL',
    [querySlug],
  );
  const query = queries[0];
  if (!query) throw notFound(`No query "${querySlug}"`);
  if (query.kind !== 'query') {
    throw badRequest('A fragment has no stored result to visualize');
  }
  const type = parseType(input.type);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO visualizations (query_id, title, description, type, config, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      query.id,
      title(input.title, true),
      description(input.description) ?? '',
      type,
      JSON.stringify(finalizeConfig(type, parseConfig(input.config))),
      principal.userId,
    ],
  );
  const created = await getVisualization(rows[0].id);
  if (!created) throw new Error('visualization vanished after insert');
  return created;
}

export async function updateVisualization(
  id: string,
  input: Record<string, unknown>,
): Promise<Visualization> {
  const sets: string[] = [];
  const values: unknown[] = [id];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  const newTitle = title(input.title, false);
  if (newTitle !== undefined) set('title', newTitle);
  const newDescription = description(input.description);
  if (newDescription !== undefined) set('description', newDescription);
  if (!UUID.test(id)) throw notFound('No such visualization');
  const db = await appDb();
  const type = input.type !== undefined ? parseType(input.type) : undefined;
  if (type) set('type', type);
  if (input.config !== undefined) {
    // A builder compiles for the chart's type: the new one, or the stored one.
    const kind =
      type ??
      (
        await db.query<{ type: VisualizationType }>(
          'SELECT type FROM visualizations WHERE id = $1',
          [id],
        )
      ).rows[0]?.type ??
      'table';
    set(
      'config',
      JSON.stringify(finalizeConfig(kind, parseConfig(input.config))),
    );
  }
  if (!sets.length) throw badRequest('Nothing to update');
  const { rowCount } = await db.query(
    `UPDATE visualizations SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $1 AND archived_at IS NULL`,
    values,
  );
  if (!rowCount) throw notFound('No such visualization');
  const updated = await getVisualization(id);
  if (!updated) throw new Error('visualization vanished after update');
  return updated;
}

/**
 * Archives a visualization and takes it off every dashboard showing it: a
 * widget pointing at an archived chart would only render an error.
 */
export async function archiveVisualization(id: string): Promise<void> {
  if (!UUID.test(id)) throw notFound('No such visualization');
  await transaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE visualizations SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`,
      [id],
    );
    if (!rowCount) throw notFound('No such visualization');
    await client.query(
      'DELETE FROM dashboard_widgets WHERE visualization_id = $1',
      [id],
    );
  });
}

/* Dashboards. */

export type VariableType = 'range' | 'network' | 'text' | 'select';

export type Variable = {
  name: string;
  label: string;
  type: VariableType;
  default?: string;
  /** For `range` and `select`: the choices, e.g. 7d, 30d, 90d, all. */
  options?: string[];
  /** Display names for some options, e.g. 31d → "Last 30 days". */
  labels?: Record<string, string>;
  /**
   * For the data source variable: whether viewers may pick every source at
   * once, their rows stacked. Absent means yes; dashboards made before the
   * choice existed all offered it.
   */
  stack?: boolean;
};

export type WidgetOptions = {
  title?: string;
  /**
   * Clicking a row or bar sets `var` to that row's `column`, on this dashboard
   * or — with `dashboard` — on another one.
   */
  link?: { column: string; var: string; dashboard?: string };
  /** Shown only while this variable has a value. */
  requires?: string;
  /** The caption under a section heading or text block. */
  note?: string;
};

export type Widget = {
  id: string;
  kind: 'visualization' | 'text';
  visualization: Visualization | null;
  text: string;
  /** Columns of the 12-column grid, 1 to 12. */
  width: number;
  height: number;
  options: WidgetOptions;
};

export type Dashboard = {
  id: string;
  slug: string;
  title: string;
  description: string;
  visibility: 'private' | 'unlisted' | 'public';
  variables: Variable[];
  createdBy: string | null;
  updatedAt: string;
  archivedAt: string | null;
  widgets: Widget[];
};

export function parseVariables(input: unknown): Variable[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw badRequest('variables must be a list');
  const seen = new Set<string>();
  return input.map((raw, index) => {
    const where = `variables[${index}]`;
    if (typeof raw !== 'object' || raw === null)
      throw badRequest(`${where} must be an object`);
    const entry = raw as Record<string, unknown>;
    const name = asText(entry.name ?? '');
    if (!VAR_NAME.test(name))
      throw badRequest(`${where}.name must be lowercase letters, digits or _`);
    if (seen.has(name))
      throw badRequest(`Variable "${name}" is declared twice`);
    seen.add(name);
    const type = entry.type as VariableType;
    if (!['range', 'network', 'text', 'select'].includes(type)) {
      throw badRequest(`${where}.type must be range, network, text or select`);
    }
    const variable: Variable = {
      name,
      label:
        typeof entry.label === 'string' && entry.label.trim()
          ? entry.label.trim().slice(0, 60)
          : name,
      type,
    };
    if (
      entry.default !== undefined &&
      entry.default !== null &&
      entry.default !== ''
    ) {
      variable.default = asText(entry.default).slice(0, 200);
    }
    if (type === 'network' && entry.stack === false) variable.stack = false;
    if (type === 'range' || type === 'select') {
      const options = Array.isArray(entry.options)
        ? entry.options.map(String).filter(Boolean)
        : type === 'range'
          ? ['7d', '30d', '90d', 'all']
          : [];
      if (!options.length)
        throw badRequest(`${where}.options are required for a select`);
      variable.options = options.slice(0, 20);
      if (typeof entry.labels === 'object' && entry.labels !== null) {
        const labels: Record<string, string> = {};
        for (const [option, label] of Object.entries(
          entry.labels as Record<string, unknown>,
        )) {
          if (variable.options.includes(option) && typeof label === 'string')
            if (label.trim()) labels[option] = label.trim().slice(0, 40);
        }
        if (Object.keys(labels).length) variable.labels = labels;
      }
    }
    return variable;
  });
}

type DashboardRow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  visibility: Dashboard['visibility'];
  variables: Variable[];
  created_by: string | null;
  updated_at: Date;
  archived_at: Date | null;
};

const SELECT_DASHBOARD = `
  SELECT d.id, d.slug, d.title, d.description, d.visibility, d.variables,
         u.username AS created_by, d.updated_at, d.archived_at
  FROM dashboards d LEFT JOIN users u ON u.id = d.created_by
`;

async function widgetsOf(dashboardId: string): Promise<Widget[]> {
  const db = await appDb();
  const { rows } = await db.query<{
    id: string;
    kind: Widget['kind'];
    visualization_id: string | null;
    text: string;
    width: Widget['width'];
    height: number;
    options: WidgetOptions;
  }>(
    `SELECT id, kind, visualization_id, text, width, height, options
     FROM dashboard_widgets WHERE dashboard_id = $1 ORDER BY position`,
    [dashboardId],
  );
  const ids = rows.flatMap((row) =>
    row.visualization_id ? [row.visualization_id] : [],
  );
  const visualizations = new Map<string, Visualization>();
  if (ids.length) {
    const { rows: found } = await db.query<VisualizationRow>(
      `${SELECT_VISUALIZATION} WHERE v.id = ANY ($1) AND v.archived_at IS NULL`,
      [ids],
    );
    for (const row of found) visualizations.set(row.id, toVisualization(row));
  }
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    visualization: row.visualization_id
      ? (visualizations.get(row.visualization_id) ?? null)
      : null,
    text: row.text,
    width: row.width,
    height: row.height,
    options: row.options,
  }));
}

export async function getDashboard(slug: string): Promise<Dashboard | null> {
  const db = await appDb();
  const { rows } = await db.query<DashboardRow>(
    `${SELECT_DASHBOARD} WHERE d.slug = $1`,
    [slug],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    variables: row.variables,
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
    widgets: await widgetsOf(row.id),
  };
}

export async function requireDashboard(
  slug: string,
  editor: boolean,
): Promise<Dashboard> {
  const dashboard = await getDashboard(slug);
  if (
    !dashboard ||
    (!editor && (dashboard.visibility === 'private' || dashboard.archivedAt))
  ) {
    throw notFound(`No dashboard "${slug}"`);
  }
  return dashboard;
}

export type DashboardSummary = Omit<Dashboard, 'widgets'> & {
  official: boolean;
  /** Charts on it, headings not counted. */
  charts: number;
};

export async function listDashboards(
  editor: boolean,
): Promise<DashboardSummary[]> {
  const db = await appDb();
  const { rows } = await db.query<
    DashboardRow & { official: boolean; charts: number }
  >(
    `SELECT d.id, d.slug, d.title, d.description, d.visibility, d.variables,
            u.username AS created_by, d.updated_at, d.archived_at, d.official,
            (SELECT count(*)::int FROM dashboard_widgets w
             WHERE w.dashboard_id = d.id AND w.kind = 'visualization') AS charts
     FROM dashboards d LEFT JOIN users u ON u.id = d.created_by
     WHERE d.archived_at IS NULL
     ${editor ? '' : `AND d.visibility = 'public'`}
     ORDER BY d.official DESC, d.title, d.updated_at DESC`,
  );
  return rows.map((row) => ({
    official: row.official,
    charts: row.charts,
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    variables: row.variables,
    createdBy: row.created_by,
    updatedAt: row.updated_at.toISOString(),
    archivedAt: null,
  }));
}

/** The dashboards that show at least one chart of this query, and how many. */
export async function dashboardsShowing(
  query: string,
  editor: boolean,
): Promise<Array<{ slug: string; title: string; charts: number }>> {
  const db = await appDb();
  const { rows } = await db.query<{
    slug: string;
    title: string;
    charts: number;
  }>(
    `SELECT d.slug, d.title, count(DISTINCT w.visualization_id)::int AS charts
     FROM dashboards d
     JOIN dashboard_widgets w ON w.dashboard_id = d.id
     JOIN visualizations v ON v.id = w.visualization_id
     JOIN queries q ON q.id = v.query_id
     WHERE q.slug = $1 AND d.archived_at IS NULL AND v.archived_at IS NULL
     ${editor ? '' : `AND d.visibility = 'public'`}
     GROUP BY d.slug, d.title
     ORDER BY d.title`,
    [query],
  );
  return rows;
}

function visibility(input: unknown): Dashboard['visibility'] | undefined {
  if (input === undefined) return undefined;
  if (!['private', 'unlisted', 'public'].includes(input as string)) {
    throw badRequest('visibility must be private, unlisted or public');
  }
  return input as Dashboard['visibility'];
}

export async function createDashboard(
  input: Record<string, unknown>,
  principal: Principal,
): Promise<Dashboard> {
  const slug = asText(input.slug ?? '');
  if (!SLUG.test(slug))
    throw badRequest('slug must be lowercase letters, digits and dashes');
  const db = await appDb();
  try {
    await db.query(
      `INSERT INTO dashboards (slug, title, description, visibility, variables, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        slug,
        title(input.title, true),
        description(input.description) ?? '',
        visibility(input.visibility) ?? 'private',
        JSON.stringify(
          input.variables === undefined
            ? parseVariables([
                {
                  name: 'range',
                  label: 'Range',
                  type: 'range',
                  default: '30d',
                },
                {
                  name: 'network',
                  label: 'Data source',
                  type: 'network',
                  default: 'all',
                },
              ])
            : parseVariables(input.variables),
        ),
        principal.userId,
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new HttpError(
        409,
        `A dashboard with slug "${slug}" already exists`,
      );
    }
    throw error;
  }
  const created = await getDashboard(slug);
  if (!created) throw new Error('dashboard vanished after insert');
  return created;
}

export async function updateDashboard(
  slug: string,
  input: Record<string, unknown>,
): Promise<Dashboard> {
  const sets: string[] = [];
  const values: unknown[] = [slug];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  const newTitle = title(input.title, false);
  if (newTitle !== undefined) set('title', newTitle);
  const newDescription = description(input.description);
  if (newDescription !== undefined) set('description', newDescription);
  const newVisibility = visibility(input.visibility);
  if (newVisibility) set('visibility', newVisibility);
  if (input.variables !== undefined) {
    set('variables', JSON.stringify(parseVariables(input.variables)));
  }
  if (!sets.length) throw badRequest('Nothing to update');
  const db = await appDb();
  const { rowCount } = await db.query(
    `UPDATE dashboards SET ${sets.join(', ')}, updated_at = now()
     WHERE slug = $1 AND archived_at IS NULL`,
    values,
  );
  if (!rowCount) throw notFound(`No dashboard "${slug}"`);
  const updated = await getDashboard(slug);
  if (!updated) throw new Error('dashboard vanished after update');
  return updated;
}

export async function archiveDashboard(slug: string): Promise<void> {
  const db = await appDb();
  const { rowCount } = await db.query(
    `UPDATE dashboards SET archived_at = now() WHERE slug = $1 AND archived_at IS NULL`,
    [slug],
  );
  if (!rowCount) throw notFound(`No dashboard "${slug}"`);
}

function parseWidgetOptions(input: unknown, where: string): WidgetOptions {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest(`${where}.options must be an object`);
  }
  const raw = input as Record<string, unknown>;
  const options: WidgetOptions = {};
  if (typeof raw.title === 'string' && raw.title.trim())
    options.title = raw.title.trim().slice(0, 200);
  if (typeof raw.note === 'string' && raw.note.trim())
    options.note = raw.note.trim().slice(0, 2_000);
  if (typeof raw.requires === 'string' && raw.requires) {
    if (!VAR_NAME.test(raw.requires))
      throw badRequest(`${where}.options.requires is not a variable name`);
    options.requires = raw.requires;
  }
  if (raw.link !== undefined && raw.link !== null) {
    const link = raw.link as Record<string, unknown>;
    if (
      typeof link.column !== 'string' ||
      !link.column ||
      typeof link.var !== 'string' ||
      !VAR_NAME.test(link.var)
    ) {
      throw badRequest(`${where}.options.link needs a column and a variable`);
    }
    options.link = { column: link.column, var: link.var };
    if (typeof link.dashboard === 'string' && link.dashboard) {
      if (!SLUG.test(link.dashboard))
        throw badRequest(`${where}.options.link.dashboard is not a slug`);
      options.link.dashboard = link.dashboard;
    }
  }
  return options;
}

/**
 * Replaces a dashboard's widgets with the given list, in that order.
 *
 * The editor saves the whole layout at once — reordering, resizing, adding —
 * so one call that states the full arrangement is simpler and cannot leave
 * the positions half-updated.
 */
export async function replaceWidgets(
  slug: string,
  input: unknown,
): Promise<Dashboard> {
  if (!Array.isArray(input)) throw badRequest('widgets must be a list');
  if (input.length > 100) throw badRequest('At most 100 widgets');
  const widgets = input.map((raw, index) => {
    const where = `widgets[${index}]`;
    if (typeof raw !== 'object' || raw === null)
      throw badRequest(`${where} must be an object`);
    const entry = raw as Record<string, unknown>;
    const kind = entry.kind;
    if (kind !== 'visualization' && kind !== 'text') {
      throw badRequest(`${where}.kind must be visualization or text`);
    }
    const width = Number(entry.width ?? 6);
    if (!Number.isInteger(width) || width < 1 || width > 12) {
      throw badRequest(`${where}.width must be a whole number from 1 to 12`);
    }
    const height = Number(entry.height ?? 260);
    if (!Number.isInteger(height) || height < 80 || height > 1_200) {
      throw badRequest(`${where}.height must be from 80 to 1200`);
    }
    const visualization =
      kind === 'visualization' ? asText(entry.visualization ?? '') : null;
    if (kind === 'visualization' && !UUID.test(visualization ?? '')) {
      throw badRequest(`${where}.visualization must be a visualization id`);
    }
    const text =
      kind === 'text' ? asText(entry.text ?? '').slice(0, 5_000) : '';
    return {
      kind,
      visualization,
      text,
      width,
      height,
      options: parseWidgetOptions(entry.options, where),
    };
  });

  await transaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM dashboards WHERE slug = $1 AND archived_at IS NULL FOR UPDATE',
      [slug],
    );
    const dashboard = rows[0];
    if (!dashboard) throw notFound(`No dashboard "${slug}"`);
    const ids = widgets.flatMap((widget) =>
      widget.visualization ? [widget.visualization] : [],
    );
    if (ids.length) {
      const { rows: known } = await client.query<{ id: string }>(
        'SELECT id FROM visualizations WHERE id = ANY ($1) AND archived_at IS NULL',
        [ids],
      );
      const found = new Set(known.map((row) => row.id));
      const missing = ids.find((id) => !found.has(id));
      if (missing) throw badRequest(`No visualization ${missing}`);
    }
    await client.query(
      'DELETE FROM dashboard_widgets WHERE dashboard_id = $1',
      [dashboard.id],
    );
    for (const [position, widget] of widgets.entries()) {
      await client.query(
        `INSERT INTO dashboard_widgets
           (dashboard_id, position, kind, visualization_id, text, width, height, options)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          dashboard.id,
          position,
          widget.kind,
          widget.visualization,
          widget.text,
          widget.width,
          widget.height,
          JSON.stringify(widget.options),
        ],
      );
    }
    await client.query(
      'UPDATE dashboards SET updated_at = now() WHERE id = $1',
      [dashboard.id],
    );
  });
  const updated = await getDashboard(slug);
  if (!updated) throw new Error('dashboard vanished after update');
  return updated;
}

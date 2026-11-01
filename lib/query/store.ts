import 'server-only';

import type { PoolClient } from 'pg';

import { HttpError, badRequest, notFound } from '../api/errors';
import type { Principal } from '../auth/session';
import { appDb, transaction } from '../db/app';
import { compile, type ResolveFragment } from './compile';
import { parseDefinitions, type ParameterDefinition } from './params';

/**
 * Saved queries and their versions.
 *
 * A query's SQL is never edited in place. Saving creates a new immutable
 * version and moves the query's `current_version_id` to it, so every result,
 * and later every dashboard widget, can say exactly which SQL produced it.
 */

export type Visibility = 'private' | 'unlisted' | 'public';
export type Kind = 'query' | 'fragment';
export type Combine = 'concat' | 'hidden';

export type QueryVersion = {
  id: string;
  version: number;
  sql: string;
  parameters: ParameterDefinition[];
  note: string;
  createdBy: string | null;
  createdAt: string;
};

export type QueryRecord = {
  id: string;
  slug: string;
  title: string;
  description: string;
  kind: Kind;
  visibility: Visibility;
  official: boolean;
  combine: Combine;
  refreshSeconds: number | null;
  /** How long a run may take; null takes the server's default. */
  timeoutSeconds: number | null;
  /** How many rows a stored result keeps; null takes the server's default. */
  rowLimit: number | null;
  forkedFrom: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  current: QueryVersion | null;
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MAX_SQL = 200_000;

type Row = {
  id: string;
  slug: string;
  title: string;
  description: string;
  kind: Kind;
  visibility: Visibility;
  official: boolean;
  combine: Combine;
  refresh_seconds: number | null;
  timeout_seconds: number | null;
  row_limit: string | null;
  forked_from: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  v_id: string | null;
  v_version: number | null;
  v_sql: string | null;
  v_parameters: ParameterDefinition[] | null;
  v_note: string | null;
  v_created_by: string | null;
  v_created_at: Date | null;
};

const SELECT = `
  SELECT q.id, q.slug, q.title, q.description, q.kind, q.visibility, q.official,
         q.combine, q.refresh_seconds, q.timeout_seconds, q.row_limit,
         parent.slug AS forked_from,
         author.username AS created_by, q.created_at, q.updated_at, q.archived_at,
         v.id AS v_id, v.version AS v_version, v.sql AS v_sql,
         v.parameters AS v_parameters, v.note AS v_note,
         vauthor.username AS v_created_by, v.created_at AS v_created_at
  FROM queries q
  LEFT JOIN queries parent ON parent.id = q.forked_from
  LEFT JOIN users author ON author.id = q.created_by
  LEFT JOIN query_versions v ON v.id = q.current_version_id
  LEFT JOIN users vauthor ON vauthor.id = v.created_by
`;

function toRecord(row: Row): QueryRecord {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    kind: row.kind,
    visibility: row.visibility,
    official: row.official,
    combine: row.combine,
    refreshSeconds: row.refresh_seconds,
    timeoutSeconds: row.timeout_seconds,
    rowLimit: row.row_limit === null ? null : Number(row.row_limit),
    forkedFrom: row.forked_from,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString() ?? null,
    current:
      row.v_id && row.v_version !== null && row.v_sql !== null
        ? {
            id: row.v_id,
            version: row.v_version,
            sql: row.v_sql,
            parameters: row.v_parameters ?? [],
            note: row.v_note ?? '',
            createdBy: row.v_created_by,
            createdAt: (row.v_created_at ?? row.created_at).toISOString(),
          }
        : null,
  };
}

/** Whether a reader may see this query. Editors see everything. */
export function canRead(query: QueryRecord, editor: boolean): boolean {
  if (editor) return true;
  return query.visibility !== 'private' && !query.archivedAt;
}

export async function getQuery(slug: string): Promise<QueryRecord | null> {
  const db = await appDb();
  const { rows } = await db.query<Row>(`${SELECT} WHERE q.slug = $1`, [slug]);
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function requireQuery(
  slug: string,
  editor: boolean,
): Promise<QueryRecord> {
  const query = await getQuery(slug);
  // A private query answers exactly as a missing one, so its slug is not
  // confirmed to anyone who cannot read it.
  if (!query || !canRead(query, editor)) throw notFound(`No query "${slug}"`);
  return query;
}

export async function listQueries(options: {
  editor: boolean;
  kind?: Kind;
  includeArchived?: boolean;
}): Promise<QueryRecord[]> {
  const db = await appDb();
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (!options.editor) conditions.push(`q.visibility = 'public'`);
  if (!options.editor || !options.includeArchived) {
    conditions.push('q.archived_at IS NULL');
  }
  if (options.kind) {
    values.push(options.kind);
    conditions.push(`q.kind = $${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await db.query<Row>(
    `${SELECT} ${where} ORDER BY q.official DESC, q.updated_at DESC`,
    values,
  );
  return rows.map(toRecord);
}

/**
 * Loads fragments for the compiler: the current version of a live fragment.
 * `fragmentResolver(client)` reads inside the caller's transaction.
 */
export function fragmentResolver(client?: PoolClient): ResolveFragment {
  return async (slug) => {
    const db = client ?? (await appDb());
    const { rows } = await db.query<{
      version_id: string;
      sql: string;
      parameters: ParameterDefinition[];
    }>(
      `SELECT v.id AS version_id, v.sql, v.parameters
       FROM queries q JOIN query_versions v ON v.id = q.current_version_id
       WHERE q.slug = $1 AND q.kind = 'fragment' AND q.archived_at IS NULL`,
      [slug],
    );
    const row = rows[0];
    return row
      ? {
          slug,
          versionId: row.version_id,
          sql: row.sql,
          parameters: row.parameters,
        }
      : null;
  };
}

function text(
  input: Record<string, unknown>,
  key: string,
  options: { required?: boolean; max: number },
): string | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    if (options.required) throw badRequest(`${key} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw badRequest(`${key} must be a string`);
  if (value.length > options.max) {
    throw badRequest(`${key} is longer than ${options.max} characters`);
  }
  return value;
}

function oneOf<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = input[key];
  if (value === undefined || value === null) return undefined;
  if (!allowed.includes(value as T)) {
    throw badRequest(`${key} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function refresh(input: Record<string, unknown>): number | null | undefined {
  if (!('refreshSeconds' in input)) return undefined;
  const value = input.refreshSeconds;
  if (value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 60 ||
    value > 7 * 86_400
  ) {
    throw badRequest(
      'refreshSeconds must be null or an integer from 60 to 604800',
    );
  }
  return value;
}

/** A whole number from `min` to `max`, null to clear it, or undefined when absent. */
function bounded(
  input: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | null | undefined {
  if (!(key in input)) return undefined;
  const value = input[key];
  if (value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw badRequest(`${key} must be null or an integer from ${min} to ${max}`);
  }
  return value;
}

const limitsOf = (input: Record<string, unknown>) => ({
  timeoutSeconds: bounded(input, 'timeoutSeconds', 1, 3_600),
  rowLimit: bounded(input, 'rowLimit', 1, 1_000_000_000),
});

/**
 * Parses SQL and parameters, and proves the template compiles — every
 * placeholder known, every fragment present, no cycle — before it is stored.
 * Whether the SQL itself is valid is the database's call, at the first run.
 */
async function checkedSource(
  input: Record<string, unknown>,
  client: PoolClient,
  selfSlug: string,
): Promise<{ sql: string; parameters: ParameterDefinition[] }> {
  const sql =
    text(input, 'sql', { required: true, max: MAX_SQL })?.trim() ?? '';
  if (!sql) throw badRequest('sql must not be empty');
  const parameters = parseDefinitions(input.parameters);
  const resolve = fragmentResolver(client);
  await compile(sql, parameters, async (slug) => {
    // The stored graph still holds the previous version of this query, so a
    // cycle through it only shows as a reference back to its own slug.
    if (slug === selfSlug) {
      throw badRequest(`Saving would make ${slug} include itself`);
    }
    return resolve(slug);
  });
  return { sql, parameters };
}

function uniqueViolation(error: unknown, message: string): unknown {
  return (error as { code?: string }).code === '23505'
    ? new HttpError(409, message)
    : error;
}

async function insertVersion(
  client: PoolClient,
  queryId: string,
  source: { sql: string; parameters: ParameterDefinition[] },
  note: string,
  principal: Principal,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO query_versions (query_id, version, sql, parameters, note, created_by)
     SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3, $4, $5
     FROM query_versions WHERE query_id = $1
     RETURNING id`,
    [
      queryId,
      source.sql,
      JSON.stringify(source.parameters),
      note,
      principal.userId,
    ],
  );
  await client.query(
    'UPDATE queries SET current_version_id = $2, updated_at = now() WHERE id = $1',
    [queryId, rows[0].id],
  );
}

export async function createQuery(
  input: Record<string, unknown>,
  principal: Principal,
  forkedFrom?: string,
): Promise<QueryRecord> {
  const slug = text(input, 'slug', { required: true, max: 80 }) ?? '';
  if (!SLUG.test(slug)) {
    throw badRequest('slug must be lowercase letters, digits and dashes');
  }
  const title = text(input, 'title', { required: true, max: 200 })?.trim();
  if (!title) throw badRequest('title must not be empty');
  const kind = oneOf(input, 'kind', ['query', 'fragment'] as const) ?? 'query';
  const refreshSeconds = refresh(input) ?? null;
  const limits = limitsOf(input);
  if (kind === 'fragment' && refreshSeconds !== null) {
    throw badRequest(
      'A fragment is not run on a schedule; omit refreshSeconds',
    );
  }

  await transaction(async (client) => {
    // Checked inside the transaction so the fragment graph it validated
    // against is the one the version is stored into.
    const source = await checkedSource(input, client, slug);
    let id: string;
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO queries
           (slug, title, description, kind, visibility, combine, refresh_seconds,
            forked_from, created_by, timeout_seconds, row_limit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          slug,
          title,
          text(input, 'description', { max: 5_000 }) ?? '',
          kind,
          oneOf(input, 'visibility', [
            'private',
            'unlisted',
            'public',
          ] as const) ?? 'private',
          oneOf(input, 'combine', ['concat', 'hidden'] as const) ?? 'concat',
          refreshSeconds,
          forkedFrom ?? null,
          principal.userId,
          limits.timeoutSeconds ?? null,
          limits.rowLimit ?? null,
        ],
      );
      id = rows[0].id;
    } catch (error) {
      throw uniqueViolation(
        error,
        `A query with slug "${slug}" already exists`,
      );
    }
    await insertVersion(
      client,
      id,
      source,
      text(input, 'note', { max: 2_000 }) ?? '',
      principal,
    );
  });
  const created = await getQuery(slug);
  if (!created) throw new Error('query vanished after insert');
  return created;
}

export async function saveVersion(
  slug: string,
  input: Record<string, unknown>,
  principal: Principal,
): Promise<QueryRecord> {
  await transaction(async (client) => {
    const { rows } = await client.query<{ id: string; current: string | null }>(
      `SELECT id, current_version_id AS current FROM queries
       WHERE slug = $1 AND archived_at IS NULL FOR UPDATE`,
      [slug],
    );
    const query = rows[0];
    if (!query) throw notFound(`No query "${slug}"`);
    const source = await checkedSource(input, client, slug);

    // Saving what is already current would only add noise to the history.
    if (query.current) {
      const { rows: same } = await client.query(
        `SELECT 1 FROM query_versions
         WHERE id = $1 AND sql = $2 AND parameters = $3::jsonb`,
        [query.current, source.sql, JSON.stringify(source.parameters)],
      );
      if (same.length) return;
    }
    await insertVersion(
      client,
      query.id,
      source,
      text(input, 'note', { max: 2_000 }) ?? '',
      principal,
    );
  });
  const saved = await getQuery(slug);
  if (!saved) throw new Error('query vanished after save');
  return saved;
}

export async function updateQuery(
  slug: string,
  input: Record<string, unknown>,
): Promise<QueryRecord> {
  const sets: string[] = [];
  const values: unknown[] = [slug];
  const set = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  const title = text(input, 'title', { max: 200 });
  if (title !== undefined) {
    if (!title.trim()) throw badRequest('title must not be empty');
    set('title', title.trim());
  }
  const description = text(input, 'description', { max: 5_000 });
  if (description !== undefined) set('description', description);
  const visibility = oneOf(input, 'visibility', [
    'private',
    'unlisted',
    'public',
  ] as const);
  if (visibility) set('visibility', visibility);
  const combine = oneOf(input, 'combine', ['concat', 'hidden'] as const);
  if (combine) set('combine', combine);
  const refreshSeconds = refresh(input);
  if (refreshSeconds !== undefined) set('refresh_seconds', refreshSeconds);
  const limits = limitsOf(input);
  if (limits.timeoutSeconds !== undefined)
    set('timeout_seconds', limits.timeoutSeconds);
  if (limits.rowLimit !== undefined) set('row_limit', limits.rowLimit);
  if ('official' in input) {
    if (typeof input.official !== 'boolean') {
      throw badRequest('official must be a boolean');
    }
    set('official', input.official);
  }
  for (const key of ['sql', 'parameters', 'slug', 'kind']) {
    if (key in input) {
      throw badRequest(
        key === 'sql' || key === 'parameters'
          ? 'SQL and parameters change by saving a new version'
          : `${key} cannot be changed`,
      );
    }
  }
  if (!sets.length) throw badRequest('Nothing to update');

  const db = await appDb();
  try {
    const { rowCount } = await db.query(
      `UPDATE queries SET ${sets.join(', ')}, updated_at = now()
       WHERE slug = $1 AND archived_at IS NULL`,
      values,
    );
    if (!rowCount) throw notFound(`No query "${slug}"`);
  } catch (error) {
    if ((error as { code?: string }).code === '23514') {
      throw badRequest('A fragment cannot be scheduled');
    }
    throw error;
  }
  const updated = await getQuery(slug);
  if (!updated) throw new Error('query vanished after update');
  return updated;
}

/**
 * Archives rather than deletes: results and, later, dashboards may still refer
 * to its versions, and an archived query can be restored by hand.
 */
export async function archiveQuery(slug: string): Promise<void> {
  const db = await appDb();
  const { rowCount } = await db.query(
    `UPDATE queries SET archived_at = now(), refresh_seconds = NULL, updated_at = now()
     WHERE slug = $1 AND archived_at IS NULL`,
    [slug],
  );
  if (!rowCount) throw notFound(`No query "${slug}"`);
}

export async function forkQuery(
  slug: string,
  input: Record<string, unknown>,
  principal: Principal,
): Promise<QueryRecord> {
  const source = await requireQuery(slug, true);
  if (!source.current)
    throw badRequest(`Query "${slug}" has no version to fork`);
  return createQuery(
    {
      slug: input.slug,
      title: input.title ?? `${source.title} (fork)`,
      description: source.description,
      kind: source.kind,
      visibility: 'private',
      combine: source.combine,
      sql: source.current.sql,
      parameters: source.current.parameters,
      note: `Forked from ${slug} v${source.current.version}`,
    },
    principal,
    source.id,
  );
}

export async function listVersions(slug: string): Promise<QueryVersion[]> {
  const db = await appDb();
  const { rows } = await db.query<{
    id: string;
    version: number;
    sql: string;
    parameters: ParameterDefinition[];
    note: string;
    created_by: string | null;
    created_at: Date;
  }>(
    `SELECT v.id, v.version, v.sql, v.parameters, v.note,
            u.username AS created_by, v.created_at
     FROM query_versions v
     JOIN queries q ON q.id = v.query_id
     LEFT JOIN users u ON u.id = v.created_by
     WHERE q.slug = $1
     ORDER BY v.version DESC`,
    [slug],
  );
  return rows.map((row) => ({
    id: row.id,
    version: row.version,
    sql: row.sql,
    parameters: row.parameters,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  }));
}

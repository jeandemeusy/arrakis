import 'server-only';

import { badRequest, notFound } from '../api/errors';
import type { Principal } from '../auth/session';
import { appDb } from '../db/app';
import type { BindValue } from './params';
import type { ListType, ResolveList } from './compile';

/**
 * Lists: named sets of values an editor keeps, read by queries as
 * `{{list:name}}` — an array of the list's type, holding the values kept for
 * the data source the run reads plus those kept for every source.
 *
 * Changing a list changes what the queries that read it return, so their
 * stored results go stale (the list's values are part of a result's inputs
 * fingerprint) and scheduled ones rerun. Removals are recorded, not deleted.
 */

export const LIST_TYPES: ListType[] = ['text', 'number', 'bytes'];

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const NUMBER = /^-?\d+(\.\d+)?$/;
const BYTES = /^0x([0-9a-f]{2})*$/;

export type ListValue = {
  id: string;
  /** Null: kept for every data source. */
  source: string | null;
  value: string;
  label: string;
  addedAt: string;
  addedBy: string | null;
};

export type List = {
  name: string;
  type: ListType;
  description: string;
  values: ListValue[];
};

/** A value as stored: checked against the list's type, in one spelling. */
export function normalizeValue(type: ListType, input: unknown): string {
  const raw =
    typeof input === 'string'
      ? input.trim()
      : typeof input === 'number'
        ? String(input)
        : '';
  if (!raw) throw badRequest('value must not be empty');
  if (raw.length > 1000)
    throw badRequest('value is longer than 1000 characters');
  if (type === 'number') {
    if (!NUMBER.test(raw)) throw badRequest('value must be a number');
    return raw;
  }
  if (type === 'bytes') {
    const lower = raw.toLowerCase();
    if (!BYTES.test(lower) || lower.length < 4)
      throw badRequest('value must be 0x-prefixed hex bytes');
    return lower;
  }
  return raw;
}

export function listResolver(): ResolveList {
  return async (name) => {
    const db = await appDb();
    const { rows } = await db.query<{ type: ListType }>(
      'SELECT type FROM lists WHERE name = $1',
      [name],
    );
    return rows[0]?.type ?? null;
  };
}

/**
 * Each named list's values for one data source, as bind values: Buffers for
 * bytes, strings otherwise. Sorted, so equal sets hash equally.
 */
export async function listValues(
  names: string[],
  source: string,
): Promise<Record<string, BindValue>> {
  if (!names.length) return {};
  const db = await appDb();
  const { rows } = await db.query<{
    name: string;
    type: ListType;
    value: string | null;
  }>(
    `SELECT l.name, l.type, v.value
     FROM lists l
     LEFT JOIN list_values v
       ON v.list_id = l.id AND v.removed_at IS NULL
      AND (v.source IS NULL OR v.source = $2)
     WHERE l.name = ANY($1::text[])
     ORDER BY l.name, v.value`,
    [names, source],
  );
  const out: Record<string, BindValue> = {};
  for (const name of names) out[name] = [];
  for (const row of rows) {
    if (row.value === null) continue;
    const values = out[row.name] as unknown[];
    values.push(
      row.type === 'bytes' ? Buffer.from(row.value.slice(2), 'hex') : row.value,
    );
  }
  return out;
}

export async function listLists(): Promise<List[]> {
  const db = await appDb();
  const { rows } = await db.query<{
    name: string;
    type: ListType;
    description: string;
    values: Array<{
      id: string;
      source: string | null;
      value: string;
      label: string;
      added_at: string;
      added_by: string | null;
    }> | null;
  }>(
    `SELECT l.name, l.type, l.description,
            (SELECT json_agg(json_build_object(
                      'id', v.id, 'source', v.source, 'value', v.value,
                      'label', v.label, 'added_at', v.added_at,
                      'added_by', u.username)
                    ORDER BY v.source NULLS FIRST, v.value)
             FROM list_values v LEFT JOIN users u ON u.id = v.added_by
             WHERE v.list_id = l.id AND v.removed_at IS NULL) AS values
     FROM lists l ORDER BY l.name`,
  );
  return rows.map((row) => ({
    name: row.name,
    type: row.type,
    description: row.description,
    values: (row.values ?? []).map((value) => ({
      id: value.id,
      source: value.source,
      value: value.value,
      label: value.label,
      addedAt: new Date(value.added_at).toISOString(),
      addedBy: value.added_by,
    })),
  }));
}

export async function getList(name: string): Promise<List> {
  const list = (await listLists()).find((entry) => entry.name === name);
  if (!list) throw notFound(`No list "${name}"`);
  return list;
}

export async function createList(
  input: Record<string, unknown>,
  principal: Principal,
): Promise<List> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!NAME.test(name))
    throw badRequest(
      'name must start with a letter or _, then letters, digits or _ (it is written {{list:name}})',
    );
  const type = input.type;
  if (!LIST_TYPES.includes(type as ListType))
    throw badRequest(`type must be one of ${LIST_TYPES.join(', ')}`);
  const description =
    typeof input.description === 'string'
      ? input.description.slice(0, 2_000)
      : '';
  const db = await appDb();
  try {
    await db.query(
      `INSERT INTO lists (name, type, description, created_by) VALUES ($1, $2, $3, $4)`,
      [name, type, description, principal.userId],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw badRequest(`A list named "${name}" already exists`);
    throw error;
  }
  return getList(name);
}

export async function updateList(
  name: string,
  input: Record<string, unknown>,
): Promise<List> {
  await getList(name);
  if (typeof input.description === 'string') {
    const db = await appDb();
    await db.query(
      'UPDATE lists SET description = $2, updated_at = now() WHERE name = $1',
      [name, input.description.slice(0, 2_000)],
    );
  }
  return getList(name);
}

export async function deleteList(name: string): Promise<void> {
  const db = await appDb();
  const { rowCount } = await db.query('DELETE FROM lists WHERE name = $1', [
    name,
  ]);
  if (!rowCount) throw notFound(`No list "${name}"`);
}

export async function addValue(
  name: string,
  input: Record<string, unknown>,
  sources: string[],
  principal: Principal,
): Promise<List> {
  const list = await getList(name);
  const value = normalizeValue(list.type, input.value);
  const source =
    input.source === undefined || input.source === null || input.source === ''
      ? null
      : typeof input.source === 'string'
        ? input.source
        : '';
  if (source !== null && !sources.includes(source))
    throw badRequest(`No data source "${source}"`);
  const label =
    typeof input.label === 'string' ? input.label.trim().slice(0, 200) : '';
  const db = await appDb();
  try {
    await db.query(
      `INSERT INTO list_values (list_id, source, value, label, added_by)
       SELECT id, $2, $3, $4, $5 FROM lists WHERE name = $1`,
      [name, source, value, label, principal.userId],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw badRequest(`${value} is already in the list`);
    throw error;
  }
  await db.query('UPDATE lists SET updated_at = now() WHERE name = $1', [name]);
  return getList(name);
}

export async function removeValue(
  name: string,
  id: string,
  principal: Principal,
): Promise<List> {
  const db = await appDb();
  const { rowCount } = await db.query(
    `UPDATE list_values v SET removed_at = now(), removed_by = $3
     FROM lists l
     WHERE v.id = $2::uuid AND v.list_id = l.id AND l.name = $1 AND v.removed_at IS NULL`,
    [name, id, principal.userId],
  );
  if (!rowCount) throw notFound('No such value in the list');
  await db.query('UPDATE lists SET updated_at = now() WHERE name = $1', [name]);
  return getList(name);
}

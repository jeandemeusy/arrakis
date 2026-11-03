import 'server-only';

import { badRequest, HttpError, notFound } from '../api/errors';
import { appDb } from '../db/app';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function folderName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200)
    throw badRequest('Folder name must be between 1 and 200 characters');
  return value.trim();
}

function folderId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value))
    throw badRequest('Invalid folder ID');
  return value;
}

export async function listFolders(editor: boolean) {
  const db = await appDb();
  const { rows } = await db.query<{ id: string; name: string }>(
    `SELECT f.id, f.name FROM dashboard_folders f
     ${editor ? '' : `WHERE EXISTS (SELECT 1 FROM dashboards d WHERE d.folder_id = f.id AND d.archived_at IS NULL AND d.visibility = 'public')`}
     ORDER BY lower(f.name), f.id`,
  );
  return rows;
}

export async function saveFolder(id: string | null, name: unknown) {
  const db = await appDb();
  try {
    const { rows } =
      id === null
        ? await db.query<{ id: string; name: string }>(
            'INSERT INTO dashboard_folders (name) VALUES ($1) RETURNING id, name',
            [folderName(name)],
          )
        : await db.query<{ id: string; name: string }>(
            'UPDATE dashboard_folders SET name = $2 WHERE id = $1 RETURNING id, name',
            [folderId(id), folderName(name)],
          );
    if (!rows[0]) throw notFound('Folder not found');
    return rows[0];
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw new HttpError(409, 'A folder with that name already exists');
    throw error;
  }
}

export async function deleteFolder(id: string) {
  const db = await appDb();
  const { rowCount } = await db.query(
    'DELETE FROM dashboard_folders WHERE id = $1',
    [folderId(id)],
  );
  if (!rowCount) throw notFound('Folder not found');
}

export async function moveDashboard(slug: string, value: unknown) {
  const id = value === null ? null : folderId(value);
  const db = await appDb();
  const { rowCount } = await db.query(
    `UPDATE dashboards SET folder_id = $2
     WHERE slug = $1 AND archived_at IS NULL
     AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM dashboard_folders WHERE id = $2))`,
    [slug, id],
  );
  if (!rowCount) throw notFound('Dashboard or folder not found');
}

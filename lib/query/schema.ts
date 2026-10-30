import 'server-only';

import type { NetworkConfig } from '../networks';
import { runReadOnly } from './runner';

/**
 * What an editor can query on a network: every table and view the role can
 * read, with its columns. Cached for a few minutes; the Blokli schema only
 * changes with a migration.
 */

export type SchemaTable = {
  schema: string;
  name: string;
  kind: 'table' | 'view';
  columns: Array<{ name: string; type: string }>;
};

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; tables: Promise<SchemaTable[]> }>();

async function load(network: NetworkConfig): Promise<SchemaTable[]> {
  const { rows } = await runReadOnly({
    network,
    text: `
      SELECT n.nspname, c.relname, c.relkind, a.attname,
             format_type(a.atttypid, a.atttypmod)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
        AND has_table_privilege(c.oid, 'SELECT')
      ORDER BY n.nspname, c.relname, a.attnum`,
    values: [],
    rowLimit: 50_000,
  });
  const tables = new Map<string, SchemaTable>();
  for (const [schema, name, kind, column, type] of rows as string[][]) {
    const key = `${schema}.${name}`;
    let table = tables.get(key);
    if (!table) {
      table = {
        schema,
        name,
        kind: kind === 'v' || kind === 'm' ? 'view' : 'table',
        columns: [],
      };
      tables.set(key, table);
    }
    table.columns.push({ name: column, type });
  }
  return [...tables.values()];
}

export async function describeSchema(
  network: NetworkConfig,
): Promise<{ network: string; tables: SchemaTable[] }> {
  let hit = cache.get(network.id);
  if (!hit || Date.now() - hit.at > TTL_MS) {
    hit = { at: Date.now(), tables: load(network) };
    cache.set(network.id, hit);
    hit.tables.catch(() => cache.delete(network.id));
  }
  return { network: network.id, tables: await hit.tables };
}

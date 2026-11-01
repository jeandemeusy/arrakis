/**
 * Result columns: what a PostgreSQL type becomes in a result table, and in JSON.
 *
 * Databases often store hashes, addresses and large values as raw bytes, and bigints
 * exceed what a JSON number holds exactly, so the mapping is explicit rather than
 * left to `JSON.stringify`: bytes become 0x-hex, 64-bit integers and numerics
 * stay decimal strings, timestamps become ISO 8601.
 */

export type ColumnType =
  | 'boolean'
  | 'bytes'
  | 'text'
  | 'integer'
  | 'bigint'
  | 'float'
  | 'numeric'
  | 'date'
  | 'timestamp'
  | 'timestamptz'
  | 'json';

export type Column = {
  /** The name the query gave it. */
  name: string;
  type: ColumnType;
  /** The column's name in the materialized table, unique and ≤ 63 bytes. */
  column?: string;
};

const BY_OID: Record<number, ColumnType> = {
  16: 'boolean',
  17: 'bytes',
  18: 'text',
  19: 'text',
  20: 'bigint',
  21: 'integer',
  23: 'integer',
  25: 'text',
  26: 'bigint',
  114: 'json',
  700: 'float',
  701: 'float',
  1042: 'text',
  1043: 'text',
  1082: 'date',
  1114: 'timestamp',
  1184: 'timestamptz',
  1700: 'numeric',
  2950: 'text',
  3802: 'json',
};

/**
 * Array types are kept as JSON: they are rare in results, and storing them as
 * jsonb avoids PostgreSQL's rectangular-array rules when they are written back
 * in batches.
 */
const ARRAY_OIDS = new Set([
  199, 1000, 1001, 1005, 1007, 1009, 1014, 1015, 1016, 1021, 1022, 1115, 1182,
  1185, 1231, 2951, 3807,
]);

/** Anything else — intervals, network types, enums — arrives as text. */
export function columnType(oid: number): ColumnType {
  return BY_OID[oid] ?? (ARRAY_OIDS.has(oid) ? 'json' : 'text');
}

/** The type a column gets in a materialized result table. */
export const STORAGE_TYPE: Record<ColumnType, string> = {
  boolean: 'boolean',
  bytes: 'bytea',
  text: 'text',
  integer: 'integer',
  bigint: 'bigint',
  float: 'double precision',
  numeric: 'numeric',
  date: 'date',
  timestamp: 'timestamp',
  timestamptz: 'timestamptz',
  json: 'jsonb',
};

/** JSON form of anything a driver can hand back: bytes as hex, dates as ISO. */
export function toJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && !Number.isFinite(value))
    return String(value);
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        toJsonValue(entry),
      ]),
    );
  }
  return value;
}

/**
 * A value as stored in a result table of the given column type.
 *
 * JSON columns hold the JSON form, so arrays of bytes are still readable once
 * stored; everything else is passed through for `pg` to serialize.
 */
export function toStoredValue(value: unknown, type: ColumnType): unknown {
  if (value === null || value === undefined) return null;
  if (type === 'json') return JSON.stringify(toJsonValue(value));
  if (type === 'text' && typeof value !== 'string') {
    return typeof value === 'object'
      ? JSON.stringify(toJsonValue(value))
      : String(value as number | boolean | bigint);
  }
  return value;
}

/**
 * Unique, valid storage names for the result's columns.
 *
 * Kept close to the query's own names so a hand-written query over a result
 * reads naturally, but lowercased, limited to 63 bytes and de-duplicated —
 * `SELECT a.id, b.id` is legal SQL and would otherwise collide. `arrakis_row`
 * is reserved for the row order.
 */
export function storageNames(names: string[]): string[] {
  const taken = new Set<string>(['arrakis_row']);
  return names.map((name) => {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 55) || 'column';
    const start = /^[a-z_]/.test(base) ? base : `c_${base}`;
    let candidate = start;
    for (let suffix = 2; taken.has(candidate); suffix += 1) {
      candidate = `${start}_${suffix}`;
    }
    taken.add(candidate);
    return candidate;
  });
}

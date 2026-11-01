import { badRequest } from '../api/errors';

/**
 * Query parameters: what a saved query declares, and how a caller's values are
 * checked and converted before they are bound.
 *
 * Values never reach the SQL text. Each `{{name}}` becomes `$n::<type>` and the
 * value travels separately as a bind parameter, so a parameter cannot change
 * the shape of the statement whatever it contains.
 */

export const PARAMETER_TYPES = [
  'text',
  'integer',
  'number',
  'boolean',
  'date',
  'timestamp',
  'address',
  'text[]',
  'integer[]',
  'address[]',
  'enum',
] as const;

export type ParameterType = (typeof PARAMETER_TYPES)[number];

export type ParameterDefinition = {
  name: string;
  type: ParameterType;
  label?: string;
  /** Used when the caller supplies nothing; required to schedule a query. */
  default?: unknown;
  /** The allowed values, for `enum`. */
  options?: string[];
};

/** A value ready to bind: what `pg` serializes for the declared type. */
export type BindValue = string | number | boolean | Buffer | null | BindValue[];

/** The PostgreSQL type each parameter is cast to where it is used. */
export const PG_TYPE: Record<ParameterType, string> = {
  text: 'text',
  integer: 'bigint',
  number: 'numeric',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'timestamptz',
  address: 'bytea',
  'text[]': 'text[]',
  'integer[]': 'bigint[]',
  'address[]': 'bytea[]',
  enum: 'text',
};

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Names the platform fills in itself. A query uses them like any parameter but
 * cannot declare them, so a caller can never substitute, say, its own exit set.
 */
export const SYSTEM_PARAMETERS = {
  network: 'text',
  source: 'text',
} as const;

export type SystemParameter = keyof typeof SYSTEM_PARAMETERS;

export function isSystemParameter(name: string): name is SystemParameter {
  return Object.hasOwn(SYSTEM_PARAMETERS, name);
}

/** Validates the `parameters` array stored on a query version. */
export function parseDefinitions(input: unknown): ParameterDefinition[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw badRequest('parameters must be an array');
  const seen = new Set<string>();
  return input.map((entry, index) => {
    const where = `parameters[${index}]`;
    if (typeof entry !== 'object' || entry === null) {
      throw badRequest(`${where} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    if (!NAME.test(name)) {
      throw badRequest(
        `${where}.name must be lowercase letters, digits or underscores`,
      );
    }
    if (isSystemParameter(name) || name === 'exits' || name.startsWith('__')) {
      throw badRequest(`${where}.name "${name}" is reserved`);
    }
    if (seen.has(name))
      throw badRequest(`Parameter "${name}" is declared twice`);
    seen.add(name);
    const type = record.type as ParameterType;
    if (!PARAMETER_TYPES.includes(type)) {
      throw badRequest(
        `${where}.type must be one of ${PARAMETER_TYPES.join(', ')}`,
      );
    }
    const definition: ParameterDefinition = { name, type };
    if (typeof record.label === 'string' && record.label.trim()) {
      definition.label = record.label.trim().slice(0, 100);
    }
    if (type === 'enum') {
      const options = record.options;
      if (
        !Array.isArray(options) ||
        !options.length ||
        !options.every((option) => typeof option === 'string')
      ) {
        throw badRequest(`${where}.options must be a non-empty string array`);
      }
      definition.options = [...new Set(options as string[])];
    }
    if (record.default !== undefined && record.default !== null) {
      // Proves the default is valid now, rather than at the first scheduled run.
      coerce(definition, record.default);
      definition.default = record.default;
    }
    return definition;
  });
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INTEGER = /^-?\d{1,19}$/;

function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value
      .split(/[\s,]+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [value];
}

function scalar(type: ParameterType, value: unknown, name: string): BindValue {
  const fail = (expected: string) =>
    badRequest(`Parameter "${name}" must be ${expected}`);
  switch (type) {
    case 'text':
    case 'enum':
      if (typeof value !== 'string') throw fail('a string');
      if (value.length > 10_000) throw fail('at most 10,000 characters');
      return value;
    case 'integer': {
      const text = typeof value === 'number' ? String(value) : value;
      if (typeof text !== 'string' || !INTEGER.test(text)) {
        throw fail('an integer');
      }
      return text;
    }
    case 'number': {
      const number = typeof value === 'string' ? Number(value) : value;
      if (typeof number !== 'number' || !Number.isFinite(number)) {
        throw fail('a number');
      }
      return number;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      throw fail('true or false');
    case 'date':
      if (
        typeof value !== 'string' ||
        !DATE.test(value) ||
        Number.isNaN(Date.parse(`${value}T00:00:00Z`))
      ) {
        throw fail('a date (YYYY-MM-DD)');
      }
      return value;
    case 'timestamp': {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        throw fail('an ISO timestamp');
      }
      return new Date(value).toISOString();
    }
    case 'address':
      if (typeof value !== 'string' || !ADDRESS.test(value.trim())) {
        throw fail('a 0x-prefixed 20-byte address');
      }
      return Buffer.from(value.trim().slice(2), 'hex');
    default:
      throw fail('a scalar');
  }
}

/** Checks and converts one value for binding. */
export function coerce(
  definition: ParameterDefinition,
  value: unknown,
): BindValue {
  const { name, type } = definition;
  if (type.endsWith('[]')) {
    const element = type.slice(0, -2) as ParameterType;
    const items = list(value);
    if (items.length > 10_000) {
      throw badRequest(`Parameter "${name}" has more than 10,000 entries`);
    }
    return items.map((item) => scalar(element, item, name));
  }
  const converted = scalar(type, value, name);
  if (type === 'enum' && !definition.options?.includes(converted as string)) {
    throw badRequest(
      `Parameter "${name}" must be one of ${definition.options?.join(', ')}`,
    );
  }
  return converted;
}

/** A value as it can be stored and shown again: addresses back to hex. */
export function displayValue(value: BindValue): unknown {
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (Array.isArray(value)) return value.map(displayValue);
  return value;
}

import { badRequest } from '../api/errors';
import {
  PG_TYPE,
  SYSTEM_PARAMETERS,
  coerce,
  isSystemParameter,
  type BindValue,
  type ParameterDefinition,
  type SystemParameter,
} from './params';
import { isRelation, segments } from './scan';
import { expandEventTopics } from './event-topic';

export { isRelation };

/**
 * Turns a saved query's template into one parameterized statement.
 *
 * The template language is deliberately small:
 *
 *   {{name}}               a declared parameter, bound as $n::<type>
 *   {{source}}             the id of the data source the run reads (also
 *                          written {{network}})
 *   {{list:name}}          a list an editor keeps under Settings → Lists, for
 *                          the data source the run reads, as an array of the
 *                          list's type (`{{exits}}` is `{{list:exits}}`)
 *   {{list:name:values}}   the same values array (explicit form)
 *   {{list:name:names}}    labels aligned with the values array
 *   event_topic('Event(type,...)')  Ethereum event signature as 32 bytes
 *   {{> slug}}             another saved query of kind `fragment`, inlined as a
 *                          parenthesized subquery: `FROM {{> clients}} AS c`
 *                          or `WITH c AS {{> clients}}`
 *   {{> slug(a, b)}}       a fragment with arguments. A fragment that is an
 *                          expression rather than a query stands in for a
 *                          value: `{{> hex(r.payer)}}`, `{{> uint256(balance)}}`.
 *                          Named arguments work too: `{{> f(value => x)}}`.
 *   {{$name}}              inside a fragment, one of its arguments, in the
 *   {{$name = default}}    order they first appear; the default is used when
 *                          a call leaves it out, or the fragment runs alone
 *
 * Placeholders are only recognized in code, never inside strings or comments.
 * Raw positional parameters ($1) and a second statement are rejected here, with
 * a message, before the database would reject them less helpfully.
 */

export type FragmentSource = {
  slug: string;
  versionId: string;
  sql: string;
  parameters: ParameterDefinition[];
};

export type ResolveFragment = (slug: string) => Promise<FragmentSource | null>;

type Slot =
  | { kind: 'user'; name: string }
  | { kind: 'system'; name: SystemParameter }
  | { kind: 'list'; name: string }
  | { kind: 'list-label'; name: string };

/** What a list holds, and so the array type it binds as. */
export type ListType = 'text' | 'number' | 'bytes';

const LIST_CAST: Record<ListType, string> = {
  text: 'text[]',
  number: 'numeric[]',
  bytes: 'bytea[]',
};

/** A list's type, or null when there is no list of that name. */
export type ResolveList = (name: string) => Promise<ListType | null>;

export type Compiled = {
  /** The statement, with $n placeholders. */
  text: string;
  /** What each $n is bound to, in order. */
  slots: Slot[];
  /** Every declared parameter in scope — the query's own and its fragments'. */
  parameters: ParameterDefinition[];
  /** The declared parameters the statement actually uses. */
  used: string[];
  system: SystemParameter[];
  /** The lists the statement reads. */
  lists: string[];
  /** Lists whose labels are read as well as their values. */
  labeledLists: string[];
  /** Fragments inlined, outermost first, each with the version that was used. */
  fragments: Array<{ slug: string; versionId: string }>;
};

const MAX_FRAGMENT_DEPTH = 8;
const FRAGMENT = /^>\s*([a-z0-9][a-z0-9-]{0,79})\s*(?:\(([\s\S]*)\))?$/;
const ARGUMENT = /^\$([a-z_][a-z0-9_]{0,62})(?:\s*=\s*([\s\S]+))?$/;
const LIST = /^list:([a-z_][a-z0-9_]{0,62})(?::(values|names))?$/;
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

type Placeholder = { start: number; end: number; inner: string };

/** Finds placeholders and enforces the single-statement and no-$n rules. */
function analyse(
  sql: string,
  where: string,
): {
  placeholders: Placeholder[];
  trailing: number[];
} {
  const code: boolean[] = [];
  for (const segment of segments(sql)) {
    for (let index = 0; index < segment.text.length; index += 1) {
      code.push(segment.code);
    }
  }

  const placeholders: Placeholder[] = [];
  const semicolons: number[] = [];
  let index = 0;
  while (index < sql.length) {
    if (!code[index]) {
      index += 1;
      continue;
    }
    if (sql.startsWith('{{', index)) {
      let close = index + 2;
      while (
        close < sql.length &&
        !(code[close] && sql.startsWith('}}', close))
      ) {
        close += 1;
      }
      if (close >= sql.length) {
        throw badRequest(`${where}: unclosed {{ at offset ${index}`);
      }
      placeholders.push({
        start: index,
        end: close + 2,
        inner: sql.slice(index + 2, close).trim(),
      });
      index = close + 2;
      continue;
    }
    const char = sql[index];
    if (char === '$' && /\d/.test(sql[index + 1] ?? '')) {
      throw badRequest(
        `${where}: positional parameters like $1 are not allowed; declare a parameter and write {{name}}`,
      );
    }
    if (char === ';') semicolons.push(index);
    index += 1;
  }

  // A semicolon is only allowed as the very last thing in the code.
  for (const position of semicolons) {
    for (let after = position + 1; after < sql.length; after += 1) {
      if (code[after] && !/[\s;]/.test(sql[after])) {
        throw badRequest(`${where}: only a single statement is allowed`);
      }
    }
  }
  return { placeholders, trailing: semicolons };
}

/**
 * A fragment's arguments, in the order they first appear, with their
 * defaults. Empty for SQL that cannot be read (it fails elsewhere).
 */
export function fragmentArguments(
  sql: string,
): Array<{ name: string; default?: string }> {
  let placeholders: Placeholder[];
  try {
    placeholders = analyse(sql, 'Fragment').placeholders;
  } catch {
    return [];
  }
  const out: Array<{ name: string; default?: string }> = [];
  for (const placeholder of placeholders) {
    // An argument passed straight on to a nested fragment: `{{> f($x)}}`.
    const call = FRAGMENT.exec(placeholder.inner)?.[2];
    if (call && !call.includes('{{')) {
      for (const forwarded of call.matchAll(
        /(?:^|,|=>)\s*\$([a-z_][a-z0-9_]*)\s*(?=,|$)/g,
      )) {
        if (!out.some((entry) => entry.name === forwarded[1]))
          out.push({ name: forwarded[1] });
      }
      continue;
    }
    const match = ARGUMENT.exec(placeholder.inner);
    if (!match) continue;
    const known = out.find((entry) => entry.name === match[1]);
    if (!known) {
      out.push({
        name: match[1],
        ...(match[2] ? { default: match[2].trim() } : {}),
      });
    } else if (match[2] && known.default === undefined) {
      known.default = match[2].trim();
    }
  }
  return out;
}

/** Splits `a, f(b, c), 'd,e'` at its top-level commas. */
function splitArguments(text: string, where: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      current += char;
      if (char === quote) {
        if (text[index + 1] === quote) {
          current += text[index + 1];
          index += 1;
        } else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (quote || depth !== 0) {
    throw badRequest(
      `${where}: unbalanced quotes or brackets in the arguments`,
    );
  }
  if (current.trim() || parts.length) parts.push(current.trim());
  if (parts.some((part) => !part)) {
    throw badRequest(`${where}: an argument is empty`);
  }
  return parts;
}

export async function compile(
  sql: string,
  definitions: ParameterDefinition[],
  resolveFragment: ResolveFragment,
  resolveList: ResolveList = async () => 'text',
): Promise<Compiled> {
  const slots: Slot[] = [];
  const slotIndex = new Map<string, number>();
  const scope = new Map<string, ParameterDefinition>();
  const used = new Set<string>();
  const system = new Set<SystemParameter>();
  const fragments: Compiled['fragments'] = [];
  const lists = new Set<string>();
  const labeledLists = new Set<string>();

  const slot = (key: string, value: Slot): number => {
    let position = slotIndex.get(key);
    if (position === undefined) {
      slots.push(value);
      position = slots.length;
      slotIndex.set(key, position);
    }
    return position;
  };

  /**
   * `args` holds the arguments a fragment was called with, already in SQL;
   * null for the query itself, where an argument takes its default or NULL
   * — which is what previewing an expression fragment alone shows.
   */
  const expand = async (
    text: string,
    where: string,
    stack: string[],
    args: Map<string, string> | null,
  ): Promise<string> => {
    text = expandEventTopics(text);
    const { placeholders, trailing } = analyse(text, where);
    let out = '';
    let cursor = 0;
    const blank = new Set(trailing);
    const copy = (until: number) => {
      for (let index = cursor; index < until; index += 1) {
        out += blank.has(index) ? ' ' : text[index];
      }
      cursor = until;
    };

    for (const placeholder of placeholders) {
      copy(placeholder.start);
      cursor = placeholder.end;
      const { inner } = placeholder;

      if (
        inner.startsWith('>') &&
        text.slice(placeholder.start + 2, placeholder.end).includes('{{')
      ) {
        throw badRequest(
          `${where}: an argument to a fragment cannot contain a placeholder; pass $name to forward one of your own`,
        );
      }
      const fragment = FRAGMENT.exec(inner);
      if (fragment) {
        const slug = fragment[1];
        if (stack.includes(slug)) {
          throw badRequest(`Fragment cycle: ${[...stack, slug].join(' → ')}`);
        }
        if (stack.length >= MAX_FRAGMENT_DEPTH) {
          throw badRequest(`Fragments nest deeper than ${MAX_FRAGMENT_DEPTH}`);
        }
        const source = await resolveFragment(slug);
        if (!source) throw badRequest(`Unknown fragment: ${slug}`);
        fragments.push({ slug, versionId: source.versionId });
        const declared = fragmentArguments(source.sql);
        const given = new Map<string, string>();
        const call = fragment[2]?.trim();
        if (call) {
          if (call.includes('{{')) {
            throw badRequest(
              `${where}: an argument to ${slug} cannot contain a placeholder; pass $name to forward one of your own`,
            );
          }
          const parts = splitArguments(call, `${where}, ${slug}()`);
          parts.forEach((part, position) => {
            const named = /^([a-z_][a-z0-9_]*)\s*=>\s*([\s\S]+)$/.exec(part);
            const name = named ? named[1] : declared[position]?.name;
            if (!name || !declared.some((entry) => entry.name === name)) {
              throw badRequest(
                named
                  ? `${slug} has no argument "${named[1]}"; it takes ${declared.map((entry) => entry.name).join(', ') || 'none'}`
                  : `${slug} takes ${declared.length} argument${declared.length === 1 ? '' : 's'}, given ${parts.length}`,
              );
            }
            let value = (named ? named[2] : part).trim();
            // `$name` forwards an argument of the fragment being expanded.
            const forwarded = /^\$([a-z_][a-z0-9_]*)$/.exec(value);
            if (forwarded) {
              // Run alone, a fragment's own arguments are empty.
              const outer = args === null ? 'NULL' : args.get(forwarded[1]);
              if (outer === undefined) {
                throw badRequest(
                  `${where}: no argument $${forwarded[1]} to pass on`,
                );
              }
              value = outer;
            }
            given.set(name, value);
          });
        }
        // A fragment's own declarations apply unless the query declares the
        // same name itself, in which case the query's definition wins.
        for (const definition of source.parameters) {
          if (!scope.has(definition.name))
            scope.set(definition.name, definition);
        }
        const body = await expand(
          source.sql,
          `Fragment ${slug}`,
          [...stack, slug],
          given,
        );
        out += `(\n${body}\n)`;
        continue;
      }

      const argument = ARGUMENT.exec(inner);
      if (argument) {
        const [, name, fallback] = argument;
        const value =
          args?.get(name) ??
          (fallback !== undefined || args === null
            ? (fallback?.trim() ?? 'NULL')
            : undefined);
        if (value === undefined) {
          throw badRequest(`${where} needs an argument "${name}"`);
        }
        out += `(${value})`;
        continue;
      }

      // `{{exits}}`, from before lists, is the list of that name.
      const list = LIST.exec(inner) ?? (inner === 'exits' ? [inner, 'exits'] : null);
      if (list) {
        const name = list[1];
        const type = await resolveList(name);
        if (!type) {
          throw badRequest(
            `${where}: there is no list "${name}"; add it under Settings → Lists`,
          );
        }
        lists.add(name);
        if (list[2] === 'names') {
          labeledLists.add(name);
          const labels = slot(`list-label:${name}`, { kind: 'list-label', name });
          out += `$${labels}::text[]`;
        } else {
          const position = slot(`list:${name}`, { kind: 'list', name });
          out += `$${position}::${LIST_CAST[type]}`;
        }
        continue;
      }

      if (NAME.test(inner)) {
        if (isSystemParameter(inner)) {
          system.add(inner);
          const position = slot(`system:${inner}`, {
            kind: 'system',
            name: inner,
          });
          out += `$${position}::${SYSTEM_PARAMETERS[inner]}`;
          continue;
        }
        // Resolved after expansion, once every fragment's declarations are in
        // scope; the cast is filled in then.
        used.add(inner);
        const position = slot(`user:${inner}`, { kind: 'user', name: inner });
        out += `$${position}::\u0000${inner}\u0000`;
        continue;
      }

      throw badRequest(`${where}: unrecognized placeholder {{${inner}}}`);
    }
    copy(text.length);
    return out.trim();
  };

  for (const definition of definitions) scope.set(definition.name, definition);
  let text = await expand(sql, 'Query', [], null);
  // An expression fragment run on its own: one value.
  if (!isRelation(text)) text = `SELECT (${text}) AS value`;

  for (const name of used) {
    const definition = scope.get(name);
    if (!definition) {
      throw badRequest(
        `Parameter "${name}" is used but not declared; add it to the query's parameters`,
      );
    }
    text = text.replaceAll(`\u0000${name}\u0000`, PG_TYPE[definition.type]);
  }

  return {
    text,
    slots,
    parameters: [...scope.values()],
    used: [...used],
    system: [...system],
    lists: [...lists],
    labeledLists: [...labeledLists],
    fragments,
  };
}

export type SystemValues = {
  network: string;
  /** Each list the statement reads, as its values for this data source. */
  lists?: Record<string, BindValue>;
  listLabels?: Record<string, BindValue>;
};

/**
 * Resolves every declared parameter to a value — supplied, else the default —
 * and lays out the bind values in slot order.
 *
 * `resolved` holds the user parameters only: it is what identifies a result, so
 * two runs with the same values share one, while system values are accounted
 * for separately (see the inputs hash).
 */
export function bind(
  compiled: Compiled,
  supplied: Record<string, unknown>,
  systemValues: SystemValues,
): { values: BindValue[]; resolved: Record<string, BindValue> } {
  const resolved: Record<string, BindValue> = {};
  for (const name of Object.keys(supplied)) {
    if (!compiled.parameters.some((definition) => definition.name === name)) {
      throw badRequest(`Unknown parameter "${name}"`);
    }
  }
  for (const definition of compiled.parameters) {
    if (!compiled.used.includes(definition.name)) continue;
    const raw = supplied[definition.name] ?? definition.default;
    if (raw === undefined || raw === null) {
      throw badRequest(`Parameter "${definition.name}" needs a value`);
    }
    resolved[definition.name] = coerce(definition, raw);
  }

  const values = compiled.slots.map((slot): BindValue => {
    switch (slot.kind) {
      case 'user':
        return resolved[slot.name];
      case 'system':
        return systemValues.network;
      case 'list': {
        const value = systemValues.lists?.[slot.name];
        if (value === undefined) {
          throw new Error(
            `list ${slot.name} was not resolved for a query that uses it`,
          );
        }
        return value;
      }
      case 'list-label': {
        const value = systemValues.listLabels?.[slot.name];
        if (value === undefined) throw new Error(`labels for list ${slot.name} were not resolved`);
        return value;
      }
    }
  });
  return { values, resolved };
}

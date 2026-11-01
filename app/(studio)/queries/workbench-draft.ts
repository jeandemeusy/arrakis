import {
  type Combine,
  type Kind,
  type ParameterDefinition,
  type QueryRecord,
  type Visibility,
} from '../api';
import { segments } from '@/lib/query/scan';

/**
 * The workbench's draft: what the form holds before it is saved, how it is made
 * from a saved query, and the small helpers that read it.
 */

export type Draft = {
  slug: string;
  title: string;
  description: string;
  kind: Kind;
  visibility: Visibility;
  combine: Combine;
  refreshSeconds: number | null;
  timeoutSeconds: number | null;
  rowLimit: number | null;
  sql: string;
  parameters: ParameterDefinition[];
};

const SYSTEM_NAMES = new Set(['network', 'exits']);

const STARTER_SQL = `-- Each run reads one network, or every network with "All".
-- {{network}} and {{exits}} are filled in for you; {{> slug}} inlines a fragment.
SELECT
  account.chain_key AS address,
  account.published_block,
  {{block_time(account.published_block)}} AS deployed_at
FROM account
ORDER BY account.published_block DESC
LIMIT 100`;

export function emptyDraft(): Draft {
  return {
    slug: '',
    title: '',
    description: '',
    kind: 'query',
    visibility: 'private',
    combine: 'concat',
    refreshSeconds: null,
    timeoutSeconds: null,
    rowLimit: null,
    sql: STARTER_SQL,
    parameters: [],
  };
}

export function draftOf(query: QueryRecord): Draft {
  return {
    slug: query.slug,
    title: query.title,
    description: query.description,
    kind: query.kind,
    visibility: query.visibility,
    combine: query.combine,
    refreshSeconds: query.refreshSeconds,
    timeoutSeconds: query.timeoutSeconds,
    rowLimit: query.rowLimit,
    sql: query.current?.sql ?? '',
    parameters: query.current?.parameters ?? [],
  };
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** The SQL outside comments and strings. */
export function codeOf(sql: string): string {
  return segments(sql)
    .filter((segment) => segment.code)
    .map((segment) => segment.text)
    .join(' ');
}

/** `{{name}}` placeholders in code that are neither declared nor built in. */
export function undeclared(
  sql: string,
  declared: ParameterDefinition[],
): string[] {
  const known = new Set(declared.map((parameter) => parameter.name));
  const found = new Set<string>();
  // Comments and strings are stripped first so a commented-out placeholder
  // does not become a parameter.
  const code = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^']|'')*'/g, "''");
  for (const match of code.matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g)) {
    const name = match[1];
    if (!known.has(name) && !SYSTEM_NAMES.has(name)) found.add(name);
  }
  return [...found];
}

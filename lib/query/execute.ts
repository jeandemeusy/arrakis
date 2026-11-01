import 'server-only';

import { createHash } from 'node:crypto';

import { badRequest } from '../api/errors';
import type { NetworkConfig } from '../networks';
import { toJsonValue, type Column } from './columns';
import { bind, compile, type Compiled, type ResolveFragment } from './compile';
import { listResolver, listValues } from './lists';
import {
  coerce,
  displayValue,
  type BindValue,
  type ParameterDefinition,
} from './params';
import { timeoutFor } from './limits';
import { runReadOnly } from './runner';
import { fragmentResolver } from './store';

/**
 * From template to rows: compile, resolve the system values the statement
 * actually uses, bind, run. Also derives the two fingerprints that identify a
 * result — which parameter values it was run with, and which inputs outside
 * the SQL (fragment versions, the exit set) shaped it.
 */

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Same values, same hash, whatever order they were supplied in. */
function canonical(values: Record<string, BindValue>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(values)
      .sort()
      .map((key) => [key, displayValue(values[key])]),
  );
}

/**
 * The user parameter values a run would use, and their hash, without touching
 * a data source. Readers use it to find the stored result for a request.
 */
export function parameterKey(
  compiled: Compiled,
  supplied: Record<string, unknown>,
): { values: Record<string, unknown>; hash: string } {
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
  const values = canonical(resolved);
  return { values, hash: sha256(values) };
}

/**
 * Everything outside the SQL text that changes what a query returns on this
 * data source: the fragment versions it inlined and the lists it reads. A
 * stored result whose fingerprint differs is stale.
 *
 * Shaped as it was when the only list was the exit set, so results stored
 * then stay current.
 */
export async function inputsFingerprint(
  compiled: Compiled,
  network: NetworkConfig,
  lists?: Record<string, BindValue>,
): Promise<string> {
  const values = lists ?? (await listValues(compiled.lists, network.id));
  const text = (value: unknown) =>
    Buffer.isBuffer(value) ? value.toString('hex') : String(value);
  const others = compiled.lists.filter((name) => name !== 'exits').sort();
  return sha256({
    fragments: compiled.fragments,
    exits: compiled.lists.includes('exits')
      ? (values.exits as unknown[]).map(text)
      : null,
    ...(others.length
      ? {
          lists: Object.fromEntries(
            others.map((name) => [name, (values[name] as unknown[]).map(text)]),
          ),
        }
      : {}),
  });
}

export type Prepared = {
  compiled: Compiled;
  values: BindValue[];
  parameters: { values: Record<string, unknown>; hash: string };
  inputsHash: string;
};

export async function prepare(
  source: { sql: string; parameters: ParameterDefinition[] },
  supplied: Record<string, unknown>,
  network: NetworkConfig,
  resolve: ResolveFragment = fragmentResolver(),
): Promise<Prepared> {
  const compiled = await compile(
    source.sql,
    source.parameters,
    resolve,
    listResolver(),
  );
  const lists = await listValues(compiled.lists, network.id);
  const { values } = bind(compiled, supplied, { network: network.id, lists });
  return {
    compiled,
    values,
    parameters: parameterKey(compiled, supplied),
    inputsHash: await inputsFingerprint(compiled, network, lists),
  };
}

export type Preview = {
  columns: Column[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  networks: Array<{
    id: string;
    rowCount: number;
    durationMs: number;
    error?: string;
  }>;
};

/**
 * Runs SQL for the editor and returns the rows, without storing anything.
 *
 * Across several networks the rows are stacked under a leading `network`
 * column. A network that fails is reported beside the others rather than
 * failing the whole preview — unless it is the only one asked for.
 */
export async function preview(
  source: { sql: string; parameters: ParameterDefinition[] },
  supplied: Record<string, unknown>,
  targets: NetworkConfig[],
  rowLimit: number,
  options: {
    /** Seconds the query asks for; the preview default otherwise. */
    timeoutSeconds?: number | null;
    /** The page's token for this run, to cancel it by. */
    runKey?: string;
    query?: string;
    startedBy?: string;
    /** The plan rather than the rows; `analyze` runs it to measure. */
    explain?: 'plan' | 'analyze';
  } = {},
): Promise<Preview> {
  const outcomes = await Promise.allSettled(
    targets.map(async (network) => {
      const prepared = await prepare(source, supplied, network);
      const outcome = await runReadOnly({
        network,
        text: prepared.compiled.text,
        values: prepared.values,
        rowLimit,
        timeoutMs: timeoutFor('preview', options.timeoutSeconds),
        explain: options.explain,
        track: {
          kind: 'preview',
          runKey: options.runKey,
          query: options.query,
          startedBy: options.startedBy,
        },
      });
      return { network, prepared, outcome };
    }),
  );

  if (targets.length === 1) {
    const only = outcomes[0];
    if (only.status === 'rejected') throw only.reason;
    const { network, outcome } = only.value;
    return {
      columns: outcome.columns,
      rows: outcome.rows.map((row) => row.map(toJsonValue)),
      rowCount: outcome.rowCount,
      truncated: outcome.truncated,
      networks: [
        {
          id: network.id,
          rowCount: outcome.rowCount,
          durationMs: outcome.durationMs,
        },
      ],
    };
  }

  const result: Preview = {
    columns: [],
    rows: [],
    rowCount: 0,
    truncated: false,
    networks: [],
  };
  let shape: string | null = null;
  outcomes.forEach((settled, index) => {
    const id = targets[index].id;
    if (settled.status === 'rejected') {
      result.networks.push({
        id,
        rowCount: 0,
        durationMs: 0,
        error: (settled.reason as Error).message,
      });
      return;
    }
    const { outcome } = settled.value;
    const signature = JSON.stringify(outcome.columns);
    if (shape === null) {
      shape = signature;
      result.columns = [{ name: 'network', type: 'text' }, ...outcome.columns];
    } else if (signature !== shape) {
      result.networks.push({
        id,
        rowCount: 0,
        durationMs: outcome.durationMs,
        error: 'Returned different columns from the other networks',
      });
      return;
    }
    for (const row of outcome.rows) {
      if (result.rows.length >= rowLimit) {
        result.truncated = true;
        break;
      }
      result.rows.push([id, ...row.map(toJsonValue)]);
    }
    result.truncated ||= outcome.truncated;
    result.networks.push({
      id,
      rowCount: outcome.rowCount,
      durationMs: outcome.durationMs,
    });
  });
  result.rowCount = result.rows.length;
  if (!result.columns.length) {
    // Every network failed: surface the first failure as the error.
    const first = outcomes.find((settled) => settled.status === 'rejected');
    if (first?.status === 'rejected') throw first.reason;
  }
  return result;
}

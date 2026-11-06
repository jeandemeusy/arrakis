'use client';

import { useState } from 'react';
import type { VisualizationConfig } from '@/lib/viz/config';
import type { Step, ValueRef } from '@/lib/viz/transform';
import { valueInputs } from '@/lib/viz/value-inputs';
import { asText } from '@/lib/viz/text';
import { api, ApiError } from '../(studio)/api';
import type { WidgetPayload } from './widget-tile';

type Data = Extract<WidgetPayload, { state: 'ok' }>['data'];
type Inputs = Data & {
  scope: 'aggregate' | 'first-row';
  hasMore: boolean;
  supported: true;
};
const WHEN = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function ref(
  value: ValueRef | undefined,
  vars: Record<string, string | undefined>,
): string {
  if (!value) return 'no value';
  if ('var' in value) return `${value.var} (${vars[value.var] ?? 'not set'})`;
  return value.literal === null ? 'null' : asText(value.literal);
}

function describe(
  step: Step,
  vars: Record<string, string | undefined>,
): string {
  switch (step.op) {
    case 'filter':
      return `Filter ${step.column} ${step.operator.replaceAll('_', ' ')}${step.operator === 'is_null' || step.operator === 'not_null' ? '' : ` ${ref(step.value, vars)}`}${step.optional && 'var' in (step.value ?? {}) && !vars[(step.value as { var: string }).var] ? ' (skipped because the variable is not set)' : ''}`;
    case 'range': {
      const selected = step.window ?? vars[step.var ?? 'range'];
      if (!selected || selected === 'all')
        return `No range limit on ${step.column}`;
      return `Keep ${step.column} within ${step.window ?? ref({ var: step.var ?? 'range' }, vars)} of ${step.anchorColumn ? step.anchorColumn : step.anchor === 'now' ? 'now' : 'the latest value'}`;
    }
    case 'bucket':
      return `Group ${step.column} into ${step.size ? `${step.size}-unit bins` : step.unit.replaceAll('_', ' ')} as ${step.as}`;
    case 'compute':
      return `Calculate ${step.as} from ${step.left} ${step.operator} ${typeof step.right === 'string' ? step.right : step.right.literal}`;
    case 'window':
      return `Calculate ${step.as} using ${step.fn.replaceAll('_', ' ')}${step.column ? ` of ${step.column}` : ''}`;
    case 'aggregate':
      return `Calculate ${step.measures.map((measure) => `${measure.fn.replaceAll('_', ' ')}${measure.columns?.length ? ` of ${measure.columns.join(', ')}` : ''} as ${measure.as}`).join('; ')}${step.groupBy.length ? `, grouped by ${step.groupBy.join(', ')}` : ' across all matching rows'}`;
    case 'rolling':
      return `Calculate a ${step.days}-day rolling window over ${step.time}`;
    case 'top':
      return `Keep the top ${step.n} values of ${step.column} by ${step.by}${step.others ? ` and combine the rest as ${step.others}` : ''}`;
    case 'sort':
      return `Sort by ${step.by.map((entry) => `${entry.column} ${entry.desc ? 'descending' : 'ascending'}`).join(', ')}`;
    case 'limit':
      return `Keep at most ${step.n} rows`;
  }
}

function sameResults(a: Data, b: Data): boolean {
  const snapshot = (data: Data) =>
    [...data.networks]
      .map((network) => [network.id, network.status, network.finishedAt])
      .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  return (
    a.queryVersion === b.queryVersion &&
    JSON.stringify(snapshot(a)) === JSON.stringify(snapshot(b))
  );
}

export function WhyValue({
  data,
  title,
  query,
  source,
  vars,
  config,
  chart,
  network,
  sources,
  busy,
}: {
  data: Data | null;
  title?: string;
  query?: string;
  source?: { href: string; label: string; resultsHref?: string };
  vars: Record<string, string | undefined>;
  config?: VisualizationConfig;
  chart?: { id: string; updatedAt: string };
  network?: string;
  sources?: string;
  busy?: 'running' | 'updating';
}) {
  const [inputs, setInputs] = useState<Inputs | null>(null);
  const [loadedKey, setLoadedKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const plan = config ? valueInputs(config) : null;
  const inputKey = JSON.stringify([
    chart?.id,
    chart?.updatedAt,
    network,
    sources,
    vars,
  ]);
  const visibleInputs =
    !busy && inputs && data && loadedKey === inputKey && sameResults(inputs, data)
      ? inputs
      : null;
  const load = async () => {
    if (!chart || !data) return;
    setLoading(true);
    setError('');
    setInputs(null);
    try {
      const params = new URLSearchParams({
        network: network ?? 'all',
        chartVersion: chart.updatedAt,
      });
      if (sources)
        for (const id of sources.split(',')) params.append('source', id);
      for (const [key, value] of Object.entries(vars))
        if (value !== undefined) params.set(`v.${key}`, value);
      const result = await api<Inputs | { supported: false; reason: string }>(
        `/api/v1/visualizations/${chart.id}/inputs?${params}`,
      );
      if (!result.supported) setError(result.reason);
      else if (!sameResults(data, result))
        setError(
          'The stored result changed. Close this dialog and reload the dashboard before inspecting its rows.',
        );
      else if (
        result.scope === 'first-row' &&
        (JSON.stringify(result.columns) !== JSON.stringify(data.columns) ||
          JSON.stringify(result.rows[0]) !== JSON.stringify(data.rows[0]))
      )
        setError(
          'The first row is not stable, so it cannot be matched reliably to this value.',
        );
      else {
        setInputs(result);
        setLoadedKey(inputKey);
      }
    } catch (failure) {
      setError((failure as ApiError).message);
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="tile-details">
      {query && (
        <p>
          <strong>Query:</strong> {query}
          {data?.queryVersion != null ? ` · v${data.queryVersion}` : ''}
          {source && (
            <>
              {' '}
              · <a href={source.href}>Open chart and query</a>
            </>
          )}
        </p>
      )}
      {title && (
        <p>
          <strong>Chart:</strong> {title}
        </p>
      )}
      {data?.networks.map((entry) => (
        <p key={entry.id}>
          <strong>{entry.id}:</strong> {entry.status}
          {entry.stale ? ' · stale' : ''}
          {entry.finishedAt
            ? ` · last successful run ${WHEN.format(new Date(entry.finishedAt))}`
            : ''}
          {entry.lastAttempt?.status === 'failed'
            ? ` · last run failed${entry.lastAttempt.error ? `: ${entry.lastAttempt.error}` : ''}`
            : ''}
        </p>
      ))}
      {Object.entries(vars)
        .filter(([, value]) => value !== undefined)
        .map(([name, value]) => (
          <p key={name}>
            <strong>{name}:</strong> {value}
          </p>
        ))}
      {config && (
        <section className="why-section">
          <h3>How the chart calculates it</h3>
          {config.sql ? (
            <p>
              The chart uses custom SQL over the stored query result. Open the
              chart to inspect that SQL.
            </p>
          ) : config.steps.length ? (
            <ol>
              {config.steps.map((step, index) => (
                <li key={index}>{describe(step, vars)}</li>
              ))}
            </ol>
          ) : (
            <p>
              The chart reads its value directly from the first stored result
              row.
            </p>
          )}
        </section>
      )}
      <section className="why-section">
        <h3>Chart result</h3>
        <p>
          {data
            ? `${data.rows.length} transformed row${data.rows.length === 1 ? '' : 's'}${data.truncated ? ' (truncated)' : ''}.`
            : 'Not available.'}
        </p>
        {data && data.rows.length > 0 && (
          <div className="tile-details-table">
            <table>
              <thead>
                <tr>
                  {data.columns.map((column) => (
                    <th key={column.name}>{column.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.slice(0, 10).map((row, index) => (
                  <tr key={index}>
                    {row.map((value, at) => (
                      <td key={at}>{asText(value)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.rows.length > 10 && (
          <p>Showing the first 10 transformed rows.</p>
        )}
      </section>
      {chart && config && (
        <section className="why-section">
          <h3>Rows behind the value</h3>
          {plan?.supported ? (
            <>
              <p>
                {plan.scope === 'aggregate'
                  ? 'See the stored query rows after the chart’s filters and calculations, before aggregation. Nulls and duplicate values may be handled differently by each aggregate.'
                  : 'See the first stored query row after the chart’s transformations.'}
              </p>
          {busy ? (
            <p>Wait for the chart to finish updating before inspecting its input rows.</p>
          ) : data?.pending ? (
                <p>There is no stored result yet.</p>
              ) : data && !data.rows.length ? (
                <p>The chart returned no value to trace.</p>
              ) : (
                <button
                  type="button"
                  className="studio-button"
                  disabled={loading || !data}
                  onClick={() => void load()}
                >
                  {loading ? 'Loading…' : 'Show input rows'}
                </button>
              )}
            </>
          ) : (
            <p>{plan?.reason}</p>
          )}
          {error && (
            <p className="studio-error" role="alert">
              {error}
            </p>
          )}
          {!busy && inputs && !visibleInputs && (
            <p className="studio-error">
              The displayed result changed. Load the input rows again.
            </p>
          )}
          {visibleInputs && (
            <>
              <p>
                {visibleInputs.rows.length
                  ? `Showing ${visibleInputs.rows.length}${visibleInputs.hasMore ? ' of more than 100' : ''} input rows.`
                  : 'No input rows match.'}
              </p>
              <div className="tile-details-table">
                <table>
                  <thead>
                    <tr>
                      {visibleInputs.columns.map((column) => (
                        <th key={column.name}>{column.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleInputs.rows.map((row, index) => (
                      <tr key={index}>
                        {row.map((value, at) => (
                          <td key={at}>{asText(value)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {source?.resultsHref && (
            <p>
              <a href={source.resultsHref}>
                Open the complete stored query result
              </a>{' '}
              (before chart filters).
            </p>
          )}
        </section>
      )}
    </div>
  );
}

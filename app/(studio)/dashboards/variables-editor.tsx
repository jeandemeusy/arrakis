'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { type DashboardVariable, type Network } from '../api';

/**
 * A variable's choices as one line, `value` or `value=Label` separated by
 * commas: `7d=Last 7 days, 31d=Last 30 days, all`. Kept as typed until the
 * field loses focus, so a half-written entry is not tidied away mid-word.
 */
function OptionsInput({
  variable,
  onChange,
}: {
  variable: DashboardVariable;
  onChange: (options: string[], labels?: Record<string, string>) => void;
}) {
  const written = (variable.options ?? [])
    .map((option) =>
      variable.labels?.[option]
        ? `${option}=${variable.labels[option]}`
        : option,
    )
    .join(', ');
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="studio-input"
      aria-label="Options"
      placeholder="7d=Last 7 days, 30d, all"
      value={draft ?? written}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft === null) return;
        const options: string[] = [];
        const labels: Record<string, string> = {};
        for (const entry of draft.split(',')) {
          const [value, ...rest] = entry.split('=');
          const option = value.trim();
          if (!option) continue;
          options.push(option);
          const label = rest.join('=').trim();
          if (label) labels[option] = label;
        }
        setDraft(null);
        onChange(options, Object.keys(labels).length ? labels : undefined);
      }}
    />
  );
}

export function VariablesEditor({
  variables,
  networks,
  onChange,
}: {
  variables: DashboardVariable[];
  networks: Network[];
  onChange: (variables: DashboardVariable[]) => void;
}) {
  const set = (at: number, patch: Partial<DashboardVariable>) =>
    onChange(
      variables.map((variable, index) =>
        index === at ? { ...variable, ...patch } : variable,
      ),
    );
  return (
    <div className="variables-editor">
      {variables.map((variable, at) => (
        <div className="variable-row" key={at}>
          <input
            className="studio-input mono"
            aria-label="Variable name"
            value={variable.name}
            onChange={(event) => set(at, { name: event.target.value })}
          />
          <input
            className="studio-input"
            aria-label="Label"
            value={variable.label}
            onChange={(event) => set(at, { label: event.target.value })}
          />
          <select
            className="studio-input"
            aria-label="Type"
            value={variable.type}
            onChange={(event) => {
              const type = event.target.value as DashboardVariable['type'];
              set(at, {
                type,
                networks: undefined,
                options:
                  type === 'range'
                    ? ['7d', '30d', '90d', 'all']
                    : type === 'select'
                      ? (variable.options ?? ['a', 'b'])
                      : undefined,
                default:
                  type === 'network'
                    ? 'all'
                    : type === 'range'
                      ? '30d'
                      : variable.default,
              });
            }}
          >
            <option value="range">time range</option>
            <option value="network">data source</option>
            <option value="text">text (set by clicks)</option>
            <option value="select">select</option>
          </select>
          <label className="variable-label-option">
            <input
              type="checkbox"
              checked={variable.showLabel !== false}
              onChange={(event) =>
                set(at, { showLabel: event.target.checked ? undefined : false })
              }
            />
            Show label on dashboard
          </label>
          {variable.type === 'network' && (
            <label
              className="stack-sources"
              title="Offer every data source at once, their rows stacked under a source column"
            >
              <input
                type="checkbox"
                checked={variable.stack !== false}
                onChange={(event) =>
                  set(at, { stack: event.target.checked ? undefined : false })
                }
              />
              <span>All, stacked</span>
            </label>
          )}
          {variable.type === 'network' && (
            <fieldset className="allowed-networks">
              <legend>Selectable data sources</legend>
              <label>
                <input
                  type="checkbox"
                  checked={!variable.networks}
                  onChange={(event) => {
                    if (event.target.checked) set(at, { networks: undefined });
                    else if (networks.length)
                      set(at, {
                        networks: networks.map((network) => network.id),
                      });
                  }}
                />
                All configured sources
              </label>
              {variable.networks && (
                <div className="allowed-networks-list">
                  {[
                    ...networks,
                    ...variable.networks
                      .filter(
                        (id) => !networks.some((network) => network.id === id),
                      )
                      .map((id) => ({ id, label: `${id} (unavailable)` })),
                  ].map((network) => {
                    const selected = variable.networks!.includes(network.id);
                    return (
                      <label key={network.id}>
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={selected && variable.networks!.length === 1}
                          onChange={(event) => {
                            const next = event.target.checked
                              ? [...variable.networks!, network.id]
                              : variable.networks!.filter(
                                  (id) => id !== network.id,
                                );
                            set(at, {
                              networks: next,
                              default:
                                variable.default &&
                                variable.default !== 'all' &&
                                !next.includes(variable.default)
                                  ? next[0]
                                  : variable.default,
                            });
                          }}
                        />
                        {network.label}
                      </label>
                    );
                  })}
                </div>
              )}
              {!networks.length && <small>Data sources are unavailable.</small>}
            </fieldset>
          )}
          {(variable.type === 'range' || variable.type === 'select') && (
            <OptionsInput
              variable={variable}
              onChange={(options, labels) => set(at, { options, labels })}
            />
          )}
          <input
            className="studio-input"
            aria-label="Default"
            placeholder="default"
            value={variable.default ?? ''}
            onChange={(event) =>
              set(at, { default: event.target.value || undefined })
            }
          />
          <button
            type="button"
            className="studio-icon-button"
            aria-label={`Remove ${variable.name}`}
            onClick={() =>
              onChange(variables.filter((_, index) => index !== at))
            }
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="studio-button"
        onClick={() =>
          onChange([
            ...variables,
            {
              name: `var_${variables.length + 1}`,
              label: 'Selection',
              type: 'text',
            },
          ])
        }
      >
        <Plus size={12} aria-hidden="true" /> Variable
      </button>
    </div>
  );
}

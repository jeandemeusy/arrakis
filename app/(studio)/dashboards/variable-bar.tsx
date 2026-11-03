'use client';

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { type DashboardVariable, type Network } from '../api';
import { VariableSwitch } from './variable-switch';

function shortValue(value: string): string {
  return /^0x[0-9a-f]{16,}$/i.test(value)
    ? `${value.slice(0, 6)}…${value.slice(-4)}`
    : value;
}

export function VariableBar({
  variables,
  vars,
  networks,
  freshnessSummary,
  actions,
  onChange,
}: {
  variables: DashboardVariable[];
  vars: Record<string, string | undefined>;
  networks: Network[];
  freshnessSummary?: string;
  actions?: ReactNode;
  onChange: (name: string, value: string | undefined) => void;
}) {
  return (
    <div className="dashboard-vars">
      {variables.map((variable) => {
        if (variable.type === 'network' && variable.fixed) return null;
        const allowedNetworks =
          variable.type === 'network' && variable.networks
            ? networks.filter((network) =>
                variable.networks!.includes(network.id),
              )
            : networks;
        const raw = vars[variable.name];
        // A single source, or a non-stacking variable, resolves "all" to
        // the source actually being displayed.
        const value =
          variable.type === 'network' &&
          (variable.stack === false || allowedNetworks.length === 1) &&
          (raw === 'all' || !raw)
            ? allowedNetworks[0]?.id
            : raw;
        if (variable.type === 'range' || variable.type === 'select') {
          return (
            <VariableSwitch
              key={variable.name}
              variable={variable}
              showLabel={variable.showLabel !== false}
              value={value}
              onChange={(option) => onChange(variable.name, option)}
            />
          );
        }
        if (variable.type === 'network') {
          const options = [
            ...(allowedNetworks.length > 1 && variable.stack !== false
              ? [{ value: 'all', label: 'All, stacked' }]
              : []),
            ...allowedNetworks.map((network) => ({
              value: network.id,
              label: network.label,
            })),
          ];
          if (!allowedNetworks.length) return null;
          return (
            <fieldset key={variable.name} className="network-switch">
              <legend
                className={variable.showLabel === false ? 'sr-only' : undefined}
              >
                {variable.label}
              </legend>
              {options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={value === option.value}
                  className={value === option.value ? 'active' : ''}
                  onClick={() => onChange(variable.name, option.value)}
                >
                  {option.label}
                </button>
              ))}
            </fieldset>
          );
        }
        return value ? (
          <span key={variable.name} className="var-chip">
            <span
              className={variable.showLabel === false ? 'sr-only' : undefined}
            >
              {variable.label}
            </span>
            <code title={value}>{shortValue(value)}</code>
            <button
              type="button"
              aria-label={`Clear ${variable.label}`}
              onClick={() => onChange(variable.name, undefined)}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ) : (
          <label key={variable.name} className="var-input">
            <span
              className={variable.showLabel === false ? 'sr-only' : undefined}
            >
              {variable.label}
            </span>
            <input
              className="studio-input mono"
              placeholder="any"
              onKeyDown={(event) => {
                if (event.key === 'Enter')
                  onChange(
                    variable.name,
                    event.currentTarget.value || undefined,
                  );
              }}
              onBlur={(event) =>
                event.currentTarget.value &&
                onChange(variable.name, event.currentTarget.value)
              }
            />
          </label>
        );
      })}
      {actions}
      {freshnessSummary && (
        <span
          className="dashboard-freshness"
          title="Oldest available result across visible dashboard data"
        >
          {freshnessSummary}
        </span>
      )}
    </div>
  );
}

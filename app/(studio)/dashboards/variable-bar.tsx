'use client';

import { X } from 'lucide-react';
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
  onChange,
}: {
  variables: DashboardVariable[];
  vars: Record<string, string | undefined>;
  networks: Network[];
  onChange: (name: string, value: string | undefined) => void;
}) {
  return (
    <div className="dashboard-vars">
      {variables.map((variable) => {
        const raw = vars[variable.name];
        // Not stacking: "all" means the first source, as the server reads it.
        const value =
          variable.type === 'network' &&
          variable.stack === false &&
          raw === 'all'
            ? networks[0]?.id
            : raw;
        if (variable.type === 'range' || variable.type === 'select') {
          return (
            <VariableSwitch
              key={variable.name}
              variable={variable}
              value={value}
              onChange={(option) => onChange(variable.name, option)}
            />
          );
        }
        if (variable.type === 'network') {
          const options = [
            ...(networks.length > 1 && variable.stack !== false
              ? [{ value: 'all', label: 'All, stacked' }]
              : []),
            ...networks.map((network) => ({
              value: network.id,
              label: network.label,
            })),
          ];
          if (networks.length <= 1) return null;
          return (
            <fieldset key={variable.name} className="network-switch">
              <legend className="sr-only">{variable.label}</legend>
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
            <span>{variable.label}</span>
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
            <span>{variable.label}</span>
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
    </div>
  );
}

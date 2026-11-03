'use client';

import type { DashboardVariable } from '../api';

/**
 * The choices of a `range` or `select` variable, drawn as a row of buttons.
 *
 * It is the same control on a dashboard and in the chart editor's preview, so
 * a window reads and is picked the same way in both: the options, their
 * labels and their default come from one variable definition.
 */
export function VariableSwitch({
  variable,
  value,
  onChange,
  showLabel = false,
}: {
  variable: Pick<DashboardVariable, 'label' | 'options' | 'labels'>;
  value: string | undefined;
  onChange: (value: string) => void;
  showLabel?: boolean;
}) {
  return (
    <fieldset className="network-switch">
      <legend className={showLabel ? undefined : 'sr-only'}>{variable.label}</legend>
      {(variable.options ?? []).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          className={value === option ? 'active' : ''}
          onClick={() => onChange(option)}
        >
          {variable.labels?.[option] ?? (option === 'all' ? 'All' : option)}
        </button>
      ))}
    </fieldset>
  );
}

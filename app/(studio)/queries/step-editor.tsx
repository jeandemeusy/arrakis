'use client';

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';

import type { Measure, Step } from '@/lib/viz/transform';

/**
 * Forms for the transform steps.
 *
 * Every column field is a select over the columns the previous step left, so
 * a step can only name something that exists at that point.
 */

export type ScopeColumn = { name: string; type: string };

export const NUMERIC = ['integer', 'bigint', 'float', 'numeric'];
export const TEMPORAL = ['date', 'timestamp', 'timestamptz'];

export const STEP_LABELS: Record<Step['op'], string> = {
  filter: 'Filter rows',
  range: 'Limit to a range',
  bucket: 'Bucket a time',
  compute: 'Compute a column',
  window: 'Window function',
  aggregate: 'Group and aggregate',
  rolling: 'Rolling window',
  top: 'Top N + others',
  sort: 'Sort',
  limit: 'Limit rows',
};

export function newStep(op: Step['op'], scope: ScopeColumn[]): Step {
  const first = scope[0]?.name ?? '';
  const time =
    scope.find((column) => TEMPORAL.includes(column.type))?.name ?? first;
  const number =
    scope.find((column) => NUMERIC.includes(column.type))?.name ?? first;
  switch (op) {
    case 'filter':
      return { op, column: first, operator: '=', value: { literal: '' } };
    case 'range':
      return { op, column: time };
    case 'bucket':
      return { op, column: time, unit: 'day', as: 'day' };
    case 'compute':
      return {
        op,
        as: 'computed',
        left: number,
        operator: '/',
        right: { literal: 1 },
      };
    case 'window':
      return { op, as: 'first_seen', fn: 'min', column: time, partitionBy: [] };
    case 'aggregate':
      return { op, groupBy: [], measures: [{ fn: 'count', as: 'count' }] };
    case 'rolling':
      return {
        op,
        time,
        days: 7,
        fill: true,
        measures: [{ fn: 'count', as: 'rolling' }],
      };
    case 'top':
      return { op, column: first, by: number, n: 5, sum: [number] };
    case 'sort':
      return { op, by: [{ column: first, desc: true }] };
    case 'limit':
      return { op, n: 100 };
  }
}

export function ColumnSelect({
  value,
  scope,
  onChange,
  label,
  filter,
  allowNone,
}: {
  value: string | undefined;
  scope: ScopeColumn[];
  onChange: (value: string) => void;
  label: string;
  filter?: (column: ScopeColumn) => boolean;
  allowNone?: boolean;
}) {
  const options = scope.filter(filter ?? (() => true));
  const known = !value || options.some((column) => column.name === value);
  return (
    <select
      className="studio-input"
      aria-label={label}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value)}
    >
      {(allowNone || !value) && (
        <option value="">{allowNone ? '—' : 'choose…'}</option>
      )}
      {!known && <option value={value}>{value} (missing)</option>}
      {options.map((column) => (
        <option key={column.name} value={column.name}>
          {column.name} · {column.type}
        </option>
      ))}
    </select>
  );
}

export function ColumnList({
  value,
  scope,
  onChange,
  label,
}: {
  value: string[];
  scope: ScopeColumn[];
  onChange: (value: string[]) => void;
  label: string;
}) {
  return (
    <span className="chip-list" aria-label={label}>
      {value.map((name, at) => (
        <span className="chip" key={`${name}-${at}`}>
          {name}
          <button
            type="button"
            aria-label={`Remove ${name}`}
            onClick={() => onChange(value.filter((_, index) => index !== at))}
          >
            ×
          </button>
        </span>
      ))}
      <select
        className="studio-input chip-add"
        aria-label={`Add to ${label}`}
        value=""
        onChange={(event) =>
          event.target.value && onChange([...value, event.target.value])
        }
      >
        <option value="">+ column</option>
        {scope
          .filter((column) => !value.includes(column.name))
          .map((column) => (
            <option key={column.name} value={column.name}>
              {column.name}
            </option>
          ))}
      </select>
    </span>
  );
}

function Measures({
  measures,
  scope,
  onChange,
}: {
  measures: Measure[];
  scope: ScopeColumn[];
  onChange: (measures: Measure[]) => void;
}) {
  const set = (at: number, patch: Partial<Measure>) =>
    onChange(
      measures.map((measure, index) =>
        index === at ? { ...measure, ...patch } : measure,
      ),
    );
  return (
    <div className="measures">
      {measures.map((measure, at) => (
        <div className="measure" key={at}>
          <select
            className="studio-input"
            aria-label="Aggregate function"
            value={measure.fn}
            onChange={(event) => {
              const fn = event.target.value as Measure['fn'];
              set(at, {
                fn,
                columns:
                  fn === 'count'
                    ? []
                    : measure.columns?.length
                      ? measure.columns.slice(
                          0,
                          fn === 'count_distinct' ? undefined : 1,
                        )
                      : [scope[0]?.name ?? ''],
              });
            }}
          >
            <option value="count">count rows</option>
            <option value="count_distinct">count distinct</option>
            <option value="sum">sum</option>
            <option value="avg">average</option>
            <option value="min">min</option>
            <option value="max">max</option>
          </select>
          {measure.fn === 'count_distinct' ? (
            <ColumnList
              label="Distinct columns"
              value={measure.columns ?? []}
              scope={scope}
              onChange={(columns) => set(at, { columns })}
            />
          ) : measure.fn !== 'count' ? (
            <ColumnSelect
              label="Measured column"
              value={measure.columns?.[0]}
              scope={scope}
              filter={
                measure.fn === 'sum' || measure.fn === 'avg'
                  ? (column) => NUMERIC.includes(column.type)
                  : undefined
              }
              onChange={(column) => set(at, { columns: [column] })}
            />
          ) : null}
          <span className="studio-muted">as</span>
          <input
            className="studio-input mono"
            aria-label="Output name"
            value={measure.as}
            onChange={(event) => set(at, { as: event.target.value })}
          />
          <button
            type="button"
            className="studio-icon-button"
            aria-label="Remove measure"
            disabled={measures.length === 1}
            onClick={() =>
              onChange(measures.filter((_, index) => index !== at))
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
            ...measures,
            { fn: 'count', as: `measure_${measures.length + 1}` },
          ])
        }
      >
        <Plus size={12} aria-hidden="true" /> Measure
      </button>
    </div>
  );
}

export function ValueInput({
  value,
  onChange,
}: {
  value:
    | { literal: string | number | boolean | null }
    | { var: string }
    | undefined;
  onChange: (value: { literal: string } | { var: string }) => void;
}) {
  const isVar = Boolean(value && 'var' in value);
  const text = value
    ? 'var' in value
      ? value.var
      : String(value.literal ?? '')
    : '';
  return (
    <span className="inline-field">
      <select
        className="studio-input"
        aria-label="Value source"
        value={isVar ? 'var' : 'literal'}
        onChange={(event) =>
          onChange(
            event.target.value === 'var'
              ? { var: text || 'client' }
              : { literal: text },
          )
        }
      >
        <option value="literal">value</option>
        <option value="var">variable</option>
      </select>
      <input
        className="studio-input mono"
        aria-label={isVar ? 'Variable name' : 'Value'}
        value={text}
        placeholder={isVar ? 'client' : 'value'}
        onChange={(event) =>
          onChange(
            isVar
              ? { var: event.target.value }
              : { literal: event.target.value },
          )
        }
      />
    </span>
  );
}

function StepFields({
  step,
  scope,
  onChange,
}: {
  step: Step;
  scope: ScopeColumn[];
  onChange: (step: Step) => void;
}) {
  const patch = (changes: Partial<Step>) =>
    onChange({ ...step, ...changes } as Step);
  switch (step.op) {
    case 'filter':
      return (
        <>
          <ColumnSelect
            label="Column"
            value={step.column}
            scope={scope}
            onChange={(column) => patch({ column })}
          />
          <select
            className="studio-input"
            aria-label="Operator"
            value={step.operator}
            onChange={(event) =>
              patch({ operator: event.target.value as typeof step.operator })
            }
          >
            {[
              '=',
              '!=',
              '>',
              '>=',
              '<',
              '<=',
              'contains',
              'in',
              'is_null',
              'not_null',
            ].map((operator) => (
              <option key={operator} value={operator}>
                {operator.replace('_', ' ')}
              </option>
            ))}
          </select>
          {step.operator !== 'is_null' && step.operator !== 'not_null' && (
            <ValueInput
              value={step.value}
              onChange={(value) => patch({ value })}
            />
          )}
          {step.value && 'var' in step.value && (
            <label className="studio-check">
              <input
                type="checkbox"
                checked={Boolean(step.optional)}
                onChange={(event) => patch({ optional: event.target.checked })}
              />
              skip when unset
            </label>
          )}
        </>
      );
    case 'range': {
      // A date or time column is limited by days back, a number column (a
      // block) by a count back, so the window and its anchor follow the column.
      const picked = scope.find((column) => column.name === step.column);
      const numeric = Boolean(picked && NUMERIC.includes(picked.type));
      return (
        <>
          <ColumnSelect
            label="Column"
            value={step.column}
            scope={scope}
            filter={(column) =>
              TEMPORAL.includes(column.type) || NUMERIC.includes(column.type)
            }
            onChange={(column) => {
              const next = scope.find((entry) => entry.name === column);
              const nextNumeric = Boolean(next && NUMERIC.includes(next.type));
              // A window and an anchor of the other kind would only fail.
              patch({
                column,
                ...(nextNumeric === numeric
                  ? {}
                  : {
                      window:
                        step.window === undefined
                          ? undefined
                          : nextNumeric
                            ? '100000'
                            : '30d',
                      anchor: undefined,
                      anchorColumn: undefined,
                    }),
              });
            }}
          />
          <select
            className="studio-input"
            aria-label="Window source"
            value={step.window === undefined ? 'var' : 'fixed'}
            onChange={(event) =>
              patch({
                window:
                  event.target.value === 'fixed'
                    ? numeric
                      ? '100000'
                      : '30d'
                    : undefined,
              })
            }
          >
            <option value="var">from variable</option>
            <option value="fixed">fixed window</option>
          </select>
          {step.window === undefined ? (
            <input
              className="studio-input mono short"
              aria-label="Range variable"
              value={step.var ?? 'range'}
              onChange={(event) => patch({ var: event.target.value })}
            />
          ) : (
            <input
              className="studio-input mono short"
              aria-label="Window"
              placeholder={numeric ? '100000' : '31d'}
              value={step.window}
              onChange={(event) => patch({ window: event.target.value })}
            />
          )}
          {numeric ? (
            <>
              <span className="studio-muted">ending at</span>
              <ColumnSelect
                label="Window end"
                value={step.anchorColumn}
                scope={scope}
                filter={(column) =>
                  NUMERIC.includes(column.type) && column.name !== step.column
                }
                allowNone
                onChange={(column) =>
                  patch({ anchorColumn: column || undefined })
                }
              />
            </>
          ) : (
            <select
              className="studio-input"
              aria-label="Anchor"
              value={step.anchor ?? 'latest'}
              onChange={(event) =>
                patch({ anchor: event.target.value as 'latest' | 'now' })
              }
            >
              <option value="latest">back from the newest row</option>
              <option value="now">back from now</option>
            </select>
          )}
        </>
      );
    }
    case 'bucket':
      return (
        <>
          <ColumnSelect
            label="Time column"
            value={step.column}
            scope={scope}
            filter={(column) => TEMPORAL.includes(column.type)}
            onChange={(column) => patch({ column })}
          />
          <span className="studio-muted">by</span>
          <select
            className="studio-input"
            aria-label="Unit"
            value={step.unit}
            onChange={(event) =>
              patch({ unit: event.target.value as typeof step.unit })
            }
          >
            <option value="auto">day or week, by range</option>
            <option value="hour">hour</option>
            <option value="day">day</option>
            <option value="week">week</option>
            <option value="month">month</option>
            <option value="hour_of_day">hour of day (0–23)</option>
            <option value="day_of_week">day of week (1 = Mon)</option>
          </select>
          <span className="studio-muted">as</span>
          <input
            className="studio-input mono short"
            aria-label="Output name"
            value={step.as}
            onChange={(event) => patch({ as: event.target.value })}
          />
        </>
      );
    case 'compute': {
      const right = typeof step.right === 'string' ? step.right : null;
      return (
        <>
          <ColumnSelect
            label="Left"
            value={step.left}
            scope={scope}
            onChange={(left) => patch({ left })}
          />
          <select
            className="studio-input"
            aria-label="Operator"
            value={step.operator}
            onChange={(event) =>
              patch({ operator: event.target.value as typeof step.operator })
            }
          >
            <option value="+">+</option>
            <option value="-">−</option>
            <option value="*">×</option>
            <option value="/">÷</option>
            <option value="days_between">days between</option>
            <option value="months_between">months between</option>
          </select>
          {right !== null ? (
            <ColumnSelect
              label="Right"
              value={right}
              scope={scope}
              onChange={(column) => patch({ right: column })}
            />
          ) : (
            <input
              className="studio-input short"
              type="number"
              aria-label="Right value"
              value={typeof step.right === 'object' ? step.right.literal : 0}
              onChange={(event) =>
                patch({ right: { literal: Number(event.target.value) } })
              }
            />
          )}
          <button
            type="button"
            className="studio-button"
            onClick={() =>
              patch({
                right: right !== null ? { literal: 1 } : (scope[0]?.name ?? ''),
              })
            }
          >
            {right !== null ? 'use a number' : 'use a column'}
          </button>
          <span className="studio-muted">as</span>
          <input
            className="studio-input mono short"
            aria-label="Output name"
            value={step.as}
            onChange={(event) => patch({ as: event.target.value })}
          />
        </>
      );
    }
    case 'window':
      return (
        <>
          <select
            className="studio-input"
            aria-label="Window function"
            value={step.fn}
            onChange={(event) =>
              patch({ fn: event.target.value as typeof step.fn })
            }
          >
            {[
              'min',
              'max',
              'sum',
              'count',
              'first_value',
              'row_number',
              'rank',
            ].map((fn) => (
              <option key={fn} value={fn}>
                {fn}
              </option>
            ))}
          </select>
          {!['count', 'row_number', 'rank'].includes(step.fn) && (
            <ColumnSelect
              label="Column"
              value={step.column}
              scope={scope}
              onChange={(column) => patch({ column })}
            />
          )}
          <span className="studio-muted">per</span>
          <ColumnList
            label="Partition"
            value={step.partitionBy ?? []}
            scope={scope}
            onChange={(partitionBy) => patch({ partitionBy })}
          />
          <span className="studio-muted">ordered by</span>
          <ColumnList
            label="Order"
            value={(step.orderBy ?? []).map((entry) => entry.column)}
            scope={scope}
            onChange={(columns) =>
              patch({ orderBy: columns.map((column) => ({ column })) })
            }
          />
          <span className="studio-muted">as</span>
          <input
            className="studio-input mono short"
            aria-label="Output name"
            value={step.as}
            onChange={(event) => patch({ as: event.target.value })}
          />
        </>
      );
    case 'aggregate':
      return (
        <>
          <span className="studio-muted">group by</span>
          <ColumnList
            label="Group by"
            value={step.groupBy}
            scope={scope}
            onChange={(groupBy) => patch({ groupBy })}
          />
          <Measures
            measures={step.measures}
            scope={scope}
            onChange={(measures) => patch({ measures })}
          />
        </>
      );
    case 'rolling':
      return (
        <>
          <ColumnSelect
            label="Date column"
            value={step.time}
            scope={scope}
            filter={(column) => column.type === 'date'}
            onChange={(time) => patch({ time })}
          />
          <span className="studio-muted">over</span>
          <input
            className="studio-input short"
            type="number"
            min={1}
            aria-label="Days"
            value={step.days}
            onChange={(event) => patch({ days: Number(event.target.value) })}
          />
          <span className="studio-muted">days, per</span>
          <ColumnList
            label="Group by"
            value={step.groupBy ?? []}
            scope={scope}
            onChange={(groupBy) => patch({ groupBy })}
          />
          <label className="studio-check">
            <input
              type="checkbox"
              checked={Boolean(step.fill)}
              onChange={(event) => patch({ fill: event.target.checked })}
            />
            every day
          </label>
          <Measures
            measures={step.measures}
            scope={scope}
            onChange={(measures) => patch({ measures })}
          />
        </>
      );
    case 'top':
      return (
        <>
          <span className="studio-muted">keep the top</span>
          <input
            className="studio-input short"
            type="number"
            min={1}
            aria-label="N"
            value={step.n}
            onChange={(event) => patch({ n: Number(event.target.value) })}
          />
          <ColumnSelect
            label="Category"
            value={step.column}
            scope={scope}
            onChange={(column) => patch({ column })}
          />
          <span className="studio-muted">by</span>
          <ColumnSelect
            label="Ranked by"
            value={step.by}
            scope={scope}
            filter={(column) => NUMERIC.includes(column.type)}
            onChange={(by) =>
              patch({
                by,
                sum: step.sum.includes(by) ? step.sum : [...step.sum, by],
              })
            }
          />
          <span className="studio-muted">summing</span>
          <ColumnList
            label="Summed"
            value={step.sum}
            scope={scope.filter((column) => NUMERIC.includes(column.type))}
            onChange={(sum) => patch({ sum })}
          />
          <span className="studio-muted">rest as</span>
          <input
            className="studio-input short"
            aria-label="Label for the rest"
            value={step.others ?? 'Others'}
            onChange={(event) => patch({ others: event.target.value })}
          />
        </>
      );
    case 'sort':
      return (
        <>
          {step.by.map((entry, at) => (
            <span className="inline-field" key={at}>
              <ColumnSelect
                label="Sort column"
                value={entry.column}
                scope={scope}
                onChange={(column) =>
                  patch({
                    by: step.by.map((item, index) =>
                      index === at ? { ...item, column } : item,
                    ),
                  })
                }
              />
              <select
                className="studio-input"
                aria-label="Direction"
                value={entry.desc ? 'desc' : 'asc'}
                onChange={(event) =>
                  patch({
                    by: step.by.map((item, index) =>
                      index === at
                        ? { ...item, desc: event.target.value === 'desc' }
                        : item,
                    ),
                  })
                }
              >
                <option value="asc">ascending</option>
                <option value="desc">descending</option>
              </select>
            </span>
          ))}
          <button
            type="button"
            className="studio-button"
            onClick={() =>
              patch({ by: [...step.by, { column: scope[0]?.name ?? '' }] })
            }
          >
            <Plus size={12} aria-hidden="true" /> Then by
          </button>
        </>
      );
    case 'limit':
      return (
        <input
          className="studio-input short"
          type="number"
          min={1}
          aria-label="Rows"
          value={step.n}
          onChange={(event) => patch({ n: Number(event.target.value) })}
        />
      );
  }
}

export function StepList({
  steps,
  scopes,
  errors,
  onChange,
}: {
  steps: Step[];
  /** The columns in scope before each step, and after the last one. */
  scopes: ScopeColumn[][];
  /** The first failing step, by index, with the reason. */
  errors: Map<number, string>;
  onChange: (steps: Step[]) => void;
}) {
  const move = (from: number, to: number) => {
    const next = [...steps];
    const [step] = next.splice(from, 1);
    next.splice(to, 0, step);
    onChange(next);
  };
  return (
    <ol className="step-list">
      {steps.map((step, at) => (
        <li key={at} className={errors.has(at) ? 'broken' : undefined}>
          <div className="step-head">
            <strong>
              {at + 1}. {STEP_LABELS[step.op]}
            </strong>
            <span className="results-spacer" />
            <button
              type="button"
              className="studio-icon-button"
              aria-label="Move up"
              disabled={at === 0}
              onClick={() => move(at, at - 1)}
            >
              <ArrowUp size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="studio-icon-button"
              aria-label="Move down"
              disabled={at === steps.length - 1}
              onClick={() => move(at, at + 1)}
            >
              <ArrowDown size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="studio-icon-button"
              aria-label="Remove step"
              onClick={() => onChange(steps.filter((_, index) => index !== at))}
            >
              <Trash2 size={13} aria-hidden="true" />
            </button>
          </div>
          <div className="step-fields">
            <StepFields
              step={step}
              scope={scopes[at] ?? []}
              onChange={(next) =>
                onChange(
                  steps.map((entry, index) => (index === at ? next : entry)),
                )
              }
            />
          </div>
          {errors.get(at) && <p className="step-error">{errors.get(at)}</p>}
        </li>
      ))}
      <li className="step-add">
        <select
          className="studio-input"
          aria-label="Add a step"
          value=""
          onChange={(event) => {
            const op = event.target.value as Step['op'];
            if (op)
              onChange([...steps, newStep(op, scopes[steps.length] ?? [])]);
          }}
        >
          <option value="">+ Add a step…</option>
          {(Object.keys(STEP_LABELS) as Step['op'][]).map((op) => (
            <option key={op} value={op}>
              {STEP_LABELS[op]}
            </option>
          ))}
        </select>
      </li>
    </ol>
  );
}

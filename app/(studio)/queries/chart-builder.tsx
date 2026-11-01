'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';

import {
  UNIT_LABELS,
  dimensionName,
  shapeOf,
  type Builder,
  type BuilderFilter,
  type BuilderMeasure,
  type Dimension,
  type Unit,
} from '@/lib/viz/builder';
import { FORMATS, type Format, type VisualizationType } from '@/lib/viz/config';
import type { ValueRef } from '@/lib/viz/transform';
import { asText } from '@/lib/viz/text';

import { api } from '../api';
import { measureName } from './chart-templates';
import {
  ColumnList,
  ColumnSelect,
  NUMERIC,
  TEMPORAL,
  type ScopeColumn,
} from './step-editor';

/**
 * The simple chart editor: a chart as a sentence — show this, over that,
 * split by something, for these rows — instead of a list of steps. Every
 * change is a new builder; the panel compiles it and redraws the preview.
 */

type Props = {
  type: VisualizationType;
  builder: Builder;
  /** The stored result's columns. */
  columns: ScopeColumn[];
  /** The chart's own output columns, for sorting and post-group filters. */
  output: ScopeColumn[];
  onChange: (builder: Builder) => void;
  slug: string;
  network: string;
};

const MEASURES: Array<{ fn: BuilderMeasure['fn']; label: string }> = [
  { fn: 'count', label: 'Number of rows' },
  { fn: 'count_distinct', label: 'Number of distinct' },
  { fn: 'sum', label: 'Sum of' },
  { fn: 'avg', label: 'Average of' },
  { fn: 'min', label: 'Smallest' },
  { fn: 'max', label: 'Largest' },
];

const OPERATORS: Array<{ value: BuilderFilter['operator']; label: string }> = [
  { value: '=', label: 'is' },
  { value: '!=', label: 'is not' },
  { value: '>', label: '>' },
  { value: '>=', label: '≥' },
  { value: '<', label: '<' },
  { value: '<=', label: '≤' },
  { value: 'contains', label: 'contains' },
  { value: 'in', label: 'is one of' },
  { value: 'is_null', label: 'is empty' },
  { value: 'not_null', label: 'is not empty' },
];

const FORMAT_LABELS: Record<Format, string> = {
  number: '1,234',
  compact: '1.2K',
  decimal: '1.23',
  percent: '12%',
  gigabytes: 'GB / MB',
  token: '÷ 10¹⁸ (token)',
};

const isTime = (column: ScopeColumn | undefined) =>
  Boolean(column && TEMPORAL.includes(column.type));

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="builder-section">
      <h4>
        {title}
        {hint && <small>{hint}</small>}
      </h4>
      {children}
    </section>
  );
}

function RemoveButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="builder-remove"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <X size={13} aria-hidden="true" />
    </button>
  );
}

function AddButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" className="builder-add" onClick={onClick}>
      <Plus size={12} aria-hidden="true" /> {children}
    </button>
  );
}

function MeasureRow({
  measure,
  columns,
  taken,
  onChange,
  onRemove,
}: {
  measure: BuilderMeasure;
  columns: ScopeColumn[];
  taken: string[];
  onChange: (measure: BuilderMeasure) => void;
  onRemove?: () => void;
}) {
  // The name follows the measure until someone types their own.
  const automatic =
    measure.as === measureName(measure.fn, measure.columns, taken);
  const update = (patch: Partial<BuilderMeasure>) => {
    const next = { ...measure, ...patch };
    if (automatic) next.as = measureName(next.fn, next.columns, taken);
    onChange(next);
  };
  const numbers = (column: ScopeColumn) => NUMERIC.includes(column.type);
  return (
    <div className="builder-row measure-row">
      <select
        className="studio-input"
        aria-label="Measure"
        value={measure.fn}
        onChange={(event) => {
          const fn = event.target.value as BuilderMeasure['fn'];
          const keep = measure.columns?.filter((name) =>
            columns.some(
              (column) =>
                column.name === name &&
                (fn === 'sum' || fn === 'avg' ? numbers(column) : true),
            ),
          );
          const first =
            fn === 'count'
              ? undefined
              : keep?.length
                ? fn === 'count_distinct'
                  ? keep
                  : keep.slice(0, 1)
                : [
                    (fn === 'sum' || fn === 'avg'
                      ? columns.find(numbers)
                      : columns.find((column) => column.name !== 'network')
                    )?.name ?? '',
                  ].filter(Boolean);
          update({ fn, columns: first });
        }}
      >
        {MEASURES.map((entry) => (
          <option key={entry.fn} value={entry.fn}>
            {entry.label}
          </option>
        ))}
      </select>
      {measure.fn === 'count_distinct' ? (
        <ColumnList
          label="Distinct values of"
          value={measure.columns ?? []}
          scope={columns}
          onChange={(value) => update({ columns: value })}
        />
      ) : measure.fn !== 'count' ? (
        <ColumnSelect
          label="Column"
          value={measure.columns?.[0]}
          scope={columns}
          filter={
            measure.fn === 'sum' || measure.fn === 'avg' ? numbers : undefined
          }
          onChange={(value) => update({ columns: value ? [value] : [] })}
        />
      ) : null}
      <label className="builder-inline">
        <span>as</span>
        <input
          className="studio-input mono"
          aria-label="Column name"
          value={measure.as}
          onChange={(event) =>
            onChange({
              ...measure,
              as: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
            })
          }
        />
      </label>
      <label className="builder-inline">
        <span>shown</span>
        <select
          className="studio-input"
          aria-label="Shown as"
          value={measure.format ?? ''}
          onChange={(event) =>
            onChange({
              ...measure,
              format: (event.target.value || undefined) as Format | undefined,
            })
          }
        >
          <option value="">as is</option>
          {FORMATS.map((format) => (
            <option key={format} value={format}>
              {FORMAT_LABELS[format]}
            </option>
          ))}
        </select>
      </label>
      {onRemove && (
        <RemoveButton label="Remove this measure" onClick={onRemove} />
      )}
    </div>
  );
}

function DimensionRow({
  dimension,
  columns,
  label,
  allowNone,
  onChange,
}: {
  dimension: Dimension | undefined;
  columns: ScopeColumn[];
  label: string;
  allowNone?: boolean;
  onChange: (dimension: Dimension | undefined) => void;
}) {
  const column = columns.find((entry) => entry.name === dimension?.column);
  const units: Array<Unit | ''> =
    column?.type === 'date'
      ? ['', 'auto', 'week', 'month', 'day_of_week']
      : ['auto', 'hour', 'day', 'week', 'month', 'hour_of_day', 'day_of_week'];
  return (
    <div className="builder-row">
      <ColumnSelect
        label={label}
        value={dimension?.column}
        scope={columns}
        allowNone={allowNone}
        onChange={(name) => {
          if (!name) return onChange(undefined);
          const picked = columns.find((entry) => entry.name === name);
          onChange({
            column: name,
            ...(isTime(picked) ? { unit: 'auto' as Unit } : {}),
          });
        }}
      />
      {dimension && isTime(column) && (
        <label className="builder-inline">
          <span>by</span>
          <select
            className="studio-input"
            aria-label={`${label} granularity`}
            value={dimension.unit ?? ''}
            onChange={(event) => {
              const unit = event.target.value as Unit | '';
              onChange({
                column: dimension.column,
                ...(unit ? { unit } : {}),
              });
            }}
          >
            {units.map((unit) => (
              <option key={unit || 'as-is'} value={unit}>
                {unit ? UNIT_LABELS[unit] : 'Day (as stored)'}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

const valueCache = new Map<string, Promise<string[]>>();

/** A text column's most common values, largest first; cached per page. */
export function topValues(
  slug: string,
  network: string,
  column: string,
): Promise<string[]> {
  const key = `${slug}|${network}|${column}`;
  let pending = valueCache.get(key);
  if (!pending) {
    pending = api<{ rows: unknown[][] }>('/api/v1/visualizations/preview', {
      method: 'POST',
      body: {
        query: slug,
        network,
        config: {
          steps: [
            {
              op: 'aggregate',
              groupBy: [column],
              measures: [{ fn: 'count', as: 'n' }],
            },
            { op: 'sort', by: [{ column: 'n', desc: true }] },
            { op: 'limit', n: 100 },
          ],
        },
      },
    })
      .then(({ rows }) => rows.map((row) => asText(row[0])))
      .catch(() => []);
    valueCache.set(key, pending);
  }
  return pending;
}

/** The most common values of a text column, offered while typing a filter. */
function useValues(
  slug: string,
  network: string,
  column: ScopeColumn | undefined,
): string[] {
  const [values, setValues] = useState<{ key: string; list: string[] }>({
    key: '',
    list: [],
  });
  const wanted =
    column && (column.type === 'text' || column.type === 'boolean')
      ? `${slug}|${network}|${column.name}`
      : '';
  useEffect(() => {
    if (!wanted || !column) return;
    let live = true;
    void topValues(slug, network, column.name).then(
      (list) => live && setValues({ key: wanted, list }),
    );
    return () => {
      live = false;
    };
  }, [wanted, slug, network, column]);
  return values.key === wanted ? values.list : [];
}

function FilterRow({
  filter,
  columns,
  slug,
  network,
  onChange,
  onRemove,
}: {
  filter: BuilderFilter;
  columns: ScopeColumn[];
  slug: string;
  network: string;
  onChange: (filter: BuilderFilter) => void;
  onRemove: () => void;
}) {
  const column = columns.find((entry) => entry.name === filter.column);
  const values = useValues(slug, network, column);
  const listId = `values-${slug}-${filter.column}`;
  const isVar = Boolean(filter.value && 'var' in filter.value);
  const text = filter.value
    ? 'var' in filter.value
      ? filter.value.var
      : asText(filter.value.literal ?? '')
    : '';
  const needsValue =
    filter.operator !== 'is_null' && filter.operator !== 'not_null';
  const setValue = (value: ValueRef) => onChange({ ...filter, value });
  return (
    <div className="builder-row filter-row">
      <ColumnSelect
        label="Filter column"
        value={filter.column}
        scope={columns}
        onChange={(name) => onChange({ ...filter, column: name })}
      />
      <select
        className="studio-input"
        aria-label="Comparison"
        value={filter.operator}
        onChange={(event) =>
          onChange({
            ...filter,
            operator: event.target.value as BuilderFilter['operator'],
          })
        }
      >
        {OPERATORS.map((operator) => (
          <option key={operator.value} value={operator.value}>
            {operator.label}
          </option>
        ))}
      </select>
      {needsValue && (
        <>
          <input
            className={`studio-input ${isVar ? 'mono' : ''}`}
            aria-label={isVar ? 'Dashboard variable' : 'Value'}
            placeholder={
              isVar
                ? 'variable, e.g. client'
                : filter.operator === 'in'
                  ? 'a, b, c'
                  : 'value'
            }
            list={!isVar && values.length ? listId : undefined}
            value={text}
            onChange={(event) =>
              setValue(
                isVar
                  ? { var: event.target.value }
                  : { literal: event.target.value },
              )
            }
          />
          {!isVar && values.length > 0 && (
            <datalist id={listId}>
              {values.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </datalist>
          )}
          <button
            type="button"
            className={`builder-toggle ${isVar ? 'active' : ''}`}
            aria-pressed={isVar}
            title="Compare with a dashboard variable instead of a fixed value"
            onClick={() =>
              setValue(isVar ? { literal: '' } : { var: text || 'client' })
            }
          >
            {'{x}'}
          </button>
          {isVar && (
            <label className="studio-check">
              <input
                type="checkbox"
                checked={Boolean(filter.optional)}
                onChange={(event) =>
                  onChange({
                    ...filter,
                    optional: event.target.checked || undefined,
                  })
                }
              />
              all rows while unset
            </label>
          )}
        </>
      )}
      <RemoveButton label="Remove this filter" onClick={onRemove} />
    </div>
  );
}

function WindowField({
  window,
  columns,
  onChange,
}: {
  window: Builder['window'];
  columns: ScopeColumn[];
  onChange: (window: Builder['window']) => void;
}) {
  const source = !window ? 'all' : window.fixed ? 'fixed' : 'range';
  const temporal = columns.filter((column) => TEMPORAL.includes(column.type));
  if (!temporal.length) {
    return <p className="studio-muted">No date or time column to limit by.</p>;
  }
  return (
    <div className="builder-row">
      <select
        className="studio-input"
        aria-label="Time window"
        value={source}
        onChange={(event) => {
          const next = event.target.value;
          const column = window?.column ?? temporal[0].name;
          if (next === 'all') onChange(undefined);
          else if (next === 'fixed')
            onChange({ column, fixed: '30d', from: window?.from });
          else onChange({ column, from: window?.from });
        }}
      >
        <option value="range">The dashboard&rsquo;s range</option>
        <option value="fixed">A fixed window</option>
        <option value="all">All time</option>
      </select>
      {window && window.fixed !== undefined && (
        <input
          className="studio-input mono short"
          aria-label="Window length"
          placeholder="30d"
          value={window.fixed}
          onChange={(event) =>
            onChange({ ...window, fixed: event.target.value })
          }
        />
      )}
      {window && (
        <>
          <span className="builder-inline">
            <span>of</span>
            <ColumnSelect
              label="Time column"
              value={window.column}
              scope={temporal}
              onChange={(column) => onChange({ ...window, column })}
            />
          </span>
          <label className="builder-inline">
            <span>from</span>
            <input
              className="studio-input"
              type="date"
              aria-label="Never before"
              value={window.from ?? ''}
              onChange={(event) =>
                onChange({ ...window, from: event.target.value || undefined })
              }
            />
          </label>
        </>
      )}
    </div>
  );
}

const GROUP_TITLES: Partial<Record<VisualizationType, string[]>> = {
  line: ['X axis'],
  area: ['X axis'],
  bar: ['X axis'],
  share: ['Slices'],
  pie: ['Slices'],
  heatmap: ['Columns', 'Rows'],
};

export function BuilderForm({
  type,
  builder,
  columns,
  output,
  onChange,
  slug,
  network,
}: Props) {
  const shape = shapeOf(type);
  const set = (patch: Partial<Builder>) => {
    const next: Builder = { ...builder, ...patch };
    for (const key of Object.keys(next) as Array<keyof Builder>) {
      const value = next[key];
      if (value === undefined || (Array.isArray(value) && !value.length))
        delete next[key];
    }
    onChange(next);
  };
  const measures = builder.measures ?? [];
  const groups = builder.groups ?? [];
  const filters = builder.filters ?? [];
  const having = builder.having ?? [];
  const names = measures.map((measure) => measure.as);
  const raw = type === 'table' && !measures.length;
  const measureColumns = output.filter((column) => names.includes(column.name));
  const plotsTime =
    shape.split &&
    groups[0] !== undefined &&
    isTime(columns.find((column) => column.name === groups[0].column));
  const moreOpen = Boolean(
    builder.rolling ||
    builder.top ||
    builder.share ||
    builder.rank ||
    having.length ||
    builder.sort?.length ||
    builder.limit,
  );

  const setMeasure = (at: number, measure: BuilderMeasure) =>
    set({ measures: measures.map((entry, i) => (i === at ? measure : entry)) });
  const setGroup = (at: number, dimension: Dimension | undefined) => {
    const next = [...groups];
    if (dimension) next[at] = dimension;
    else next.splice(at, 1);
    set({ groups: next.filter(Boolean) });
  };

  return (
    <div className="builder">
      <Section
        title="Show"
        hint={
          raw
            ? 'Nothing to count: the table lists the rows as they are.'
            : undefined
        }
      >
        {measures.map((measure, at) => (
          <MeasureRow
            key={at}
            measure={measure}
            columns={columns}
            taken={names.filter((_, i) => i !== at)}
            onChange={(next) => setMeasure(at, next)}
            onRemove={
              measures.length > 1 || type === 'table'
                ? () => set({ measures: measures.filter((_, i) => i !== at) })
                : undefined
            }
          />
        ))}
        {(shape.measures === 'many' || !measures.length) && (
          <AddButton
            onClick={() =>
              set({
                measures: [
                  ...measures,
                  { fn: 'count', as: measureName('count', undefined, names) },
                ],
              })
            }
          >
            {measures.length ? 'Another measure' : 'Count or sum something'}
          </AddButton>
        )}
        {type === 'number' && measures.length > 1 && (
          <p className="studio-muted builder-note">
            The first is the figure; the second is shown under it.
          </p>
        )}
      </Section>

      {type !== 'number' && type !== 'table' && type !== 'cohort' && (
        <Section
          title={type === 'share' || type === 'pie' ? 'Split into' : 'Over'}
        >
          {(GROUP_TITLES[type] ?? ['Group']).map((label, at) =>
            shape.groups > 1 ? (
              <div key={label} className="builder-labelled">
                <span>{label}</span>
                <DimensionRow
                  dimension={groups[at]}
                  columns={columns}
                  label={label}
                  onChange={(dimension) => setGroup(at, dimension)}
                />
              </div>
            ) : (
              <DimensionRow
                key={label}
                dimension={groups[at]}
                columns={columns}
                label={label}
                onChange={(dimension) => setGroup(at, dimension)}
              />
            ),
          )}
        </Section>
      )}

      {type === 'table' && (
        <Section
          title="Group by"
          hint={groups.length ? undefined : 'Optional: one row per group.'}
        >
          {groups.map((dimension, at) => (
            <div className="builder-row" key={at}>
              <DimensionRow
                dimension={dimension}
                columns={columns}
                label={`Group ${at + 1}`}
                onChange={(next) => setGroup(at, next)}
              />
              <RemoveButton
                label="Remove this group"
                onClick={() => setGroup(at, undefined)}
              />
            </div>
          ))}
          {groups.length < 4 && (
            <AddButton
              onClick={() => {
                const next = columns.find(
                  (column) =>
                    !groups.some((group) => group.column === column.name) &&
                    !NUMERIC.includes(column.type),
                );
                if (next) set({ groups: [...groups, { column: next.name }] });
              }}
            >
              Group by a column
            </AddButton>
          )}
        </Section>
      )}

      {shape.split && (
        <Section
          title="Split into series"
          hint="Optional: one line or colour per value."
        >
          <div className="builder-row">
            <DimensionRow
              dimension={builder.split}
              columns={columns}
              label="Split by"
              allowNone
              onChange={(dimension) =>
                set({
                  split: dimension
                    ? {
                        ...dimension,
                        ...(builder.split?.order
                          ? { order: builder.split.order }
                          : {}),
                        ...(builder.split?.top
                          ? { top: builder.split.top }
                          : {}),
                      }
                    : undefined,
                })
              }
            />
            {builder.split && (
              <>
                <select
                  className="studio-input"
                  aria-label="Series order"
                  value={builder.split.order ?? 'size'}
                  onChange={(event) =>
                    builder.split &&
                    set({
                      split: {
                        ...builder.split,
                        order: event.target.value as 'size' | 'az' | 'za',
                      },
                    })
                  }
                >
                  <option value="size">largest first</option>
                  <option value="az">A → Z</option>
                  <option value="za">Z → A</option>
                </select>
                <label className="builder-inline">
                  <span>keep top</span>
                  <input
                    className="studio-input short"
                    type="number"
                    min={1}
                    max={50}
                    placeholder="all"
                    aria-label="Keep the largest series"
                    value={builder.split.top ?? ''}
                    onChange={(event) =>
                      builder.split &&
                      set({
                        split: {
                          ...builder.split,
                          top: Number(event.target.value) || undefined,
                        },
                      })
                    }
                  />
                </label>
              </>
            )}
          </div>
        </Section>
      )}

      <Section title="Rows">
        <div className="builder-labelled">
          <span>Within</span>
          <WindowField
            window={builder.window}
            columns={columns}
            onChange={(window) => set({ window })}
          />
        </div>
        {filters.map((filter, at) => (
          <div className="builder-labelled" key={at}>
            <span>{at === 0 ? 'Where' : 'and'}</span>
            <FilterRow
              filter={filter}
              columns={columns}
              slug={slug}
              network={network}
              onChange={(next) =>
                set({
                  filters: filters.map((entry, i) => (i === at ? next : entry)),
                })
              }
              onRemove={() =>
                set({ filters: filters.filter((_, i) => i !== at) })
              }
            />
          </div>
        ))}
        <AddButton
          onClick={() =>
            set({
              filters: [
                ...filters,
                {
                  column:
                    columns.find(
                      (column) =>
                        column.type === 'text' && column.name !== 'network',
                    )?.name ??
                    columns[0]?.name ??
                    '',
                  operator: '=',
                  value: { literal: '' },
                },
              ],
            })
          }
        >
          Only rows where…
        </AddButton>
      </Section>

      <details className="builder-more" open={moreOpen}>
        <summary>
          <ChevronDown size={13} aria-hidden="true" /> More
        </summary>
        {plotsTime && !raw && (
          <label className="studio-check">
            <input
              type="checkbox"
              checked={Boolean(builder.rolling)}
              onChange={(event) =>
                set({ rolling: event.target.checked ? 30 : undefined })
              }
            />
            Each point counts its trailing
            <input
              className="studio-input short"
              type="number"
              min={1}
              max={3650}
              aria-label="Trailing days"
              disabled={!builder.rolling}
              value={builder.rolling ?? 30}
              onChange={(event) =>
                set({ rolling: Number(event.target.value) || undefined })
              }
            />
            days
          </label>
        )}
        {!raw && groups.length > 0 && type !== 'heatmap' && (
          <label className="studio-check">
            <input
              type="checkbox"
              checked={Boolean(builder.top)}
              onChange={(event) =>
                set({ top: event.target.checked ? { n: 10 } : undefined })
              }
            />
            Only the top
            <input
              className="studio-input short"
              type="number"
              min={1}
              max={500}
              aria-label="How many to keep"
              disabled={!builder.top}
              value={builder.top?.n ?? 10}
              onChange={(event) =>
                set({
                  top: { ...builder.top, n: Number(event.target.value) || 10 },
                })
              }
            />
            {dimensionName(groups[0])}, the rest as &ldquo;Others&rdquo;
          </label>
        )}
        {!raw && measures.length > 0 && type !== 'number' && (
          <label className="builder-inline">
            <span>As a share of the total</span>
            <select
              className="studio-input"
              aria-label="Show as a share"
              value={builder.share?.of ?? ''}
              onChange={(event) =>
                set({
                  share: event.target.value
                    ? { of: event.target.value }
                    : undefined,
                })
              }
            >
              <option value="">no</option>
              {names.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
        {type === 'table' && !raw && (
          <label className="builder-inline">
            <span>Number the rows by</span>
            <select
              className="studio-input"
              aria-label="Rank by"
              value={builder.rank?.by ?? ''}
              onChange={(event) =>
                set({
                  rank: event.target.value
                    ? { by: event.target.value }
                    : undefined,
                })
              }
            >
              <option value="">no ranking</option>
              {names.map((name) => (
                <option key={name} value={name}>
                  {name}, largest first
                </option>
              ))}
            </select>
          </label>
        )}
        {!raw &&
          having.map((filter, at) => (
            <div className="builder-labelled" key={at}>
              <span>Keep groups where</span>
              <FilterRow
                filter={filter}
                columns={measureColumns.length ? measureColumns : output}
                slug={slug}
                network={network}
                onChange={(next) =>
                  set({
                    having: having.map((entry, i) => (i === at ? next : entry)),
                  })
                }
                onRemove={() =>
                  set({ having: having.filter((_, i) => i !== at) })
                }
              />
            </div>
          ))}
        {!raw && measures.length > 0 && (
          <AddButton
            onClick={() =>
              set({
                having: [
                  ...having,
                  { column: names[0], operator: '>', value: { literal: '0' } },
                ],
              })
            }
          >
            Only groups where a measure…
          </AddButton>
        )}
        <div className="builder-labelled">
          <span>Order</span>
          <div className="builder-row">
            <ColumnSelect
              label="Sort by"
              value={builder.sort?.[0]?.column}
              scope={output.length ? output : columns}
              allowNone
              onChange={(column) =>
                set({
                  sort: column
                    ? [{ column, desc: builder.sort?.[0]?.desc ?? true }]
                    : undefined,
                })
              }
            />
            {builder.sort?.[0] ? (
              <select
                className="studio-input"
                aria-label="Direction"
                value={builder.sort[0].desc ? 'desc' : 'asc'}
                onChange={(event) =>
                  builder.sort &&
                  set({
                    sort: [
                      {
                        ...builder.sort[0],
                        desc: event.target.value === 'desc',
                      },
                      ...builder.sort.slice(1),
                    ],
                  })
                }
              >
                <option value="desc">largest / newest first</option>
                <option value="asc">smallest / oldest first</option>
              </select>
            ) : (
              <span className="studio-muted">automatic</span>
            )}
            <label className="builder-inline">
              <span>at most</span>
              <input
                className="studio-input short"
                type="number"
                min={1}
                max={50000}
                placeholder="all"
                aria-label="Row limit"
                value={builder.limit ?? ''}
                onChange={(event) =>
                  set({ limit: Number(event.target.value) || undefined })
                }
              />
              <span>rows</span>
            </label>
          </div>
        </div>
      </details>
    </div>
  );
}

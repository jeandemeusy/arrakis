'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ChartArea,
  ChartColumn,
  ChartLine,
  ChartBarDecreasing,
  ChartPie,
  ChevronDown,
  Code2,
  Grid3x3,
  GripVertical,
  Hash,
  ListTree,
  Rows3,
  Save,
  Sparkles,
  Table2,
  Trash2,
  type LucideIcon,
} from 'lucide-react';

import type { Builder } from '@/lib/viz/builder';
import {
  FORMATS,
  VISUALIZATION_TYPES,
  finalizeConfig,
  type Encoding,
  type Format,
  type Options,
  type TableColumnOptions,
  type VisualizationConfig,
  type VisualizationType,
} from '@/lib/viz/config';
import { buildSql, type Step } from '@/lib/viz/transform';

import { seriesOf } from '../../viz/series';
import { VisualizationBody } from '../../viz/visualization';
import { usePalette } from '../../style';
import { api, ApiError, type ChartHost, type DashboardVariable } from '../api';
import { VariableSwitch } from '../dashboards/variable-switch';
import { ResultsTable } from '../results-table';
import { BuilderForm, topValues } from './chart-builder';
import {
  CARTESIAN,
  ChartPanel,
  SeriesTable,
  XAxisPanel,
  YAxisPanel,
} from './chart-options';
import { adaptBuilder, templates, type Template } from './chart-templates';
import { StepList, type ScopeColumn } from './step-editor';
import { HelpTip } from '../help-tip';

/**
 * The charts built on one query's stored result, and the editor for them.
 *
 * Three ways to describe a chart, from simplest: the builder (a sentence:
 * show this, over that, for these rows), steps (the pipeline the builder
 * compiles to), and SQL over the stored result. The form sits on the left
 * and the chart on the right, redrawn a moment after each change — always
 * from the stored result, never from the data source, so trying things costs nothing.
 */

export type Saved = {
  id: string;
  title: string;
  type: VisualizationType;
  config: VisualizationConfig;
  updatedAt: string;
};

type Mode = 'builder' | 'steps' | 'sql';

type Draft = {
  id: string | null;
  title: string;
  type: VisualizationType;
  mode: Mode;
  builder: Builder;
  steps: Step[];
  sql: string;
  encoding: Encoding;
  options: Options;
};

type PreviewData = {
  columns: ScopeColumn[];
  rows: unknown[][];
  truncated: boolean;
  pending: boolean;
};

const TYPE_LABELS: Record<VisualizationType, string> = {
  number: 'Number',
  line: 'Line',
  area: 'Area',
  bar: 'Bar',
  share: 'Share',
  pie: 'Pie',
  heatmap: 'Heatmap',
  cohort: 'Cohort grid',
  table: 'Table',
};

export const TYPE_ICONS: Record<VisualizationType, LucideIcon> = {
  number: Hash,
  line: ChartLine,
  area: ChartArea,
  bar: ChartColumn,
  share: ChartBarDecreasing,
  pie: ChartPie,
  heatmap: Grid3x3,
  cohort: Rows3,
  table: Table2,
};

const MODE_LABELS: Record<Mode, string> = {
  builder: 'Simple',
  steps: 'Steps',
  sql: 'SQL',
};

const NUMERIC = ['integer', 'bigint', 'float', 'numeric'];

/**
 * Windows offered when no dashboard defines the variable: days for a time
 * column, blocks for a number column. A dashboard's own definition wins.
 */
const TIME_WINDOWS = ['24h', '7d', '30d', '31d', '90d', 'all'];
const BLOCK_WINDOWS = ['all', '10000', '100000', '500000', '2000000'];

function draftOf(saved: Saved): Draft {
  return {
    id: saved.id,
    title: saved.title,
    type: saved.type,
    mode: saved.config.sql ? 'sql' : saved.config.builder ? 'builder' : 'steps',
    builder: saved.config.builder ?? {
      measures: [{ fn: 'count', as: 'count' }],
    },
    steps: saved.config.steps,
    sql: saved.config.sql ?? 'SELECT *\nFROM {{result}}\nLIMIT 100',
    encoding: saved.config.encoding,
    options: saved.config.options,
  };
}

function draftFromTemplate(template: Template): Draft {
  return {
    id: null,
    title: template.title,
    type: template.type,
    mode: 'builder',
    builder: template.builder,
    steps: [],
    sql: 'SELECT *\nFROM {{result}}\nLIMIT 100',
    encoding: {},
    options: template.options ?? {},
  };
}

function configOf(draft: Draft): VisualizationConfig {
  switch (draft.mode) {
    case 'builder':
      return {
        steps: [],
        encoding: {},
        options: draft.options,
        builder: draft.builder,
      };
    case 'sql':
      return {
        steps: [],
        encoding: draft.encoding,
        options: draft.options,
        sql: draft.sql,
      };
    default:
      return {
        steps: draft.steps,
        encoding: draft.encoding,
        options: draft.options,
      };
  }
}

/**
 * The columns before each step, computed in the browser with the same code
 * the server builds SQL with. Filter values are swapped for an unset variable
 * first: only the shape matters here, and a literal would need decoding.
 */
function scopesOf(
  base: ScopeColumn[],
  steps: Step[],
): { scopes: ScopeColumn[][]; errors: Map<number, string> } {
  const shapeOnly = steps.map((step) =>
    step.op === 'filter'
      ? { ...step, value: { var: '__shape' }, optional: true }
      : step,
  );
  const scopes: ScopeColumn[][] = [base];
  const errors = new Map<number, string>();
  for (let at = 0; at < steps.length; at += 1) {
    try {
      const built = buildSql(
        { sql: 'SELECT 1', columns: base as never },
        shapeOnly.slice(0, at + 1),
        {},
      );
      scopes.push(built.columns);
    } catch (error) {
      errors.set(
        at,
        (error as Error).message.replace(/^Step \d+ \([a-z_]+\): /, ''),
      );
      scopes.push(scopes[at]);
    }
  }
  return { scopes, errors };
}

/** For each variable a filter compares a column with: that column. */
function filteredBy(steps: Step[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const step of steps) {
    if (step.op === 'filter' && step.value && 'var' in step.value)
      out.set(step.value.var, step.column);
  }
  return out;
}

/** Variables a chart reads, so the preview can offer an input for each. */
function variablesOf(mode: Mode, steps: Step[], sql: string): string[] {
  const names = new Set<string>();
  if (mode === 'sql') {
    for (const match of sql.matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g)) {
      if (match[1] !== 'result') names.add(match[1]);
    }
    return [...names];
  }
  for (const step of steps) {
    if (step.op === 'range' && step.window === undefined)
      names.add(step.var ?? 'range');
    if (step.op === 'bucket' && step.unit === 'auto')
      names.add(step.var ?? 'range');
    if (step.op === 'filter' && step.value && 'var' in step.value)
      names.add(step.value.var);
  }
  return [...names];
}

/** Sensible axes for a new type, from the columns the steps produce. */
function guessEncoding(
  type: VisualizationType,
  columns: ScopeColumn[],
): Encoding {
  const numbers = columns.filter((column) => NUMERIC.includes(column.type));
  const others = columns.filter(
    (column) => !NUMERIC.includes(column.type) && column.name !== 'network',
  );
  const x = others[0]?.name ?? columns[0]?.name;
  const y = numbers[0]?.name ?? columns[1]?.name;
  switch (type) {
    case 'number':
      return { y: y ? [y] : [] };
    case 'heatmap':
    case 'cohort':
      return {
        row: columns[0]?.name,
        x: columns[1]?.name,
        value: numbers.at(-1)?.name,
      };
    case 'table':
      return {};
    default:
      return { x, y: y ? [y] : [] };
  }
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="studio-field compact">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Pick({
  value,
  columns,
  onChange,
  allowNone = true,
}: {
  value: string | undefined;
  columns: ScopeColumn[];
  onChange: (value: string | undefined) => void;
  allowNone?: boolean;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || undefined)}
    >
      {allowNone && <option value="">—</option>}
      {value && !columns.some((column) => column.name === value) && (
        <option value={value}>{value} (missing)</option>
      )}
      {columns.map((column) => (
        <option key={column.name} value={column.name}>
          {column.name}
        </option>
      ))}
    </select>
  );
}

function EncodingFields({
  draft,
  columns,
  onChange,
}: {
  draft: Draft;
  columns: ScopeColumn[];
  onChange: (encoding: Encoding, options: Options) => void;
}) {
  const { encoding, options, type } = draft;
  const set = (patch: Partial<Encoding>) =>
    onChange({ ...encoding, ...patch }, options);
  const setOption = (patch: Partial<Options>) =>
    onChange(encoding, { ...options, ...patch });
  const y = encoding.y ?? [];
  return (
    <div className="encoding">
      {(type === 'line' ||
        type === 'area' ||
        type === 'bar' ||
        type === 'share' ||
        type === 'pie') && (
        <Field label={type === 'share' || type === 'pie' ? 'Label' : 'X axis'}>
          <Pick
            value={encoding.x}
            columns={columns}
            onChange={(x) => set({ x })}
          />
        </Field>
      )}
      {(type === 'heatmap' || type === 'cohort') && (
        <>
          <Field label={type === 'cohort' ? 'Cohort (rows)' : 'Rows'}>
            <Pick
              value={encoding.row}
              columns={columns}
              onChange={(row) => set({ row })}
            />
          </Field>
          <Field label={type === 'cohort' ? 'Offset (columns)' : 'Columns'}>
            <Pick
              value={encoding.x}
              columns={columns}
              onChange={(x) => set({ x })}
            />
          </Field>
          <Field label={type === 'cohort' ? 'Share (0–1)' : 'Value'}>
            <Pick
              value={encoding.value}
              columns={columns}
              onChange={(value) => set({ value })}
            />
          </Field>
        </>
      )}
      {(type === 'line' || type === 'area' || type === 'bar') && (
        <>
          {[...y, ''].map((name, at) =>
            at < 6 && (at === 0 || !encoding.series) ? (
              <Field key={at} label={at === 0 ? 'Y axis' : `Y ${at + 1}`}>
                <Pick
                  value={name || undefined}
                  columns={columns}
                  onChange={(value) => {
                    const next = [...y];
                    if (value) next[at] = value;
                    else next.splice(at, 1);
                    set({ y: next.filter(Boolean) });
                  }}
                />
              </Field>
            ) : null,
          )}
          <Field label="Split by">
            <Pick
              value={encoding.series}
              columns={columns}
              onChange={(series) => set({ series })}
            />
          </Field>
        </>
      )}
      {(type === 'number' || type === 'share' || type === 'pie') && (
        <Field label="Value">
          <Pick
            value={y[0]}
            columns={columns}
            onChange={(value) => set({ y: value ? [value] : [] })}
          />
        </Field>
      )}
      {type === 'number' && (
        <Field label="Note column">
          <Pick
            value={encoding.note}
            columns={columns}
            onChange={(note) => set({ note })}
          />
        </Field>
      )}
      <Field label="Format">
        <select
          value={options.format ?? 'number'}
          onChange={(event) =>
            setOption({ format: event.target.value as Format })
          }
        >
          {FORMATS.map((format) => (
            <option key={format} value={format}>
              {format}
            </option>
          ))}
        </select>
      </Field>
      {(type === 'line' || type === 'area' || type === 'bar') &&
        encoding.series && (
          <label
            className="studio-check"
            title="Otherwise the largest series comes first"
          >
            <input
              type="checkbox"
              checked={options.seriesOrder === 'rows'}
              onChange={(event) =>
                setOption({
                  seriesOrder: event.target.checked ? 'rows' : undefined,
                })
              }
            />
            series in row order
          </label>
        )}
      {type === 'table' && (
        <TableColumns
          options={options}
          columns={columns}
          onChange={setOption}
        />
      )}
    </div>
  );
}

/**
 * Which columns a table shows, and how each reads: a header and a format.
 * Every column is shown until one is unticked.
 */
function TableColumns({
  options,
  columns,
  onChange,
}: {
  options: Options;
  columns: ScopeColumn[];
  onChange: (patch: Partial<Options>) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ name: string; after: boolean } | null>(null);
  const configured = options.columns;
  const shown = configured?.length
    ? configured
    : columns.map((column) => column.name);
  const ordered = [
    ...shown,
    ...columns.map((column) => column.name).filter((name) => !shown.includes(name)),
  ];
  const storeColumns = (next: string[]) => {
    const original = columns.map((column) => column.name);
    onChange({
      columns:
        next.length === original.length &&
        next.every((name, index) => name === original[index])
          ? undefined
          : next,
    });
  };
  const toggle = (name: string, on: boolean) => {
    storeColumns(ordered.filter((entry) => entry === name ? on : shown.includes(entry)));
  };
  const move = (name: string, to: number) => {
    const next = ordered.filter((entry) => entry !== name);
    next.splice(Math.max(0, Math.min(to, next.length)), 0, name);
    storeColumns(next.filter((entry) => shown.includes(entry)));
  };
  const setRecord = (
    key: 'labels' | 'formats',
    name: string,
    value: string,
  ) => {
    const next: Record<string, string> = { ...options[key] };
    if (value) next[name] = value;
    else delete next[name];
    onChange({ [key]: Object.keys(next).length ? next : undefined });
  };
  const setDisplay = (
    name: string,
    patch: Partial<TableColumnOptions>,
  ) => {
    const current = { ...options.tableColumns?.[name], ...patch };
    for (const key of Object.keys(current) as Array<keyof TableColumnOptions>) {
      if (current[key] === undefined || current[key] === false)
        delete current[key];
    }
    const next = { ...options.tableColumns };
    if (Object.keys(current).length) next[name] = current;
    else delete next[name];
    onChange({ tableColumns: Object.keys(next).length ? next : undefined });
  };
  return (
    <details className="builder-more table-columns-disclosure">
      <summary>
        <ChevronDown size={14} aria-hidden="true" /> Columns
      </summary>
    <fieldset className="table-columns">
      <legend className="sr-only">Columns</legend>
      <p className="table-columns-hint">Choose and arrange the columns shown in the table.</p>
      {ordered.map((name, index) => {
        const column = columns.find((entry) => entry.name === name);
        if (!column) return null;
        const display = options.tableColumns?.[column.name];
        const displayType = display?.text
          ? `text${display.monospace ? '-mono' : ''}${display.condensed ? '-short' : ''}`
          : (options.formats?.[column.name] ?? '');
        return (
        <div
          key={column.name}
          className={`table-column${dragging === name ? ' dragging' : ''}${drop?.name === name ? (drop.after ? ' drop-after' : ' drop-before') : ''}`}
          onDragOver={(event) => {
            if (!dragging || dragging === name) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            setDrop({ name, after: event.clientY >= rect.top + rect.height / 2 });
          }}
          onDrop={(event) => {
            event.preventDefault();
            const dragged = event.dataTransfer.getData('text/plain');
            if (dragged && dragged !== column.name) {
              const target = index + (drop?.name === name && drop.after ? 1 : 0);
              move(dragged, target - (ordered.indexOf(dragged) < target ? 1 : 0));
            }
            setDragging(null);
            setDrop(null);
          }}
        >
          <button
            type="button"
            className="drag-handle"
            draggable
            aria-label={`Move ${column.name}; arrow keys move it`}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', column.name);
              setDragging(column.name);
            }}
            onDragEnd={() => { setDragging(null); setDrop(null); }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp' && index > 0) {
                event.preventDefault();
                move(column.name, index - 1);
              } else if (event.key === 'ArrowDown' && index < ordered.length - 1) {
                event.preventDefault();
                move(column.name, index + 1);
              }
            }}
          >
            <GripVertical size={14} aria-hidden="true" />
          </button>
          <label className="studio-check">
            <input
              type="checkbox"
              checked={shown.includes(column.name)}
              onChange={(event) => toggle(column.name, event.target.checked)}
            />
            <code>{column.name}</code>
          </label>
          <label className="table-column-field"><span>Header</span><input
            className="studio-input"
            aria-label={`Header for ${column.name}`}
            placeholder="header"
            value={options.labels?.[column.name] ?? ''}
            onChange={(event) =>
              setRecord('labels', column.name, event.target.value)
            }
          /></label>
          <label className="table-column-field"><span>Display</span><select
            className="studio-input"
            aria-label={`Format for ${column.name}`}
            value={displayType}
            onChange={(event) => {
              const value = event.target.value;
              const text = value.startsWith('text');
              const formats = { ...options.formats };
              if (text || !value) delete formats[column.name];
              else formats[column.name] = value as Format;
              const tableColumns = { ...options.tableColumns };
              const next = { ...display, text: text || undefined, monospace: value.includes('-mono') || undefined, condensed: value.includes('-short') || undefined };
              if (Object.values(next).some((entry) => entry !== undefined)) tableColumns[column.name] = next;
              else delete tableColumns[column.name];
              onChange({ formats: Object.keys(formats).length ? formats : undefined, tableColumns: Object.keys(tableColumns).length ? tableColumns : undefined });
            }}
          >
            <option value="">default</option>
            <option value="text">text</option>
            <option value="text-mono">text · monospace</option>
            <option value="text-short">text · condensed</option>
            <option value="text-mono-short">text · monospace, condensed</option>
            {FORMATS.map((format) => (
              <option key={format} value={format}>
                {format}
              </option>
            ))}
          </select></label>
          <label className="table-column-field"><span>Align</span><select
            className="studio-input"
            aria-label={`Alignment for ${column.name}`}
            value={options.tableColumns?.[column.name]?.align ?? ''}
            onChange={(event) =>
              setDisplay(column.name, {
                align: (event.target.value || undefined) as
                  | TableColumnOptions['align']
                  | undefined,
              })
            }
          >
            <option value="">automatic</option>
            <option value="left">left</option>
            <option value="center">center</option>
            <option value="right">right</option>
          </select></label>
          <label className="table-column-field"><span>Width (px)</span><input
            className="studio-input"
            type="number"
            min={40}
            max={1000}
            aria-label={`Width for ${column.name}`}
            placeholder="width"
            value={options.tableColumns?.[column.name]?.width ?? ''}
            onChange={(event) =>
              setDisplay(column.name, {
                width: event.target.value ? Number(event.target.value) : undefined,
              })
            }
          /></label>
          <label className="table-column-field table-column-link"><span>Link URL (optional)</span><input
            className="studio-input"
            aria-label={`Link URL for ${column.name}`}
            placeholder={`/dashboards/details?id={{${column.name}}}`}
            value={display?.link ?? ''}
            maxLength={2048}
            onChange={(event) => setDisplay(column.name, { link: event.target.value || undefined })}
          /><small>Use {'{{column}}'} for a row value. Links can be dashboard paths or http(s) URLs.</small></label>
        </div>
        );
      })}
    </fieldset>
    </details>
  );
}

function TemplatePicker({
  columns,
  pending,
  onPick,
  onCancel,
}: {
  columns: ScopeColumn[];
  pending: string | null;
  onPick: (template: Template) => void;
  onCancel?: () => void;
}) {
  const list = templates(columns);
  return (
    <section className="template-picker" aria-label="Start a chart">
      <header>
        <h3>
          <Sparkles size={15} aria-hidden="true" /> Start from
        </h3>
        <p className="studio-muted">
          Each one is built from this query&rsquo;s own columns; adjust it
          afterwards.
        </p>
      </header>
      {pending && <p className="studio-warning">{pending}</p>}
      <div className="template-grid">
        {list.map((template) => {
          const Icon = TYPE_ICONS[template.type];
          return (
            <button
              key={template.id}
              type="button"
              className="template-card"
              disabled={!columns.length}
              onClick={() => onPick(template)}
            >
              <Icon size={18} aria-hidden="true" />
              <strong>{template.title}</strong>
              <span>{template.description}</span>
            </button>
          );
        })}
      </div>
      {onCancel && (
        <button type="button" className="studio-button" onClick={onCancel}>
          Cancel
        </button>
      )}
    </section>
  );
}

export function VisualizationsPanel({
  slug,
  editor,
  network,
  chart,
  hosts,
  onSaved,
  onDeleted,
}: {
  slug: string;
  editor: boolean;
  network: string;
  /** The chart to open, or null to start a new one from a template. */
  chart: Saved | null;
  /** The dashboards showing this query's charts, whose variables it borrows. */
  hosts: ChartHost[];
  onSaved: (chart: Saved) => void;
  onDeleted: (id: string) => void;
}) {
  // Each chart is its own tab, mounted afresh: the draft starts from it.
  const [draft, setDraft] = useState<Draft | null>(() =>
    chart ? draftOf(chart) : null,
  );
  const choosing = !draft;
  const [base, setBase] = useState<ScopeColumn[]>([]);
  const [baseError, setBaseError] = useState<string | null>(null);
  const [vars, setVars] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [showData, setShowData] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [switching, setSwitching] = useState<Mode | null>(null);
  const [dirty, setDirty] = useState(false);
  const palette = usePalette();

  // The stored result's own columns: the starting point every chart sees.
  useEffect(() => {
    if (!editor) return;
    let live = true;
    api<PreviewData>('/api/v1/visualizations/preview', {
      method: 'POST',
      body: {
        query: slug,
        config: { steps: [{ op: 'limit', n: 1 }] },
        network,
      },
    })
      .then((data) => {
        if (!live) return;
        setBase(data.columns);
        setBaseError(
          data.pending
            ? 'Nothing is stored for this query yet. Run and store it first.'
            : null,
        );
      })
      .catch((error: ApiError) => live && setBaseError(error.message));
    return () => {
      live = false;
    };
  }, [editor, slug, network]);

  // The config as it will be saved and run: a builder compiled for its type.
  const compiled = useMemo((): {
    config: VisualizationConfig | null;
    error: string | null;
  } => {
    if (!draft) return { config: null, error: null };
    try {
      return {
        config: finalizeConfig(draft.type, configOf(draft)),
        error: null,
      };
    } catch (error) {
      return { config: null, error: (error as Error).message };
    }
  }, [draft]);
  const config = compiled.config;

  const { scopes, errors } = useMemo(
    () =>
      scopesOf(
        base,
        draft?.mode === 'builder'
          ? (config?.steps ?? [])
          : (draft?.steps ?? []),
      ),
    [base, draft?.mode, draft?.steps, config?.steps],
  );
  const output =
    draft?.mode === 'sql'
      ? (preview?.columns ?? base)
      : (scopes.at(-1) ?? base);
  // Column checks need the stored columns, which only editors load; a
  // reader is looking at a saved chart the server checks for itself.
  const buildError =
    compiled.error ??
    (draft?.mode === 'builder' && base.length
      ? errors.values().next().value
      : null) ??
    null;

  // A filter on a dashboard variable matches nothing while the variable is
  // unset, so the preview fills it with the column's most common value —
  // shown as the field's placeholder — until one is typed.
  const activeSteps =
    draft?.mode === 'builder' ? (config?.steps ?? []) : (draft?.steps ?? []);
  const filterKey = JSON.stringify(
    [...filteredBy(activeSteps)].filter(([, column]) =>
      base.some((entry) => entry.name === column && entry.type === 'text'),
    ),
  );
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (!editor) return;
    let live = true;
    const pairs = JSON.parse(filterKey) as Array<[string, string]>;
    void Promise.all(
      pairs.map(async ([name, column]) => [
        name,
        await topValues(slug, network, column),
      ]),
    ).then((entries) => live && setSuggestions(Object.fromEntries(entries)));
    return () => {
      live = false;
    };
  }, [editor, filterKey, slug, network]);
  // A window variable counts days for a time column and blocks for a number
  // column, so the preview offers whichever the chart's range step reads.
  const rangeUnits = ((): Record<string, 'time' | 'blocks'> => {
    const units: Record<string, 'time' | 'blocks'> = {};
    for (const step of activeSteps) {
      if (step.op !== 'bucket' && step.op !== 'range') continue;
      const column = base.find((entry) => entry.name === step.column);
      const unit = column && NUMERIC.includes(column.type) ? 'blocks' : 'time';
      // An auto bin sizes itself to the window, so it reads the same variable,
      // in blocks when it bins a number column.
      if (step.op === 'bucket' && step.unit === 'auto')
        units[step.var ?? 'range'] ??= unit;
      if (step.op === 'range' && step.window === undefined)
        units[step.var ?? 'range'] = unit;
    }
    return units;
  })();
  const names = draft ? variablesOf(draft.mode, activeSteps, draft.sql) : [];
  // Each window the chart reads is offered as a dashboard offers it: from the
  // variable that a dashboard showing this chart defines (one showing this very
  // chart first), else from the kind of column it limits.
  const definitions = ((): Record<string, DashboardVariable> => {
    const ordered = [...hosts].sort(
      (a, b) =>
        Number(chart ? b.chartIds.includes(chart.id) : 0) -
        Number(chart ? a.chartIds.includes(chart.id) : 0),
    );
    const found: Record<string, DashboardVariable> = {};
    for (const name of names) {
      const defined = ordered
        .flatMap((host) => host.variables)
        .find(
          (entry) =>
            entry.name === name &&
            (entry.type === 'range' || entry.type === 'select') &&
            entry.options?.length,
        );
      const unit = rangeUnits[name] ?? (name === 'range' ? 'time' : undefined);
      if (defined) found[name] = defined;
      else if (unit)
        found[name] = {
          name,
          label: name,
          type: 'range',
          options: unit === 'blocks' ? BLOCK_WINDOWS : TIME_WINDOWS,
          default: unit === 'blocks' ? 'all' : '30d',
        };
    }
    return found;
  })();
  const definitionsKey = JSON.stringify(definitions);
  const previewVars = useMemo(() => {
    const out: Record<string, string> = { ...vars };
    for (const [name, list] of Object.entries(suggestions)) {
      if (!out[name] && list[0]) out[name] = list[0];
    }
    // A value its definition does not offer (`30d` over blocks, a window the
    // dashboard dropped) would only fail the step: take the default instead.
    for (const [name, entry] of Object.entries(
      JSON.parse(definitionsKey) as Record<string, DashboardVariable>,
    )) {
      const options = entry.options ?? [];
      if (!options.includes(out[name] ?? '')) {
        out[name] =
          entry.default && options.includes(entry.default)
            ? entry.default
            : (options[0] ?? 'all');
      }
    }
    return out;
  }, [vars, suggestions, definitionsKey]);

  useEffect(() => {
    if (!config || buildError) return;
    let live = true;
    // Editors preview the draft as it stands; anyone else is looking at a
    // saved chart, which the public data route serves.
    const published = !editor && draft?.id;
    const search = new URLSearchParams({ network });
    for (const [name, value] of Object.entries(previewVars)) {
      if (value) search.set(`v.${name}`, value);
    }
    const timer = setTimeout(() => {
      (published
        ? api<PreviewData>(
            `/api/v1/visualizations/${draft.id}/data?${search.toString()}`,
          )
        : api<PreviewData>('/api/v1/visualizations/preview', {
            method: 'POST',
            body: { query: slug, config, network, vars: previewVars },
          })
      )
        .then((data) => {
          if (!live) return;
          setPreview(data);
          setPreviewError(null);
        })
        .catch((error: ApiError) => {
          if (!live) return;
          setPreviewError(error);
        });
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [config, buildError, slug, network, previewVars, editor, draft?.id]);

  const update = (patch: Partial<Draft>) => {
    setDirty(true);
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const open = (next: Draft | null) => {
    setDraft(next);
    setPreview(null);
    setPreviewError(null);
    setConfirmDelete(false);
    setSwitching(null);
    setSaveError(null);
    setDirty(false);
  };

  const changeType = (type: VisualizationType) => {
    if (!draft) return;
    // A new chart still named after the template it started from takes the
    // name of the type it becomes, so a line is not left titled "Share as a
    // donut".
    const list = templates(base);
    const renamed =
      !draft.id && list.some((entry) => entry.title === draft.title)
        ? {
            title:
              list.find((entry) => entry.type === type && entry.id !== 'blank')
                ?.title ?? `${TYPE_LABELS[type]} chart`,
          }
        : {};
    if (draft.mode === 'builder') {
      update({
        type,
        ...renamed,
        builder: adaptBuilder(type, draft.builder, base),
      });
    } else {
      update({
        type,
        ...renamed,
        encoding:
          Object.keys(draft.encoding).length && draft.type !== 'table'
            ? draft.encoding
            : guessEncoding(type, output),
      });
    }
  };

  const changeMode = (mode: Mode) => {
    if (!draft || mode === draft.mode) return;
    if (draft.mode === 'builder' && mode === 'steps' && config) {
      // One way: the builder's steps become the chart's own.
      update({
        mode,
        steps: config.steps,
        encoding: config.encoding,
        options: config.options,
      });
    } else if (mode === 'builder') {
      const start = templates(base).find((entry) => entry.type === draft.type);
      update({
        mode,
        builder: adaptBuilder(
          draft.type,
          start?.builder ?? { measures: [{ fn: 'count', as: 'count' }] },
          base,
        ),
      });
    } else {
      update({ mode });
    }
    setSwitching(null);
  };

  const save = async () => {
    if (!draft || !config) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload = { title: draft.title, type: draft.type, config };
      const { visualization } = draft.id
        ? await api<{ visualization: Saved }>(
            `/api/v1/visualizations/${draft.id}`,
            { method: 'PATCH', body: payload },
          )
        : await api<{ visualization: Saved }>(
            `/api/v1/queries/${slug}/visualizations`,
            { method: 'POST', body: payload },
          );
      setDraft(draftOf(visualization));
      setDirty(false);
      onSaved(visualization);
    } catch (error) {
      setSaveError((error as ApiError).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!draft?.id) return;
    try {
      await api(`/api/v1/visualizations/${draft.id}`, { method: 'DELETE' });
      onDeleted(draft.id);
    } catch (error) {
      setSaveError((error as ApiError).message);
    }
  };

  const variables = draft
    ? variablesOf(draft.mode, activeSteps, draft.sql)
    : [];
  const shown = config ?? (draft ? configOf(draft) : null);
  const cartesian = draft ? CARTESIAN.includes(draft.type) : false;
  const series = useMemo(
    () =>
      draft && shown && preview && !preview.pending
        ? seriesOf(
            draft.type,
            shown.encoding,
            shown.options,
            preview.columns,
            preview.rows,
            palette,
          )
        : [],
    [draft, shown, preview, palette],
  );
  const setOptions = (patch: Partial<Options>) => {
    if (!draft) return;
    const options = { ...draft.options, ...patch };
    for (const key of Object.keys(options) as Array<keyof Options>) {
      if (options[key] === undefined) delete options[key];
    }
    update({ options });
  };

  return (
    <div className="viz-panel">
      {choosing && editor && (
        <TemplatePicker
          columns={base}
          pending={baseError}
          onPick={(template) => {
            open(draftFromTemplate(template));
            setDirty(true);
          }}
        />
      )}

      {draft && (
        <section className="viz-editor">
          <header className="viz-editor-head">
            <input
              className="title-input small"
              aria-label="Chart title"
              value={draft.title}
              disabled={!editor}
              onChange={(event) => update({ title: event.target.value })}
            />
            {editor && (
              <div className="viz-editor-actions">
                {dirty && <span className="studio-muted">Unsaved</span>}
                {draft.id &&
                  (confirmDelete ? (
                    <>
                      <button
                        type="button"
                        className="studio-button danger"
                        onClick={() => void remove()}
                      >
                        Delete chart
                      </button>
                      <button
                        type="button"
                        className="studio-button"
                        onClick={() => setConfirmDelete(false)}
                      >
                        Keep
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="studio-icon-button"
                      aria-label="Delete chart"
                      title="Delete chart"
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  ))}
                <button
                  type="button"
                  className="studio-button primary"
                  disabled={saving || !config}
                  onClick={() => void save()}
                >
                  <Save size={13} aria-hidden="true" />{' '}
                  {saving
                    ? 'Saving…'
                    : draft.id
                      ? 'Save chart'
                      : 'Create chart'}
                </button>
              </div>
            )}
          </header>
          {saveError && <p className="studio-error">{saveError}</p>}
          {baseError && <p className="studio-warning">{baseError}</p>}

          {editor && (
            <div className="viz-editor-bar">
              <fieldset className="chart-types">
                <legend className="sr-only">Chart type</legend>
                {VISUALIZATION_TYPES.filter(
                  (type) => type !== 'cohort' || draft.mode !== 'builder',
                ).map((type) => {
                  const Icon = TYPE_ICONS[type];
                  return (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={draft.type === type}
                      title={TYPE_LABELS[type]}
                      onClick={() => changeType(type)}
                    >
                      <Icon size={15} aria-hidden="true" />
                      <span>{TYPE_LABELS[type]}</span>
                    </button>
                  );
                })}
              </fieldset>
              <fieldset className="viz-mode">
                <legend className="sr-only">How the chart is described</legend>
                {(['builder', 'steps', 'sql'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={draft.mode === mode}
                    onClick={() =>
                      draft.mode === 'builder' || mode === 'builder'
                        ? setSwitching(mode)
                        : changeMode(mode)
                    }
                  >
                    {mode === 'builder' ? (
                      <Sparkles size={13} aria-hidden="true" />
                    ) : mode === 'steps' ? (
                      <ListTree size={13} aria-hidden="true" />
                    ) : (
                      <Code2 size={13} aria-hidden="true" />
                    )}{' '}
                    {MODE_LABELS[mode]}
                  </button>
                ))}
              </fieldset>
              <HelpTip topic="charts" />
            </div>
          )}
          {switching && switching !== draft.mode && (
            <output className="viz-switch">
              {switching === 'steps'
                ? 'This turns the chart into its steps, for what the simple form cannot do. The simple form cannot read steps back.'
                : switching === 'sql'
                  ? 'This starts the chart over as SQL on the stored result.'
                  : 'This starts the chart over in the simple form.'}
              <button
                type="button"
                className="studio-button primary"
                onClick={() => changeMode(switching)}
              >
                Switch to {MODE_LABELS[switching].toLowerCase()}
              </button>
              <button
                type="button"
                className="studio-button"
                onClick={() => setSwitching(null)}
              >
                Cancel
              </button>
            </output>
          )}

          <div className={`viz-editor-body ${editor ? '' : 'reader'}`}>
            <div className="viz-stage">
              {variables.length > 0 && (
                <div className="viz-vars">
                  {variables.map((name) => (
                    <label key={name} className="studio-field compact">
                      <span>
                        {definitions[name]?.label ?? name}
                        {rangeUnits[name] === 'blocks' ? ' (blocks)' : ''}
                      </span>
                      {definitions[name] ? (
                        <VariableSwitch
                          variable={definitions[name]}
                          value={previewVars[name]}
                          onChange={(value) =>
                            setVars({ ...vars, [name]: value })
                          }
                        />
                      ) : (
                        <>
                          <input
                            value={vars[name] ?? ''}
                            placeholder={previewVars[name] ?? 'unset'}
                            list={
                              suggestions[name]?.length
                                ? `preview-${name}`
                                : undefined
                            }
                            onChange={(event) =>
                              setVars({ ...vars, [name]: event.target.value })
                            }
                          />
                          {suggestions[name]?.length ? (
                            <datalist id={`preview-${name}`}>
                              {suggestions[name].map((value) => (
                                <option key={value} value={value}>
                                  {value}
                                </option>
                              ))}
                            </datalist>
                          ) : null}
                        </>
                      )}
                    </label>
                  ))}
                </div>
              )}
              <div className="viz-preview">
                {buildError ? (
                  <p className="studio-warning">
                    Not drawable yet: {buildError}
                  </p>
                ) : previewError ? (
                  <p className="studio-error">{previewError.message}</p>
                ) : preview && shown ? (
                  preview.pending ? (
                    <p className="studio-muted">
                      Nothing stored yet for this query.
                    </p>
                  ) : (
                    <VisualizationBody
                      type={draft.type}
                      encoding={shown.encoding}
                      options={shown.options}
                      columns={preview.columns}
                      rows={preview.rows}
                      height={360}
                    />
                  )
                ) : (
                  <p className="studio-muted">Drawing…</p>
                )}
              </div>
              {preview && !preview.pending && !previewError && !buildError && (
                <div className="viz-preview-foot">
                  <span className="studio-muted">
                    {preview.rows.length.toLocaleString()} row
                    {preview.rows.length === 1 ? '' : 's'}
                    {preview.truncated && ' (cut off at 50,000)'}
                  </span>
                  <button
                    type="button"
                    className="studio-link"
                    aria-expanded={showData}
                    onClick={() => setShowData(!showData)}
                  >
                    {showData ? 'Hide the data' : 'Show the data'}
                  </button>
                </div>
              )}
              {showData && preview && !preview.pending && !buildError && (
                <ResultsTable
                  columns={preview.columns as never}
                  rows={preview.rows}
                  name={draft.title}
                />
              )}
            </div>
            {editor && (
              <div className="viz-options">
                <section className="opt-panel opt-data">
                  <h4>Result data</h4>
                  {draft.mode === 'builder' && (
                    <>
                      <BuilderForm
                        type={draft.type}
                        builder={draft.builder}
                        columns={base}
                        output={output}
                        slug={slug}
                        network={network}
                        onChange={(builder) => update({ builder })}
                      />
                      {draft.type === 'table' &&
                        !draft.builder.measures?.length && (
                          <TableColumns
                            options={draft.options}
                            columns={output}
                            onChange={setOptions}
                          />
                        )}
                    </>
                  )}
                  {draft.mode === 'steps' && (
                    <>
                      <StepList
                        steps={draft.steps}
                        scopes={scopes}
                        errors={errors}
                        onChange={(steps) => update({ steps })}
                      />
                      <EncodingFields
                        draft={draft}
                        columns={output}
                        onChange={(encoding, options) =>
                          update({ encoding, options })
                        }
                      />
                    </>
                  )}
                  {draft.mode === 'sql' && (
                    <>
                      <label className="studio-field">
                        <span>
                          SQL over <code>{'{{result}}'}</code>;{' '}
                          <code>{'{{name}}'}</code> reads a dashboard variable
                        </span>
                        <textarea
                          className="studio-input mono viz-sql"
                          rows={10}
                          spellCheck={false}
                          value={draft.sql}
                          onChange={(event) =>
                            update({ sql: event.target.value })
                          }
                        />
                      </label>
                      <EncodingFields
                        draft={draft}
                        columns={output}
                        onChange={(encoding, options) =>
                          update({ encoding, options })
                        }
                      />
                    </>
                  )}
                </section>
                <div className="opt-col">
                  <ChartPanel
                    type={draft.type}
                    options={draft.options}
                    split={series.length > 1}
                    set={setOptions}
                  />
                  {cartesian && (
                    <XAxisPanel options={draft.options} set={setOptions} />
                  )}
                  {cartesian && (
                    <YAxisPanel
                      side="left"
                      options={draft.options}
                      set={setOptions}
                    />
                  )}
                  {cartesian &&
                    series.some((entry) => entry.axis === 'right') && (
                      <YAxisPanel
                        side="right"
                        options={draft.options}
                        set={setOptions}
                      />
                    )}
                </div>
                <SeriesTable
                  type={draft.type}
                  series={series}
                  options={draft.options}
                  set={setOptions}
                />
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

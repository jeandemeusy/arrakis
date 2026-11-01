'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ChartArea,
  ChartColumn,
  ChartLine,
  ChartPie,
  Code2,
  Grid3x3,
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
  type VisualizationConfig,
  type VisualizationType,
} from '@/lib/viz/config';
import { buildSql, type Step } from '@/lib/viz/transform';

import { seriesOf } from '../../viz/series';
import { VisualizationBody } from '../../viz/visualization';
import { usePalette } from '../../style';
import { api, ApiError } from '../api';
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

/**
 * The charts built on one query's stored result, and the editor for them.
 *
 * Three ways to describe a chart, from simplest: the builder (a sentence:
 * show this, over that, for these rows), steps (the pipeline the builder
 * compiles to), and SQL over the stored result. The form sits on the left
 * and the chart on the right, redrawn a moment after each change — always
 * from the stored result, never from Blokli, so trying things costs nothing.
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
  heatmap: 'Heatmap',
  cohort: 'Cohort grid',
  table: 'Table',
};

export const TYPE_ICONS: Record<VisualizationType, LucideIcon> = {
  number: Hash,
  line: ChartLine,
  area: ChartArea,
  bar: ChartColumn,
  share: ChartPie,
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
        type === 'share') && (
        <Field label={type === 'share' ? 'Label' : 'X axis'}>
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
      {(type === 'number' || type === 'share') && (
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
  const shown = options.columns?.length
    ? options.columns
    : columns.map((column) => column.name);
  const toggle = (name: string, on: boolean) => {
    const next = columns
      .map((column) => column.name)
      .filter((entry) => (entry === name ? on : shown.includes(entry)));
    onChange({
      columns: next.length === columns.length ? undefined : next,
    });
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
  return (
    <fieldset className="table-columns">
      <legend>Columns</legend>
      {columns.map((column) => (
        <div key={column.name} className="table-column">
          <label className="studio-check">
            <input
              type="checkbox"
              checked={shown.includes(column.name)}
              onChange={(event) => toggle(column.name, event.target.checked)}
            />
            <code>{column.name}</code>
          </label>
          <input
            className="studio-input"
            aria-label={`Header for ${column.name}`}
            placeholder="header"
            value={options.labels?.[column.name] ?? ''}
            onChange={(event) =>
              setRecord('labels', column.name, event.target.value)
            }
          />
          <select
            className="studio-input"
            aria-label={`Format for ${column.name}`}
            value={options.formats?.[column.name] ?? ''}
            onChange={(event) =>
              setRecord('formats', column.name, event.target.value)
            }
          >
            <option value="">default</option>
            {FORMATS.map((format) => (
              <option key={format} value={format}>
                {format}
              </option>
            ))}
          </select>
        </div>
      ))}
    </fieldset>
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
  onSaved,
  onDeleted,
}: {
  slug: string;
  editor: boolean;
  network: string;
  /** The chart to open, or null to start a new one from a template. */
  chart: Saved | null;
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
  const [vars, setVars] = useState<Record<string, string>>({ range: '30d' });
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
  const previewVars = useMemo(() => {
    const out: Record<string, string> = { ...vars };
    for (const [name, list] of Object.entries(suggestions)) {
      if (!out[name] && list[0]) out[name] = list[0];
    }
    return out;
  }, [vars, suggestions]);

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
    if (draft.mode === 'builder') {
      update({ type, builder: adaptBuilder(type, draft.builder, base) });
    } else {
      update({
        type,
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
                      <span>{name}</span>
                      {name === 'range' ? (
                        <select
                          value={vars.range ?? 'all'}
                          onChange={(event) =>
                            setVars({ ...vars, range: event.target.value })
                          }
                        >
                          {['24h', '7d', '30d', '31d', '90d', 'all'].map(
                            (option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ),
                          )}
                        </select>
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

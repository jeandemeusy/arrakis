'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Globe,
  GripVertical,
  LayoutGrid,
  Lock,
  Pencil,
  Plus,
  Save,
  Search,
  Settings2,
  SlidersHorizontal,
  Trash2,
  Type,
  X,
} from 'lucide-react';

import { asText } from '@/lib/viz/text';
import { variablesOf } from '@/lib/viz/config';

import { WidgetTile, type WidgetPayload } from '../../viz/widget-tile';
import {
  api,
  ApiError,
  type DashboardRecord,
  type DashboardVariable,
  type DashboardWidget,
  type Network,
  type SavedVisualization,
  type Visibility,
} from '../api';
import { sectionIds, useDashboardSections, useNav } from '../nav';
import { useSession } from '../session';
import { TYPE_ICONS } from '../queries/visualizations-panel';

/**
 * A dashboard: its variables across the top, its widgets on the grid below.
 *
 * Readers change variables — the range, the network, a selected client — and
 * the whole grid follows, every widget reading the same stored results. An
 * editor can switch to the layout editor: add charts from any query, reorder,
 * resize, link a chart's clicks to a variable, and save.
 */

/** Heights snap to this, in pixels, from 80 to 1200 (what the store accepts). */
const HEIGHT_STEP = 40;
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 1200;

const snapHeight = (height: number) =>
  Math.min(
    MAX_HEIGHT,
    Math.max(MIN_HEIGHT, Math.round(height / HEIGHT_STEP) * HEIGHT_STEP),
  );

type Edge = 'corner' | 'right' | 'bottom';

/**
 * Grips on a tile being edited: drag the corner to resize both ways, an edge
 * for one. The width snaps to twelfths of the grid, the height to 40px; the
 * tile follows live, with its size shown while dragging.
 */
function ResizeHandles({
  width,
  height,
  onResize,
}: {
  width: number;
  height: number;
  onResize: (size: { width: number; height: number }) => void;
}) {
  const grip = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<Edge | null>(null);
  const start = useRef<{
    x: number;
    y: number;
    height: number;
    left: number;
    column: number;
    gap: number;
  } | null>(null);

  const begin = (edge: Edge) => (event: React.PointerEvent) => {
    const cell = grip.current?.closest<HTMLElement>('.dashboard-cell');
    const grid = cell?.parentElement;
    if (!cell || !grid) return;
    event.preventDefault();
    (event.target as Element).setPointerCapture(event.pointerId);
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
    const box = grid.getBoundingClientRect();
    start.current = {
      x: event.clientX,
      y: event.clientY,
      height,
      left: cell.getBoundingClientRect().left,
      column: (box.width - gap * 11) / 12,
      gap,
    };
    setDragging(edge);
  };

  const move = (event: React.PointerEvent) => {
    const from = start.current;
    if (!dragging || !from) return;
    let next = { width, height };
    if (dragging !== 'bottom') {
      // As many columns as reach the pointer, counting the gaps between them.
      const span = Math.round(
        (event.clientX - from.left + from.gap) / (from.column + from.gap),
      );
      next = { ...next, width: Math.min(12, Math.max(1, span)) };
    }
    if (dragging !== 'right') {
      next = {
        ...next,
        height: snapHeight(from.height + event.clientY - from.y),
      };
    }
    if (next.width !== width || next.height !== height) onResize(next);
  };

  const end = () => {
    start.current = null;
    setDragging(null);
  };

  const keys = (edge: Edge) => (event: React.KeyboardEvent) => {
    const step: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -HEIGHT_STEP],
      ArrowDown: [0, HEIGHT_STEP],
    };
    const delta = step[event.key];
    if (!delta) return;
    event.preventDefault();
    onResize({
      width:
        edge === 'bottom' ? width : Math.min(12, Math.max(1, width + delta[0])),
      height: edge === 'right' ? height : snapHeight(height + delta[1]),
    });
  };

  const handle = (edge: Edge, label: string) => (
    <button
      type="button"
      className={`resize-handle ${edge}`}
      aria-label={`${label} (${width}/12 wide, ${height}px high)`}
      title={label}
      onPointerDown={begin(edge)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={keys(edge)}
    />
  );

  return (
    <div className={`resize-grips ${dragging ? 'dragging' : ''}`} ref={grip}>
      {handle('right', 'Width: drag, or arrow keys')}
      {handle('bottom', 'Height: drag, or arrow keys')}
      {handle('corner', 'Size: drag, or arrow keys')}
      {dragging && (
        <output className="resize-size">
          {width}/12 · {height}px
        </output>
      )}
    </div>
  );
}

type DataResponse = {
  vars: Record<string, string | undefined>;
  widgets: Array<
    | {
        id: string;
        state: 'ok';
        data: Extract<WidgetPayload, { state: 'ok' }>['data'];
      }
    | { id: string; state: 'hidden' | 'text' }
    | { id: string; state: 'error'; error: { status: number; message: string } }
  >;
};

type RunState = {
  query: string;
  running: boolean;
  finishedAt: string | null;
  failed: boolean;
};

const LOADING: WidgetPayload = { state: 'loading' };

/**
 * One payload object per data entry, so an unchanged chart is handed the very
 * same props and is not redrawn. Entries are never reused across dashboards,
 * so a module-wide map is safe, and it lets go of them with the data.
 */
const payloads = new WeakMap<object, WidgetPayload>();

/**
 * The new response, with every widget whose data did not change kept as the
 * very object already on screen — so its tile is not redrawn.
 */
function keepUnchanged(
  previous: DataResponse | null,
  next: DataResponse,
): DataResponse {
  if (!previous) return next;
  const before = new Map(previous.widgets.map((entry) => [entry.id, entry]));
  return {
    ...next,
    widgets: next.widgets.map((entry) => {
      const old = before.get(entry.id);
      return old && JSON.stringify(old) === JSON.stringify(entry) ? old : entry;
    }),
  };
}

/** The variables a chart reads, worked out once per chart. */
const reads = new WeakMap<object, Set<string>>();
function readsOf(visualization: SavedVisualization): Set<string> {
  let names = reads.get(visualization);
  if (!names) {
    names = variablesOf(visualization.config);
    reads.set(visualization, names);
  }
  return names;
}

/** A widget being edited: saved ones keep their id, new ones get a local one. */
type DraftWidget = DashboardWidget & { local?: boolean };

function shortValue(value: string): string {
  return /^0x[0-9a-f]{16,}$/i.test(value)
    ? `${value.slice(0, 6)}…${value.slice(-4)}`
    : value;
}

function VariableBar({
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
        const value = vars[variable.name];
        if (
          variable.type === 'range' ||
          variable.type === 'select' ||
          variable.type === 'network'
        ) {
          const options =
            variable.type === 'network'
              ? [
                  ...(networks.length > 1
                    ? [{ value: 'all', label: 'All networks' }]
                    : []),
                  ...networks.map((network) => ({
                    value: network.id,
                    label: network.label,
                  })),
                ]
              : (variable.options ?? []).map((option) => ({
                  value: option,
                  label:
                    variable.labels?.[option] ??
                    (option === 'all' ? 'All' : option),
                }));
          if (variable.type === 'network' && networks.length <= 1) return null;
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

/** One widget's data, fetched on its own: for widgets added while editing. */
function useWidgetData(
  id: string | null,
  network: string,
  vars: Record<string, string | undefined>,
  skip: boolean,
): WidgetPayload {
  const [payload, setPayload] = useState<WidgetPayload>({ state: 'loading' });
  const search = useMemo(() => {
    const params = new URLSearchParams({ network });
    for (const [key, value] of Object.entries(vars))
      if (value) params.set(`v.${key}`, value);
    return params.toString();
  }, [network, vars]);
  useEffect(() => {
    if (skip || !id) return;
    let live = true;
    api<Extract<WidgetPayload, { state: 'ok' }>['data']>(
      `/api/v1/visualizations/${id}/data?${search}`,
    )
      .then((data) => live && setPayload({ state: 'ok', data }))
      .catch(
        (error: ApiError) =>
          live &&
          setPayload({
            state: 'error',
            error: { status: error.status, message: error.message },
          }),
      );
    return () => {
      live = false;
    };
  }, [id, search, skip]);
  return payload;
}

type Link = NonNullable<DashboardWidget['options']['link']>;

type VisualizationWidgetProps = {
  widget: DraftWidget;
  payload: WidgetPayload | null;
  network: string;
  vars: Record<string, string | undefined>;
  expanded: string | null;
  onExpand: (id: string | null) => void;
  /** Follows the widget's link with a clicked row; stable across renders. */
  onLink?: (link: Link, row: Record<string, unknown>) => void;
  /** Its query is being run, or its chart recomputed for new variables. */
  busy?: 'running' | 'updating';
};

/**
 * A chart tile on the dashboard. Memoised: a tile redraws only when its own
 * data, its widget or its busy state changes, so switching a variable that
 * three charts read redraws three charts, not thirty.
 */
const VisualizationWidget = memo(
  VisualizationWidgetTile,
  (before, after) =>
    before.widget === after.widget &&
    before.payload === after.payload &&
    before.network === after.network &&
    before.busy === after.busy &&
    Boolean(before.onLink) === Boolean(after.onLink) &&
    (before.expanded === before.widget.id) ===
      (after.expanded === after.widget.id) &&
    // Only a tile fetching its own data (while editing) reads the variables.
    (after.payload !== null || before.vars === after.vars),
);

function VisualizationWidgetTile({
  widget,
  payload,
  network,
  vars,
  expanded,
  onExpand,
  onLink,
  busy,
}: VisualizationWidgetProps) {
  const link = widget.options.link;
  const onSelect =
    link && onLink
      ? (row: Record<string, unknown>) => onLink(link, row)
      : undefined;
  const own = useWidgetData(
    widget.visualization?.id ?? null,
    network,
    vars,
    payload !== null,
  );
  const { user } = useSession();
  const visualization = widget.visualization;
  if (!visualization) {
    return (
      <WidgetTile
        id={widget.id}
        title={widget.options.title ?? 'Removed chart'}
        spec={{ type: 'table', encoding: {}, options: {} }}
        payload={{
          state: 'error',
          error: { status: 404, message: 'This chart was removed.' },
        }}
        width={12}
        height={widget.height}
        expanded={expanded}
        onExpand={onExpand}
      />
    );
  }
  return (
    <WidgetTile
      id={widget.id}
      title={widget.options.title ?? visualization.title}
      spec={{
        type: visualization.type,
        encoding: visualization.config.encoding,
        options: visualization.config.options,
      }}
      payload={payload ?? own}
      subtitle={visualization.queryTitle}
      busy={busy}
      width={12}
      height={widget.height}
      note={widget.options.note}
      expanded={expanded}
      onExpand={onExpand}
      onSelect={onSelect}
      // Every figure leads to the query it is computed from — unless that
      // query is private and the viewer could not open it anyway.
      source={
        visualization.queryVisibility !== 'private' || user
          ? {
              href: `/queries/${visualization.query}?tab=charts&chart=${visualization.id}`,
              label: `Open the query behind this: ${visualization.queryTitle}`,
            }
          : undefined
      }
    />
  );
}

/**
 * What a tile shows beyond its chart: a title and note of its own, what a
 * click on it sets, and when it is shown at all. Edited in the side drawer.
 */
function TileSettings({
  widget,
  variables,
  onChange,
  onRemove,
}: {
  widget: DraftWidget;
  variables: DashboardVariable[];
  onChange: (widget: DraftWidget) => void;
  onRemove: () => void;
}) {
  const textVars = variables.filter(
    (variable) => variable.type === 'text' || variable.type === 'select',
  );
  const options = widget.options;
  const set = (patch: Partial<DraftWidget['options']>) => {
    const next = { ...options, ...patch };
    for (const key of Object.keys(next) as Array<keyof typeof next>) {
      if (next[key] === undefined || next[key] === '') delete next[key];
    }
    onChange({ ...widget, options: next });
  };
  const columns = widget.visualization?.config.encoding
    ? [
        ...new Set(
          [
            widget.visualization.config.encoding.x,
            widget.visualization.config.encoding.series,
            widget.visualization.config.encoding.row,
            ...(widget.visualization.config.options.columns ?? []),
          ].filter((name): name is string => Boolean(name)),
        ),
      ]
    : [];

  return (
    <div className="drawer-body">
      {widget.visualization && (
        <p className="drawer-source">
          <span>
            {widget.visualization.title}
            <small>{widget.visualization.queryTitle}</small>
          </span>
          <Link
            href={`/queries/${widget.visualization.query}?tab=charts&chart=${widget.visualization.id}`}
          >
            Open chart
          </Link>
        </p>
      )}
      <p className="drawer-size">
        {widget.width}/12 wide · {widget.height}px high
        <small>Drag the tile&apos;s corner to resize it.</small>
      </p>
      <label className="studio-field">
        <span>Title (defaults to the chart&apos;s)</span>
        <input
          value={options.title ?? ''}
          placeholder={widget.visualization?.title}
          onChange={(event) => set({ title: event.target.value })}
        />
      </label>
      <label className="studio-field">
        <span>Note under the chart</span>
        <input
          value={options.note ?? ''}
          onChange={(event) => set({ note: event.target.value })}
        />
      </label>
      <fieldset className="link-fields">
        <legend>Clicking a row or bar sets</legend>
        <select
          className="studio-input"
          aria-label="Variable to set"
          value={options.link?.var ?? ''}
          onChange={(event) =>
            set({
              link: event.target.value
                ? {
                    column: options.link?.column ?? columns[0] ?? '',
                    var: event.target.value,
                    dashboard: options.link?.dashboard,
                  }
                : undefined,
            })
          }
        >
          <option value="">nothing</option>
          {textVars.map((variable) => (
            <option key={variable.name} value={variable.name}>
              {variable.label}
            </option>
          ))}
        </select>
        {options.link && (
          <>
            <span>to its</span>
            <input
              aria-label="Column"
              className="studio-input mono"
              list={`columns-${widget.id}`}
              value={options.link.column}
              onChange={(event) =>
                options.link &&
                set({
                  link: { ...options.link, column: event.target.value },
                })
              }
            />
            <datalist id={`columns-${widget.id}`}>
              {columns.map((column) => (
                <option key={column} value={column}>
                  {column}
                </option>
              ))}
            </datalist>
            <span>on dashboard</span>
            <input
              aria-label="Target dashboard"
              className="studio-input mono"
              placeholder="this one"
              value={options.link.dashboard ?? ''}
              onChange={(event) =>
                options.link &&
                set({
                  link: {
                    ...options.link,
                    dashboard: event.target.value || undefined,
                  },
                })
              }
            />
          </>
        )}
      </fieldset>
      <label className="studio-field">
        <span>Only show when this variable is set</span>
        <select
          value={options.requires ?? ''}
          onChange={(event) =>
            set({ requires: event.target.value || undefined })
          }
        >
          <option value="">always show</option>
          {variables.map((variable) => (
            <option key={variable.name} value={variable.name}>
              {variable.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="studio-button danger" onClick={onRemove}>
        <Trash2 size={13} aria-hidden="true" /> Remove from dashboard
      </button>
    </div>
  );
}

/**
 * The few controls a tile has while editing, floating over its top-right
 * corner: a grip to drag it elsewhere (or move it with the arrow keys), its
 * settings, and remove.
 */
function TileToolbar({
  label,
  selected,
  onDragStart,
  onDragEnd,
  onMove,
  onSettings,
  onRemove,
}: {
  label: string;
  selected: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove?: (by: -1 | 1) => void;
  onSettings?: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="tile-toolbar">
      <button
        type="button"
        className="tile-tool grip"
        draggable
        aria-label={`Move ${label}: drag, or use the arrow keys`}
        title="Drag to move"
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', label);
          const cell = (event.target as Element).closest(
            '.dashboard-cell, .dashboard-heading',
          );
          if (cell) event.dataTransfer.setDragImage(cell, 24, 24);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onKeyDown={(event) => {
          if (!onMove) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            event.preventDefault();
            onMove(-1);
          } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault();
            onMove(1);
          }
        }}
      >
        <GripVertical size={14} aria-hidden="true" />
      </button>
      {onSettings && (
        <button
          type="button"
          className="tile-tool"
          aria-label={`Settings of ${label}`}
          aria-pressed={selected}
          title="Settings"
          onClick={onSettings}
        >
          <Settings2 size={14} aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        className="tile-tool danger"
        aria-label={`Remove ${label}`}
        title="Remove"
        onClick={onRemove}
      >
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Adding a chart: every saved chart, by query, found as you type. */
function ChartPicker({
  catalog,
  onPick,
  onClose,
}: {
  catalog: SavedVisualization[];
  onPick: (visualization: SavedVisualization) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') onClose();
      } else if (!frame.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [onClose]);
  const needle = search.trim().toLowerCase();
  const groups = new Map<string, SavedVisualization[]>();
  for (const visualization of catalog) {
    if (
      needle &&
      !`${visualization.title} ${visualization.queryTitle} ${visualization.type}`
        .toLowerCase()
        .includes(needle)
    )
      continue;
    const list = groups.get(visualization.queryTitle) ?? [];
    list.push(visualization);
    groups.set(visualization.queryTitle, list);
  }
  return (
    <div className="chart-picker" ref={frame}>
      <label className="chart-picker-search">
        <Search size={14} aria-hidden="true" />
        <input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the picker opens to be typed into
          autoFocus
          placeholder="Find a chart or query…"
          aria-label="Find a chart"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div className="chart-picker-list">
        {[...groups.entries()].map(([query, list]) => (
          <section key={query}>
            <h4>{query}</h4>
            {list.map((visualization) => {
              const Icon = TYPE_ICONS[visualization.type];
              return (
                <button
                  key={visualization.id}
                  type="button"
                  onClick={() => onPick(visualization)}
                >
                  <Icon size={14} aria-hidden="true" />
                  <span>{visualization.title}</span>
                  <small>{visualization.type}</small>
                </button>
              );
            })}
          </section>
        ))}
        {!groups.size && (
          <p className="studio-muted">
            {catalog.length
              ? 'No chart matches.'
              : 'No charts yet: make one on a query first.'}
          </p>
        )}
      </div>
    </div>
  );
}

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

function VariablesEditor({
  variables,
  onChange,
}: {
  variables: DashboardVariable[];
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
            <option value="network">network</option>
            <option value="text">text (set by clicks)</option>
            <option value="select">select</option>
          </select>
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

export function DashboardView({
  slug,
  initialVars,
  initialEditing,
}: {
  slug: string;
  initialVars: Record<string, string>;
  initialEditing: boolean;
}) {
  const router = useRouter();
  const { user } = useSession();
  const { dashboardsChanged } = useNav();
  const [dashboard, setDashboard] = useState<DashboardRecord | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [revision, setRevision] = useState(0);
  // The variables as chosen here: shown at once, before any data for them
  // arrives. A key set to undefined was cleared, and falls back to its default.
  const [requested, setRequested] =
    useState<Record<string, string | undefined>>(initialVars);
  const requestedRef = useRef(requested);
  const [data, setData] = useState<DataResponse | null>(null);
  // Which request the data on screen answers; while it differs from the one
  // asked for, the charts that read a changed variable say they are updating.
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  // Bumped to read the data again without anything changing here: when one
  // of the dashboard's queries finishes a run.
  const [poke, setPoke] = useState(0);
  const [runs, setRuns] = useState<Map<string, RunState>>(() => new Map());
  const [networks, setNetworks] = useState<Network[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState(initialEditing);
  const [draft, setDraft] = useState<DraftWidget[] | null>(null);
  const [settings, setSettings] = useState<{
    title: string;
    description: string;
    visibility: Visibility;
    variables: DashboardVariable[];
  } | null>(null);
  const [catalog, setCatalog] = useState<SavedVisualization[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The editor's own state: which drawer is open and on what, the chart
  // picker, a tile being dragged and where it would land.
  const [panel, setPanel] = useState<'tile' | 'variables' | 'settings' | null>(
    null,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    side: 'before' | 'after';
  } | null>(null);
  // The same, readable at once by the drag events that follow a drag start,
  // before React has rendered the state.
  const draggingRef = useRef<string | null>(null);
  const dropRef = useRef<{ id: string; side: 'before' | 'after' } | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [added, setAdded] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<{ dashboard: DashboardRecord }>(`/api/v1/dashboards/${slug}`)
      .then(({ dashboard: loaded }) => {
        if (!live) return;
        setDashboard(loaded);
        setLoadError(null);
      })
      .catch((error: ApiError) => live && setLoadError(error));
    return () => {
      live = false;
    };
  }, [slug, user, revision]);

  const search = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(requested))
      if (value) params.set(`v.${key}`, value);
    return params.toString();
  }, [requested]);

  const requestKey = `${search}|${revision}|${poke}|${user?.username ?? ''}`;
  useEffect(() => {
    const controller = new AbortController();
    api<DataResponse>(`/api/v1/dashboards/${slug}/data?${search}`, {
      signal: controller.signal,
    })
      .then((response) =>
        // A transition: the page stays responsive while the charts that
        // changed redraw, and a newer choice interrupts it.
        startTransition(() => {
          setData((previous) => keepUnchanged(previous, response));
          setLoadedKey(requestKey);
        }),
      )
      .catch((error: Error) => {
        if (error.name === 'AbortError') return;
        setData(null);
        setLoadedKey(requestKey);
      });
    return () => controller.abort();
  }, [slug, search, requestKey]);

  // Which of the dashboard's queries are running: asked every 20 seconds,
  // every 3 while one is, and the data read again when a run finishes.
  useEffect(() => {
    if (editing) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous: Map<string, RunState> | null = null;
    const tick = async () => {
      let running = false;
      if (document.visibilityState === 'visible') {
        try {
          const { queries } = await api<{ queries: RunState[] }>(
            `/api/v1/dashboards/${slug}/status?${search}`,
          );
          if (!live) return;
          const next = new Map(queries.map((entry) => [entry.query, entry]));
          running = queries.some((entry) => entry.running);
          const finished =
            previous !== null &&
            queries.some(
              (entry) =>
                previous?.get(entry.query)?.finishedAt !== entry.finishedAt,
            );
          previous = next;
          setRuns(next);
          if (finished) setPoke((value) => value + 1);
        } catch {
          // Unreachable for a moment: ask again at the next tick.
        }
      }
      if (live) timer = setTimeout(() => void tick(), running ? 3_000 : 20_000);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [slug, search, editing]);

  useEffect(() => {
    let live = true;
    api<{ networks: Network[] }>('/api/v1/networks')
      .then(({ networks: list }) => live && setNetworks(list))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!editing || !user) return;
    let live = true;
    api<{ visualizations: SavedVisualization[] }>('/api/v1/visualizations')
      .then(({ visualizations }) => live && setCatalog(visualizations))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [editing, user]);

  // What the variable bar shows: the choice made here at once, over the
  // values the last response resolved.
  const vars = useMemo(() => {
    const out: Record<string, string | undefined> = { ...data?.vars };
    for (const [name, value] of Object.entries(requested))
      if (value !== undefined || !data) out[name] = value;
    return out;
  }, [data, requested]);
  const network =
    (dashboard?.variables.find((variable) => variable.type === 'network') &&
      vars[
        dashboard.variables.find((variable) => variable.type === 'network')
          ?.name ?? ''
      ]) ||
    'all';

  const setVar = useCallback(
    (name: string, value: string | undefined, target?: string) => {
      if (target && target !== slug) {
        router.push(
          `/dashboards/${target}?${new URLSearchParams(value ? { [name]: value } : {})}`,
        );
        return;
      }
      const next = { ...requestedRef.current, [name]: value || undefined };
      requestedRef.current = next;
      setRequested(next);
      // The address follows without a navigation: nothing on the server
      // needs to render again for a variable to change.
      const params = new URLSearchParams();
      for (const [key, entry] of Object.entries(next))
        if (entry) params.set(key, entry);
      window.history.replaceState(
        window.history.state,
        '',
        `/dashboards/${slug}${params.size ? `?${params}` : ''}`,
      );
    },
    [router, slug],
  );
  const followLink = useCallback(
    (link: Link, row: Record<string, unknown>) => {
      const value = row[link.column];
      if (value !== null && value !== undefined)
        setVar(link.var, asText(value), link.dashboard);
    },
    [setVar],
  );

  const startEditing = () => {
    if (!dashboard) return;
    setDraft(dashboard.widgets);
    setSettings({
      title: dashboard.title,
      description: dashboard.description,
      visibility: dashboard.visibility,
      variables: dashboard.variables,
    });
    setEditing(true);
  };

  // Opened with ?edit=1: enter the editor once the dashboard has loaded.
  const editorReady = editing && dashboard && user && !draft;
  if (editorReady) {
    startEditing();
  }

  const save = async () => {
    if (!draft || !settings) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api(`/api/v1/dashboards/${slug}`, {
        method: 'PATCH',
        body: settings,
      });
      await api(`/api/v1/dashboards/${slug}/widgets`, {
        method: 'PUT',
        body: {
          widgets: draft.map((widget) => ({
            kind: widget.kind,
            visualization: widget.visualization?.id,
            text: widget.text,
            width: widget.width,
            height: widget.height,
            options: widget.options,
          })),
        },
      });
      setEditing(false);
      setDraft(null);
      setSettings(null);
      setRevision((value) => value + 1);
      dashboardsChanged();
    } catch (error) {
      setSaveError((error as ApiError).message);
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    try {
      await api(`/api/v1/dashboards/${slug}`, { method: 'DELETE' });
      dashboardsChanged();
      router.push('/');
    } catch (error) {
      setSaveError((error as ApiError).message);
    }
  };

  // The headings are the dashboard's sections: anchors here, links in the
  // sidebar.
  const headings = (dashboard?.widgets ?? []).filter(
    (widget) => widget.kind === 'text',
  );
  const headingIds = sectionIds(headings.map((widget) => widget.text));
  const anchorOf = new Map(
    headings.map((widget, at) => [widget.id, headingIds[at]]),
  );
  useDashboardSections(
    slug,
    headings.map((widget, at) => ({ id: headingIds[at], title: widget.text })),
  );

  // A tile just added is scrolled to and flashed, so it is found at once.
  useEffect(() => {
    if (!added) return;
    const cell = document.querySelector(`[data-widget="${added}"]`);
    cell?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const timer = setTimeout(() => setAdded(null), 1600);
    return () => clearTimeout(timer);
  }, [added]);

  useEffect(() => {
    if (!panel) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPanel(null);
        setSelected(null);
      }
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [panel]);

  if (loadError) {
    return (
      <main className="studio-page">
        <p className="studio-error">{loadError.message}</p>
        <p>
          <Link href="/">All dashboards</Link>
        </p>
      </main>
    );
  }
  if (!dashboard) {
    return (
      <main className="studio-page">
        <p className="studio-muted">Loading…</p>
      </main>
    );
  }

  const widgets: DraftWidget[] = editing && draft ? draft : dashboard.widgets;
  const variables =
    editing && settings ? settings.variables : dashboard.variables;
  const payloadOf = (widget: DraftWidget): WidgetPayload | null => {
    if (editing) return null;
    const entry = data?.widgets.find((candidate) => candidate.id === widget.id);
    if (!entry) return LOADING;
    if (entry.state !== 'ok' && entry.state !== 'error') return null;
    let payload = payloads.get(entry);
    if (!payload) {
      payload =
        entry.state === 'ok'
          ? { state: 'ok', data: entry.data }
          : { state: 'error', error: entry.error };
      payloads.set(entry, payload);
    }
    return payload;
  };

  // The variables whose new values are still on their way.
  const loading = data !== null && loadedKey !== requestKey;
  const pendingVars = new Set(
    loading
      ? Object.keys(requested).filter(
          (name) => (requested[name] ?? null) !== (data?.vars[name] ?? null),
        )
      : [],
  );
  const networkVar = variables.find((variable) => variable.type === 'network');
  const busyOf = (widget: DraftWidget): 'running' | 'updating' | undefined => {
    const visualization = widget.visualization;
    if (!visualization || editing) return undefined;
    if (runs.get(visualization.query)?.running) return 'running';
    if (!pendingVars.size) return undefined;
    const reads = readsOf(visualization);
    for (const name of pendingVars) {
      if (
        reads.has(name) ||
        name === networkVar?.name ||
        name === widget.options.requires
      )
        return 'updating';
    }
    return undefined;
  };
  const hidden = (widget: DraftWidget) =>
    !editing &&
    data?.widgets.find((candidate) => candidate.id === widget.id)?.state ===
      'hidden';

  const moveWidget = (from: number, to: number) => {
    if (!draft) return;
    const next = [...draft];
    const [widget] = next.splice(from, 1);
    next.splice(to, 0, widget);
    setDraft(next);
  };

  const dirty =
    editing &&
    draft !== null &&
    settings !== null &&
    (JSON.stringify(draft) !== JSON.stringify(dashboard.widgets) ||
      settings.title !== dashboard.title ||
      settings.description !== dashboard.description ||
      settings.visibility !== dashboard.visibility ||
      JSON.stringify(settings.variables) !==
        JSON.stringify(dashboard.variables));

  const leave = () => {
    setEditing(false);
    setDraft(null);
    setSettings(null);
    setPanel(null);
    setSelected(null);
    setPicking(false);
    setConfirmLeave(false);
    router.replace(`/dashboards/${slug}`, { scroll: false });
  };

  const updateWidget = (next: DraftWidget) =>
    setDraft(
      (current) =>
        current?.map((entry) => (entry.id === next.id ? next : entry)) ??
        current,
    );
  const removeWidget = (id: string) => {
    setDraft(
      (current) => current?.filter((entry) => entry.id !== id) ?? current,
    );
    if (selected === id) {
      setSelected(null);
      setPanel(null);
    }
  };
  const addWidget = (widget: DraftWidget) => {
    setDraft((current) => [...(current ?? []), widget]);
    setAdded(widget.id);
  };
  const addChart = (visualization: SavedVisualization) => {
    setPicking(false);
    addWidget({
      id: `new-${Date.now()}`,
      local: true,
      kind: 'visualization',
      visualization,
      text: '',
      width: visualization.type === 'number' ? 3 : 6,
      height: visualization.type === 'number' ? 120 : 280,
      options: {},
    });
  };
  const addHeading = () =>
    addWidget({
      id: `new-${Date.now()}`,
      local: true,
      kind: 'text',
      visualization: null,
      text: 'New section',
      width: 12,
      height: 80,
      options: {},
    });

  // Dropping a dragged tile before or after the one under the pointer.
  const dragOver = (id: string) => (event: React.DragEvent<HTMLElement>) => {
    const moving = draggingRef.current;
    if (!moving || moving === id) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    const wide = box.width > box.height * 3;
    const side = (
      wide
        ? event.clientY < box.top + box.height / 2
        : event.clientX < box.left + box.width / 2
    )
      ? 'before'
      : 'after';
    if (dropRef.current?.id !== id || dropRef.current.side !== side) {
      dropRef.current = { id, side };
      setDropTarget({ id, side });
    }
  };
  const endDrag = () => {
    draggingRef.current = null;
    dropRef.current = null;
    setDragging(null);
    setDropTarget(null);
  };
  const drop = (event: React.DragEvent) => {
    event.preventDefault();
    const moving = draggingRef.current;
    const target = dropRef.current;
    if (draft && moving && target) {
      const from = draft.findIndex((entry) => entry.id === moving);
      let to = draft.findIndex((entry) => entry.id === target.id);
      if (from >= 0 && to >= 0) {
        if (target.side === 'after') to += 1;
        if (from < to) to -= 1;
        moveWidget(from, to);
      }
    }
    endDrag();
  };
  const dropClass = (id: string) =>
    dropTarget?.id === id ? ` drop-${dropTarget.side}` : '';

  const selectedWidget = draft?.find((entry) => entry.id === selected) ?? null;

  return (
    <main
      className={`studio-page dashboard-page${editing ? ' is-editing' : ''}${panel ? ' with-drawer' : ''}`}
    >
      {editing && settings && (
        <div className="edit-bar" role="toolbar" aria-label="Dashboard editor">
          <span className="edit-state">
            <i className={dirty ? 'dirty' : ''} aria-hidden="true" />
            {dirty ? 'Unsaved changes' : 'Editing'}
          </span>
          <span className="edit-bar-sep" />
          <div className="edit-bar-group menu-anchor">
            <button
              type="button"
              className="edit-bar-button"
              aria-expanded={picking}
              title="Add a chart"
              onClick={() => setPicking(!picking)}
            >
              <Plus size={15} aria-hidden="true" />
              <span className="edit-label">Add chart</span>
            </button>
            {picking && (
              <ChartPicker
                catalog={catalog}
                onPick={addChart}
                onClose={() => setPicking(false)}
              />
            )}
          </div>
          <button
            type="button"
            className="edit-bar-button"
            title="Add a heading"
            onClick={addHeading}
          >
            <Type size={15} aria-hidden="true" />
            <span className="edit-label">Heading</span>
          </button>
          <button
            type="button"
            className="edit-bar-button"
            aria-pressed={panel === 'variables'}
            title="Variables"
            onClick={() => {
              setSelected(null);
              setPanel(panel === 'variables' ? null : 'variables');
            }}
          >
            <SlidersHorizontal size={15} aria-hidden="true" />
            <span className="edit-label">Variables</span>
            <span className="edit-count">{settings.variables.length}</span>
          </button>
          <button
            type="button"
            className="edit-bar-button"
            aria-pressed={panel === 'settings'}
            title="Dashboard settings"
            onClick={() => {
              setSelected(null);
              setPanel(panel === 'settings' ? null : 'settings');
            }}
          >
            <Settings2 size={15} aria-hidden="true" />
            <span className="edit-label">Settings</span>
          </button>
          <span className="results-spacer" />
          {confirmLeave ? (
            <>
              <span className="edit-bar-note">Discard your changes?</span>
              <button type="button" className="edit-bar-button" onClick={leave}>
                Discard
              </button>
              <button
                type="button"
                className="edit-bar-button"
                onClick={() => setConfirmLeave(false)}
              >
                Keep editing
              </button>
            </>
          ) : (
            <button
              type="button"
              className="edit-bar-button"
              onClick={() => (dirty ? setConfirmLeave(true) : leave())}
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            className="edit-bar-save"
            disabled={saving || !dirty}
            onClick={() => void save()}
          >
            <Save size={14} aria-hidden="true" />
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      <header className="page-head">
        <div className="page-head-text">
          {editing && settings ? (
            <>
              <input
                className="title-input inline-edit"
                aria-label="Dashboard title"
                value={settings.title}
                onChange={(event) =>
                  setSettings({ ...settings, title: event.target.value })
                }
              />
              <textarea
                className="inline-edit description-edit"
                aria-label="Description"
                placeholder="What this dashboard shows"
                rows={2}
                value={settings.description}
                onChange={(event) =>
                  setSettings({ ...settings, description: event.target.value })
                }
              />
            </>
          ) : (
            <>
              <h1>{dashboard.title}</h1>
              {dashboard.description && (
                <p className="studio-muted">{dashboard.description}</p>
              )}
            </>
          )}
        </div>
        {user && !editing && (
          <div className="workbench-actions">
            <button
              type="button"
              className="studio-button"
              onClick={startEditing}
            >
              <Pencil size={13} aria-hidden="true" /> Edit
            </button>
          </div>
        )}
      </header>
      {saveError && <p className="studio-error">{saveError}</p>}

      <VariableBar
        variables={variables}
        vars={vars}
        networks={networks}
        onChange={(name, value) => setVar(name, value)}
      />

      <div className={`grid-frame${dragging ? ' dragging' : ''}`}>
        {editing && (
          <div className="grid-guides" aria-hidden="true">
            {Array.from({ length: 12 }, (_, at) => (
              <i key={at} />
            ))}
          </div>
        )}
        <div
          className="tile-grid dashboard-grid"
          onDragOver={(event) => {
            if (draggingRef.current) event.preventDefault();
          }}
          onDrop={drop}
        >
          {widgets.map((widget, index) => {
            if (hidden(widget)) return null;
            const label =
              widget.kind === 'text'
                ? widget.text || 'heading'
                : (widget.options.title ??
                  widget.visualization?.title ??
                  'chart');
            const toolbar = editing && draft && (
              <TileToolbar
                label={label}
                selected={selected === widget.id}
                onDragStart={() => {
                  draggingRef.current = widget.id;
                  setDragging(widget.id);
                }}
                onDragEnd={endDrag}
                onMove={(by) =>
                  moveWidget(
                    index,
                    Math.max(0, Math.min(widgets.length - 1, index + by)),
                  )
                }
                onSettings={
                  widget.kind === 'visualization'
                    ? () => {
                        setSelected(widget.id);
                        setPanel('tile');
                      }
                    : undefined
                }
                onRemove={() => removeWidget(widget.id)}
              />
            );
            const editClasses = editing
              ? ` editing${selected === widget.id ? ' selected' : ''}${dragging === widget.id ? ' is-dragged' : ''}${added === widget.id ? ' just-added' : ''}${dropClass(widget.id)}`
              : '';
            if (widget.kind === 'text') {
              return (
                <section
                  key={widget.id}
                  id={anchorOf.get(widget.id)}
                  data-widget={widget.id}
                  className={`dashboard-heading span-12${editClasses}`}
                  onDragOver={editing ? dragOver(widget.id) : undefined}
                >
                  {toolbar}
                  {editing && draft ? (
                    <>
                      <input
                        className="heading-edit"
                        aria-label="Heading"
                        value={widget.text}
                        placeholder="Section title"
                        onChange={(event) =>
                          updateWidget({ ...widget, text: event.target.value })
                        }
                      />
                      <textarea
                        className="inline-edit heading-note-edit"
                        aria-label="Text under the heading"
                        placeholder="Add a sentence about this section (optional)"
                        rows={1}
                        value={widget.options.note ?? ''}
                        onChange={(event) => {
                          const { note: _note, ...rest } = widget.options;
                          updateWidget({
                            ...widget,
                            options: event.target.value
                              ? { ...rest, note: event.target.value }
                              : rest,
                          });
                        }}
                      />
                    </>
                  ) : (
                    <>
                      <h2>{widget.text}</h2>
                      {widget.options.note && (
                        <p className="studio-muted">{widget.options.note}</p>
                      )}
                    </>
                  )}
                </section>
              );
            }
            const link = widget.options.link;
            return (
              <div
                key={widget.id}
                data-widget={widget.id}
                className={`dashboard-cell span-${widget.width}${editClasses}`}
                style={
                  {
                    '--cell-height': `${widget.height}px`,
                  } as React.CSSProperties
                }
                onDragOver={editing ? dragOver(widget.id) : undefined}
              >
                {toolbar}
                {editing && draft && (
                  <ResizeHandles
                    width={widget.width}
                    height={widget.height}
                    onResize={(size) => updateWidget({ ...widget, ...size })}
                  />
                )}
                <VisualizationWidget
                  widget={widget}
                  payload={payloadOf(widget)}
                  network={network}
                  vars={vars}
                  expanded={expanded}
                  onExpand={setExpanded}
                  onLink={link && !editing ? followLink : undefined}
                  busy={busyOf(widget)}
                />
              </div>
            );
          })}
          {editing && draft && (
            <div className="dashboard-cell span-4 add-tile-cell">
              <button
                type="button"
                className="add-tile"
                onClick={() => {
                  setPicking(true);
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
              >
                <LayoutGrid size={20} aria-hidden="true" />
                <strong>Add a chart</strong>
                <span>Any chart saved on a query</span>
              </button>
            </div>
          )}
        </div>
      </div>
      {!widgets.length && !editing && (
        <p className="studio-muted">
          {user ? 'Empty. Choose Edit to add charts.' : 'Nothing here yet.'}
        </p>
      )}

      {editing && settings && panel && (
        <aside className="edit-drawer" aria-label="Editor panel">
          <header>
            <h2>
              {panel === 'tile'
                ? 'Tile'
                : panel === 'variables'
                  ? 'Variables'
                  : 'Dashboard settings'}
            </h2>
            <button
              type="button"
              className="studio-icon-button bare"
              aria-label="Close"
              onClick={() => {
                setPanel(null);
                setSelected(null);
              }}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </header>
          {panel === 'tile' && selectedWidget && (
            <TileSettings
              key={selectedWidget.id}
              widget={selectedWidget}
              variables={settings.variables}
              onChange={updateWidget}
              onRemove={() => removeWidget(selectedWidget.id)}
            />
          )}
          {panel === 'variables' && (
            <div className="drawer-body">
              <p className="studio-muted">
                What viewers change. Charts read them through their steps: a
                range step reads <code>range</code>, a filter can read any
                variable. A text variable is usually set by clicking a linked
                chart.
              </p>
              <VariablesEditor
                variables={settings.variables}
                onChange={(next) =>
                  setSettings({ ...settings, variables: next })
                }
              />
            </div>
          )}
          {panel === 'settings' && (
            <div className="drawer-body">
              <fieldset className="visibility-choice">
                <legend>Who can see it</legend>
                {(
                  [
                    ['private', Lock, 'Private', 'Only editors'],
                    ['unlisted', Globe, 'Unlisted', 'Anyone with the link'],
                    ['public', Globe, 'Public', 'Listed for everyone'],
                  ] as const
                ).map(([value, Icon, title, hint]) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="visibility"
                      value={value}
                      checked={settings.visibility === value}
                      onChange={() =>
                        setSettings({ ...settings, visibility: value })
                      }
                    />
                    <Icon size={15} aria-hidden="true" />
                    <span>
                      {title}
                      <small>{hint}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              <section className="danger-zone">
                <h3>Archive</h3>
                <p className="studio-muted">
                  Hides the dashboard from everyone. Its charts and queries are
                  kept.
                </p>
                <button
                  type="button"
                  className="studio-button danger"
                  onClick={() => void archive()}
                >
                  Archive dashboard
                </button>
              </section>
            </div>
          )}
        </aside>
      )}
    </main>
  );
}

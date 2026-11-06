'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  Globe,
  LayoutGrid,
  Lock,
  Pencil,
  Plus,
  ClipboardPaste,
  Save,
  Undo2,
  Redo2,
  Settings2,
  SlidersHorizontal,
  Type,
  FileText,
  X,
} from 'lucide-react';
import { asText } from '@/lib/viz/text';
import { normalizeVariableValue } from '@/lib/viz/variable-value';
import {
  gridRows,
  gridTileHeight,
  compactGridBoxes,
  moveGridBox,
  responsiveSpan,
  resolveGridBoxes,
  snapGridRow,
  snapSectionRow,
  type GridBox,
} from '@/lib/viz/dashboard-grid';
import { type WidgetPayload } from '../../viz/widget-tile';
import {
  api,
  ApiError,
  type DashboardRecord,
  type DashboardVariable,
  type Network,
  type SavedVisualization,
  type Visibility,
} from '../api';
import { sectionIds, useDashboardSections, useNav } from '../nav';
import { useSession } from '../session';
import { ResizeHandles } from './resize-handles';
import {
  type DataResponse,
  type RunState,
  LOADING,
  payloads,
  keepUnchanged,
  readsOf,
  type DraftWidget,
} from './widget-data';
import { VariableBar } from './variable-bar';
import { type TileLink, VisualizationWidget } from './visualization-widget';
import { TileSettings } from './tile-settings';
import { TileToolbar } from './tile-toolbar';
import { ChartPicker } from './chart-picker';
import { VariablesEditor } from './variables-editor';
import { HelpTip } from '../help-tip';
import { LockedButton } from '../locked-link';
import { ShareButton } from '../share';
import { ago } from '../time';
import { SavedViews } from './saved-views';
import { TextTile } from './text-tile';

type EditSettings = {
  title: string;
  description: string;
  visibility: Visibility;
  variables: DashboardVariable[];
};
type EditSnapshot = { draft: DraftWidget[] | null; settings: EditSettings | null };
type EditHistory = { present: EditSnapshot; past: EditSnapshot[]; future: EditSnapshot[] };
type EditAction =
  | { type: 'draft'; value: React.SetStateAction<DraftWidget[] | null> }
  | { type: 'settings'; value: React.SetStateAction<EditSettings | null> }
  | { type: 'undo' }
  | { type: 'redo' };

function editHistory(state: EditHistory, action: EditAction): EditHistory {
  if (action.type === 'undo') {
    const previous = state.past.at(-1);
    return previous ? { present: previous, past: state.past.slice(0, -1), future: [state.present, ...state.future] } : state;
  }
  if (action.type === 'redo') {
    const next = state.future[0];
    return next ? { present: next, past: [...state.past, state.present], future: state.future.slice(1) } : state;
  }
  const key = action.type;
  const old = state.present[key];
  const value = typeof action.value === 'function'
    ? (action.value as (current: typeof old) => typeof old)(old)
    : action.value;
  if (JSON.stringify(old) === JSON.stringify(value)) return state;
  const present = { ...state.present, [key]: value };
  if (!state.present.draft || !state.present.settings || !present.draft || !present.settings)
    return { present, past: [], future: [] };
  return { present, past: [...state.past.slice(-99), state.present], future: [] };
}

/**
 * A dashboard: its variables across the top, its widgets on the grid below.
 *
 * Readers change variables — the range, the network, a selected client — and
 * the whole grid follows, every widget reading the same stored results. An
 * editor can switch to the layout editor: add charts from any query, reorder,
 * resize, link a chart's clicks to a variable, and save.
 */

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
  const [history, dispatchEdit] = useReducer(editHistory, { present: { draft: null, settings: null }, past: [], future: [] });
  const { draft, settings } = history.present;
  const setDraft = useCallback((value: React.SetStateAction<DraftWidget[] | null>) => dispatchEdit({ type: 'draft', value }), []);
  const setSettings = useCallback((value: React.SetStateAction<EditSettings | null>) => dispatchEdit({ type: 'settings', value }), []);
  useEffect(() => {
    if (!editing) return;
    const handleKey = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null;
      if (element?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element?.tagName ?? '')) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'z') return;
      event.preventDefault();
      dispatchEdit({ type: event.shiftKey ? 'redo' : 'undo' });
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [editing]);
  const [catalog, setCatalog] = useState<SavedVisualization[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The editor's own state: which drawer is open and on what, the chart
  // picker, a tile being dragged and where it would land.
  const [panel, setPanel] = useState<'tile' | 'variables' | 'settings' | null>(
    null,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [copiedWidget, setCopiedWidget] = useState<DraftWidget | null>(null);
  const [picking, setPicking] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const spatialDrag = useRef<{
    id: string;
    grid: HTMLElement;
    boxes: GridBox[];
    offsetX: number;
    offsetY: number;
    startX: number;
    startY: number;
    pointerX: number;
    pointerY: number;
    active: boolean;
  } | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const [placement, setPlacement] = useState<{
    column: number;
    row: number;
    previewRow: number;
    width: number;
    height: number;
    left: number;
    pixelWidth: number;
    gap: number;
  } | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  // Dense grid rows need to reflect the tile's actual rendered chrome: legends,
  // notes and wrapped section text vary, so a height estimate can overlap them.
  const tileNodes = useRef(new Map<string, HTMLElement>());
  const [tileRows, setTileRows] = useState<Record<string, number>>({});
  const [gridViewport, setGridViewport] = useState(1200);
  const [gridSize, setGridSize] = useState({ step: 1, gap: 4 });

  useEffect(() => {
    const update = () => setGridViewport(window.innerWidth);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(
    () => () => {
      if (scrollFrame.current !== null)
        cancelAnimationFrame(scrollFrame.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const measure = () => {
      const next: Record<string, number> = {};
      const grid = tileNodes.current.values().next().value?.parentElement;
      if (grid) {
        const style = getComputedStyle(grid);
        const columnGap = parseFloat(style.columnGap) || 0;
        const gap = parseFloat(style.getPropertyValue('--grid-row-gap')) || 0;
        const step = Math.max(
          1,
          Math.round((grid.getBoundingClientRect().width + columnGap) / 12),
        );
        setGridSize((current) =>
          current.step === step && current.gap === gap
            ? current
            : { step, gap },
        );
      }
      for (const [id, node] of tileNodes.current) {
        const content =
          node.querySelector<HTMLElement>(':scope > .chart-card') ?? node;
        const height = content.getBoundingClientRect().height;
        const gap =
          parseFloat(
            getComputedStyle(node.parentElement!).getPropertyValue(
              '--grid-row-gap',
            ),
          ) || 0;
        if (height > 0)
          next[id] = gridRows(
            height,
            gap,
            node.classList.contains('dashboard-heading') || (!editing && gridViewport <= 640) ? 1 : gridSize.step,
          );
      }
      setTileRows((current) => {
        const ids = Object.keys(next);
        if (
          ids.length === Object.keys(current).length &&
          ids.every((id) => current[id] === next[id])
        )
          return current;
        return next;
      });
    };
    const observer = new ResizeObserver(measure);
    const grid = tileNodes.current.values().next().value?.parentElement;
    if (grid) observer.observe(grid);
    for (const node of tileNodes.current.values()) observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [dashboard, draft, editing, gridSize.step, gridSize.gap, gridViewport]);

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
    for (const [name, value] of Object.entries(requested)) {
      const variable = dashboard?.variables.find(
        (entry) => entry.name === name,
      );
      if (
        variable?.type === 'network' &&
        variable.networks &&
        value &&
        value !== 'all' &&
        !variable.networks.includes(value)
      )
        continue;
      if (value !== undefined || !data) out[name] = normalizeVariableValue(variable, value);
    }
    for (const variable of dashboard?.variables ?? [])
      if (variable.type === 'network' && variable.fixed)
        out[variable.name] = variable.default;
    return out;
  }, [data, requested, dashboard]);
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
      const variable = dashboard?.variables.find((entry) => entry.name === name);
      const next = { ...requestedRef.current, [name]: normalizeVariableValue(variable, value || undefined) };
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
    [router, slug, dashboard],
  );
  const followLink = useCallback(
    (link: TileLink, row: Record<string, unknown>) => {
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
    (widget) => widget.kind === 'text' && !widget.options.textStyle,
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
    if (
      entry.state !== 'ok' &&
      entry.state !== 'error' &&
      entry.state !== 'private'
    )
      return null;
    let payload = payloads.get(entry);
    if (!payload) {
      payload =
        entry.state === 'ok'
          ? { state: 'ok', data: entry.data }
          : entry.state === 'private'
            ? { state: 'private' }
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
  const allowedSources = networkVar?.networks
    ? networks
        .filter((source) => networkVar.networks!.includes(source.id))
        .map((source) => source.id)
    : undefined;
  const chosenNetwork = networkVar?.fixed
    ? (networkVar.default ?? network)
    : network;
  const previewNetwork =
    allowedSources && !allowedSources.length
      ? '__unavailable'
      : chosenNetwork === 'all' &&
          networkVar?.stack === false &&
          allowedSources?.length
        ? allowedSources[0]
        : allowedSources &&
            chosenNetwork !== 'all' &&
            !allowedSources.includes(chosenNetwork)
          ? allowedSources[0]
          : chosenNetwork;
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
  const layoutBoxes = widgets.flatMap((widget) => {
    const layout = widget.options.layout;
    if (!layout || hidden(widget)) return [];
    const width = responsiveSpan(
      widget.kind === 'text' && !widget.options.textStyle ? 12 : widget.width,
      gridViewport,
    );
    return [
      {
        id: widget.id,
        ...layout,
        row:
          layout.unit === 'cells'
            ? layout.row * gridSize.step
            : snapGridRow(layout.row, gridSize.step),
        column: Math.min(layout.column, 12 - width),
        width,
        height: tileRows[widget.id] ?? 1,
      },
    ];
  });
  const resolvedBoxes = resolveGridBoxes(layoutBoxes);
  const layoutMeasured = layoutBoxes.every(
    (box) => tileRows[box.id] !== undefined,
  );
  const resolvedLayout = new Map(
    (layoutMeasured ? compactGridBoxes(resolvedBoxes) : resolvedBoxes).map(
      (box) => [box.id, box],
    ),
  );

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
  const duplicateWidget = (widget: DraftWidget) => {
    const bottom = Math.max(0, ...[...resolvedLayout.values()].map((box) => box.row + box.height));
    const layout = widget.options.layout;
    addWidget({
      ...widget,
      id: `new-${crypto.randomUUID()}`,
      local: true,
      options: {
        ...widget.options,
        layout: {
          column: layout?.column ?? 0,
          row: Math.ceil(bottom / gridSize.step),
          unit: 'cells',
          ...((widget.kind === 'visualization' || widget.options.textStyle) && layout?.rows ? { rows: layout.rows } : {}),
        },
      },
    });
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
  const addText = () =>
    addWidget({
      id: `new-${crypto.randomUUID()}`,
      local: true,
      kind: 'text',
      visualization: null,
      text: 'Add your text here.',
      width: 4,
      height: 240,
      options: { textStyle: 'plain' },
    });

  const endDrag = () => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    spatialDrag.current = null;
    setDragging(null);
    setPlacement(null);
  };
  const snapshotGrid = (id: string) => {
    if (!draft) return null;
    const node = tileNodes.current.get(id);
    const grid = node?.parentElement;
    if (!node || !grid) return null;
    const gridBox = grid.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
    const columnWidth = (gridBox.width - gap * 11) / 12;
    const boxes = draft.flatMap((widget) => {
      const element = tileNodes.current.get(widget.id);
      if (!element) return [];
      const rect = element.getBoundingClientRect();
      return [
        {
          id: widget.id,
          column: Math.max(
            0,
            Math.round((rect.left - gridBox.left) / (columnWidth + gap)),
          ),
          row: Math.max(0, Math.round(rect.top - gridBox.top)),
          width: Math.max(
            1,
            Math.min(12, Math.round((rect.width + gap) / (columnWidth + gap))),
          ),
          height: gridRows(
            rect.height,
            gridSize.gap,
            widget.kind === 'text' && !widget.options.textStyle ? 1 : gridSize.step,
          ),
        },
      ];
    });
    return { boxes, node };
  };
  const applyGrid = (
    boxes: GridBox[],
    resize?: { id: string; width: number; height: number },
  ) => {
    const compacted = compactGridBoxes(boxes);
    setDraft(
      (current) =>
        current?.map((widget) => {
          const box = compacted.find((entry) => entry.id === widget.id);
          const size =
            resize?.id === widget.id
              ? { width: resize.width, height: resize.height }
              : {};
          return box
            ? {
                ...widget,
                ...size,
                options: {
                  ...widget.options,
                  layout: {
                    column: box.column,
                    row: Math.round(box.row / gridSize.step),
                    unit: 'cells',
                    ...(widget.kind === 'visualization' || widget.options.textStyle
                      ? {
                          rows: Math.max(
                            1,
                            Math.round(box.height / gridSize.step),
                          ),
                        }
                      : {}),
                  },
                },
              }
            : widget;
        }) ?? current,
    );
  };
  const beginSpatialDrag = (
    id: string,
    event: React.PointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0) return;
    const snapshot = snapshotGrid(id);
    if (!snapshot) return;
    const grid = snapshot.node.parentElement;
    if (!grid) return;
    const rect = snapshot.node.getBoundingClientRect();
    spatialDrag.current = {
      id,
      grid,
      boxes: snapshot.boxes,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      startX: event.clientX,
      startY: event.clientY,
      pointerX: event.clientX,
      pointerY: event.clientY,
      active: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveSpatial = (
    id: string,
    direction: 'left' | 'right' | 'up' | 'down',
    index: number,
  ) => {
    const snapshot = snapshotGrid(id);
    const box = snapshot?.boxes.find((entry) => entry.id === id);
    if (!snapshot || !box) {
      moveWidget(
        index,
        Math.max(
          0,
          Math.min(
            widgets.length - 1,
            index + (direction === 'left' || direction === 'up' ? -1 : 1),
          ),
        ),
      );
      return;
    }
    const column =
      box.column + (direction === 'left' ? -1 : direction === 'right' ? 1 : 0);
    const row =
      box.row +
      (direction === 'up'
        ? -gridSize.step
        : direction === 'down'
          ? gridSize.step
          : 0);
    applyGrid(moveGridBox(snapshot.boxes, id, column, row));
  };
  const resizeSpatial = (
    widget: DraftWidget,
    size: { width: number; height: number; rows: number },
  ) => {
    const snapshot = snapshotGrid(widget.id);
    const box = snapshot?.boxes.find((entry) => entry.id === widget.id);
    if (!snapshot || !box) {
      updateWidget({ ...widget, width: size.width, height: size.height });
      return;
    }
    box.width = responsiveSpan(size.width, window.innerWidth);
    box.height = size.rows * gridSize.step;
    applyGrid(moveGridBox(snapshot.boxes, widget.id, box.column, box.row), {
      id: widget.id,
      ...size,
    });
  };
  const spatialPosition = (clientX: number, clientY: number) => {
    const start = spatialDrag.current;
    const moving = start?.boxes.find((box) => box.id === start.id);
    if (!start || !moving) return null;
    const grid = start.grid;
    const rect = grid.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
    const columnWidth = (rect.width - gap * 11) / 12;
    const column = Math.max(
      0,
      Math.min(
        12 - moving.width,
        Math.round((clientX - rect.left - start.offsetX) / (columnWidth + gap)),
      ),
    );
    const rawRow = Math.max(
      0,
      Math.min(100000, Math.round(clientY - rect.top - start.offsetY)),
    );
    // Each full-width heading starts a new tile grid immediately below its
    // natural height. Snap within that section instead of to the page origin.
    const headingIds = new Set(
      draft
        ?.filter((widget) => widget.kind === 'text' && !widget.options.textStyle)
        .map((widget) => widget.id),
    );
    const row = snapSectionRow(
      rawRow,
      gridSize.step,
      start.boxes,
      headingIds,
      start.id,
    );
    const preview = compactGridBoxes(
      moveGridBox(start.boxes, start.id, column, row),
    ).find((box) => box.id === start.id);
    return {
      column,
      row,
      previewRow: preview?.row ?? row,
      width: moving.width,
      height: moving.height,
      left: column * (columnWidth + gap),
      pixelWidth: moving.width * columnWidth + (moving.width - 1) * gap,
      gap: gridSize.gap,
    };
  };
  const updateSpatialDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = spatialDrag.current;
    if (!start) return;
    if (
      !start.active &&
      Math.hypot(event.clientX - start.startX, event.clientY - start.startY) < 5
    )
      return;
    if (!start.active) {
      start.active = true;
      setDragging(start.id);
    }
    event.preventDefault();
    start.pointerX = event.clientX;
    start.pointerY = event.clientY;
    setPlacement(spatialPosition(event.clientX, event.clientY));
    const scroll = () => {
      const current = spatialDrag.current;
      if (!current?.active) {
        scrollFrame.current = null;
        return;
      }
      const edge = 64;
      const direction =
        current.pointerY < edge
          ? -1
          : current.pointerY > window.innerHeight - edge
            ? 1
            : 0;
      if (!direction) {
        scrollFrame.current = null;
        return;
      }
      window.scrollBy({ top: direction * 14, behavior: 'instant' });
      setPlacement(spatialPosition(current.pointerX, current.pointerY));
      scrollFrame.current = requestAnimationFrame(scroll);
    };
    if (
      scrollFrame.current === null &&
      (event.clientY < 64 || event.clientY > window.innerHeight - 64)
    )
      scrollFrame.current = requestAnimationFrame(scroll);
  };
  const finishSpatialDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = spatialDrag.current;
    const position = start?.active
      ? spatialPosition(event.clientX, event.clientY)
      : null;
    if (start && position)
      applyGrid(
        moveGridBox(start.boxes, start.id, position.column, position.row),
      );
    endDrag();
  };

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
          <button type="button" className="edit-bar-button" title="Undo" aria-label="Undo dashboard change" disabled={!history.past.length} onClick={() => dispatchEdit({ type: 'undo' })}>
            <Undo2 size={15} aria-hidden="true" /><span className="edit-label">Undo</span>
          </button>
          <button type="button" className="edit-bar-button" title="Redo" aria-label="Redo dashboard change" disabled={!history.future.length} onClick={() => dispatchEdit({ type: 'redo' })}>
            <Redo2 size={15} aria-hidden="true" /><span className="edit-label">Redo</span>
          </button>
          <button type="button" className="edit-bar-button" disabled={!copiedWidget} title="Paste copied tile" onClick={() => copiedWidget && duplicateWidget(copiedWidget)}>
            <ClipboardPaste size={15} aria-hidden="true" /><span className="edit-label">Paste tile</span>
          </button>
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
          <button type="button" className="edit-bar-button" title="Add a text tile" onClick={addText}>
            <FileText size={15} aria-hidden="true" />
            <span className="edit-label">Text</span>
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

      {editing && (
        <p className="dashboard-edit-hint">
          Hover a tile to move or resize it. Use the arrow keys on a handle for
          precise changes.
        </p>
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
        {!editing && (
          <div className="workbench-actions">
            <ShareButton
              what="dashboard"
              visibility={dashboard.visibility}
              plainPath={`/dashboards/${slug}`}
              path={() => window.location.pathname + window.location.search}
              viewLabel="the filters as they are now"
              canEdit={Boolean(user)}
              bundleHref={
                user ? `/api/v1/dashboards/${slug}/bundle` : undefined
              }
              onVisibility={async (visibility) => {
                await api(`/api/v1/dashboards/${slug}`, {
                  method: 'PATCH',
                  body: { visibility },
                });
                setDashboard((current) =>
                  current ? { ...current, visibility } : current,
                );
              }}
            />
            <LockedButton
              className="studio-button"
              title="Edit dashboard"
              locked={user === null}
              onClick={startEditing}
            >
              <Pencil size={13} aria-hidden="true" /> Edit
            </LockedButton>
          </div>
        )}
      </header>
      {saveError && <p className="studio-error">{saveError}</p>}

      <VariableBar
        variables={variables}
        vars={vars}
        networks={networks}
        actions={!editing && dashboard.variables.length > 0 ? <SavedViews slug={slug} variables={dashboard.variables} networks={networks} vars={Object.fromEntries(dashboard.variables.map((variable) => [variable.name, vars[variable.name]]))} editable={Boolean(user)} onApply={(values) => {
        const next = Object.fromEntries(dashboard.variables.map((variable) => [variable.name, normalizeVariableValue(variable, values[variable.name])]));
        requestedRef.current = next;
        setRequested(next);
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(next)) if (value) params.set(key, value);
        window.history.replaceState(window.history.state, '', `/dashboards/${slug}${params.size ? `?${params}` : ''}`);
      }} /> : undefined}
        freshnessSummary={(() => {
          const entries = data?.widgets ?? [];
          const networks = entries.flatMap((entry) =>
            entry.state === 'ok' ? entry.data.networks : [],
          );
          const oldest = networks
            .map((network) => network.finishedAt)
            .filter((at): at is string => Boolean(at))
            .sort()[0];
          const failed = entries.filter(
            (entry) =>
              entry.state === 'error' ||
              (entry.state === 'ok' &&
                entry.data.networks.some(
                  (network) =>
                    network.status === 'failed' ||
                    network.lastAttempt?.status === 'failed',
                )),
          ).length;
          const stale = entries.filter(
            (entry) =>
              entry.state === 'ok' &&
              entry.data.networks.some((network) => network.stale),
          ).length;
          return oldest
            ? [
                `Oldest result ${ago(oldest)}`,
                failed ? `${failed} failed` : '',
                stale ? `${stale} stale` : '',
              ]
                .filter(Boolean)
                .join(' · ')
            : undefined;
        })()}
        onChange={(name, value) => setVar(name, value)}
      />

      <div
        className={`grid-frame${dragging ? ' dragging' : ''}`}
        style={{ '--grid-step': `${gridSize.step}px` } as React.CSSProperties}
      >
        {editing && (
          <div className="grid-guides" aria-hidden="true">
            {Array.from({ length: 12 }, (_, at) => (
              <i key={at} />
            ))}
          </div>
        )}
        <div className="tile-grid dashboard-grid">
          {widgets.map((widget, index) => {
            if (hidden(widget)) return null;
            const label =
              widget.kind === 'text'
                ? widget.options.textStyle
                  ? widget.text.split('\n')[0].replace(/^#+\s*/, '').trim().slice(0, 60) || 'text tile'
                  : widget.text || 'heading'
                : (widget.options.title ??
                  widget.visualization?.title ??
                  'chart');
            const toolbar = editing && draft && (
              <TileToolbar
                label={label}
                selected={selected === widget.id}
                onPointerStart={(event) => beginSpatialDrag(widget.id, event)}
                onPointerMove={updateSpatialDrag}
                onPointerEnd={finishSpatialDrag}
                onPointerCancel={endDrag}
                onMove={(direction) => moveSpatial(widget.id, direction, index)}
                onSettings={
                  widget.kind === 'visualization'
                    ? () => {
                        setSelected(widget.id);
                        setPanel('tile');
                      }
                    : undefined
                }
                onRemove={() => removeWidget(widget.id)}
                onDuplicate={() => duplicateWidget(widget)}
                onCopy={() => setCopiedWidget(widget)}
              />
            );
            const editClasses = editing
              ? ` editing${selected === widget.id ? ' selected' : ''}${dragging === widget.id ? ' is-dragged' : ''}${added === widget.id ? ' just-added' : ''}`
              : '';
            if (widget.kind === 'text' && widget.options.textStyle) {
              const renderedHeight = gridTileHeight(
                widget.options.layout?.unit === 'cells' && widget.options.layout.rows
                  ? widget.options.layout.rows * gridSize.step - gridSize.gap
                  : widget.height,
                gridSize.gap,
                gridSize.step,
              );
              return (
                <div key={widget.id} data-widget={widget.id}
                  className={`dashboard-cell span-${widget.width}${widget.options.layout ? ' has-layout' : ''}${editClasses}`}
                  ref={(node) => { if (node) tileNodes.current.set(widget.id, node); else tileNodes.current.delete(widget.id); }}
                  style={{ '--cell-rows': tileRows[widget.id], '--layout-column': (resolvedLayout.get(widget.id)?.column ?? 0) + 1, '--layout-row': (resolvedLayout.get(widget.id)?.row ?? 0) + 1, '--layout-width': resolvedLayout.get(widget.id)?.width ?? widget.width, '--tile-height': `${renderedHeight}px` } as React.CSSProperties}>
                  {toolbar}
                  {editing && draft && <ResizeHandles width={widget.width} height={widget.height} rows={Math.round((renderedHeight + gridSize.gap) / gridSize.step)} gridStep={gridSize.step} onResize={(size) => resizeSpatial(widget, size)} />}
                  <TextTile text={widget.text} style={widget.options.textStyle} editing={editing} onChange={(text) => updateWidget({ ...widget, text })} onStyle={(textStyle) => updateWidget({ ...widget, options: { ...widget.options, textStyle } })} />
                </div>
              );
            }
            if (widget.kind === 'text') {
              return (
                <section
                  key={widget.id}
                  id={anchorOf.get(widget.id)}
                  data-widget={widget.id}
                  className={`dashboard-heading span-12${widget.options.layout ? ' has-layout' : ''}${editClasses}`}
                  ref={(node) => {
                    if (node) tileNodes.current.set(widget.id, node);
                    else tileNodes.current.delete(widget.id);
                  }}
                  style={
                    {
                      '--cell-rows': tileRows[widget.id],
                      '--layout-column':
                        (resolvedLayout.get(widget.id)?.column ?? 0) + 1,
                      '--layout-row':
                        (resolvedLayout.get(widget.id)?.row ?? 0) + 1,
                      '--layout-width': 12,
                    } as React.CSSProperties
                  }
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
            const renderedHeight = gridTileHeight(
              widget.options.layout?.unit === 'cells' &&
                widget.options.layout.rows
                ? widget.options.layout.rows * gridSize.step - gridSize.gap
                : widget.height +
                    (widget.visualization?.type === 'number' ? 80 : 200),
              gridSize.gap,
              gridSize.step,
            );
            return (
              <div
                key={widget.id}
                data-widget={widget.id}
                className={`dashboard-cell span-${widget.width}${renderedHeight < 180 ? ' is-compact' : ''}${widget.options.layout ? ' has-layout' : ''}${editClasses}`}
                ref={(node) => {
                  if (node) tileNodes.current.set(widget.id, node);
                  else tileNodes.current.delete(widget.id);
                }}
                style={
                  {
                    '--cell-height': `${widget.height}px`,
                    '--tile-height': `${renderedHeight}px`,
                    '--cell-rows': tileRows[widget.id],
                    '--layout-column':
                      (resolvedLayout.get(widget.id)?.column ?? 0) + 1,
                    '--layout-row':
                      (resolvedLayout.get(widget.id)?.row ?? 0) + 1,
                    '--layout-width':
                      resolvedLayout.get(widget.id)?.width ?? widget.width,
                  } as React.CSSProperties
                }
              >
                {toolbar}
                {editing && draft && (
                  <ResizeHandles
                    width={widget.width}
                    height={widget.height}
                    rows={Math.round(
                      (renderedHeight + gridSize.gap) / gridSize.step,
                    )}
                    gridStep={gridSize.step}
                    onResize={(size) => resizeSpatial(widget, size)}
                  />
                )}
                <VisualizationWidget
                  widget={widget}
                  payload={payloadOf(widget)}
                  network={editing ? previewNetwork : network}
                  sources={
                    editing && allowedSources?.length
                      ? allowedSources.join(',')
                      : undefined
                  }
                  vars={vars}
                  expanded={expanded}
                  onExpand={setExpanded}
                  onLink={link && !editing ? followLink : undefined}
                  busy={busyOf(widget)}
                />
              </div>
            );
          })}
          {editing && placement && (
            <div
              className="grid-drop-preview"
              aria-hidden="true"
              style={{
                left: placement.left,
                top: placement.previewRow,
                width: placement.pixelWidth,
                height: placement.height - placement.gap,
              }}
            />
          )}
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
              dashboardSlug={slug}
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
                chart. <HelpTip topic="dashboards" />
              </p>
              <VariablesEditor
                variables={settings.variables}
                networks={networks}
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

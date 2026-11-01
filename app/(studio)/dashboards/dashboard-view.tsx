'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Globe,
  LayoutGrid,
  Lock,
  Pencil,
  Plus,
  Save,
  Settings2,
  SlidersHorizontal,
  Type,
  X,
} from 'lucide-react';
import { asText } from '@/lib/viz/text';
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
import { ShareButton } from '../share';

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
            {user && (
              <button
                type="button"
                className="studio-button"
                onClick={startEditing}
              >
                <Pencil size={13} aria-hidden="true" /> Edit
              </button>
            )}
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
                chart. <HelpTip topic="dashboards" />
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

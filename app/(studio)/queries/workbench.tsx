'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ChevronDown,
  Clock,
  Copy,
  Database,
  GitFork,
  Globe,
  History,
  Layers,
  Lock,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Play,
  Plus,
  Puzzle,
  RefreshCw,
  Route,
  Save,
  Settings2,
  Shapes,
  Square,
  Table2,
  Timer,
  Wand2,
  WandSparkles,
} from 'lucide-react';
import {
  api,
  ApiError,
  type ChartHost,
  type Combine,
  type Dependent,
  type Kind,
  type Network,
  type Preview,
  type QueryRecord,
  type QuerySummary,
  type QueryVersion,
  type ResultPage,
  type SchemaTable,
  type Visibility,
} from '../api';
import { ResultsTable } from '../results-table';
import { useSession } from '../session';
import { setPreference, usePreference } from '../preference';
import {
  TYPE_ICONS,
  VisualizationsPanel,
  type Saved,
} from './visualizations-panel';
import {
  SqlEditor,
  type Completion,
  type SqlEditorHandle,
} from '../sql-editor';
import { FUNCTIONS, KEYWORDS } from '../sql-highlight';
import { ago, took } from '../time';
import {
  type Draft,
  emptyDraft,
  draftOf,
  slugify,
  when,
  codeOf,
  undeclared,
} from './workbench-draft';
import { AboutPanel } from './about-panel';
import { SchemaPanel } from './schema-panel';
import { ExtractForm } from './extract-form';
import { ParametersPanel } from './parameters-panel';
import { VersionsPanel } from './versions-panel';
import { FragmentTests } from './fragment-tests';
import { HelpTip } from '../help-tip';
import { formatSql } from '../sql-format';
import { ShareButton } from '../share';
import { asText } from '@/lib/viz/text';

/**
 * Where a query is written, run, saved and read back.
 *
 * One component for every case: a new query, an existing one being edited, and
 * an existing one being read by someone who cannot edit. What differs is which
 * controls are shown; the SQL, results and history read the same way for all.
 */

/** `results`, `versions`, `new` (a new chart) or `chart:<id>`. */
type Tab = string;

type ResultMode = 'stored' | 'preview';

const REFRESH_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: 'Not scheduled', value: null },
  { label: 'Every minute', value: 60 },
  { label: 'Every 5 minutes', value: 300 },
  { label: 'Every 15 minutes', value: 900 },
  { label: 'Hourly', value: 3_600 },
  { label: 'Every 6 hours', value: 21_600 },
  { label: 'Daily', value: 86_400 },
];

function ErrorBox({ error }: { error: ApiError | null }) {
  if (!error) return null;
  const { hint, detail, sqlstate } = error.details as {
    hint?: string;
    detail?: string;
    sqlstate?: string;
  };
  return (
    <div className="studio-error" role="alert">
      <strong>{error.message}</strong>
      {detail && <p>{detail}</p>}
      {hint && <p>Hint: {hint}</p>}
      {sqlstate && <small>SQLSTATE {sqlstate}</small>}
    </div>
  );
}

/** The tab and result view a `?tab=` link asks for (older links included). */
function initialTabOf(
  creating: boolean,
  tab: string | undefined,
  chart: string | undefined,
): { tab: Tab; mode: ResultMode } {
  if (creating || tab === 'preview') return { tab: 'results', mode: 'preview' };
  if (tab === 'charts' && chart)
    return { tab: `chart:${chart}`, mode: 'stored' };
  if (tab === 'versions') return { tab: 'versions', mode: 'stored' };
  return { tab: 'results', mode: 'stored' };
}

export function Workbench({
  slug,
  initialTab,
  initialChart,
}: {
  slug: string | null;
  initialTab?: string;
  initialChart?: string;
}) {
  const router = useRouter();
  const { user } = useSession();
  const editor = Boolean(user);
  const creating = slug === null;

  const [query, setQuery] = useState<QueryRecord | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [slugTouched, setSlugTouched] = useState(false);
  const [note, setNote] = useState('');
  const [networks, setNetworks] = useState<Network[]>([]);
  const [network, setNetwork] = useState('all');
  const [values, setValues] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const [running, setRunning] = useState(false);
  const [stored, setStored] = useState<ResultPage | null>(null);
  const [storedError, setStoredError] = useState<ApiError | null>(null);
  const [storing, setStoring] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  /** The SQL selected in the editor: Run runs only it. */
  const [selection, setSelection] = useState('');
  /** What the preview on screen is: rows or a plan, of the whole or a part. */
  const [previewOf, setPreviewOf] = useState<{
    explain: 'plan' | 'analyze' | null;
    selection: boolean;
  }>({ explain: null, selection: false });
  const runKeyRef = useRef<string | null>(null);
  const [storeError, setStoreError] = useState<ApiError | null>(null);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(
    () => initialTabOf(creating, initialTab, initialChart).tab,
  );
  const [resultMode, setResultMode] = useState<ResultMode>(
    () => initialTabOf(creating, initialTab, initialChart).mode,
  );
  const [charts, setCharts] = useState<Saved[] | null>(null);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [runMenu, setRunMenu] = useState(false);
  const [dashboards, setDashboards] = useState<ChartHost[]>([]);
  const schemaOpen = usePreference('arrakis.workbench.schema', true);
  const aboutOpen = usePreference('arrakis.workbench.about', true);
  const [schemaResult, setSchemaResult] = useState<{ network: string; tables: SchemaTable[]; status: 'ready' | 'error' } | null>(null);
  const schemaNetwork = network === 'all' ? networks[0]?.id : network;
  const schema = useMemo(() => schemaResult && schemaResult.network === schemaNetwork ? schemaResult.tables : [], [schemaResult, schemaNetwork]);
  const schemaStatus = schemaResult && schemaResult.network === schemaNetwork ? schemaResult.status : 'loading';
  const [lists, setLists] = useState<Array<{ name: string; type: string }>>([]);
  const [fragments, setFragments] = useState<QuerySummary[]>([]);
  const [versions, setVersions] = useState<QueryVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [forkSlug, setForkSlug] = useState('');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const sqlEditor = useRef<SqlEditorHandle>(null);

  // Bumped to read the query, its stored result or its history again.
  const [queryRevision, setQueryRevision] = useState(0);
  const [storedRevision, setStoredRevision] = useState(0);
  const [versionsRevision, setVersionsRevision] = useState(0);

  // Re-read when the session changes too: an editor sees private queries a
  // reader gets a 404 for.
  useEffect(() => {
    if (!slug) return;
    let live = true;
    api<{ query: QueryRecord }>(`/api/v1/queries/${slug}`)
      .then(({ query: loaded }) => {
        if (!live) return;
        setQuery(loaded);
        setDraft(draftOf(loaded));
        setLoadError(null);
        if (loaded.kind === 'fragment') {
          setTab('results');
          setResultMode('preview');
        }
      })
      .catch((error: ApiError) => live && setLoadError(error));
    return () => {
      live = false;
    };
  }, [slug, user, queryRevision]);

  useEffect(() => {
    let live = true;
    api<{ networks: Network[] }>('/api/v1/networks')
      .then(({ networks: list }) => live && setNetworks(list))
      .catch(() => live && setNetworks([]));
    return () => {
      live = false;
    };
  }, []);

  // Bumped when a fragment is made from the selection, to list it.
  const [fragmentsRevision, setFragmentsRevision] = useState(0);
  useEffect(() => {
    if (!editor) return;
    let live = true;
    api<{ queries: QuerySummary[] }>('/api/v1/queries?kind=fragment')
      .then(({ queries }) => live && setFragments(queries))
      .catch(() => live && setFragments([]));
    return () => {
      live = false;
    };
  }, [editor, fragmentsRevision]);

  // For a fragment: the queries a new version would reach.
  const [dependents, setDependents] = useState<Dependent[] | null>(null);
  const isFragment = query?.kind === 'fragment';
  useEffect(() => {
    if (!slug || !isFragment) return;
    let live = true;
    api<{ dependents: Dependent[] }>(`/api/v1/queries/${slug}/dependents`)
      .then(({ dependents: list }) => live && setDependents(list))
      .catch(() => live && setDependents([]));
    return () => {
      live = false;
    };
  }, [slug, isFragment, queryRevision]);

  // The charts drawn from this query: each one a tab of its own.
  const hasCharts = query?.kind === 'query';
  useEffect(() => {
    if (!slug || !hasCharts) return;
    let live = true;
    api<{ visualizations: Saved[] }>(`/api/v1/queries/${slug}/visualizations`)
      .then(({ visualizations }) => live && setCharts(visualizations))
      .catch(() => live && setCharts([]));
    api<{ dashboards: ChartHost[] }>(`/api/v1/queries/${slug}/dashboards`)
      .then(({ dashboards: list }) => live && setDashboards(list))
      .catch(() => live && setDashboards([]));
    return () => {
      live = false;
    };
  }, [slug, hasCharts]);

  // The Run and More menus close on a click elsewhere, or Escape.
  useEffect(() => {
    if (!runMenu && !menuOpen) return;
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === 'Escape'
          : !(event.target as Element).closest?.('.menu-anchor')
      ) {
        setRunMenu(false);
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [runMenu, menuOpen]);

  // Arriving from a dashboard tile: show the chart, not the SQL above it.
  const chartsLoaded = charts !== null;
  useEffect(() => {
    if (!initialChart || !chartsLoaded) return;
    requestAnimationFrame(() =>
      document
        .querySelector('.results-card')
        ?.scrollIntoView({ block: 'start' }),
    );
  }, [initialChart, chartsLoaded]);

  // Turning the selected SQL into a fragment of its own.
  // Fragments do not run on their own: only the queries a save reruns count.
  const reruns =
    dependents?.filter((entry) => entry.kind === 'query').length ?? 0;
  const [extracting, setExtracting] = useState<{
    start: number;
    end: number;
    text: string;
  } | null>(null);
  const [extractSlug, setExtractSlug] = useState('');
  const [extractTitle, setExtractTitle] = useState('');
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractHint, setExtractHint] = useState<string | null>(null);

  // The lists a query can read, for completion and the side panel.
  useEffect(() => {
    if (!editor) return;
    let live = true;
    api<{ lists: Array<{ name: string; type: string }> }>('/api/v1/lists')
      .then((answer) => live && setLists(answer.lists))
      .catch(() => live && setLists([]));
    return () => {
      live = false;
    };
  }, [editor]);

  // The schema of one data source: with "All", the first one's stands for the rest.
  useEffect(() => {
    if (!editor || !schemaNetwork) return;
    let live = true;
    api<{ tables: SchemaTable[] }>(
      `/api/v1/schema?network=${encodeURIComponent(schemaNetwork)}`,
    )
      .then(({ tables }) => { if (live) setSchemaResult({ network: schemaNetwork, tables, status: 'ready' }); })
      .catch(() => { if (live) setSchemaResult({ network: schemaNetwork, tables: [], status: 'error' }); });
    return () => {
      live = false;
    };
  }, [editor, schemaNetwork]);

  const storedSearch = useMemo(() => {
    const search = new URLSearchParams({ network, limit: '10000' });
    for (const [name, value] of Object.entries(values)) {
      if (value !== '') search.set(`p.${name}`, value);
    }
    return search.toString();
  }, [network, values]);

  // Read whatever the tab: the header says when it last ran.
  const showsStored = query?.kind === 'query';
  useEffect(() => {
    if (!slug || !showsStored) return;
    let live = true;
    api<ResultPage>(`/api/v1/queries/${slug}/results?${storedSearch}`)
      .then((page) => {
        if (!live) return;
        setStored(page);
        setStoredError(null);
      })
      .catch((error: ApiError) => {
        if (!live) return;
        setStored(null);
        setStoredError(error);
      });
    return () => {
      live = false;
    };
  }, [slug, showsStored, storedSearch, storedRevision]);

  // Read whatever the tab: the About panel lists the latest.
  const showsVersions = Boolean(slug);
  useEffect(() => {
    if (!slug || !showsVersions) return;
    let live = true;
    api<{ versions: QueryVersion[] }>(`/api/v1/queries/${slug}/versions`)
      .then(({ versions: list }) => live && setVersions(list))
      .catch(() => live && setVersions([]));
    return () => {
      live = false;
    };
  }, [slug, showsVersions, versionsRevision]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const sqlDirty =
    creating ||
    !query?.current ||
    draft.sql.trim() !== query.current.sql.trim() ||
    JSON.stringify(draft.parameters) !==
      JSON.stringify(query.current.parameters);
  const metaDirty =
    !creating &&
    query !== null &&
    (draft.title !== query.title ||
      draft.description !== query.description ||
      draft.visibility !== query.visibility ||
      draft.combine !== query.combine ||
      draft.refreshSeconds !== query.refreshSeconds ||
      draft.timeoutSeconds !== query.timeoutSeconds ||
      draft.rowLimit !== query.rowLimit);
  const dirty = creating || sqlDirty || metaDirty;

  const supplied = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const parameter of draft.parameters) {
      const value = values[parameter.name];
      if (value !== undefined && value !== '') out[parameter.name] = value;
    }
    return out;
  }, [draft.parameters, values]);

  const run = useCallback(
    async (explain?: 'plan' | 'analyze') => {
      if (!editor || running) return;
      // A selection runs on its own, with the query's parameters.
      const part = selection.trim();
      // This run's own token: Cancel stops exactly it, on whichever server.
      const runKey = crypto.randomUUID();
      runKeyRef.current = runKey;
      setRunning(true);
      setCancelled(false);
      if (tab === 'versions' || tab.startsWith('chart:') || tab === 'new')
        setTab('results');
      setResultMode('preview');
      setPreviewError(null);
      try {
        setPreview(
          await api<Preview>('/api/v1/run', {
            method: 'POST',
            body: {
              sql: part || draft.sql,
              parameters: draft.parameters,
              values: supplied,
              network,
              runKey,
              timeoutSeconds: draft.timeoutSeconds,
              query: slug ?? undefined,
              ...(explain ? { explain } : {}),
            },
          }),
        );
        setPreviewOf({ explain: explain ?? null, selection: Boolean(part) });
      } catch (error) {
        setPreview(null);
        if ((error as ApiError).details?.cancelled) setCancelled(true);
        else setPreviewError(error as ApiError);
      } finally {
        runKeyRef.current = null;
        setRunning(false);
      }
    },
    [
      draft.parameters,
      draft.sql,
      draft.timeoutSeconds,
      editor,
      network,
      running,
      selection,
      slug,
      supplied,
      tab,
    ],
  );

  /** Formats the SQL in place, as one step Cmd/Ctrl+Z undoes. */
  const format = useCallback(() => {
    // The editor refuses to replace read-only text itself.
    sqlEditor.current?.replace(formatSql(draft.sql));
  }, [draft.sql]);

  /** Stops the preview this page started, or every stored run of the query. */
  const cancelRun = async (scope: 'preview' | 'stored') => {
    setCancelling(true);
    try {
      await api('/api/v1/runs/cancel', {
        method: 'POST',
        body:
          scope === 'preview'
            ? { runKey: runKeyRef.current ?? '' }
            : { query: slug ?? '' },
      });
    } catch {
      // Nothing was running any more: the run finished as it was cancelled.
    } finally {
      setCancelling(false);
      if (scope === 'stored') setStoredRevision((value) => value + 1);
    }
  };

  const save = useCallback(async () => {
    if (!editor || saving || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (creating) {
        const { query: created } = await api<{ query: QueryRecord }>(
          '/api/v1/queries',
          {
            method: 'POST',
            body: { ...draft, note: note || 'First version' },
          },
        );
        router.replace(`/queries/${created.slug}`);
        return;
      }
      if (metaDirty) {
        await api(`/api/v1/queries/${draft.slug}`, {
          method: 'PATCH',
          body: {
            title: draft.title,
            description: draft.description,
            visibility: draft.visibility,
            combine: draft.combine,
            timeoutSeconds: draft.timeoutSeconds,
            ...(draft.kind === 'query'
              ? {
                  refreshSeconds: draft.refreshSeconds,
                  rowLimit: draft.rowLimit,
                }
              : {}),
          },
        });
      }
      if (sqlDirty) {
        await api(`/api/v1/queries/${draft.slug}/versions`, {
          method: 'POST',
          body: { sql: draft.sql, parameters: draft.parameters, note },
        });
      }
      setNote('');
      setSavedAt(new Date().toISOString());
      setQueryRevision((value) => value + 1);
      setVersionsRevision((value) => value + 1);
    } catch (error) {
      setSaveError(error as ApiError);
    } finally {
      setSaving(false);
    }
  }, [
    creating,
    dirty,
    draft,
    editor,
    metaDirty,
    note,
    router,
    saving,
    sqlDirty,
  ]);

  const store = async () => {
    if (!slug) return;
    setStoring(true);
    setStoreError(null);
    try {
      await api(`/api/v1/queries/${slug}/run`, {
        method: 'POST',
        body: { network, values: supplied },
      });
    } catch (error) {
      if (!(error as ApiError).details?.cancelled)
        setStoreError(error as ApiError);
    } finally {
      setStoring(false);
      setStoredRevision((value) => value + 1);
    }
  };

  /** Opens the form for the selected SQL, or says to select some first. */
  const startExtract = () => {
    const selection = sqlEditor.current?.selection();
    if (!selection?.text.trim()) {
      setExtracting(null);
      setExtractHint(
        'Select the SQL to reuse — a subquery, a CTE body, or an expression — then try again.',
      );
      return;
    }
    setExtractHint(null);
    setExtractError(null);
    setExtracting(selection);
  };

  /**
   * Saves the selection as a fragment and puts `{{> slug}}` in its place.
   * The query itself still has to be saved to use it.
   */
  const extract = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!extracting) return;
    setExtractError(null);
    const text = extracting.text.trim();
    const used = new Set(
      [...text.matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g)].map(
        (match) => match[1],
      ),
    );
    try {
      await api('/api/v1/queries', {
        method: 'POST',
        body: {
          slug: extractSlug,
          title: extractTitle || extractSlug,
          kind: 'fragment',
          visibility: draft.visibility,
          sql: text,
          parameters: draft.parameters.filter((entry) => used.has(entry.name)),
          note: `Taken out of ${draft.slug || 'a new query'}`,
        },
      });
      // Only replace what is still where it was selected.
      if (
        draft.sql.slice(extracting.start, extracting.end) === extracting.text
      ) {
        update(
          'sql',
          `${draft.sql.slice(0, extracting.start)}{{> ${extractSlug}}}${draft.sql.slice(extracting.end)}`,
        );
      }
      setExtracting(null);
      setExtractSlug('');
      setExtractTitle('');
      setExtractHint(
        `Saved as the fragment ${extractSlug}. Save this query to use it in place of the SQL it replaced.`,
      );
      setFragmentsRevision((value) => value + 1);
    } catch (error) {
      setExtractError((error as ApiError).message);
    }
  };

  const fork = async () => {
    if (!slug || !forkSlug) return;
    try {
      const { query: created } = await api<{ query: QueryRecord }>(
        `/api/v1/queries/${slug}/fork`,
        { method: 'POST', body: { slug: forkSlug } },
      );
      router.push(`/queries/${created.slug}`);
    } catch (error) {
      setSaveError(error as ApiError);
    }
  };

  const archive = async () => {
    if (!slug) return;
    try {
      await api(`/api/v1/queries/${slug}`, { method: 'DELETE' });
      router.push('/queries');
    } catch (error) {
      setSaveError(error as ApiError);
    }
  };

  const completions = useMemo<Completion[]>(() => {
    const items: Completion[] = [
      ...KEYWORDS.map((label) => ({ label, kind: 'keyword' as const })),
      ...FUNCTIONS.map((label) => ({
        label,
        kind: 'function' as const,
        insert: `${label}(|)`,
      })),
      {
        label: 'source',
        kind: 'placeholder',
        detail: 'text: the data source',
        insert: 'source}}',
      },
      ...lists.map((list) => ({
        label: `list:${list.name}`,
        kind: 'placeholder' as const,
        detail: `${list.type}[]`,
        insert: `list:${list.name}}}`,
      })),
      ...draft.parameters.map((parameter) => ({
        label: parameter.name,
        kind: 'placeholder' as const,
        detail: parameter.type,
        insert: `${parameter.name}}}`,
      })),
      ...fragments
        .filter((fragment) => fragment.slug !== draft.slug)
        .map((fragment) => ({
          label: `> ${fragment.slug}`,
          kind: 'fragment' as const,
          detail: fragment.expression ? 'fragment · value' : 'fragment',
          insert: fragment.arguments?.length
            ? `> ${fragment.slug}(|${fragment.arguments.join(', ')})}}`
            : `> ${fragment.slug}}}`,
        })),
    ];
    for (const table of schema) {
      items.push({ label: table.name, kind: 'table', detail: table.kind });
    }
    const seen = new Set<string>();
    for (const table of schema) {
      for (const column of table.columns) {
        if (seen.has(column.name)) continue;
        seen.add(column.name);
        items.push({ label: column.name, kind: 'column', detail: column.type });
      }
    }
    return items;
  }, [draft.parameters, draft.slug, fragments, lists, schema]);

  const columnsByTable = useMemo(
    () =>
      new Map(
        schema.map((table) => [
          table.name,
          table.columns.map((column) => column.name),
        ]),
      ),
    [schema],
  );

  if (loadError) {
    return (
      <main className="studio-page">
        <ErrorBox error={loadError} />
        <p>
          <Link href="/queries">Back to queries</Link>
        </p>
      </main>
    );
  }
  if (!creating && !query) {
    return (
      <main className="studio-page">
        <p className="studio-muted">Loading…</p>
      </main>
    );
  }
  if (creating && user === null) {
    return (
      <main className="studio-page">
        <p>
          Writing queries needs the editor password.{' '}
          <Link href="/login?next=/queries/new">Unlock editing</Link>
        </p>
      </main>
    );
  }

  const readOnly = !editor || Boolean(query?.archivedAt);
  const missing = undeclared(draft.sql, draft.parameters);
  const selected =
    versions.find((version) => version.version === selectedVersion) ?? null;
  const publicUrl = slug ? `/api/v1/queries/${slug}/results` : null;

  const hasStored = !creating && draft.kind === 'query';
  // A run of this query in progress elsewhere — the scheduler's, say.
  const storedRunning = Boolean(
    stored?.networks.some((entry) => entry.lastAttempt?.status === 'running'),
  );
  const lastRun = stored?.networks
    .filter((entry) => entry.finishedAt)
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0];
  const runFailed = stored?.networks.some(
    (entry) => entry.lastAttempt?.status === 'failed',
  );
  const runStale = stored?.networks.some((entry) => entry.stale);
  const code = codeOf(draft.sql);
  const tables = schema
    .map((table) => table.name)
    .filter((name) => new RegExp(`\\b${name}\\b`, 'i').test(code));
  const usedFragments = [
    ...new Set(
      [...code.matchAll(/\{\{\s*>\s*([a-z0-9][a-z0-9-]*)/g)].map(
        (match) => match[1],
      ),
    ),
  ];
  const openChart = tab.startsWith('chart:')
    ? (charts?.find((entry) => entry.id === tab.slice(6)) ?? null)
    : null;
  const savedChart = (chart: Saved) => {
    setCharts((list) =>
      list?.some((entry) => entry.id === chart.id)
        ? list.map((entry) => (entry.id === chart.id ? chart : entry))
        : [...(list ?? []), chart],
    );
    setTab(`chart:${chart.id}`);
  };

  return (
    <main
      className={[
        'studio-page workbench',
        editor ? '' : 'reader',
        editor && schemaOpen ? '' : 'no-schema',
        aboutOpen && !creating ? '' : 'no-about',
      ].join(' ')}
    >
      {editor && schemaOpen && (
        <SchemaPanel
          schema={schema}
          status={schemaStatus}
          fragments={fragments}
          lists={lists}
          onInsert={(text) => sqlEditor.current?.insert(text)}
        />
      )}

      <section className="workbench-main">
        <header className="workbench-head">
          <div className="workbench-title">
            {readOnly ? (
              <h1>{draft.title}</h1>
            ) : (
              <input
                className="title-input"
                value={draft.title}
                placeholder="Untitled query"
                aria-label="Title"
                onChange={(event) => {
                  update('title', event.target.value);
                  if (creating && !slugTouched) {
                    update('slug', slugify(event.target.value));
                  }
                }}
              />
            )}
            <div className="meta-chips">
              {creating ? (
                <>
                  <label className="inline-field">
                    <span>/queries/</span>
                    <input
                      value={draft.slug}
                      aria-label="Slug"
                      placeholder="slug"
                      onChange={(event) => {
                        setSlugTouched(true);
                        update('slug', event.target.value);
                      }}
                    />
                  </label>
                  <label className="chip">
                    <Shapes size={13} aria-hidden="true" />
                    <select
                      value={draft.kind}
                      aria-label="Kind"
                      onChange={(event) => {
                        const kind = event.target.value as Kind;
                        update('kind', kind);
                        if (kind === 'fragment') update('refreshSeconds', null);
                      }}
                    >
                      <option value="query">Query</option>
                      <option value="fragment">Fragment</option>
                    </select>
                  </label>
                </>
              ) : (
                <>
                  <code className="chip mono" title="Slug">
                    {draft.slug}
                  </code>
                  {isFragment && (
                    <span className="chip">
                      <Puzzle size={13} aria-hidden="true" /> Fragment
                    </span>
                  )}
                </>
              )}
              <label className="chip" title="Who can see it">
                {draft.visibility === 'private' ? (
                  <Lock size={13} aria-hidden="true" />
                ) : (
                  <Globe size={13} aria-hidden="true" />
                )}
                <select
                  value={draft.visibility}
                  disabled={readOnly}
                  aria-label="Visibility"
                  onChange={(event) =>
                    update('visibility', event.target.value as Visibility)
                  }
                >
                  <option value="private">Private</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="public">Public</option>
                </select>
              </label>
              {draft.kind === 'query' && (
                <>
                  <label className="chip" title="Scheduled refresh">
                    <Timer size={13} aria-hidden="true" />
                    <select
                      value={draft.refreshSeconds ?? ''}
                      disabled={readOnly}
                      aria-label="Refresh"
                      onChange={(event) =>
                        update(
                          'refreshSeconds',
                          event.target.value
                            ? Number(event.target.value)
                            : null,
                        )
                      }
                    >
                      {REFRESH_OPTIONS.map((option) => (
                        <option key={option.label} value={option.value ?? ''}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label
                    className="chip"
                    title="With every data source selected: stack their rows, or show it per source only"
                  >
                    <Layers size={13} aria-hidden="true" />
                    <select
                      value={draft.combine}
                      disabled={readOnly}
                      aria-label="All data sources"
                      onChange={(event) =>
                        update('combine', event.target.value as Combine)
                      }
                    >
                      <option value="concat">All sources: stacked</option>
                      <option value="hidden">Per source only</option>
                    </select>
                  </label>
                </>
              )}
              {lastRun && (
                <button
                  type="button"
                  className={`chip status ${runFailed ? 'failed' : runStale ? 'stale' : 'fresh'}`}
                  title={`${runFailed ? 'The last run failed' : runStale ? 'Stale: its inputs changed since' : 'Up to date'} · finished ${when(lastRun.finishedAt)}`}
                  onClick={() => {
                    setTab('results');
                    setResultMode('stored');
                  }}
                >
                  <Clock size={13} aria-hidden="true" />
                  Last run {ago(lastRun.finishedAt)}
                  {lastRun.durationMs !== null &&
                    ` in ${took(lastRun.durationMs)}`}
                </button>
              )}
              {query?.current && (
                <span
                  className="chip quiet"
                  title={`Saved ${when(query.current.createdAt)}`}
                >
                  v{query.current.version}
                  {query.current.createdBy && ` · ${query.current.createdBy}`}
                  {` · ${ago(query.current.createdAt)}`}
                </span>
              )}
              {query?.forkedFrom && (
                <Link
                  className="chip quiet"
                  href={`/queries/${query.forkedFrom}`}
                >
                  <GitFork size={13} aria-hidden="true" /> {query.forkedFrom}
                </Link>
              )}
              {query?.archivedAt && <span className="chip warn">Archived</span>}
            </div>
          </div>
          <div className="workbench-actions">
            {query && slug && (
              <ShareButton
                what="query"
                visibility={query.visibility}
                plainPath={`/queries/${slug}`}
                path={() =>
                  openChart
                    ? `/queries/${slug}?tab=charts&chart=${openChart.id}`
                    : `/queries/${slug}`
                }
                viewLabel={
                  openChart ? `the chart “${openChart.title}” open` : undefined
                }
                canEdit={editor && !query.archivedAt}
                onVisibility={async (visibility) => {
                  const { query: updated } = await api<{
                    query: QueryRecord;
                  }>(`/api/v1/queries/${slug}`, {
                    method: 'PATCH',
                    body: { visibility },
                  });
                  setQuery(updated);
                  setDraft((current) => ({ ...current, visibility }));
                }}
              />
            )}
            {editor && !query?.archivedAt && (
              <>
                {dirty && !creating && (
                  <span className="dirty-mark">
                    Unsaved changes
                    {isFragment &&
                      sqlDirty &&
                      reruns > 0 &&
                      ` · saving reruns ${reruns} quer${reruns === 1 ? 'y' : 'ies'}`}
                  </span>
                )}
                {savedAt && !dirty && (
                  <span className="studio-muted">Saved</span>
                )}
                <input
                  className="studio-input note-input"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder={creating ? 'Note (optional)' : 'What changed?'}
                  aria-label="Version note"
                />
                <button
                  type="button"
                  className="studio-button primary"
                  disabled={!dirty || saving || !draft.title || !draft.slug}
                  onClick={() => void save()}
                  title="Cmd/Ctrl+S"
                >
                  <Save size={14} aria-hidden="true" />
                  {saving ? 'Saving…' : creating ? 'Create' : 'Save'}
                </button>
              </>
            )}
            {!creating && (
              <button
                type="button"
                className="studio-icon-button"
                aria-pressed={aboutOpen}
                title={aboutOpen ? 'Hide the details' : 'Show the details'}
                aria-label="About this query"
                onClick={() =>
                  setPreference('arrakis.workbench.about', !aboutOpen)
                }
              >
                <PanelRight size={15} aria-hidden="true" />
              </button>
            )}
            {editor && !creating && !query?.archivedAt && (
              <div className="menu-anchor">
                <button
                  type="button"
                  className="studio-icon-button"
                  aria-label="More"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen(!menuOpen)}
                >
                  <MoreHorizontal size={15} aria-hidden="true" />
                </button>
                {menuOpen && (
                  <div className="menu">
                    <span className="inline-field">
                      <GitFork size={14} aria-hidden="true" />
                      <input
                        className="studio-input"
                        value={forkSlug}
                        placeholder="new-slug"
                        aria-label="Slug for the fork"
                        onChange={(event) => setForkSlug(event.target.value)}
                      />
                      <button
                        type="button"
                        className="studio-button"
                        disabled={!forkSlug}
                        onClick={() => void fork()}
                      >
                        Fork
                      </button>
                    </span>
                    {confirmArchive ? (
                      <span className="inline-field">
                        <span>Archive this query? Its history is kept.</span>
                        <button
                          type="button"
                          className="studio-button danger"
                          onClick={() => void archive()}
                        >
                          Archive
                        </button>
                        <button
                          type="button"
                          className="studio-button"
                          onClick={() => setConfirmArchive(false)}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="studio-button"
                        onClick={() => setConfirmArchive(true)}
                      >
                        <Archive size={13} aria-hidden="true" /> Archive
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </header>

        <ErrorBox error={saveError} />

        {editor && isFragment && sqlDirty && dependents && <details className="fragment-impact studio-card">
          <summary>Change impact: {dependents.length} dependent {dependents.length === 1 ? 'item' : 'items'}</summary>
          <p className="studio-muted">Saving a new fragment version makes dependent stored results stale. Scheduled queries will rerun.</p>
          {dependents.length === 0 ? <p>No dependent queries or fragments.</p> : <ul>{dependents.map((entry) => <li key={entry.slug}><Link href={`/queries/${entry.slug}`}>{entry.title}</Link> {entry.direct ? '(direct)' : '(through another fragment)'}{entry.dashboards.length > 0 && <> · dashboards: {entry.dashboards.map((dashboard, index) => <span key={dashboard.slug}>{index > 0 && ', '}<Link href={`/dashboards/${dashboard.slug}`}>{dashboard.title}</Link></span>)}</>}</li>)}</ul>}
        </details>}

        <section id="query-editor" className="card editor-card" aria-label="Query editor">
          <header className="card-head">
            <h2>
              Query editor <HelpTip topic="templates" />
            </h2>
            <div className="card-tools">
              <a className="tool labelled" href="#query-results">Results &amp; charts ↓</a>
              {editor && (
                <button
                  type="button"
                  className="tool labelled"
                  aria-pressed={schemaOpen}
                  title={schemaOpen ? 'Hide the schema' : 'Show the schema'}
                  aria-label="Schema"
                  onClick={() =>
                    setPreference('arrakis.workbench.schema', !schemaOpen)
                  }
                >
                  <PanelLeft size={15} aria-hidden="true" />
                  Schema
                </button>
              )}
              {editor && !readOnly && (
                <button
                  type="button"
                  className="tool"
                  onClick={format}
                  title="Format SQL (Shift+Alt+F)"
                  aria-label="Format SQL"
                >
                  <WandSparkles size={15} aria-hidden="true" />
                </button>
              )}
              {editor && !readOnly && (
                <button
                  type="button"
                  className="tool labelled"
                  onClick={startExtract}
                  title="Save the selected SQL as a reusable fragment"
                >
                  <Puzzle size={14} aria-hidden="true" />
                  Selection to fragment
                </button>
              )}
              {!creating && (
                <button
                  type="button"
                  className="tool"
                  title="Versions"
                  aria-label="Versions"
                  onClick={() => setTab('versions')}
                >
                  <History size={15} aria-hidden="true" />
                </button>
              )}
            </div>
          </header>
          {extractHint && (
            <p className="studio-muted extract-hint">{extractHint}</p>
          )}
          {extracting && (
            <ExtractForm
              text={extracting.text}
              slug={extractSlug}
              title={extractTitle}
              error={extractError}
              onSlug={setExtractSlug}
              onTitle={setExtractTitle}
              onSubmit={(event) => void extract(event)}
              onCancel={() => setExtracting(null)}
            />
          )}

          <SqlEditor
            ref={sqlEditor}
            label="SQL"
            value={draft.sql}
            onChange={(sql) => update('sql', sql)}
            onRun={() => void run()}
            onSave={() => void save()}
            onFormat={format}
            onSelectionChange={setSelection}
            readOnly={readOnly}
            completions={completions}
            columns={columnsByTable}
            height={readOnly ? 260 : 340}
          />
          <div className="editor-foot">
            {networks.length > 1 || network !== 'all' ? (
              <fieldset className="network-switch">
                <legend className="sr-only">Data source</legend>
                {networks.length > 1 && (
                  <button
                    type="button"
                    aria-pressed={network === 'all'}
                    className={network === 'all' ? 'active' : ''}
                    onClick={() => setNetwork('all')}
                  >
                    All
                  </button>
                )}
                {networks.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    aria-pressed={network === entry.id}
                    className={
                      network === entry.id ||
                      (networks.length === 1 && network === 'all')
                        ? 'active'
                        : ''
                    }
                    onClick={() => setNetwork(entry.id)}
                  >
                    {entry.label}
                  </button>
                ))}
              </fieldset>
            ) : null}
            <div className="param-chips">
              {draft.parameters.map((parameter) => (
                <label key={parameter.name} className="chip param">
                  <span>{parameter.name}</span>
                  <input
                    value={values[parameter.name] ?? ''}
                    placeholder={
                      parameter.default === undefined ||
                      parameter.default === null
                        ? 'value'
                        : String(parameter.default as string)
                    }
                    aria-label={`Value of ${parameter.name}`}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [parameter.name]: event.target.value,
                      }))
                    }
                  />
                </label>
              ))}
              {!readOnly && missing.length > 0 && (
                <button
                  type="button"
                  className="chip warn"
                  onClick={() => setParamsOpen(true)}
                >
                  <Wand2 size={13} aria-hidden="true" />
                  {missing.map((name) => `{{${name}}}`).join(', ')} undeclared
                </button>
              )}
              {(!readOnly || draft.parameters.length > 0) && (
                <button
                  type="button"
                  className="chip ghost"
                  aria-expanded={paramsOpen}
                  title="Parameters: names, types and defaults"
                  onClick={() => setParamsOpen(!paramsOpen)}
                >
                  <Settings2 size={13} aria-hidden="true" />
                  {draft.parameters.length ? 'Parameters' : 'Add a parameter'}
                </button>
              )}
            </div>
            <span className="results-spacer" />
            {editor && (
              <div className="split-button menu-anchor">
                {running ? (
                  <button
                    type="button"
                    className="studio-button primary cancel-run"
                    onClick={() => void cancelRun('preview')}
                    disabled={cancelling}
                    title="Stop this run"
                  >
                    <Square size={12} aria-hidden="true" fill="currentColor" />
                    {cancelling ? 'Cancelling…' : 'Cancel'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="studio-button primary"
                    onClick={() => void run()}
                    title={
                      selection.trim()
                        ? 'Run only the selected SQL, storing nothing (Cmd/Ctrl+Enter)'
                        : 'Run and preview, storing nothing (Cmd/Ctrl+Enter)'
                    }
                  >
                    <Play size={14} aria-hidden="true" />
                    {selection.trim() ? 'Run selection' : 'Run'}
                  </button>
                )}
                {!running && (
                  <button
                    type="button"
                    className="studio-button primary caret"
                    aria-label="More ways to run"
                    aria-expanded={runMenu}
                    onClick={() => setRunMenu(!runMenu)}
                  >
                    <ChevronDown size={14} aria-hidden="true" />
                  </button>
                )}
                {runMenu && (
                  <div className="menu right">
                    <button
                      type="button"
                      onClick={() => {
                        setRunMenu(false);
                        void run();
                      }}
                    >
                      <Play size={13} aria-hidden="true" />
                      <span>
                        {selection.trim() ? 'Run selection' : 'Run'}
                        <small>Preview up to 10,000 rows; nothing stored</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRunMenu(false);
                        void run('plan');
                      }}
                    >
                      <Route size={13} aria-hidden="true" />
                      <span>
                        Explain
                        <small>
                          How the database would run it, without running it
                        </small>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRunMenu(false);
                        void run('analyze');
                      }}
                    >
                      <Timer size={13} aria-hidden="true" />
                      <span>
                        Explain and measure
                        <small>
                          Runs it, and says where the time went (EXPLAIN
                          ANALYZE)
                        </small>
                      </span>
                    </button>
                    {hasStored && !query?.archivedAt && (
                      <button
                        type="button"
                        disabled={storing || sqlDirty}
                        onClick={() => {
                          setRunMenu(false);
                          setTab('results');
                          setResultMode('stored');
                          void store();
                        }}
                      >
                        <Database size={13} aria-hidden="true" />
                        <span>
                          Run and store
                          <small>
                            {sqlDirty
                              ? 'Save first: stored results come from saved versions'
                              : 'Replace the stored result its charts are drawn from'}
                          </small>
                        </span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          {paramsOpen && (
            <ParametersPanel
              parameters={draft.parameters}
              onChange={(parameters) => update('parameters', parameters)}
              readOnly={readOnly}
              missing={missing}
              values={values}
              onValues={setValues}
            />
          )}
        </section>

        <section id="query-results" className="card results-card" aria-label="Query results">
          <div className="result-tabs" role="tablist" aria-label="Results">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'results'}
              onClick={() => setTab('results')}
            >
              <Table2 size={14} aria-hidden="true" /> Query results
            </button>
            {charts?.map((chart) => {
              const Icon = TYPE_ICONS[chart.type];
              return (
                <button
                  key={chart.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === `chart:${chart.id}`}
                  title={chart.title}
                  onClick={() => setTab(`chart:${chart.id}`)}
                >
                  <Icon size={14} aria-hidden="true" />
                  <span>{chart.title}</span>
                </button>
              );
            })}
            {!creating && (
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'versions'}
                onClick={() => setTab('versions')}
              >
                <History size={14} aria-hidden="true" /> Versions
              </button>
            )}
            <span className="results-spacer" />
            {editor && hasStored && !query?.archivedAt && (
              <button
                type="button"
                role="tab"
                className="new-chart"
                aria-selected={tab === 'new'}
                onClick={() => setTab('new')}
              >
                <Plus size={14} aria-hidden="true" /> New chart
              </button>
            )}
          </div>

          <div className="workbench-jump"><a href="#query-editor">↑ Back to SQL</a></div>
          <div className="workbench-panel" role="tabpanel">
            {tab === 'results' && (
              <>
                {hasStored && (
                  <div className="result-mode">
                    <fieldset className="segmented">
                      <legend className="sr-only">Which result</legend>
                      <button
                        type="button"
                        aria-pressed={resultMode === 'stored'}
                        onClick={() => setResultMode('stored')}
                      >
                        Stored result
                      </button>
                      <button
                        type="button"
                        aria-pressed={resultMode === 'preview'}
                        onClick={() => setResultMode('preview')}
                      >
                        Preview
                      </button>
                    </fieldset>
                    <HelpTip topic="results" />
                  </div>
                )}
                {hasStored && resultMode === 'stored' ? (
                  <>
                    <div className="stored-head">
                      {stored?.networks.map((entry) => (
                        <span
                          key={entry.id}
                          className={`badge ${entry.status}${entry.stale ? ' warn' : ''}`}
                          title={entry.lastAttempt?.error ?? undefined}
                        >
                          {entry.id}: {entry.status}
                          {entry.status === 'ready' &&
                            ` · ${entry.rowCount?.toLocaleString()} rows · ${when(entry.finishedAt)}`}
                          {entry.stale && ' · stale'}
                          {entry.lastAttempt?.status === 'failed' &&
                            ` · last run failed`}
                        </span>
                      ))}
                      <span className="results-spacer" />
                      <button
                        type="button"
                        className="studio-button"
                        onClick={() => setStoredRevision((value) => value + 1)}
                      >
                        <RefreshCw size={13} aria-hidden="true" /> Reload
                      </button>
                      {editor &&
                        !query?.archivedAt &&
                        (storing || storedRunning ? (
                          <button
                            type="button"
                            className="studio-button cancel-run"
                            disabled={cancelling}
                            title="Stop every run of this query in progress"
                            onClick={() => void cancelRun('stored')}
                          >
                            <Square
                              size={11}
                              aria-hidden="true"
                              fill="currentColor"
                            />
                            {cancelling ? 'Cancelling…' : 'Cancel run'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="studio-button primary"
                            disabled={sqlDirty}
                            title={
                              sqlDirty
                                ? 'Save first: stored results come from saved versions'
                                : undefined
                            }
                            onClick={() => void store()}
                          >
                            <Play size={13} aria-hidden="true" />
                            Run and store now
                          </button>
                        ))}
                    </div>
                    {stored?.networks.some(
                      (entry) => entry.lastAttempt?.error,
                    ) && (
                      <ul className="attempt-errors">
                        {stored.networks
                          .filter((entry) => entry.lastAttempt?.error)
                          .map((entry) => (
                            <li key={entry.id} className="studio-error">
                              {entry.id}: {entry.lastAttempt?.error}
                            </li>
                          ))}
                      </ul>
                    )}
                    <ErrorBox error={storeError} />
                    <ErrorBox error={storedError} />
                    {stored && stored.columns.length > 0 && (
                      <ResultsTable
                        columns={stored.columns}
                        rows={stored.rows}
                        name={`${draft.slug}-v${stored.version}`}
                      />
                    )}
                    {stored && !stored.columns.length && (
                      <p className="studio-muted">
                        Nothing stored yet for these parameters.
                        {draft.refreshSeconds
                          ? ' The scheduler will run it shortly.'
                          : editor
                            ? ' Run and store it, or set a refresh interval.'
                            : ''}
                      </p>
                    )}
                    {publicUrl && draft.visibility !== 'private' && (
                      <p className="studio-muted api-hint">
                        JSON:{' '}
                        <code>
                          {publicUrl}?network={network}
                        </code>
                        <button
                          type="button"
                          className="studio-icon-button"
                          aria-label="Copy the API address"
                          onClick={() =>
                            void navigator.clipboard?.writeText(
                              `${window.location.origin}${publicUrl}?network=${network}`,
                            )
                          }
                        >
                          <Copy size={12} aria-hidden="true" />
                        </button>
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <ErrorBox error={previewError} />
                    {preview && previewOf.explain && (
                      <QueryPlan
                        preview={preview}
                        analyze={previewOf.explain === 'analyze'}
                        selection={previewOf.selection}
                      />
                    )}
                    {preview && !previewOf.explain && (
                      <ResultsTable
                        columns={preview.columns}
                        rows={preview.rows}
                        name={draft.slug || 'preview'}
                        footer={
                          <>
                            {previewOf.selection && (
                              <span className="badge">Selection only</span>
                            )}
                            {preview.truncated && (
                              <span className="badge warn">
                                First {preview.rowCount.toLocaleString()} rows
                              </span>
                            )}
                            {preview.networks.map((entry) => (
                              <span
                                key={entry.id}
                                className={`badge${entry.error ? ' warn' : ''}`}
                                title={entry.error}
                              >
                                {entry.id}:{' '}
                                {entry.error
                                  ? 'failed'
                                  : `${entry.rowCount.toLocaleString()} in ${entry.durationMs} ms`}
                              </span>
                            ))}
                          </>
                        }
                      />
                    )}
                    {!preview && !previewError && (
                      <p className="studio-muted">
                        {running
                          ? 'Running…'
                          : cancelled
                            ? 'Run cancelled.'
                            : 'Run the SQL to preview up to 10,000 rows. Nothing is stored.'}
                      </p>
                    )}
                  </>
                )}
              </>
            )}

            {tab.startsWith('chart:') &&
              slug &&
              (openChart ? (
                <VisualizationsPanel
                  key={openChart.id}
                  slug={slug}
                  editor={editor}
                  network={network}
                  chart={openChart}
                  hosts={dashboards}
                  onSaved={savedChart}
                  onDeleted={(id) => {
                    setCharts((list) =>
                      (list ?? []).filter((entry) => entry.id !== id),
                    );
                    setTab('results');
                  }}
                />
              ) : (
                <p className="studio-muted">
                  {charts === null
                    ? 'Loading…'
                    : 'This chart no longer exists.'}
                </p>
              ))}

            {tab === 'new' && slug && (
              <VisualizationsPanel
                key="new"
                slug={slug}
                editor={editor}
                network={network}
                chart={null}
                hosts={dashboards}
                onSaved={savedChart}
                onDeleted={() => setTab('results')}
              />
            )}

            {tab === 'versions' && (
              <VersionsPanel
                versions={versions}
                selected={selected}
                onSelect={setSelectedVersion}
                draftSql={draft.sql}
                sqlDirty={sqlDirty}
                readOnly={readOnly}
                onLoad={(version) => {
                  update('sql', version.sql);
                  update('parameters', version.parameters);
                }}
              />
            )}
          </div>
        </section>
        {editor && isFragment && slug && !query?.archivedAt && <FragmentTests slug={slug} sql={draft.sql} parameters={draft.parameters} network={network === 'all' && networks.length === 1 ? networks[0].id : network} />}
      </section>

      {aboutOpen && !creating && (
        <AboutPanel
          draft={draft}
          readOnly={readOnly}
          editor={editor}
          onUpdate={update}
          tables={tables}
          usedFragments={usedFragments}
          dependents={isFragment ? dependents : null}
          dashboards={hasStored ? dashboards : null}
          versions={versions}
          onOpenVersion={(version) => {
            setTab('versions');
            setSelectedVersion(version);
          }}
        />
      )}
    </main>
  );
}

/** A plan, as Postgres writes it: one block per data source. */
function QueryPlan({
  preview,
  analyze,
  selection,
}: {
  preview: Preview;
  analyze: boolean;
  selection: boolean;
}) {
  const stacked = preview.columns[0]?.name === 'network';
  const blocks = new Map<string, string[]>();
  for (const row of preview.rows) {
    const key = stacked ? asText(row[0]) : '';
    const text = asText(row[stacked ? 1 : 0] ?? '');
    blocks.set(key, [...(blocks.get(key) ?? []), text]);
  }
  return (
    <div className="query-plan">
      <p className="studio-muted">
        {analyze
          ? 'The plan, with what each step took when the query ran.'
          : 'How the database would run the query; nothing was run.'}{' '}
        Read it from the most indented line outwards.
        {selection && ' Of the selection only.'}
      </p>
      {[...blocks].map(([network, lines]) => (
        <section key={network}>
          {network && <h4>{network}</h4>}
          <pre>{lines.join('\n')}</pre>
        </section>
      ))}
      {preview.networks
        .filter((entry) => entry.error)
        .map((entry) => (
          <p key={entry.id} className="studio-error">
            {entry.id}: {entry.error}
          </p>
        ))}
    </div>
  );
}

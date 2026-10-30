'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Clock,
  Copy,
  GitFork,
  History,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Wand2,
} from 'lucide-react';

import {
  api,
  ApiError,
  PARAMETER_TYPES,
  type Combine,
  type Kind,
  type Network,
  type ParameterDefinition,
  type ParameterType,
  type Preview,
  type QueryRecord,
  type QuerySummary,
  type QueryVersion,
  type ResultPage,
  type SchemaTable,
  type Visibility,
} from '../api';
import { diffLines } from '../diff';
import { ResultsTable } from '../results-table';
import { useSession } from '../session';
import {
  SqlEditor,
  type Completion,
  type SqlEditorHandle,
} from '../sql-editor';
import { FUNCTIONS, KEYWORDS } from '../sql-highlight';

/**
 * Where a query is written, run, saved and read back.
 *
 * One component for every case: a new query, an existing one being edited, and
 * an existing one being read by someone who cannot edit. What differs is which
 * controls are shown; the SQL, results and history read the same way for all.
 */

type Draft = {
  slug: string;
  title: string;
  description: string;
  kind: Kind;
  visibility: Visibility;
  combine: Combine;
  refreshSeconds: number | null;
  sql: string;
  parameters: ParameterDefinition[];
};

type Tab = 'preview' | 'stored' | 'versions';

const REFRESH_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: 'Not scheduled', value: null },
  { label: 'Every minute', value: 60 },
  { label: 'Every 5 minutes', value: 300 },
  { label: 'Every 15 minutes', value: 900 },
  { label: 'Hourly', value: 3_600 },
  { label: 'Every 6 hours', value: 21_600 },
  { label: 'Daily', value: 86_400 },
];

const SYSTEM_NAMES = new Set(['network', 'exits']);

const STARTER_SQL = `-- Each run reads one network, or every network with "All".
-- {{network}} and {{exits}} are filled in for you; {{> slug}} inlines a fragment.
SELECT
  account.chain_key AS address,
  account.published_block,
  {{block_time(account.published_block)}} AS deployed_at
FROM account
ORDER BY account.published_block DESC
LIMIT 100`;

function emptyDraft(): Draft {
  return {
    slug: '',
    title: '',
    description: '',
    kind: 'query',
    visibility: 'private',
    combine: 'concat',
    refreshSeconds: null,
    sql: STARTER_SQL,
    parameters: [],
  };
}

function draftOf(query: QueryRecord): Draft {
  return {
    slug: query.slug,
    title: query.title,
    description: query.description,
    kind: query.kind,
    visibility: query.visibility,
    combine: query.combine,
    refreshSeconds: query.refreshSeconds,
    sql: query.current?.sql ?? '',
    parameters: query.current?.parameters ?? [],
  };
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** `{{name}}` placeholders in code that are neither declared nor built in. */
function undeclared(sql: string, declared: ParameterDefinition[]): string[] {
  const known = new Set(declared.map((parameter) => parameter.name));
  const found = new Set<string>();
  // Comments and strings are stripped first so a commented-out placeholder
  // does not become a parameter.
  const code = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'(?:[^']|'')*'/g, "''");
  for (const match of code.matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g)) {
    const name = match[1];
    if (!known.has(name) && !SYSTEM_NAMES.has(name)) found.add(name);
  }
  return [...found];
}

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

export function Workbench({ slug }: { slug: string | null }) {
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
  const [storeError, setStoreError] = useState<ApiError | null>(null);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(creating ? 'preview' : 'stored');
  const [schema, setSchema] = useState<SchemaTable[]>([]);
  const [schemaFilter, setSchemaFilter] = useState('');
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
        if (loaded.kind === 'fragment') setTab('preview');
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

  useEffect(() => {
    if (!editor) return;
    let live = true;
    api<{ queries: QuerySummary[] }>('/api/v1/queries?kind=fragment')
      .then(({ queries }) => live && setFragments(queries))
      .catch(() => live && setFragments([]));
    return () => {
      live = false;
    };
  }, [editor]);

  // The schema of one network: with "All", the first one's stands for the rest.
  const schemaNetwork = network === 'all' ? networks[0]?.id : network;
  useEffect(() => {
    if (!editor || !schemaNetwork) return;
    let live = true;
    api<{ tables: SchemaTable[] }>(
      `/api/v1/schema?network=${encodeURIComponent(schemaNetwork)}`,
    )
      .then(({ tables }) => live && setSchema(tables))
      .catch(() => live && setSchema([]));
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

  const showsStored = tab === 'stored' && query?.kind === 'query';
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

  const showsVersions = tab === 'versions';
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
      draft.refreshSeconds !== query.refreshSeconds);
  const dirty = creating || sqlDirty || metaDirty;

  const supplied = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const parameter of draft.parameters) {
      const value = values[parameter.name];
      if (value !== undefined && value !== '') out[parameter.name] = value;
    }
    return out;
  }, [draft.parameters, values]);

  const run = useCallback(async () => {
    if (!editor || running) return;
    setRunning(true);
    setTab('preview');
    setPreviewError(null);
    try {
      setPreview(
        await api<Preview>('/api/v1/run', {
          method: 'POST',
          body: {
            sql: draft.sql,
            parameters: draft.parameters,
            values: supplied,
            network,
          },
        }),
      );
    } catch (error) {
      setPreview(null);
      setPreviewError(error as ApiError);
    } finally {
      setRunning(false);
    }
  }, [draft.parameters, draft.sql, editor, network, running, supplied]);

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
            ...(draft.kind === 'query'
              ? { refreshSeconds: draft.refreshSeconds }
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
      setStoreError(error as ApiError);
    } finally {
      setStoring(false);
      setStoredRevision((value) => value + 1);
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
        label: 'network',
        kind: 'placeholder',
        detail: 'text',
        insert: 'network}}',
      },
      {
        label: 'exits',
        kind: 'placeholder',
        detail: 'bytea[]',
        insert: 'exits}}',
      },
      {
        label: 'block_time()',
        kind: 'placeholder',
        detail: 'timestamptz',
        insert: 'block_time(|)}}',
      },
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
          detail: 'fragment',
          insert: `> ${fragment.slug}}}`,
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
  }, [draft.parameters, draft.slug, fragments, schema]);

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

  const visibleTables = useMemo(() => {
    const needle = schemaFilter.trim().toLowerCase();
    if (!needle) return schema;
    return schema.filter(
      (table) =>
        table.name.toLowerCase().includes(needle) ||
        table.columns.some((column) =>
          column.name.toLowerCase().includes(needle),
        ),
    );
  }, [schema, schemaFilter]);

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

  return (
    <main className={`studio-page workbench${editor ? '' : ' reader'}`}>
      {editor && (
        <aside className="workbench-side" aria-label="Schema">
          <h2>Schema</h2>
          <input
            className="studio-input"
            type="search"
            placeholder="Filter tables and columns"
            value={schemaFilter}
            onChange={(event) => setSchemaFilter(event.target.value)}
            aria-label="Filter tables and columns"
          />
          <div className="schema-list">
            {visibleTables.map((table) => (
              <details
                key={`${table.schema}.${table.name}`}
                open={Boolean(schemaFilter.trim())}
              >
                <summary>
                  <button
                    type="button"
                    className="schema-name"
                    onClick={() => sqlEditor.current?.insert(table.name)}
                    title="Insert at cursor"
                  >
                    {table.name}
                  </button>
                  {table.kind === 'view' && <small>view</small>}
                </summary>
                <ul>
                  {table.columns.map((column) => (
                    <li key={column.name}>
                      <button
                        type="button"
                        onClick={() => sqlEditor.current?.insert(column.name)}
                        title="Insert at cursor"
                      >
                        {column.name}
                      </button>
                      <small>{column.type}</small>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
            {!schema.length && (
              <p className="studio-muted">Loading the schema…</p>
            )}
          </div>
          <h2>Fragments</h2>
          <ul className="fragment-list">
            {fragments.map((fragment) => (
              <li key={fragment.slug}>
                <button
                  type="button"
                  onClick={() =>
                    sqlEditor.current?.insert(`{{> ${fragment.slug}}}`)
                  }
                  title={fragment.title}
                >
                  {`{{> ${fragment.slug}}}`}
                </button>
              </li>
            ))}
            {!fragments.length && (
              <li className="studio-muted">
                None yet. Save a query as a fragment to reuse it.
              </li>
            )}
          </ul>
          <h2>Built in</h2>
          <ul className="fragment-list">
            {['{{network}}', '{{exits}}', '{{block_time(block)}}'].map(
              (text) => (
                <li key={text}>
                  <button
                    type="button"
                    onClick={() => sqlEditor.current?.insert(text)}
                  >
                    {text}
                  </button>
                </li>
              ),
            )}
          </ul>
        </aside>
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
            <p className="studio-muted workbench-meta">
              {creating ? (
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
              ) : (
                <>
                  <code>{draft.slug}</code>
                  {query?.current && <> · v{query.current.version}</>}
                  {query?.current?.createdBy && (
                    <> · saved by {query.current.createdBy}</>
                  )}
                  {query?.current && <> · {when(query.current.createdAt)}</>}
                  {query?.forkedFrom && (
                    <>
                      {' '}
                      · forked from{' '}
                      <Link href={`/queries/${query.forkedFrom}`}>
                        {query.forkedFrom}
                      </Link>
                    </>
                  )}
                  {query?.archivedAt && <> · archived</>}
                </>
              )}
            </p>
          </div>
          {editor && !query?.archivedAt && (
            <div className="workbench-actions">
              {dirty && !creating && (
                <span className="dirty-mark">Unsaved changes</span>
              )}
              {savedAt && !dirty && <span className="studio-muted">Saved</span>}
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
            </div>
          )}
        </header>

        <ErrorBox error={saveError} />

        <div className="workbench-settings">
          {creating && (
            <label className="studio-field compact">
              <span>Kind</span>
              <select
                value={draft.kind}
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
          )}
          <label className="studio-field compact">
            <span>Visibility</span>
            <select
              value={draft.visibility}
              disabled={readOnly}
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
              <label className="studio-field compact">
                <span>Refresh</span>
                <select
                  value={draft.refreshSeconds ?? ''}
                  disabled={readOnly}
                  onChange={(event) =>
                    update(
                      'refreshSeconds',
                      event.target.value ? Number(event.target.value) : null,
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
              <label className="studio-field compact">
                <span>All networks</span>
                <select
                  value={draft.combine}
                  disabled={readOnly}
                  onChange={(event) =>
                    update('combine', event.target.value as Combine)
                  }
                >
                  <option value="concat">Stack rows</option>
                  <option value="hidden">Per network only</option>
                </select>
              </label>
            </>
          )}
          <label className="studio-field grow">
            <span>Description</span>
            <input
              value={draft.description}
              disabled={readOnly}
              placeholder="What this query answers"
              onChange={(event) => update('description', event.target.value)}
            />
          </label>
        </div>

        <div className="workbench-toolbar">
          <fieldset className="network-switch">
            <legend className="sr-only">Network</legend>
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
          <span className="results-spacer" />
          {editor && (
            <button
              type="button"
              className="studio-button primary"
              onClick={() => void run()}
              disabled={running}
              title="Cmd/Ctrl+Enter"
            >
              <Play size={14} aria-hidden="true" />
              {running ? 'Running…' : 'Run'}
            </button>
          )}
        </div>

        <SqlEditor
          ref={sqlEditor}
          label="SQL"
          value={draft.sql}
          onChange={(sql) => update('sql', sql)}
          onRun={() => void run()}
          onSave={() => void save()}
          readOnly={readOnly}
          completions={completions}
          columns={columnsByTable}
          height={readOnly ? 260 : 340}
        />

        <section className="parameters" aria-label="Parameters">
          <div className="parameters-head">
            <h2>Parameters</h2>
            {!readOnly && missing.length > 0 && (
              <button
                type="button"
                className="studio-button"
                onClick={() =>
                  update('parameters', [
                    ...draft.parameters,
                    ...missing.map((name) => ({
                      name,
                      type: 'text' as ParameterType,
                    })),
                  ])
                }
              >
                <Wand2 size={13} aria-hidden="true" /> Declare{' '}
                {missing.map((name) => `{{${name}}}`).join(', ')}
              </button>
            )}
            {!readOnly && (
              <button
                type="button"
                className="studio-button"
                onClick={() =>
                  update('parameters', [
                    ...draft.parameters,
                    {
                      name: `param_${draft.parameters.length + 1}`,
                      type: 'text',
                    },
                  ])
                }
              >
                <Plus size={13} aria-hidden="true" /> Add
              </button>
            )}
          </div>
          {draft.parameters.length === 0 ? (
            <p className="studio-muted">
              None. Write <code>{'{{name}}'}</code> in the SQL to add one.
            </p>
          ) : (
            <table className="parameter-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col">Default</th>
                  <th scope="col">Value for this run</th>
                  {!readOnly && (
                    <th scope="col">
                      <span className="sr-only">Remove</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {draft.parameters.map((parameter, index) => {
                  const change = (patch: Partial<ParameterDefinition>) =>
                    update(
                      'parameters',
                      draft.parameters.map((entry, at) =>
                        at === index ? { ...entry, ...patch } : entry,
                      ),
                    );
                  return (
                    <tr key={index}>
                      <td>
                        <input
                          className="studio-input mono"
                          value={parameter.name}
                          disabled={readOnly}
                          aria-label="Parameter name"
                          onChange={(event) =>
                            change({ name: event.target.value })
                          }
                        />
                      </td>
                      <td>
                        <select
                          className="studio-input"
                          value={parameter.type}
                          disabled={readOnly}
                          aria-label="Parameter type"
                          onChange={(event) =>
                            change({
                              type: event.target.value as ParameterType,
                            })
                          }
                        >
                          {PARAMETER_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {type}
                            </option>
                          ))}
                        </select>
                        {parameter.type === 'enum' && (
                          <input
                            className="studio-input"
                            placeholder="option, option"
                            value={(parameter.options ?? []).join(', ')}
                            disabled={readOnly}
                            aria-label="Enum options"
                            onChange={(event) =>
                              change({
                                options: event.target.value
                                  .split(',')
                                  .map((option) => option.trim())
                                  .filter(Boolean),
                              })
                            }
                          />
                        )}
                      </td>
                      <td>
                        <input
                          className="studio-input"
                          value={
                            parameter.default === undefined ||
                            parameter.default === null
                              ? ''
                              : String(parameter.default as string)
                          }
                          disabled={readOnly}
                          placeholder="none"
                          aria-label="Parameter default"
                          onChange={(event) => {
                            const { default: _, ...rest } = parameter;
                            update(
                              'parameters',
                              draft.parameters.map((entry, at) =>
                                at === index
                                  ? event.target.value === ''
                                    ? rest
                                    : { ...rest, default: event.target.value }
                                  : entry,
                              ),
                            );
                          }}
                        />
                      </td>
                      <td>
                        <input
                          className="studio-input"
                          value={values[parameter.name] ?? ''}
                          placeholder="default"
                          aria-label={`Value of ${parameter.name}`}
                          onChange={(event) =>
                            setValues((current) => ({
                              ...current,
                              [parameter.name]: event.target.value,
                            }))
                          }
                        />
                      </td>
                      {!readOnly && (
                        <td>
                          <button
                            type="button"
                            className="studio-icon-button"
                            aria-label={`Remove ${parameter.name}`}
                            onClick={() =>
                              update(
                                'parameters',
                                draft.parameters.filter(
                                  (_, at) => at !== index,
                                ),
                              )
                            }
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <div className="workbench-tabs" role="tablist" aria-label="Results">
          {editor && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'preview'}
              onClick={() => setTab('preview')}
            >
              <Play size={13} aria-hidden="true" /> Preview
            </button>
          )}
          {!creating && draft.kind === 'query' && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'stored'}
              onClick={() => setTab('stored')}
            >
              <Clock size={13} aria-hidden="true" /> Stored result
            </button>
          )}
          {!creating && (
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'versions'}
              onClick={() => setTab('versions')}
            >
              <History size={13} aria-hidden="true" /> Versions
            </button>
          )}
        </div>

        <div className="workbench-panel" role="tabpanel">
          {tab === 'preview' && (
            <>
              <ErrorBox error={previewError} />
              {preview && (
                <ResultsTable
                  columns={preview.columns}
                  rows={preview.rows}
                  name={draft.slug || 'preview'}
                  footer={
                    <>
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
                          {entry.timebase === 'estimated' &&
                            ' · estimated time'}
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
                    : 'Run the SQL to preview up to 10,000 rows. Nothing is stored.'}
                </p>
              )}
            </>
          )}

          {tab === 'stored' && (
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
                    {entry.timebase === 'estimated' && ' · estimated time'}
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
                {editor && !query?.archivedAt && (
                  <button
                    type="button"
                    className="studio-button primary"
                    disabled={storing || sqlDirty}
                    title={
                      sqlDirty
                        ? 'Save first: stored results come from saved versions'
                        : undefined
                    }
                    onClick={() => void store()}
                  >
                    <Play size={13} aria-hidden="true" />
                    {storing ? 'Running…' : 'Run and store now'}
                  </button>
                )}
              </div>
              {stored?.networks.some((entry) => entry.lastAttempt?.error) && (
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
          )}

          {tab === 'versions' && (
            <div className="versions">
              <ol className="version-list">
                {versions.map((version) => (
                  <li key={version.id}>
                    <button
                      type="button"
                      aria-pressed={selectedVersion === version.version}
                      onClick={() =>
                        setSelectedVersion(
                          selectedVersion === version.version
                            ? null
                            : version.version,
                        )
                      }
                    >
                      <strong>v{version.version}</strong>
                      <span>{version.note || 'No note'}</span>
                      <small>
                        {version.createdBy ?? 'unknown'} ·{' '}
                        {when(version.createdAt)}
                      </small>
                    </button>
                  </li>
                ))}
              </ol>
              {selected && (
                <div className="version-diff">
                  <div className="version-diff-head">
                    <span>
                      v{selected.version} →{' '}
                      {sqlDirty ? 'your draft' : 'current'}
                    </span>
                    {!readOnly && (
                      <button
                        type="button"
                        className="studio-button"
                        onClick={() => {
                          update('sql', selected.sql);
                          update('parameters', selected.parameters);
                        }}
                      >
                        Load into editor
                      </button>
                    )}
                  </div>
                  <pre className="diff">
                    {diffLines(selected.sql, draft.sql).map((line, index) => (
                      <span key={index} className={`diff-${line.kind}`}>
                        {line.kind === 'added'
                          ? '+ '
                          : line.kind === 'removed'
                            ? '- '
                            : '  '}
                        {line.text}
                        {'\n'}
                      </span>
                    ))}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>

        {editor && !creating && !query?.archivedAt && (
          <div className="workbench-foot">
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
            <span className="results-spacer" />
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
      </section>
    </main>
  );
}

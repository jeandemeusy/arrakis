'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { FileUp, Link2, PackageOpen, Trash2 } from 'lucide-react';

import { api, ApiError } from '../../api';
import { diffLines } from '../../diff';
import { useNav } from '../../nav';
import { useSession } from '../../session';

type Installed = {
  name: string;
  dashboards: Array<{ slug: string; title: string }>;
  queries: number;
  charts: number;
};

type PlanItem = {
  kind: 'list' | 'query' | 'fragment' | 'chart' | 'dashboard';
  name: string;
  title: string;
  action: 'create' | 'update' | 'replace' | 'restore' | 'archive' | 'keep';
  from?: string | null;
  reason?: string;
  sql?: { before: string | null; after: string };
  refreshSeconds?: number | null;
  runsSql?: boolean;
};

type RetireItem = {
  kind: 'query' | 'fragment' | 'chart' | 'dashboard';
  name: string;
  title: string;
  reason?: string;
};

type Retirement = { archive: RetireItem[]; keep: RetireItem[] };

type Plan = {
  name: string;
  title: string;
  description: string;
  items: PlanItem[];
  conflicts: number;
  digest: string;
};

const ACTION_LABEL = {
  create: 'New',
  update: 'Update',
  replace: 'Replaces yours',
  restore: 'Restores archived',
  archive: 'Archived',
  keep: 'Kept',
} as const;

/** `3600` → "every hour", for a query's refresh schedule. */
function every(seconds: number | null | undefined): string {
  if (!seconds) return 'not scheduled';
  if (seconds % 86_400 === 0)
    return seconds === 86_400 ? 'every day' : `every ${seconds / 86_400} days`;
  if (seconds % 3_600 === 0)
    return seconds === 3_600 ? 'every hour' : `every ${seconds / 3_600} hours`;
  if (seconds % 60 === 0)
    return seconds === 60 ? 'every minute' : `every ${seconds / 60} minutes`;
  return `every ${seconds} s`;
}

/**
 * An item's SQL, as the import would leave it: the diff against what is here
 * when it changes something, the whole text when it is new.
 */
function PlanSql({ sql }: { sql: { before: string | null; after: string } }) {
  const changed = sql.before !== null && sql.before !== sql.after;
  const same = sql.before !== null && sql.before === sql.after;
  return (
    <details className="plan-detail">
      <summary>{same ? 'SQL, unchanged' : changed ? 'SQL changes' : 'SQL'}</summary>
      {changed ? (
        <pre className="diff">
          {diffLines(sql.before ?? '', sql.after).map((line, index) => (
            <span key={index} className={`diff-${line.kind}`}>
              {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
              {line.text}
            </span>
          ))}
        </pre>
      ) : (
        <pre className="diff">
          <span>{sql.after}</span>
        </pre>
      )}
    </details>
  );
}

/**
 * Bundles: dashboards with their charts and queries, as one file another
 * Arrakis made. Importing one, from a file or a URL, first shows what it would
 * create, update or replace; importing it creates ordinary saved queries and
 * charts, edited like any other. Any dashboard can be exported as a bundle
 * from its Share menu. Removing a bundle archives what it created, except
 * what something outside it still uses; a newer file of a bundle archives
 * what it dropped the same way.
 */
export function BundleSettings() {
  const { user } = useSession();
  const { dashboardsChanged } = useNav();
  const router = useRouter();
  const [installed, setInstalled] = useState<Installed[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [url, setUrl] = useState('');
  const [bundle, setBundle] = useState<unknown>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [replace, setReplace] = useState(false);
  const [publish, setPublish] = useState(false);
  const [busy, setBusy] = useState<'reading' | 'importing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{
    name: string;
    title: string;
    plan: Retirement | null;
    busy: boolean;
  } | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const askRemove = async (name: string, title: string) => {
    setError(null);
    setMessage(null);
    setRemoving({ name, title, plan: null, busy: true });
    try {
      const { plan } = await api<{ plan: Retirement }>(
        `/api/v1/bundles/${name}`,
      );
      setRemoving({ name, title, plan, busy: false });
    } catch (failure) {
      setRemoving(null);
      setError((failure as ApiError).message);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setRemoving({ ...removing, busy: true });
    try {
      const { report } = await api<{ report: Retirement }>(
        `/api/v1/bundles/${removing.name}`,
        { method: 'DELETE' },
      );
      setMessage(
        `${removing.title}: ${report.archive.length} archived${report.keep.length ? `, ${report.keep.length} kept because something else uses them` : ''}. Archived queries are listed under Queries → Show archived.`,
      );
      setRemoving(null);
      setRevision((value) => value + 1);
      dashboardsChanged();
    } catch (failure) {
      setRemoving({ ...removing, busy: false });
      setError((failure as ApiError).message);
    }
  };

  useEffect(() => {
    if (!user) return;
    let live = true;
    api<{ bundles: Installed[] }>('/api/v1/bundles')
      .then(({ bundles }) => live && setInstalled(bundles))
      .catch((failure: ApiError) => live && setError(failure.message));
    return () => {
      live = false;
    };
  }, [user, revision]);

  const preview = async (body: { bundle?: unknown; url?: string }) => {
    setBusy('reading');
    setError(null);
    setMessage(null);
    setPlan(null);
    setReplace(false);
    setPublish(false);
    try {
      const answer = await api<{ plan: Plan; bundle: unknown }>(
        '/api/v1/bundles/preview',
        { method: 'POST', body },
      );
      setPlan(answer.plan);
      setBundle(answer.bundle);
    } catch (failure) {
      setError((failure as ApiError).message);
    } finally {
      setBusy(null);
    }
  };

  const readFile = async (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size > 5 * 1024 * 1024) {
      setError('The bundle is larger than 5 MB');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await picked.text());
    } catch {
      setError(`${picked.name} is not JSON`);
      return;
    }
    await preview({ bundle: parsed });
  };

  const install = async () => {
    if (!plan || !bundle) return;
    setBusy('importing');
    setError(null);
    try {
      const { report } = await api<{
        report: {
          dashboard: string;
          created: string[];
          updated: string[];
          unchanged: string[];
          archived: string[];
        };
      }>('/api/v1/bundles', {
        method: 'POST',
        body: { bundle, replace, publish, digest: plan.digest },
      });
      setMessage(
        `${plan.title}: ${report.created.length} created, ${report.updated.length} updated, ${report.unchanged.length} unchanged${report.archived.length ? `, ${report.archived.length} archived` : ''}. Its queries are running now; charts fill in as their results are stored.${publish ? '' : ' What it created is private: only editors see it until you change its visibility.'}`,
      );
      setPlan(null);
      setBundle(null);
      setUrl('');
      setRevision((value) => value + 1);
      dashboardsChanged();
      router.push(`/dashboards/${report.dashboard}`);
    } catch (failure) {
      setError((failure as ApiError).message);
    } finally {
      setBusy(null);
    }
  };

  const PLURAL = {
    list: 'lists',
    query: 'queries',
    fragment: 'fragments',
    chart: 'charts',
    dashboard: 'dashboards',
  } as const;
  const counts = plan
    ? (['list', 'query', 'fragment', 'chart', 'dashboard'] as const)
        .map((kind) => {
          const n = plan.items.filter(
            (item) =>
              item.kind === kind &&
              item.action !== 'archive' &&
              item.action !== 'keep',
          ).length;
          return n ? `${n} ${n === 1 ? kind : PLURAL[kind]}` : null;
        })
        .filter(Boolean)
        .join(', ')
    : '';
  const queries = plan
    ? plan.items.filter(
        (item) => item.kind === 'query' && item.action !== 'archive' && item.action !== 'keep',
      )
    : [];
  const scheduled = queries.filter((item) => item.refreshSeconds).length;
  const sqlCharts = plan
    ? plan.items.filter((item) => item.runsSql && item.action !== 'archive').length
    : 0;

  return (
    <main className="studio-page studio-medium">
      <header className="page-head">
        <div>
          <h1>Bundles</h1>
          <p className="studio-muted">
            A bundle is a dashboard with its charts and the queries behind them,
            as one file, made on another Arrakis. Import one from a file or a
            URL; export any of your dashboards from its Share menu.
          </p>
        </div>
      </header>
      {user === null && (
        <p className="studio-muted">
          <Link href="/login?next=/settings/bundles">Unlock editing</Link> to
          import or export bundles.
        </p>
      )}
      {error && <p className="studio-error">{error}</p>}
      {message && <output className="studio-muted">{message}</output>}

      {user && (
        <section className="studio-card bundle-import">
          <h2>Import a bundle</h2>
          <div className="bundle-sources">
            <button
              type="button"
              className="studio-button"
              disabled={busy !== null}
              onClick={() => file.current?.click()}
            >
              <FileUp size={14} aria-hidden="true" /> Choose a file…
            </button>
            <input
              ref={file}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => {
                void readFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <span className="studio-muted">or</span>
            <form
              className="bundle-url"
              onSubmit={(event) => {
                event.preventDefault();
                if (url.trim()) void preview({ url });
              }}
            >
              <Link2 size={14} aria-hidden="true" />
              <input
                className="studio-input"
                type="url"
                placeholder="https://…/dashboard.arrakis.json"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                aria-label="Bundle URL"
              />
              <button
                type="submit"
                className="studio-button"
                disabled={busy !== null || !url.trim()}
              >
                {busy === 'reading' ? 'Reading…' : 'Read'}
              </button>
            </form>
          </div>

          {plan && (
            <div className="bundle-plan">
              <h3>{plan.title}</h3>
              {plan.description && (
                <p className="studio-muted">{plan.description}</p>
              )}
              <p>{counts}.</p>
              <p className="bundle-warning">
                Its {queries.length} quer{queries.length === 1 ? 'y runs' : 'ies run'}{' '}
                on your data sources
                {scheduled > 0 && `, ${scheduled} on a schedule`}
                {sqlCharts > 0 &&
                  `, and ${sqlCharts} chart${sqlCharts === 1 ? ' runs' : 's run'} SQL of ${sqlCharts === 1 ? 'its' : 'their'} own`}
                . Read the SQL below before importing: it is someone else&apos;s.
              </p>
              {plan.items.some((item) => item.action === 'archive') && (
                <p className="studio-muted">
                  An earlier version of this bundle made items this one no
                  longer has: they are archived, unless something else still
                  uses them.
                </p>
              )}
              {plan.items.some((item) => item.kind === 'list') && (
                <p className="studio-muted">
                  Lists are created empty: fill in their values under{' '}
                  <Link href="/settings/lists">Lists</Link> for its queries to
                  count what you mean.
                </p>
              )}
              <ul>
                {plan.items.map((item) => (
                  <li key={`${item.kind}:${item.name}`}>
                    <span className={`plan-action ${item.action}`}>
                      {ACTION_LABEL[item.action]}
                    </span>
                    <span className="plan-kind">{item.kind}</span>
                    <span className="plan-title" title={item.name}>
                      {item.title}
                      {item.kind === 'query' && item.action !== 'archive' && item.action !== 'keep' && (
                        <small className="studio-muted"> · {every(item.refreshSeconds)}</small>
                      )}
                      {item.runsSql && (
                        <small className="plan-flag"> Runs its own SQL</small>
                      )}
                      {item.reason && (
                        <small className="studio-muted"> · {item.reason}</small>
                      )}
                    </span>
                    {item.sql && item.action !== 'archive' && item.action !== 'keep' && (
                      <PlanSql sql={item.sql} />
                    )}
                  </li>
                ))}
              </ul>
              {plan.conflicts > 0 && (
                <label className="bundle-replace">
                  <input
                    type="checkbox"
                    checked={replace}
                    onChange={(event) => setReplace(event.target.checked)}
                  />
                  <span>
                    Replace or restore the {plan.conflicts} item
                    {plan.conflicts === 1 ? '' : 's'} marked above: of the same
                    name but not from this bundle, or archived here. A replaced
                    query keeps its history: the bundle&apos;s SQL becomes a new
                    version.
                  </span>
                </label>
              )}
              <label className="bundle-replace">
                <input
                  type="checkbox"
                  checked={publish}
                  onChange={(event) => setPublish(event.target.checked)}
                />
                <span>
                  Publish what it creates, as its author shared it. Otherwise
                  its new queries and dashboards are private: only editors see
                  them until you change their visibility. What is already here
                  keeps its visibility either way.
                </span>
              </label>
              <div className="bundle-actions">
                <button
                  type="button"
                  className="studio-button primary"
                  disabled={busy !== null || (plan.conflicts > 0 && !replace)}
                  onClick={() => void install()}
                >
                  {busy === 'importing' ? 'Importing…' : 'Import'}
                </button>
                <button
                  type="button"
                  className="studio-button"
                  disabled={busy !== null}
                  onClick={() => {
                    setPlan(null);
                    setBundle(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {user && installed && (
        <section className="bundle-list">
          <h2>Imported</h2>
          {installed.length === 0 && (
            <p className="studio-muted">No bundle imported yet.</p>
          )}
          {installed.map((entry) => {
            const title = entry.dashboards[0]?.title ?? entry.name;
            const open = removing?.name === entry.name;
            return (
              <div key={entry.name} className="bundle">
                <PackageOpen size={18} aria-hidden="true" />
                <div>
                  <strong>{title}</strong>
                  <p className="studio-muted">
                    {entry.dashboards.map((dashboard, at) => (
                      <span key={dashboard.slug}>
                        {at > 0 && ', '}
                        <Link href={`/dashboards/${dashboard.slug}`}>
                          {dashboard.title}
                        </Link>
                      </span>
                    ))}
                    {entry.dashboards.length > 0 && ' · '}
                    {entry.charts} chart{entry.charts === 1 ? '' : 's'},{' '}
                    {entry.queries} quer{entry.queries === 1 ? 'y' : 'ies'}.
                    Importing a newer file of the same bundle updates them.
                  </p>
                  {open && removing.plan && (
                    <div className="bundle-plan">
                      <p>
                        Removing it archives {removing.plan.archive.length} item
                        {removing.plan.archive.length === 1 ? '' : 's'}. Lists
                        are kept, values and all.
                      </p>
                      <ul>
                        {[...removing.plan.archive, ...removing.plan.keep].map(
                          (item) => (
                            <li key={`${item.kind}:${item.name}`}>
                              <span
                                className={`plan-action ${item.reason ? 'keep' : 'archive'}`}
                              >
                                {item.reason ? 'Kept' : 'Archived'}
                              </span>
                              <span className="plan-kind">{item.kind}</span>
                              <span className="plan-title" title={item.name}>
                                {item.title}
                                {item.reason && (
                                  <small className="studio-muted">
                                    {' '}
                                    · {item.reason}
                                  </small>
                                )}
                              </span>
                            </li>
                          ),
                        )}
                      </ul>
                      <div className="bundle-actions">
                        <button
                          type="button"
                          className="studio-button danger"
                          disabled={removing.busy}
                          onClick={() => void remove()}
                        >
                          {removing.busy ? 'Removing…' : 'Remove'}
                        </button>
                        <button
                          type="button"
                          className="studio-button"
                          disabled={removing.busy}
                          onClick={() => setRemoving(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                {!open && (
                  <button
                    type="button"
                    className="studio-button"
                    disabled={removing?.busy}
                    onClick={() => void askRemove(entry.name, title)}
                  >
                    <Trash2 size={13} aria-hidden="true" /> Remove…
                  </button>
                )}
              </div>
            );
          })}
        </section>
      )}
    </main>
  );
}

'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { FileUp, Link2, PackageOpen } from 'lucide-react';

import { api, ApiError } from '../../api';
import { useNav } from '../../nav';
import { useSession } from '../../session';

type Installed = {
  name: string;
  dashboards: Array<{ slug: string; title: string }>;
  queries: number;
};

type PlanItem = {
  kind: 'list' | 'query' | 'fragment' | 'chart' | 'dashboard';
  name: string;
  title: string;
  action: 'create' | 'update' | 'replace';
  from?: string | null;
};

type Plan = {
  name: string;
  title: string;
  description: string;
  items: PlanItem[];
  conflicts: number;
};

const ACTION_LABEL = {
  create: 'New',
  update: 'Update',
  replace: 'Replaces yours',
} as const;

/**
 * Bundles: dashboards with their charts and queries, as one file another
 * Arrakis made. Importing one, from a file or a URL, first shows what it would
 * create, update or replace; importing it creates ordinary saved queries and
 * charts, edited like any other. Any dashboard can be exported as a bundle
 * from its Share menu.
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
  const [busy, setBusy] = useState<'reading' | 'importing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

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
        };
      }>('/api/v1/bundles', {
        method: 'POST',
        body: { bundle, replace },
      });
      setMessage(
        `${plan.title}: ${report.created.length} created, ${report.updated.length} updated, ${report.unchanged.length} unchanged. Its queries are running now; charts fill in as their results are stored.`,
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
          const n = plan.items.filter((item) => item.kind === kind).length;
          return n ? `${n} ${n === 1 ? kind : PLURAL[kind]}` : null;
        })
        .filter(Boolean)
        .join(', ')
    : '';

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
                    </span>
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
                    Replace the {plan.conflicts} item
                    {plan.conflicts === 1 ? '' : 's'} of the same name that did
                    not come from this bundle. A replaced query keeps its
                    history: the bundle&apos;s SQL becomes a new version.
                  </span>
                </label>
              )}
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
          {installed.map((entry) => (
            <div key={entry.name} className="bundle">
              <PackageOpen size={18} aria-hidden="true" />
              <div>
                <strong>{entry.dashboards[0]?.title ?? entry.name}</strong>
                <p className="studio-muted">
                  {entry.dashboards.map((dashboard, at) => (
                    <span key={dashboard.slug}>
                      {at > 0 && ', '}
                      <Link href={`/dashboards/${dashboard.slug}`}>
                        {dashboard.title}
                      </Link>
                    </span>
                  ))}{' '}
                  · {entry.queries} quer{entry.queries === 1 ? 'y' : 'ies'}.
                  Importing a newer file of the same bundle updates them.
                </p>
              </div>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

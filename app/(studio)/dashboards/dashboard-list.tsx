'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LayoutDashboard, Plus } from 'lucide-react';

import { api, ApiError, type DashboardRecord } from '../api';
import { useNav } from '../nav';
import { useSession } from '../session';

type Summary = Omit<DashboardRecord, 'widgets'> & {
  official: boolean;
  charts: number;
};

const UPDATED = new Intl.DateTimeFormat('en', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Home: every dashboard as a card, the bundled ones first. */
export function DashboardList() {
  const { user } = useSession();
  const { dashboardsChanged } = useNav();
  const router = useRouter();
  const [dashboards, setDashboards] = useState<Summary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let live = true;
    api<{ dashboards: Summary[] }>('/api/v1/dashboards')
      .then(({ dashboards: list }) => live && setDashboards(list))
      .catch((failure: ApiError) => live && setError(failure.message));
    return () => {
      live = false;
    };
  }, [user]);

  const create = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const { dashboard } = await api<{ dashboard: DashboardRecord }>(
        '/api/v1/dashboards',
        { method: 'POST', body: { title, slug } },
      );
      dashboardsChanged();
      router.push(`/dashboards/${dashboard.slug}?edit=1`);
    } catch (failure) {
      setError((failure as ApiError).message);
      setCreating(false);
    }
  };

  return (
    <main className="studio-page">
      <header className="page-head">
        <div>
          <h1>Dashboards</h1>
          <p className="studio-muted">
            Every figure on a dashboard comes from a saved, versioned query:
            open a chart&rsquo;s title to see the query behind it.
          </p>
        </div>
      </header>
      {error && <p className="studio-error">{error}</p>}
      {dashboards === null && !error && (
        <p className="studio-muted">Loading…</p>
      )}
      {dashboards && (
        <div className="dashboard-cards">
          {dashboards.map((dashboard) => (
            <Link
              key={dashboard.id}
              href={`/dashboards/${dashboard.slug}`}
              className="dashboard-card"
            >
              <span className="dashboard-card-head">
                <LayoutDashboard size={16} aria-hidden="true" />
                <strong>{dashboard.title}</strong>
              </span>
              {dashboard.description && <span>{dashboard.description}</span>}
              <small>
                {dashboard.charts} chart{dashboard.charts === 1 ? '' : 's'} ·
                updated {UPDATED.format(new Date(dashboard.updatedAt))}
                {dashboard.official && ' · from a bundle'}
                {dashboard.visibility !== 'public' && (
                  <span className={`badge ${dashboard.visibility}`}>
                    {dashboard.visibility}
                  </span>
                )}
              </small>
            </Link>
          ))}
          {user && (
            <form
              className="dashboard-card new-dashboard"
              onSubmit={(event) => void create(event)}
            >
              <span className="dashboard-card-head">
                <Plus size={16} aria-hidden="true" />
                <strong>New dashboard</strong>
              </span>
              <input
                className="studio-input"
                placeholder="Title"
                aria-label="Dashboard title"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setSlug(
                    event.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-+|-+$/g, ''),
                  );
                }}
                required
              />
              <input
                className="studio-input mono"
                placeholder="address, e.g. my-dashboard"
                aria-label="Dashboard slug"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                required
              />
              <button
                className="studio-button primary"
                type="submit"
                disabled={creating}
              >
                Create
              </button>
            </form>
          )}
        </div>
      )}
      {dashboards?.length === 0 && (
        <p className="studio-muted">
          No dashboards yet.{' '}
          {user ? (
            <>
              Create one above, or import one somebody shared as a bundle from{' '}
              <Link href="/settings/bundles">Bundles</Link>.
            </>
          ) : (
            <>
              <Link href="/login?next=/">Unlock editing</Link> to create one.
            </>
          )}
        </p>
      )}
    </main>
  );
}

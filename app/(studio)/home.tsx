'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, Clock3, LayoutDashboard, Search } from 'lucide-react';
import { api, type DashboardRecord, type QuerySummary } from './api';
import { Favorite, usePersonal, type PersonalItem } from './personal';
import { useSession } from './session';

type Dashboard = Omit<DashboardRecord, 'widgets'> & { official: boolean };
export function Home() {
  const { user } = useSession();
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [queries, setQueries] = useState<QuerySummary[]>([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const favorites = usePersonal('favorites');
  const recent = usePersonal('recent');
  useEffect(() => {
    let live = true;
    Promise.all([
      api<{ dashboards: Dashboard[] }>('/api/v1/dashboards'),
      api<{ queries: QuerySummary[] }>('/api/v1/queries'),
    ])
      .then(([d, q]) => {
        if (live) {
          setDashboards(d.dashboards);
          setQueries(q.queries);
          setError('');
          setLoaded(true);
        }
      })
      .catch(() => {
        if (live) {
          setError('Could not load your Home.');
          setLoaded(true);
        }
      });
    return () => {
      live = false;
    };
  }, [user]);
  const cards = (items: PersonalItem[]) =>
    items.flatMap((item) => {
      const record =
        item.kind === 'dashboard'
          ? dashboards.find((d) => d.slug === item.slug)
          : queries.find((q) => q.slug === item.slug);
      if (!record) return [];
      return [
        <div className="home-item" key={`${item.kind}:${item.slug}`}>
          <span className="home-item-icon" aria-hidden="true">
            {item.kind === 'dashboard' ? (
              <LayoutDashboard size={18} />
            ) : (
              <Search size={18} />
            )}
          </span>
          <div className="home-item-content">
            <span className="home-item-kind">
              {item.kind === 'dashboard' ? 'Dashboard' : 'Query'}
            </span>
            <Link
              href={`/${item.kind === 'dashboard' ? 'dashboards' : 'queries'}/${item.slug}`}
            >
              <strong>{record.title}</strong>
            </Link>
            {record.description && <p>{record.description}</p>}
            {item.kind === 'query' && 'refreshSeconds' in record && (
              <small>
                {record.refreshSeconds
                  ? `Refreshes every ${record.refreshSeconds >= 60 ? `${Math.round(record.refreshSeconds / 60)} min` : `${record.refreshSeconds} sec`}`
                  : 'Manual refresh'}
                {record.version ? ` · v${record.version}` : ''}
              </small>
            )}
          </div>
          <Favorite item={item} />
        </div>,
      ];
    });
  const favoriteCards = cards(favorites);
  const recentCards = cards(recent);
  const suggested = cards(
    dashboards.map((d) => ({ kind: 'dashboard', slug: d.slug })),
  );
  const queryCount = queries.filter((q) => q.kind === 'query').length;
  return (
    <main className="studio-page">
      <header className="page-head">
        <div>
          <h1>Home</h1>
          <p className="studio-muted">
            Pick up where you left off and keep your most useful work close.
          </p>
        </div>
      </header>
      {error && <p className="studio-error">{error}</p>}
      {!loaded && <p className="studio-muted">Loading…</p>}
      {loaded && !error && (
        <>
          <div className="home-sections">
            <section className="home-section">
              <div className="home-section-head">
                <div>
                  <h2>Favorites</h2>
                  <p>
                    Keep the dashboards and queries you use most within reach.
                  </p>
                </div>
              </div>
              {favoriteCards.length ? (
                <div className="home-cards">{favoriteCards}</div>
              ) : (
                <>
                  <p className="home-hint">
                    Choose a dashboard to get started. You can also favorite
                    queries when you open them.
                  </p>
                  {suggested.length ? (
                    <div className="home-cards">{suggested}</div>
                  ) : (
                    <p className="studio-muted">No dashboards available yet.</p>
                  )}
                </>
              )}
              <Link className="home-more" href="/dashboards">
                Browse dashboards <ArrowRight size={15} />
              </Link>
            </section>
            <div className="home-side">
              <section className="home-section">
                <div className="home-section-head">
                  <div>
                    <h2>Recently viewed</h2>
                    <p>Your latest dashboards and queries, on this browser.</p>
                  </div>
                </div>
                {recentCards.length ? (
                  <div className="home-cards">{recentCards}</div>
                ) : (
                  <div className="home-empty">
                    <Clock3 size={20} />
                    <strong>Nothing viewed yet</strong>
                    <span>
                      Open a dashboard or query and it will appear here.
                    </span>
                  </div>
                )}
              </section>
              <section className="home-query-summary">
                <div>
                  <h2>Queries</h2>
                  <p>
                    {queryCount} saved {queryCount === 1 ? 'query' : 'queries'}{' '}
                    available to explore.
                  </p>
                </div>
                <Link className="studio-button" href="/queries">
                  Browse queries <ArrowRight size={15} />
                </Link>
              </section>
            </div>
          </div>
        </>
      )}
    </main>
  );
}

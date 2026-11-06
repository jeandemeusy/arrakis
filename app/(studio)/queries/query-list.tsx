'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';

import { api, ApiError, type QuerySummary } from '../api';
import { LockedLink } from '../locked-link';
import { useSession } from '../session';

function age(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

function every(seconds: number | null): string {
  if (!seconds) return '—';
  if (seconds % 86_400 === 0) return `${seconds / 86_400} d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} h`;
  return `${Math.round(seconds / 60)} min`;
}

export function QueryList() {
  const { user } = useSession();
  const [queries, setQueries] = useState<QuerySummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [filter, setFilter] = useState('');
  const [kind, setKind] = useState<'all' | 'query' | 'fragment'>('all');
  const [archived, setArchived] = useState(false);

  useEffect(() => {
    const search = new URLSearchParams();
    if (archived) search.set('archived', '1');
    void api<{ queries: QuerySummary[] }>(`/api/v1/queries?${search}`)
      .then(({ queries: list }) => {
        setQueries(list);
        setError(null);
      })
      .catch((failure: ApiError) => setError(failure));
    // The session decides what the list holds, so it is re-read on sign-in.
  }, [user, archived]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (queries ?? []).filter(
      (query) =>
        (kind === 'all' || query.kind === kind) &&
        (!needle ||
          query.title.toLowerCase().includes(needle) ||
          query.slug.includes(needle) ||
          query.description.toLowerCase().includes(needle)),
    );
  }, [filter, kind, queries]);

  return (
    <main className="studio-page">
      <header className="page-head">
        <div>
          <h1>Queries</h1>
          <p className="studio-muted">
            {user
              ? 'Every saved query and fragment. Private ones are visible to editors only.'
              : 'Public queries behind the dashboard. Sign in to write your own.'}
          </p>
        </div>
        <LockedLink
          className="studio-button primary"
          href="/queries/new"
          title="New query"
          locked={user === null}
        >
          <Plus size={14} aria-hidden="true" /> New query
        </LockedLink>
      </header>

      <div className="list-controls">
        <input
          className="studio-input"
          type="search"
          placeholder="Search"
          aria-label="Search queries"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <fieldset className="network-switch">
          <legend className="sr-only">Kind</legend>
          {(['all', 'query', 'fragment'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              className={kind === value ? 'active' : ''}
              onClick={() => setKind(value)}
            >
              {value === 'all'
                ? 'All'
                : value === 'query'
                  ? 'Queries'
                  : 'Fragments'}
            </button>
          ))}
        </fieldset>
        {user && (
          <label className="studio-check">
            <input
              type="checkbox"
              checked={archived}
              onChange={(event) => setArchived(event.target.checked)}
            />
            Show archived
          </label>
        )}
      </div>

      {error && (
        <p className="studio-error" role="alert">
          {error.message}
        </p>
      )}
      {queries === null && !error && <p className="studio-muted">Loading…</p>}

      {queries !== null && (
        <table className="query-table">
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Kind</th>
              <th scope="col">Visibility</th>
              <th scope="col">Refresh</th>
              <th scope="col">Version</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((query) => (
              <tr key={query.id} className={query.archivedAt ? 'archived' : ''}>
                <td>
                  <Link href={`/queries/${query.slug}`}>
                    <strong>{query.title}</strong>
                    <small>{query.slug}</small>
                  </Link>
                  {query.description && (
                    <p className="studio-muted">{query.description}</p>
                  )}
                </td>
                <td className="quiet-cell">{query.kind}</td>
                <td className="badges">
                  <span className={`badge ${query.visibility}`}>
                    {query.visibility}
                  </span>
                  {query.official && (
                    <span className="badge official">official</span>
                  )}
                </td>
                <td>{every(query.refreshSeconds)}</td>
                <td>{query.version ? `v${query.version}` : '—'}</td>
                <td className="quiet-cell nowrap">{age(query.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {queries !== null && !visible.length && (
        <p className="studio-muted">
          {queries.length ? 'Nothing matches.' : 'No queries yet.'}
        </p>
      )}
    </main>
  );
}

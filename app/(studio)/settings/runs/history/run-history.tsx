'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';

import { api, ApiError } from '../../../api';
import { useSession } from '../../../session';
import { took } from '../../../time';
import type { Run } from '../run-times';

type Filter = { query: string; network: string; status: string };

const PAGE = 50;

/** The filter's non-empty values, as the address and the API both take them. */
function searchOf(filter: Filter): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter))
    if (value) params.set(key, value);
  return params;
}

function pageOf(filter: Filter, before: string | null) {
  const params = searchOf(filter);
  params.set('limit', String(PAGE));
  if (before) params.set('before', before);
  return api<{ runs: Run[]; next: string | null }>(
    `/api/v1/runs/history?${params}`,
  );
}

/**
 * Every recorded run, newest first, a page at a time: the raw rows behind the
 * Run time chart on Query health, filterable by query, source and status. The
 * filters travel in the address, so a filtered view can be linked to.
 */
export function RunHistory({ initial }: { initial: Filter }) {
  const { user } = useSession();
  const [filter, setFilter] = useState<Filter>(initial);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [queries, setQueries] = useState<Array<{ slug: string; title: string }>>([]);
  const [sources, setSources] = useState<Array<{ id: string; label: string }>>([]);

  useEffect(() => {
    if (!user) return;
    let live = true;
    void Promise.all([
      api<{ queries: Array<{ slug: string; title: string }> }>(
        '/api/v1/queries?kind=query',
      ),
      api<{ networks: Array<{ id: string; label: string }> }>(
        '/api/v1/networks',
      ),
    ])
      .then(([listed, configured]) => {
        if (!live) return;
        setQueries(listed.queries);
        setSources(configured.networks);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [user]);

  useEffect(() => {
    if (!user) return;
    let live = true;
    const params = searchOf(filter);
    window.history.replaceState(
      window.history.state,
      '',
      `/settings/runs/history${params.size ? `?${params}` : ''}`,
    );
    pageOf(filter, null)
      .then((result) => {
        if (!live) return;
        setError('');
        setRuns(result.runs);
        setNext(result.next);
      })
      .catch((failure: ApiError) => live && setError(failure.message));
    return () => {
      live = false;
    };
  }, [user, filter]);

  const older = async () => {
    if (!next || !runs) return;
    setLoadingMore(true);
    try {
      const result = await pageOf(filter, next);
      setRuns([...runs, ...result.runs]);
      setNext(result.next);
    } catch (failure) {
      setError((failure as ApiError).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const set = (name: keyof Filter) => (event: { target: { value: string } }) => {
    setRuns(null);
    setFilter({ ...filter, [name]: event.target.value });
  };

  return (
    <main className="studio-page studio-medium">
      <header className="page-head">
        <div>
          <Link className="back-link" href="/settings/runs">
            <ArrowLeft size={14} aria-hidden="true" /> Query health
          </Link>
          <h1>All runs</h1>
          <p className="studio-muted">
            Every stored and scheduled run recorded, newest first. Previews are
            not recorded.
          </p>
        </div>
      </header>
      {user === null && (
        <p className="studio-muted">
          <Link href="/login?next=/settings/runs/history">Sign in</Link> to see
          the runs.
        </p>
      )}
      {user && (
        <>
          <div className="run-filters">
            <label>
              <span>Query</span>
              <select className="studio-input" value={filter.query} onChange={set('query')}>
                <option value="">All queries</option>
                {queries.map((query) => (
                  <option key={query.slug} value={query.slug}>
                    {query.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Source</span>
              <select className="studio-input" value={filter.network} onChange={set('network')}>
                <option value="">All sources</option>
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Status</span>
              <select className="studio-input" value={filter.status} onChange={set('status')}>
                <option value="">Any status</option>
                <option value="succeeded">Succeeded</option>
                <option value="failed">Failed</option>
                <option value="running">Running</option>
              </select>
            </label>
          </div>
          {error && <p className="studio-error">{error}</p>}
          {!runs && !error && <p className="studio-muted">Loading runs…</p>}
          {runs &&
            (runs.length === 0 ? (
              <p className="studio-muted">No runs match.</p>
            ) : (
              <div className="studio-card runs-card">
                <table className="query-table">
                  <thead>
                    <tr>
                      <th scope="col">Query</th>
                      <th scope="col">Source</th>
                      <th scope="col">Started</th>
                      <th scope="col">Trigger</th>
                      <th scope="col">Status</th>
                      <th scope="col">Duration</th>
                      <th scope="col">Rows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <tr key={run.id}>
                        <td>
                          <Link href={`/queries/${run.slug}`}>{run.title}</Link>
                        </td>
                        <td>{run.network}</td>
                        <td>{new Date(run.startedAt).toLocaleString()}</td>
                        <td>{run.trigger ?? '—'}</td>
                        <td title={run.error ?? undefined}>
                          {run.status}
                          {run.error ? `: ${run.error}` : ''}
                        </td>
                        <td>
                          {run.durationMs === null ? '—' : took(run.durationMs)}
                        </td>
                        <td>{run.rowCount ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          {next && runs && (
            <button
              type="button"
              className="studio-button run-history-more"
              disabled={loadingMore}
              onClick={() => void older()}
            >
              {loadingMore ? 'Loading…' : 'Older runs'}
            </button>
          )}
        </>
      )}
    </main>
  );
}

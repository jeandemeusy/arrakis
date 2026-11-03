'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api';
import { took } from '../../time';

type Source = {
  id: string;
  status: string;
  stale: boolean;
  error?: string;
  lastAttempt?: { status: string; error: string | null } | null;
};
type Health = {
  slug: string;
  title: string;
  networks: Source[];
  dashboards: { slug: string; title: string }[];
};
type History = {
  id: string;
  slug: string;
  network: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
  rowCount: string | null;
  error: string | null;
};

export function QueryHealth({ enabled }: { enabled: boolean }) {
  const [data, setData] = useState<{
    health: Health[];
    history: History[];
  } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    api<{ health: Health[]; history: History[] }>('/api/v1/runs/health')
      .then((result) => {
        if (live) setData(result);
      })
      .catch((failure: ApiError) => {
        if (live) setError(failure.message);
      });
    return () => {
      live = false;
    };
  }, [enabled]);
  if (!enabled) return null;
  const problems =
    data?.health.flatMap((query) =>
      query.networks
        .filter(
          (source) =>
            source.status !== 'ready' ||
            source.stale ||
            source.lastAttempt?.status === 'failed',
        )
        .map((source) => ({ query, source })),
    ) ?? [];
  return (
    <section className="query-health">
      <h2>Stored result health</h2>
      <p className="studio-muted">
        Status of default parameter values on each configured data source. Other
        parameter combinations can have different results.
      </p>
      {error && <p className="studio-error">{error}</p>}
      {!data && !error && <p className="studio-muted">Checking results…</p>}
      {data &&
        (problems.length ? (
          <div className="studio-card runs-card">
            <table className="query-table">
              <thead>
                <tr>
                  <th>Query</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Dashboards</th>
                </tr>
              </thead>
              <tbody>
                {problems.map(({ query, source }) => (
                  <tr key={`${query.slug}:${source.id}`}>
                    <td>
                      <Link href={`/queries/${query.slug}`}>{query.title}</Link>
                    </td>
                    <td>{source.id}</td>
                    <td>
                      {source.lastAttempt?.status === 'failed'
                        ? `Last run failed${source.lastAttempt.error ? `: ${source.lastAttempt.error}` : ''}`
                        : source.stale
                          ? 'Stale'
                          : (source.error ?? source.status)}
                    </td>
                    <td>
                      {query.dashboards.length
                        ? query.dashboards.map((dashboard, index) => (
                            <span key={dashboard.slug}>
                              {index > 0 && ', '}
                              <Link href={`/dashboards/${dashboard.slug}`}>
                                {dashboard.title}
                              </Link>
                            </span>
                          ))
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="studio-muted">
            No problems found for default parameter values.
          </p>
        ))}
      <h2>Recent stored runs</h2>
      <p className="studio-muted">
        Up to 100 runs recorded since run history was enabled. Previews are not
        stored here.
      </p>
      {data &&
        (data.history.length ? (
          <div className="studio-card runs-card">
            <table className="query-table">
              <thead>
                <tr>
                  <th>Query</th>
                  <th>Source</th>
                  <th>Started</th>
                  <th>Status</th>
                  <th>Duration</th>
                  <th>Rows</th>
                </tr>
              </thead>
              <tbody>
                {data.history.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <Link href={`/queries/${run.slug}`}>{run.slug}</Link>
                    </td>
                    <td>{run.network}</td>
                    <td>{new Date(run.startedAt).toLocaleString()}</td>
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
        ) : (
          <p className="studio-muted">No runs recorded yet.</p>
        ))}
    </section>
  );
}

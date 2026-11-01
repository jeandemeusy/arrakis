'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Activity, Square } from 'lucide-react';

import { api, ApiError } from '../../api';
import { useSession } from '../../session';
import { took } from '../../time';

type ActiveRun = {
  id: string;
  network: string;
  kind: 'preview' | 'store' | 'schedule';
  query: string | null;
  startedBy: string | null;
  startedAt: string;
};

const KIND: Record<ActiveRun['kind'], string> = {
  preview: 'Preview',
  store: 'Run and store',
  schedule: 'Scheduled refresh',
};

/**
 * Every run in progress, on every replica, read again every few seconds:
 * what is busy right now, and a way to stop what should not be.
 */
export function RunsMonitor() {
  const { user } = useSession();
  const [runs, setRuns] = useState<ActiveRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!user) return;
    let live = true;
    api<{ runs: ActiveRun[] }>('/api/v1/runs')
      .then(({ runs: list }) => {
        if (!live) return;
        setRuns(list);
        setError(null);
        setNow(Date.now());
      })
      .catch((cause: ApiError) => live && setError(cause.message));
    const timer = setTimeout(() => setTick((value) => value + 1), 3_000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [user, tick]);

  const cancel = async (id: string) => {
    setCancelling(id);
    try {
      await api('/api/v1/runs/cancel', { method: 'POST', body: { id } });
    } catch (cause) {
      setError((cause as ApiError).message);
    } finally {
      setCancelling(null);
      setTick((value) => value + 1);
    }
  };

  return (
    <main className="studio-page studio-medium">
      <header className="page-head">
        <div>
          <h1>Running now</h1>
          <p className="studio-muted">
            Every query running against a data source at this moment, on any
            server: editors&apos; previews, runs stored by hand and scheduled
            refreshes. Cancelling stops it in the database at once.
          </p>
        </div>
      </header>
      {user === null && (
        <p className="studio-muted">
          <Link href="/login?next=/settings/runs">Unlock editing</Link> to see
          what is running.
        </p>
      )}
      {error && <p className="studio-error">{error}</p>}
      {user && runs && (
        <div className="studio-card runs-card">
          {runs.length === 0 ? (
            <p className="runs-empty">
              <Activity size={18} aria-hidden="true" />
              Nothing is running.
            </p>
          ) : (
            <table className="query-table">
              <thead>
                <tr>
                  <th scope="col">Query</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Source</th>
                  <th scope="col">By</th>
                  <th scope="col">Running for</th>
                  <th scope="col">
                    <span className="sr-only">Cancel</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>
                      {run.query ? (
                        <Link href={`/queries/${run.query}`}>
                          <strong>{run.query}</strong>
                        </Link>
                      ) : (
                        <span className="studio-muted">Unsaved SQL</span>
                      )}
                    </td>
                    <td className="quiet-cell">{KIND[run.kind]}</td>
                    <td className="quiet-cell">{run.network}</td>
                    <td className="quiet-cell">{run.startedBy ?? '—'}</td>
                    <td className="nowrap">
                      {took(Math.max(0, now - Date.parse(run.startedAt)))}
                    </td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className="studio-button cancel-run"
                        disabled={cancelling === run.id}
                        onClick={() => void cancel(run.id)}
                      >
                        <Square
                          size={11}
                          aria-hidden="true"
                          fill="currentColor"
                        />
                        {cancelling === run.id ? 'Cancelling…' : 'Cancel'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </main>
  );
}

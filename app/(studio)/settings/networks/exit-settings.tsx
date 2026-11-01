'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import {
  api,
  ApiError,
  type Exit,
  type ExitActivity,
  type Network,
} from '../../api';
import { useSession } from '../../session';

/**
 * Exits per network.
 *
 * Downstream volume can only be attributed if the exits are named, and this is
 * the only place they are named. Anyone can read the list — the downstream
 * figures rest on it — while adding and removing needs the editor password.
 */

function when(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function NetworkExits({
  network,
  editor,
}: {
  network: Network;
  editor: boolean;
}) {
  const [exits, setExits] = useState<Exit[] | null>(null);
  const [activity, setActivity] = useState<Map<string, ExitActivity>>(
    new Map(),
  );
  const [activityError, setActivityError] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  // Bumped after every change, to read the list again.
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let live = true;
    api<{ exits: Exit[] }>(`/api/v1/networks/${network.id}/exits`)
      .then(({ exits: list }) => live && setExits(list))
      .catch((failure: ApiError) => live && setError(failure.message));
    if (editor) {
      api<{ activity: ExitActivity[] }>(
        `/api/v1/networks/${network.id}/exits/activity`,
      )
        .then(({ activity: rows }) => {
          if (!live) return;
          setActivity(new Map(rows.map((row) => [row.address, row])));
          setActivityError(null);
        })
        .catch(
          (failure: ApiError) => live && setActivityError(failure.message),
        );
    }
    return () => {
      live = false;
    };
  }, [editor, network.id, revision]);

  const add = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      const result = await api<{ warning: string | null }>(
        `/api/v1/networks/${network.id}/exits`,
        { method: 'POST', body: { address, label } },
      );
      setWarning(result.warning);
      setAddress('');
      setLabel('');
      setRevision((value) => value + 1);
    } catch (failure) {
      setError((failure as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (exit: string) => {
    setError(null);
    try {
      await api(`/api/v1/networks/${network.id}/exits/${exit}`, {
        method: 'DELETE',
      });
      setRemoving(null);
      setRevision((value) => value + 1);
    } catch (failure) {
      setError((failure as ApiError).message);
    }
  };

  return (
    <section
      className="studio-card exits-card"
      aria-labelledby={`exits-${network.id}`}
    >
      <header>
        <h2 id={`exits-${network.id}`}>{network.label}</h2>
        <span className="studio-muted">
          {exits === null
            ? 'Loading…'
            : `${exits.length} exit${exits.length === 1 ? '' : 's'}`}
        </span>
      </header>
      {exits !== null && exits.length === 0 && (
        <p className="studio-muted">
          No exits named. Queries using <code>{'{{exits}}'}</code> get an empty
          list, so this network has no downstream figure. Nothing is guessed.
        </p>
      )}
      {exits !== null && exits.length > 0 && (
        <table className="query-table exits-table">
          <thead>
            <tr>
              <th scope="col">Address</th>
              <th scope="col">Label</th>
              {editor && <th scope="col">Last redemption</th>}
              {editor && <th scope="col">Redemptions</th>}
              <th scope="col">Added</th>
              {editor && (
                <th scope="col">
                  <span className="sr-only">Remove</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {exits.map((exit) => {
              const seen = activity.get(exit.address);
              return (
                <tr key={exit.address}>
                  <td className="mono">{exit.address}</td>
                  <td>
                    {exit.label || <span className="studio-muted">—</span>}
                  </td>
                  {editor && (
                    <td className={seen?.lastAt ? '' : 'quiet'}>
                      {seen ? when(seen.lastAt) : '…'}
                    </td>
                  )}
                  {editor && (
                    <td className="numeric">{seen?.redemptions ?? '…'}</td>
                  )}
                  <td>
                    {when(exit.addedAt)}
                    {exit.addedBy && (
                      <small className="studio-muted"> by {exit.addedBy}</small>
                    )}
                  </td>
                  {editor && (
                    <td className="row-actions">
                      {removing === exit.address ? (
                        <>
                          <button
                            type="button"
                            className="studio-button danger"
                            onClick={() => void remove(exit.address)}
                          >
                            Remove
                          </button>
                          <button
                            type="button"
                            className="studio-button"
                            onClick={() => setRemoving(null)}
                          >
                            Keep
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="studio-icon-button"
                          aria-label={`Remove ${exit.address}`}
                          onClick={() => setRemoving(exit.address)}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {activityError && (
        <p className="studio-muted">Activity unavailable: {activityError}</p>
      )}
      {editor && (
        <form className="exit-form" onSubmit={(event) => void add(event)}>
          <input
            className="studio-input mono"
            placeholder="0x… exit node address"
            aria-label="Exit address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            required
            pattern="^0x[0-9a-fA-F]{40}$"
          />
          <input
            className="studio-input"
            placeholder="Label (optional)"
            aria-label="Exit label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
          <button
            className="studio-button primary"
            type="submit"
            disabled={busy}
          >
            <Plus size={14} aria-hidden="true" /> Add exit
          </button>
        </form>
      )}
      {!editor && (
        <p className="studio-muted">
          <Link href="/login?next=/settings/networks">Unlock editing</Link> to
          add or remove exits.
        </p>
      )}
      {warning && <output className="studio-warning">{warning}</output>}
      {error && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function ExitSettings() {
  const { user } = useSession();
  const [networks, setNetworks] = useState<Network[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ networks: Network[] }>('/api/v1/networks')
      .then(({ networks: list }) => setNetworks(list))
      .catch((failure: ApiError) => setError(failure.message));
  }, []);

  return (
    <main className="studio-page studio-medium">
      <header className="page-head">
        <div>
          <h1>Exits</h1>
          <p className="studio-muted">
            Nothing on chain tells an exit from a relay, so downstream volume
            only counts the exits named here. Every change is kept on record,
            and queries that read <code>{'{{exits}}'}</code> are rerun within
            seconds of one.
          </p>
        </div>
      </header>
      {error && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}
      {networks?.map((network) => (
        <NetworkExits
          key={`${network.id}:${user ? 'editor' : 'reader'}`}
          network={network}
          editor={Boolean(user)}
        />
      ))}
    </main>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';

type View = { id: string; name: string; variables: Record<string, string> };

export function SavedViews({
  slug,
  vars,
  editable,
  onApply,
}: {
  slug: string;
  vars: Record<string, string | undefined>;
  editable: boolean;
  onApply: (variables: Record<string, string>) => void;
}) {
  const [views, setViews] = useState<View[]>([]);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = views.find((view) => view.id === selected);
  const matches =
    active &&
    Object.keys(vars).every(
      (key) => (vars[key] ?? '') === (active.variables[key] ?? ''),
    );
  const path = `/api/v1/dashboards/${encodeURIComponent(slug)}/views`;
  useEffect(() => {
    let live = true;
    api<{ views: View[] }>(path)
      .then((result) => {
        if (live) setViews(result.views);
      })
      .catch((failure: ApiError) => {
        if (live) setError(failure.message);
      });
    return () => {
      live = false;
    };
  }, [path]);
  const save = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const variables = Object.fromEntries(
        Object.entries(vars).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
      const { view } = await api<{ view: View }>(path, {
        method: 'POST',
        body: { name, variables },
      });
      setViews((old) =>
        [...old, view].sort((a, b) => a.name.localeCompare(b.name)),
      );
      setSelected(view.id);
      setName('');
      setAdding(false);
    } catch (failure) {
      setError((failure as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await api(`${path}?id=${encodeURIComponent(selected)}`, {
        method: 'DELETE',
      });
      setViews((old) => old.filter((view) => view.id !== selected));
      setSelected('');
    } catch (failure) {
      setError((failure as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dashboard-saved-views">
      {views.length > 0 && (
        <label>
          Saved view{' '}
          <select
            className="studio-input"
            value={matches ? selected : ''}
            onChange={(event) => {
              const id = event.target.value;
              setSelected(id);
              const view = views.find((entry) => entry.id === id);
              if (view) onApply(view.variables);
            }}
          >
            <option value="">Choose a view</option>
            {views.map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {editable && !adding && (
        <button
          type="button"
          className="studio-button"
          onClick={() => setAdding(true)}
        >
          Save view
        </button>
      )}
      {editable && matches && !adding && (
        <button
          type="button"
          className="studio-button"
          disabled={busy}
          onClick={() => {
            if (window.confirm('Delete this saved view?')) void remove();
          }}
        >
          Delete view
        </button>
      )}
      {adding && (
        <form onSubmit={(event) => void save(event)}>
          <span className="studio-muted">Saved views are visible to anyone who can open this dashboard.</span>
          <label>
            View name{' '}
            <input
              className="studio-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={120}
            />
          </label>
          <button className="studio-button" disabled={busy}>
            Save
          </button>
          <button
            className="studio-button"
            type="button"
            onClick={() => setAdding(false)}
          >
            Cancel
          </button>
        </form>
      )}
      {error && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

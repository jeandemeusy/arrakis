'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ListPlus, Plus, Trash2 } from 'lucide-react';

import { api, ApiError } from '../../api';
import { useSession } from '../../session';

type ListType = 'text' | 'number' | 'bytes';

type ListValue = {
  id: string;
  source: string | null;
  value: string;
  label: string;
  addedAt: string;
  addedBy: string | null;
};

type List = {
  name: string;
  type: ListType;
  description: string;
  values: ListValue[];
};

type Source = { id: string; label: string };

const TYPE_HINT: Record<ListType, string> = {
  text: 'Text',
  number: 'Numbers',
  bytes: 'Bytes, written 0x…',
};

const PLACEHOLDER: Record<ListType, string> = {
  text: 'a value',
  number: '42',
  bytes: '0x…',
};

/**
 * Lists: sets of values a query reads as `{{list:name}}` — the accounts to
 * leave out, the regions that count, the addresses that are exits. A value is
 * kept for one data source or for every one. Changing a list makes the
 * results of the queries that read it stale, and the scheduled ones rerun.
 */
export function ListSettings() {
  const { user } = useSession();
  const [lists, setLists] = useState<List[] | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    type: 'text' as ListType,
    description: '',
  });

  useEffect(() => {
    if (!user) return;
    let live = true;
    api<{ lists: List[]; sources: Source[] }>('/api/v1/lists')
      .then((answer) => {
        if (!live) return;
        setLists(answer.lists);
        setSources(answer.sources);
      })
      .catch((failure: ApiError) => live && setError(failure.message));
    return () => {
      live = false;
    };
  }, [user, revision]);

  const refresh = () => setRevision((value) => value + 1);
  const attempt = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      refresh();
      return true;
    } catch (failure) {
      setError((failure as ApiError).message);
      return false;
    }
  };

  return (
    <main className="studio-page studio-medium">
      <header className="page-head">
        <div>
          <h1>Lists</h1>
          <p className="studio-muted">
            Values a query reads as <code>{'{{list:name:values}}'}</code>: an array of
            the list&apos;s type, holding what is kept for the data source the
            run reads and what is kept for all of them. Changing a list reruns
            the scheduled queries that read it.
            Use <code>{'{{list:name:names}}'}</code> for the corresponding names.
          </p>
        </div>
        {user && (
          <button
            type="button"
            className="studio-button primary"
            onClick={() => setCreating(!creating)}
          >
            <ListPlus size={14} aria-hidden="true" /> New list
          </button>
        )}
      </header>
      {user === null && (
        <p className="studio-muted">
          <Link href="/login?next=/settings/lists">Unlock editing</Link> to see
          and change lists.
        </p>
      )}
      {error && <p className="studio-error">{error}</p>}

      {creating && (
        <form
          className="studio-card list-create"
          onSubmit={(event) => {
            event.preventDefault();
            void attempt(() =>
              api('/api/v1/lists', { method: 'POST', body: draft }),
            ).then((done) => {
              if (!done) return;
              setCreating(false);
              setDraft({ name: '', type: 'text', description: '' });
            });
          }}
        >
          <label>
            <span>Name</span>
            <input
              className="studio-input mono"
              required
              pattern="[a-z_][a-z0-9_]*"
              placeholder="excluded_accounts"
              value={draft.name}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </label>
          <label>
            <span>Holds</span>
            <select
              className="studio-input"
              value={draft.type}
              onChange={(event) =>
                setDraft({ ...draft, type: event.target.value as ListType })
              }
            >
              {(Object.keys(TYPE_HINT) as ListType[]).map((type) => (
                <option key={type} value={type}>
                  {TYPE_HINT[type]}
                </option>
              ))}
            </select>
          </label>
          <label className="list-create-wide">
            <span>What it is for</span>
            <input
              className="studio-input"
              placeholder="Accounts we run ourselves, left out of usage"
              value={draft.description}
              onChange={(event) =>
                setDraft({ ...draft, description: event.target.value })
              }
            />
          </label>
          <div className="list-create-actions">
            <button type="submit" className="studio-button primary">
              Create
            </button>
            <button
              type="button"
              className="studio-button"
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {user && lists?.length === 0 && !creating && (
        <p className="studio-muted runs-empty">
          No lists yet. Create one when a query needs values you would rather
          keep here than write into its SQL.
        </p>
      )}

      {lists?.map((list) => (
        <ListCard
          key={list.name}
          list={list}
          sources={sources}
          onAdd={(value) =>
            attempt(() =>
              api(`/api/v1/lists/${list.name}/values`, {
                method: 'POST',
                body: value,
              }),
            )
          }
          onRemove={(id) =>
            void attempt(() =>
              api(`/api/v1/lists/${list.name}/values/${id}`, {
                method: 'DELETE',
              }),
            )
          }
          onDelete={() =>
            void attempt(() =>
              api(`/api/v1/lists/${list.name}`, { method: 'DELETE' }),
            )
          }
        />
      ))}
    </main>
  );
}

function ListCard({
  list,
  sources,
  onAdd,
  onRemove,
  onDelete,
}: {
  list: List;
  sources: Source[];
  onAdd: (value: {
    value: string;
    label: string;
    source: string | null;
  }) => Promise<boolean>;
  onRemove: (id: string) => void;
  onDelete: () => void;
}) {
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [source, setSource] = useState('');
  const [confirm, setConfirm] = useState(false);
  const label_ = (id: string | null) =>
    id === null
      ? 'All data sources'
      : (sources.find((entry) => entry.id === id)?.label ?? id);

  return (
    <section className="studio-card list-card">
      <header>
        <div>
          <h2>
            <code>{`{{list:${list.name}}}`}</code>
          </h2>
          <p className="studio-muted">
            {TYPE_HINT[list.type]}
            {list.description && ` · ${list.description}`}
          </p>
        </div>
        {confirm ? (
          <span className="list-confirm">
            Queries that read it will fail.{' '}
            <button
              type="button"
              className="studio-button danger"
              onClick={onDelete}
            >
              Delete
            </button>
            <button
              type="button"
              className="studio-button"
              onClick={() => setConfirm(false)}
            >
              Keep
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="studio-icon-button"
            aria-label={`Delete the list ${list.name}`}
            onClick={() => setConfirm(true)}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        )}
      </header>
      <table className="query-table">
        <thead>
          <tr>
            <th scope="col">Value</th>
            <th scope="col">Name</th>
            {sources.length > 1 && <th scope="col">Data source</th>}
            <th scope="col">Added</th>
            <th scope="col">
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.values.map((entry) => (
            <tr key={entry.id}>
              <td className="mono">{entry.value}</td>
              <td>{entry.label || <span className="studio-muted">—</span>}</td>
              {sources.length > 1 && (
                <td className="quiet-cell">{label_(entry.source)}</td>
              )}
              <td className="quiet-cell nowrap">
                {new Date(entry.addedAt).toLocaleDateString()}
                {entry.addedBy && ` · ${entry.addedBy}`}
              </td>
              <td className="row-actions">
                <button
                  type="button"
                  className="studio-icon-button"
                  aria-label={`Remove ${entry.value}`}
                  onClick={() => onRemove(entry.id)}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </td>
            </tr>
          ))}
          {list.values.length === 0 && (
            <tr>
              <td colSpan={5} className="studio-muted">
                Empty: queries read an empty array.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <form
        className="list-add"
        onSubmit={(event) => {
          event.preventDefault();
          void onAdd({ value, label, source: source || null }).then((done) => {
            if (!done) return;
            setValue('');
            setLabel('');
          });
        }}
      >
        <input
          className="studio-input mono"
          required
          placeholder={PLACEHOLDER[list.type]}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-label="Value"
        />
        <input
          className="studio-input"
          placeholder="Name (optional)"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          aria-label="Name"
        />
        {sources.length > 1 && (
          <select
            className="studio-input"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            aria-label="Data source"
          >
            <option value="">All data sources</option>
            {sources.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        )}
        <button type="submit" className="studio-button">
          <Plus size={13} aria-hidden="true" /> Add
        </button>
      </form>
    </section>
  );
}

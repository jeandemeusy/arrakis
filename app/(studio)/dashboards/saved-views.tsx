'use client';

import { useEffect, useRef, useState } from 'react';
import { Bookmark, Check, ChevronDown, Plus, Trash2, X } from 'lucide-react';
import { api, ApiError, type DashboardVariable, type Network } from '../api';

type View = { id: string; name: string; variables: Record<string, string> };

export function SavedViews({ slug, variables, networks, vars, editable, onApply }: {
  slug: string;
  variables: DashboardVariable[];
  networks: Network[];
  vars: Record<string, string | undefined>;
  editable: boolean;
  onApply: (variables: Record<string, string>) => void;
}) {
  const [views, setViews] = useState<View[]>([]);
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const path = `/api/v1/dashboards/${encodeURIComponent(slug)}/views`;
  const current = Object.fromEntries(Object.entries(vars).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const normalized = (variable: DashboardVariable, raw: string | undefined) => {
    if (variable.type !== 'network') return raw ?? '';
    const allowed = variable.networks ? networks.filter((network) => variable.networks!.includes(network.id)) : networks;
    return (variable.stack === false || allowed.length === 1) && (!raw || raw === 'all') ? allowed[0]?.id ?? '' : raw ?? '';
  };
  const matches = (view: View) => variables.every((variable) => normalized(variable, vars[variable.name]) === normalized(variable, view.variables[variable.name]));
  const active = views.find(matches);

  useEffect(() => {
    let live = true;
    api<{ views: View[] }>(path)
      .then((result) => { if (live) setViews(result.views); })
      .catch((failure: ApiError) => { if (live) setError(failure.message); });
    return () => { live = false; };
  }, [path]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); button.current?.focus(); }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [open]);
  useEffect(() => { if (adding) input.current?.focus(); }, [adding]);

  const describe = (values: Record<string, string | undefined>) => variables.map((variable) => {
    const value = normalized(variable, values[variable.name]);
    const label = value ? (variable.labels?.[value] ?? (variable.type === 'network' ? (value === 'all' ? 'All, stacked' : networks.find((network) => network.id === value)?.label) : undefined) ?? value) : 'Any';
    const short = /^0x[0-9a-f]{16,}$/i.test(label) ? `${label.slice(0, 6)}…${label.slice(-4)}` : label;
    return `${variable.label}: ${short}`;
  }).join(' · ');
  const save = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setError('');
    try {
      const { view } = await api<{ view: View }>(path, { method: 'POST', body: { name: name.trim(), variables: current } });
      setViews((old) => [...old, view].sort((a, b) => a.name.localeCompare(b.name)));
      setName(''); setAdding(false);
    } catch (failure) { setError((failure as ApiError).message); }
    finally { setBusy(false); }
  };
  const update = async (id: string) => {
    setBusy(true); setError('');
    try {
      const { view } = await api<{ view: View }>(`${path}?id=${encodeURIComponent(id)}`, { method: 'PATCH', body: { variables: current } });
      setViews((old) => old.map((entry) => entry.id === id ? view : entry));
      setUpdating(null);
    } catch (failure) { setError((failure as ApiError).message); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    setBusy(true); setError('');
    try {
      await api(`${path}?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      setViews((old) => old.filter((view) => view.id !== id));
      setDeleting(null);
    } catch (failure) { setError((failure as ApiError).message); }
    finally { setBusy(false); }
  };
  if (!editable && views.length === 0 && !error) return null;
  return (
    <div className="dashboard-saved-views menu-anchor" ref={anchor}>
      <button ref={button} type="button" className="studio-button saved-views-trigger" aria-expanded={open} aria-controls="saved-views-panel" onClick={() => { const rect = button.current?.getBoundingClientRect(); setAlignRight(Boolean(rect && rect.left + Math.min(380, window.innerWidth - 32) > window.innerWidth - 16)); setOpen(!open); setAdding(false); setDeleting(null); setUpdating(null); }}>
        <Bookmark size={14} aria-hidden="true" /> <span>{active ? active.name : 'Views'}</span><ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && <section className={`menu saved-views-panel${alignRight ? ' align-right' : ''}`} id="saved-views-panel" aria-label="Saved views">
        <header><div><strong>Saved views</strong><p>Save and return to a set of filters.</p></div><button className="saved-view-icon" type="button" aria-label="Close saved views" onClick={() => setOpen(false)}><X size={15} /></button></header>
        {views.length ? <ul className="saved-views-list">{views.map((view) => <li key={view.id}>
          <button type="button" className="saved-view-apply" onClick={() => { onApply(view.variables); setOpen(false); }}>
            <span><strong>{view.name}</strong>{matches(view) && <span className="saved-view-current"><Check size={12} aria-hidden="true" /> Current</span>}</span>
            <small title={describe(view.variables)}>{describe(view.variables)}</small>
          </button>
          {editable && <div className="saved-view-actions">
            {updating === view.id ? <><span>Replace with current filters?</span><button type="button" disabled={busy} onClick={() => void update(view.id)}>Replace</button><button type="button" onClick={() => setUpdating(null)}>Cancel</button></> : deleting === view.id ? <><span>Delete?</span><button type="button" disabled={busy} onClick={() => void remove(view.id)}>Delete</button><button type="button" onClick={() => setDeleting(null)}>Cancel</button></> : <>
              {!matches(view) && <button type="button" disabled={busy} onClick={() => setUpdating(view.id)}>Update filters</button>}
              <button className="saved-view-icon" type="button" aria-label={`Delete ${view.name}`} title="Delete view" onClick={() => setDeleting(view.id)}><Trash2 size={14} /></button>
            </>}
          </div>}
        </li>)}</ul> : <p className="saved-views-empty">No saved views yet. Choose your filters, then save them for later.</p>}
        {editable && (adding ? <form onSubmit={(event) => void save(event)} className="saved-view-form">
          <label htmlFor="saved-view-name">Name this view</label>
          <input ref={input} id="saved-view-name" className="studio-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Last 500k blocks" maxLength={120} required />
          <p title={describe(current)}>{describe(current)}</p>
          <small>Visible to everyone who can open this dashboard.</small>
          <div><button className="studio-button" disabled={busy || !name.trim()}>Save view</button><button type="button" className="studio-button" onClick={() => { setAdding(false); setError(''); }}>Cancel</button></div>
        </form> : <button type="button" className="studio-button saved-view-add" onClick={() => { setAdding(true); setError(''); }}><Plus size={14} aria-hidden="true" /> Save current filters</button>)}
        {error && <p className="studio-error" role="alert">{error}</p>}
      </section>}
    </div>
  );
}

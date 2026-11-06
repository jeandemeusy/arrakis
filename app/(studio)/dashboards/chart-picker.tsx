'use client';

import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { type SavedVisualization } from '../api';
import { TYPE_ICONS } from '../queries/visualizations-panel';

/** Adding a chart: every saved chart, by query, found as you type. */
export function ChartPicker({
  catalog,
  onPick,
  onClose,
}: {
  catalog: SavedVisualization[];
  onPick: (visualization: SavedVisualization) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') onClose();
      } else if (!frame.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [onClose]);
  const needle = search.trim().toLowerCase();
  const groups = new Map<string, SavedVisualization[]>();
  for (const visualization of catalog) {
    if (
      needle &&
      !`${visualization.title} ${visualization.queryTitle} ${visualization.type}`
        .toLowerCase()
        .includes(needle)
    )
      continue;
    const list = groups.get(visualization.queryTitle) ?? [];
    list.push(visualization);
    groups.set(visualization.queryTitle, list);
  }
  return (
    <div className="chart-picker" ref={frame}>
      <label className="chart-picker-search">
        <Search size={14} aria-hidden="true" />
        <input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the picker opens to be typed into
          autoFocus
          placeholder="Find a chart or query…"
          aria-label="Find a chart"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div className="chart-picker-list">
        {[...groups.entries()].map(([query, list]) => (
          <section key={query}>
            <h4>{query}</h4>
            {list.map((visualization) => {
              const Icon = TYPE_ICONS[visualization.type];
              return (
                <button
                  key={visualization.id}
                  type="button"
                  onClick={() => onPick(visualization)}
                >
                  <Icon size={14} aria-hidden="true" />
                  <span>{visualization.title}</span>
                  <small>{visualization.type}</small>
                </button>
              );
            })}
          </section>
        ))}
        {!groups.size && (
          <p className="studio-muted">
            {catalog.length
              ? 'No chart matches.'
              : 'No charts yet: make one on a query first.'}
          </p>
        )}
      </div>
    </div>
  );
}

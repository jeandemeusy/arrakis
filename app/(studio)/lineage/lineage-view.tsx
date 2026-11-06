'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  ChartColumn,
  Database,
  LayoutDashboard,
  Puzzle,
  Search,
  Table2,
  X,
  type LucideIcon,
} from 'lucide-react';

import type { Lineage, LineageKind, LineageNode } from '../api';
import { useLineage } from '../lineage-data';
import { useSession } from '../session';

/**
 * Lineage: every table, fragment, query, chart and dashboard as a column, left
 * to right in the direction data flows, with a line for each "reads". Picking
 * an item lights up everything upstream of it (what it is made from) and
 * downstream (what would change with it), and dims the rest.
 */

const COLUMNS: Array<{ kind: LineageKind; label: string; icon: LucideIcon }> = [
  { kind: 'table', label: 'Tables', icon: Table2 },
  { kind: 'fragment', label: 'Fragments', icon: Puzzle },
  { kind: 'query', label: 'Queries', icon: Database },
  { kind: 'chart', label: 'Charts', icon: ChartColumn },
  { kind: 'dashboard', label: 'Dashboards', icon: LayoutDashboard },
];

type Box = { x: number; y: number; w: number; h: number };

type Graph = {
  byId: Map<string, LineageNode>;
  parents: Map<string, string[]>;
  children: Map<string, string[]>;
};

function graphOf(lineage: Lineage): Graph {
  const byId = new Map(lineage.nodes.map((node) => [node.id, node]));
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const { from, to } of lineage.edges) {
    if (!byId.has(from) || !byId.has(to)) continue;
    parents.set(to, [...(parents.get(to) ?? []), from]);
    children.set(from, [...(children.get(from) ?? []), to]);
  }
  return { byId, parents, children };
}

/** Everything reachable from `start` along `next`, `start` left out. */
function reach(start: string, next: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const id = queue.pop()!;
    for (const neighbour of next.get(id) ?? []) {
      if (seen.has(neighbour) || neighbour === start) continue;
      seen.add(neighbour);
      queue.push(neighbour);
    }
  }
  return seen;
}

/**
 * Orders each column so lines cross as little as is cheap to arrange: tables by
 * name, then every other column by the average place of what it reads
 * (fragments that read fragments after the ones they read).
 */
function columnsOf(lineage: Lineage, graph: Graph): Map<LineageKind, string[]> {
  const out = new Map<LineageKind, string[]>();
  const place = new Map<string, number>();
  const depth = new Map<string, number>();
  const depthOf = (id: string, trail = new Set<string>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (trail.has(id)) return 0;
    trail.add(id);
    const node = graph.byId.get(id);
    const same = (graph.parents.get(id) ?? []).filter(
      (parent) => graph.byId.get(parent)?.kind === node?.kind,
    );
    const value = same.length
      ? 1 + Math.max(...same.map((parent) => depthOf(parent, trail)))
      : 0;
    depth.set(id, value);
    return value;
  };
  for (const { kind } of COLUMNS) {
    const ids = lineage.nodes
      .filter((node) => node.kind === kind)
      .map((node) => node.id);
    const centre = (id: string) => {
      const placed = (graph.parents.get(id) ?? [])
        .map((parent) => place.get(parent))
        .filter((value): value is number => value !== undefined);
      return placed.length
        ? placed.reduce((sum, value) => sum + value, 0) / placed.length
        : Number.POSITIVE_INFINITY;
    };
    const label = (id: string) => graph.byId.get(id)?.label ?? id;
    const sorted =
      kind === 'table'
        ? ids.sort((a, b) => label(a).localeCompare(label(b)))
        : ids
            .map((id) => ({ id, depth: depthOf(id), centre: centre(id) }))
            .sort(
              (a, b) =>
                a.depth - b.depth ||
                a.centre - b.centre ||
                label(a.id).localeCompare(label(b.id)),
            )
            .map((entry) => entry.id);
    sorted.forEach((id, index) =>
      place.set(id, sorted.length > 1 ? index / (sorted.length - 1) : 0.5),
    );
    out.set(kind, sorted);
  }
  return out;
}

function edgePath(from: Box, to: Box, sameColumn: boolean): string {
  const y1 = from.y + from.h / 2;
  const y2 = to.y + to.h / 2;
  if (sameColumn) {
    const x = Math.max(from.x + from.w, to.x + to.w);
    const bend = 28 + Math.min(60, Math.abs(y2 - y1) / 6);
    return `M ${from.x + from.w} ${y1} C ${x + bend} ${y1}, ${x + bend} ${y2}, ${to.x + to.w} ${y2}`;
  }
  const x1 = from.x + from.w;
  const x2 = to.x;
  const dx = Math.max(24, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export function LineageView({ initialFocus }: { initialFocus?: string }) {
  const { lineage, error } = useLineage();
  const { user } = useSession();
  const [focus, setFocusState] = useState<string | null>(initialFocus ?? null);
  const [filter, setFilter] = useState('');
  const [boxes, setBoxes] = useState<Map<string, Box>>(new Map());
  const canvas = useRef<HTMLDivElement>(null);

  const setFocus = (id: string | null) => {
    setFocusState(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('focus', id);
    else url.searchParams.delete('focus');
    window.history.replaceState(window.history.state, '', url);
  };

  const graph = useMemo(() => (lineage ? graphOf(lineage) : null), [lineage]);
  const columns = useMemo(
    () => (lineage && graph ? columnsOf(lineage, graph) : null),
    [lineage, graph],
  );

  const focused = focus && graph?.byId.has(focus) ? focus : null;
  const upstream = useMemo(
    () =>
      focused && graph ? reach(focused, graph.parents) : new Set<string>(),
    [focused, graph],
  );
  const downstream = useMemo(
    () =>
      focused && graph ? reach(focused, graph.children) : new Set<string>(),
    [focused, graph],
  );

  // The filter keeps what matches and everything connected to it.
  const shown = useMemo(() => {
    if (!lineage || !graph) return null;
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return null;
    const keep = new Set<string>();
    for (const node of lineage.nodes) {
      const text =
        `${node.label} ${node.detail} ${node.description}`.toLowerCase();
      if (!words.every((word) => text.includes(word))) continue;
      keep.add(node.id);
      for (const id of reach(node.id, graph.parents)) keep.add(id);
      for (const id of reach(node.id, graph.children)) keep.add(id);
    }
    return keep;
  }, [filter, lineage, graph]);

  // Where every node sits, measured once laid out and again when it moves.
  useEffect(() => {
    const root = canvas.current;
    if (!root) return;
    const measure = () => {
      const origin = root.getBoundingClientRect();
      const next = new Map<string, Box>();
      for (const element of root.querySelectorAll<HTMLElement>('[data-node]')) {
        const rect = element.getBoundingClientRect();
        next.set(element.dataset.node!, {
          x: rect.left - origin.left,
          y: rect.top - origin.top,
          w: rect.width,
          h: rect.height,
        });
      }
      setBoxes(next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const column of root.querySelectorAll('.lineage-column'))
      observer.observe(column);
    return () => observer.disconnect();
  }, [columns, shown]);

  const node = focused ? graph?.byId.get(focused) : null;
  const visible = (id: string) => !shown || shown.has(id);
  const related = (id: string) =>
    !focused || id === focused || upstream.has(id) || downstream.has(id);

  const edges = (lineage?.edges ?? []).filter(
    (edge) =>
      visible(edge.from) &&
      visible(edge.to) &&
      boxes.has(edge.from) &&
      boxes.has(edge.to),
  );
  const lit = (from: string, to: string) =>
    Boolean(focused) &&
    (((from === focused || downstream.has(from)) && downstream.has(to)) ||
      ((to === focused || upstream.has(to)) && upstream.has(from)));

  const columnsShown = COLUMNS.filter(
    (column) => (columns?.get(column.kind)?.length ?? 0) > 0,
  );

  return (
    <main className="studio-page lineage-page">
      <header className="page-head">
        <div>
          <h1>Lineage</h1>
          <p className="studio-muted">
            What every chart is made from, and what would change with it. Pick
            an item to follow it upstream to the tables it reads and downstream
            to the dashboards that show it.
            {user === null &&
              ' Tables and private queries are listed for editors.'}
          </p>
        </div>
        <label className="lineage-filter">
          <Search size={14} aria-hidden="true" />
          <input
            className="studio-input"
            type="search"
            placeholder="Filter, e.g. a table or a chart"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            aria-label="Filter the lineage"
          />
        </label>
      </header>

      {node && (
        <div className="lineage-focus">
          <span className={`lineage-kind kind-${node.kind}`}>{node.kind}</span>
          <strong>{node.label}</strong>
          {node.detail && <code>{node.detail}</code>}
          <span className="studio-muted">
            {upstream.size} upstream · {downstream.size} downstream
          </span>
          <span className="results-spacer" />
          {node.kind !== 'table' && (
            <Link className="studio-button" href={node.href}>
              Open <ArrowUpRight size={13} aria-hidden="true" />
            </Link>
          )}
          <button
            type="button"
            className="studio-icon-button"
            aria-label="Clear the selection"
            onClick={() => setFocus(null)}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}

      {error && <p className="studio-error">{error}</p>}
      {!lineage && !error && <p className="studio-muted">Loading…</p>}
      {lineage && !lineage.nodes.length && (
        <p className="studio-muted">Nothing saved yet.</p>
      )}

      {columns && lineage && lineage.nodes.length > 0 && (
        <div
          className={`lineage-canvas ${focused ? 'has-focus' : ''}`}
          ref={canvas}
          style={{ '--lineage-columns': columnsShown.length } as never}
        >
          <svg className="lineage-edges" aria-hidden="true">
            {edges.map((edge) => {
              const from = boxes.get(edge.from)!;
              const to = boxes.get(edge.to)!;
              const same =
                graph?.byId.get(edge.from)?.kind ===
                graph?.byId.get(edge.to)?.kind;
              return (
                <path
                  key={`${edge.from}>${edge.to}`}
                  d={edgePath(from, to, same)}
                  className={lit(edge.from, edge.to) ? 'lit' : ''}
                />
              );
            })}
          </svg>
          {columnsShown.map((column) => {
            const ids = (columns.get(column.kind) ?? []).filter(visible);
            const Icon = column.icon;
            return (
              <section
                key={column.kind}
                className="lineage-column"
                aria-label={column.label}
              >
                <h2>
                  {column.label} <span className="count">{ids.length}</span>
                </h2>
                <ul>
                  {ids.map((id) => {
                    const entry = graph!.byId.get(id)!;
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          data-node={id}
                          className={`lineage-node kind-${entry.kind} ${
                            related(id) ? '' : 'dim'
                          } ${upstream.has(id) ? 'up' : ''} ${
                            downstream.has(id) ? 'down' : ''
                          }`}
                          aria-pressed={id === focused}
                          title={entry.description || entry.label}
                          onClick={() => setFocus(id === focused ? null : id)}
                        >
                          <Icon size={13} aria-hidden="true" />
                          <span>{entry.label}</span>
                        </button>
                      </li>
                    );
                  })}
                  {!ids.length && <li className="studio-muted">None</li>}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}

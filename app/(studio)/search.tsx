'use client';

import { useRouter } from 'next/navigation';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  BookOpen,
  ChartColumn,
  CornerDownLeft,
  Database,
  FileText,
  LayoutDashboard,
  Puzzle,
  Search,
  Table2,
  type LucideIcon,
} from 'lucide-react';

import type { LineageKind } from './api';
import { GUIDE_TOPICS } from './guide/topics';
import { useLineage } from './lineage-data';
import { useSession } from './session';

/**
 * The search palette: Cmd/Ctrl+K (or `/`) from anywhere in the studio finds a
 * dashboard, query, fragment, chart, table, page or guide section, and Enter
 * opens it. Everything it searches comes from the lineage endpoint, fetched
 * when the palette first opens, and is matched in the browser as you type.
 */

let isOpen = false;
const listeners = new Set<() => void>();

export function openSearch(open = true) {
  isOpen = open;
  for (const listener of listeners) listener();
}

function useSearchOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => isOpen,
    () => false,
  );
}

type Group = LineageKind | 'page' | 'guide';

type Item = {
  id: string;
  group: Group;
  label: string;
  detail: string;
  description: string;
  href: string;
};

const GROUPS: Array<{ id: Group; label: string; icon: LucideIcon }> = [
  { id: 'page', label: 'Pages', icon: FileText },
  { id: 'dashboard', label: 'Dashboards', icon: LayoutDashboard },
  { id: 'query', label: 'Queries', icon: Database },
  { id: 'chart', label: 'Charts', icon: ChartColumn },
  { id: 'fragment', label: 'Fragments', icon: Puzzle },
  { id: 'table', label: 'Tables', icon: Table2 },
  { id: 'guide', label: 'Guide', icon: BookOpen },
];

const PER_GROUP = 6;

function pages(editor: boolean): Item[] {
  const page = (href: string, label: string, detail = ''): Item => ({
    id: `page:${href}`,
    group: 'page',
    label,
    detail,
    description: '',
    href,
  });
  return [
    page('/', 'Home', 'Every dashboard'),
    page('/queries', 'Queries', 'Every saved query'),
    ...(editor ? [page('/queries/new', 'New query')] : []),
    page('/lineage', 'Lineage', 'What reads what'),
    page('/guide', 'Guide', 'How Arrakis works, and questions'),
    page('/settings', 'Settings'),
    ...(editor
      ? [
          page('/settings/lists', 'Lists', 'Values queries read'),
          page('/settings/bundles', 'Bundles', 'Import or export dashboards'),
          page('/settings/runs', 'Running now', 'Settings'),
        ]
      : []),
  ];
}

const GUIDE: Item[] = GUIDE_TOPICS.map((entry) => ({
  id: `guide:${entry.id}`,
  group: 'guide',
  label: entry.title,
  detail: 'Guide',
  description: entry.summary,
  href: `/guide#${entry.id}`,
}));

/**
 * Every word typed must appear somewhere; a match in the label counts most,
 * at its start most of all, then the slug or context, then the description.
 */
function score(item: Item, words: string[]): number {
  const label = item.label.toLowerCase();
  const detail = item.detail.toLowerCase();
  const description = item.description.toLowerCase();
  let total = 0;
  for (const word of words) {
    if (label.startsWith(word)) total += 8;
    else if (label.includes(` ${word}`)) total += 6;
    else if (label.includes(word)) total += 4;
    else if (detail.includes(word)) total += 3;
    else if (description.includes(word)) total += 1;
    else return 0;
  }
  return total;
}

export function SearchPalette() {
  const open = useSearchOpen();
  const router = useRouter();
  const { user } = useSession();
  const { lineage, error } = useLineage(open);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);

  // Cmd/Ctrl+K anywhere; `/` when not typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch(!isOpen);
        return;
      }
      const target = event.target as HTMLElement | null;
      const typing =
        target?.closest('input, textarea, select, [contenteditable="true"]') !=
        null;
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        openSearch(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A click on the backdrop, outside the box, closes it.
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const onClick = (event: MouseEvent) => {
      if (event.target === node) openSearch(false);
    };
    node.addEventListener('click', onClick);
    return () => node.removeEventListener('click', onClick);
  }, []);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      node.showModal();
      input.current?.select();
    } else if (!open && node.open) node.close();
  }, [open]);

  const items = useMemo<Item[]>(
    () => [
      ...pages(Boolean(user)),
      ...(lineage?.nodes ?? []).map((node) => ({
        id: node.id,
        group: node.kind,
        label: node.label,
        detail: node.detail,
        description: node.description,
        href: node.href,
      })),
      ...GUIDE,
    ],
    [lineage, user],
  );

  const sections = useMemo(() => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    return GROUPS.map((group) => {
      const inGroup = items.filter((item) => item.group === group.id);
      const ranked = words.length
        ? inGroup
            .map((item) => ({ item, score: score(item, words) }))
            .filter((entry) => entry.score > 0)
            .sort(
              (a, b) =>
                b.score - a.score || a.item.label.localeCompare(b.item.label),
            )
            .map((entry) => entry.item)
        : // Before anything is typed: where to go, and the dashboards.
          group.id === 'page' || group.id === 'dashboard'
          ? inGroup
          : [];
      return {
        ...group,
        items: ranked.slice(0, PER_GROUP),
        more: Math.max(0, ranked.length - PER_GROUP),
      };
    })
      .filter((section) => section.items.length)
      .map((section, _, all) => {
        // Each item's place in the whole list, for the arrow keys.
        const before = all
          .slice(0, all.indexOf(section))
          .reduce((sum, entry) => sum + entry.items.length, 0);
        return {
          ...section,
          items: section.items.map((item, at) => ({ item, at: before + at })),
        };
      });
  }, [items, text]);

  const flat = useMemo(
    () => sections.flatMap((section) => section.items.map(({ item }) => item)),
    [sections],
  );
  const current = Math.min(active, Math.max(0, flat.length - 1));

  useEffect(() => {
    list.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [current, flat]);

  const close = () => {
    openSearch(false);
    setText('');
    setActive(0);
  };

  const go = (item: Item | undefined) => {
    if (!item) return;
    close();
    router.push(item.href);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current + 1) % Math.max(1, flat.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current - 1 + flat.length) % Math.max(1, flat.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      go(flat[current]);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="search-palette"
      aria-label="Search"
      onClose={close}
    >
      <div className="search-box">
        <div className="search-field">
          <Search size={16} aria-hidden="true" />
          <input
            ref={input}
            type="text"
            aria-label="Search"
            aria-controls="search-results"
            placeholder="Search dashboards, queries, charts, tables…"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <kbd>esc</kbd>
        </div>
        <ul
          id="search-results"
          ref={list}
          className="search-results"
          aria-label="Results"
        >
          {sections.map((section) => (
            <li key={section.id}>
              <span className="search-group">{section.label}</span>
              <ul>
                {section.items.map(({ item, at }) => {
                  const Icon = section.icon;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        tabIndex={-1}
                        className="search-item"
                        aria-current={at === current ? 'true' : undefined}
                        onMouseMove={() => at !== current && setActive(at)}
                        onClick={() => go(item)}
                      >
                        <Icon size={15} aria-hidden="true" />
                        <span className="search-label">{item.label}</span>
                        {item.detail && (
                          <span className="search-detail">{item.detail}</span>
                        )}
                        {at === current && (
                          <CornerDownLeft
                            size={13}
                            aria-hidden="true"
                            className="search-enter"
                          />
                        )}
                      </button>
                    </li>
                  );
                })}
                {section.more > 0 && (
                  <li className="search-more">
                    {section.more} more — keep typing to narrow
                  </li>
                )}
              </ul>
            </li>
          ))}
          {!flat.length && (
            <li className="search-empty">
              {lineage || error ? `Nothing matches “${text}”.` : 'Loading…'}
            </li>
          )}
        </ul>
        <div className="search-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> to open
          </span>
          <span>
            <kbd>⌘K</kbd> anywhere
          </span>
          {error && <span className="studio-error">{error}</span>}
        </div>
      </div>
    </dialog>
  );
}

/** The sidebar's search field: a button that opens the palette. */
export function SearchButton({ onOpen }: { onOpen?: () => void }) {
  return (
    <button
      type="button"
      className="sidebar-search"
      title="Search (Cmd/Ctrl+K)"
      onClick={() => {
        onOpen?.();
        openSearch(true);
      }}
    >
      <Search size={15} aria-hidden="true" />
      <span>Search</span>
      <kbd>⌘K</kbd>
    </button>
  );
}

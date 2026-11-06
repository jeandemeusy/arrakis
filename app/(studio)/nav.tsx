'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

/**
 * What the sidebar shows beyond its fixed links: the sections of the
 * dashboard on screen, published by that dashboard, and whether the sidebar
 * is folded to icons — a per-browser preference kept in local storage.
 */

export type NavSection = { id: string; title: string };

type NavState = {
  dashboard: { slug: string; sections: NavSection[] } | null;
  setDashboard: (
    value: { slug: string; sections: NavSection[] } | null,
  ) => void;
  /** Bumped when dashboards are created, archived or installed. */
  dashboardsRevision: number;
  dashboardsChanged: () => void;
};

const NavContext = createContext<NavState>({
  dashboard: null,
  setDashboard: () => undefined,
  dashboardsRevision: 0,
  dashboardsChanged: () => undefined,
});

export function NavProvider({ children }: { children: React.ReactNode }) {
  const [dashboard, setDashboard] = useState<NavState['dashboard']>(null);
  const [dashboardsRevision, setRevision] = useState(0);
  const value = useMemo(
    () => ({
      dashboard,
      setDashboard,
      dashboardsRevision,
      dashboardsChanged: () => setRevision((current) => current + 1),
    }),
    [dashboard, dashboardsRevision],
  );
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav(): NavState {
  return useContext(NavContext);
}

/** A heading's anchor: its text as a slug, unique on the page. */
export function sectionIds(titles: string[]): string[] {
  const seen = new Map<string, number>();
  return titles.map((title) => {
    const base =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'section';
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count + 1}` : base;
  });
}

/** Publishes a dashboard's sections to the sidebar while it is on screen. */
export function useDashboardSections(slug: string, sections: NavSection[]) {
  const { setDashboard } = useNav();
  const key = JSON.stringify(sections);
  useEffect(() => {
    setDashboard({ slug, sections: JSON.parse(key) as NavSection[] });
    return () => setDashboard(null);
  }, [slug, key, setDashboard]);
}

// The folded state, read from local storage the way the visual style is:
// through an external store, so the server render and hydration agree.
const FOLDED_KEY = 'arrakis.sidebar.folded';
const listeners = new Set<() => void>();

function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLDED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setFolded(folded: boolean) {
  try {
    localStorage.setItem(FOLDED_KEY, folded ? '1' : '0');
  } catch {
    // Storage refused: the sidebar still folds, just not for the next visit.
  }
  memory = folded;
  for (const listener of listeners) listener();
}

let memory: boolean | null = null;

export function useFolded(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (memory ??= readFolded()),
    () => false,
  );
}

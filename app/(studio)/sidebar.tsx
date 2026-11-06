'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  BookOpen,
  Database,
  Folder,
  House,
  LayoutDashboard,
  LogIn,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react';

import { Logo } from '../logo';
import { StyleSwitch, ThemeSwitch } from '../style';
import { api } from './api';
import { SearchButton } from './search';
import { setFolded, useFolded, useNav } from './nav';
import { useSession } from './session';
import { LockedLink } from './locked-link';
import { SETTINGS_PAGES } from './settings/settings-pages';

/**
 * The studio's navigation: home, every dashboard (with the sections of the
 * one on screen), queries and settings, plus the style switch and the
 * editing lock. Folds to icons on wide screens; a drawer on narrow ones.
 */

type DashboardLink = {
  slug: string;
  title: string;
  official: boolean;
  folderId: string | null;
};
type DashboardFolder = { id: string; name: string };

function NavLink({
  href,
  icon: Icon,
  label,
  active,
  className,
  onNavigate,
  locked = false,
}: {
  href: string;
  icon?: LucideIcon;
  label: string;
  active: boolean;
  className?: string;
  onNavigate: () => void;
  locked?: boolean;
}) {
  return (
    <LockedLink
      href={href}
      className={`nav-link ${className ?? ''}`}
      title={label}
      onClick={onNavigate}
      locked={locked}
      active={active}
    >
      {Icon && <Icon size={16} aria-hidden="true" />}
      <span>{label}</span>
    </LockedLink>
  );
}

/** The section of the dashboard currently in view, for the highlight. */
function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join('|');
  useEffect(() => {
    if (!key) return;
    const targets = key
      .split('|')
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null);
    if (!targets.length) return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting)
            visible.set(entry.target.id, entry.boundingClientRect.top);
          else visible.delete(entry.target.id);
        }
        // The topmost heading on screen; past the last one, keep the last.
        const first = [...visible.entries()].sort((a, b) => a[1] - b[1])[0];
        if (first) setActive(first[0]);
      },
      { rootMargin: '0px 0px -55% 0px' },
    );
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [key]);
  return active;
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, signOut } = useSession();
  const { dashboard, dashboardsRevision } = useNav();
  const folded = useFolded();
  const [open, setOpen] = useState(false);
  const [dashboards, setDashboards] = useState<DashboardLink[] | null>(null);
  const [folders, setFolders] = useState<DashboardFolder[]>([]);
  const activeSection = useActiveSection(
    dashboard?.sections.map((section) => section.id) ?? [],
  );

  useEffect(() => {
    let live = true;
    api<{ dashboards: DashboardLink[] }>('/api/v1/dashboards')
      .then(({ dashboards: list }) => live && setDashboards(list))
      .catch(() => live && setDashboards([]));
    api<{ folders: DashboardFolder[] }>('/api/v1/dashboard-folders')
      .then(({ folders: list }) => live && setFolders(list))
      .catch(() => live && setFolders([]));
    return () => {
      live = false;
    };
  }, [user, dashboardsRevision]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const close = () => setOpen(false);
  const within = (prefix: string) =>
    pathname === prefix || pathname.startsWith(`${prefix}/`);
  const currentDashboard = pathname.startsWith('/dashboards/')
    ? decodeURIComponent(pathname.split('/')[2] ?? '')
    : null;

  const dashboardLink = (entry: DashboardLink) => {
    const here = currentDashboard === entry.slug;
    const sections =
      here && dashboard?.slug === entry.slug ? dashboard.sections : [];
    return (
      <li key={entry.slug}>
        <NavLink
          href={`/dashboards/${entry.slug}`}
          label={entry.title}
          active={here}
          onNavigate={close}
        />
        {sections.length > 0 && (
          <ul className="nav-sections" aria-label={`${entry.title} sections`}>
            {sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="nav-section"
                  aria-current={
                    activeSection === section.id ? 'location' : undefined
                  }
                  onClick={close}
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <>
      <header className="mobile-bar">
        <button
          type="button"
          className="mobile-menu"
          aria-label="Open navigation"
          aria-expanded={open}
          aria-controls="studio-sidebar"
          onClick={() => setOpen(true)}
        >
          <Menu size={18} aria-hidden="true" />
        </button>
        <Link className="sidebar-brand" href="/">
          <Logo />
          <span>Arrakis</span>
        </Link>
      </header>

      <aside
        id="studio-sidebar"
        className={`sidebar ${folded ? 'folded' : ''} ${open ? 'open' : ''}`}
        aria-label="Navigation"
      >
        <div className="sidebar-head">
          <Link className="sidebar-brand" href="/" onClick={close} title="Home">
            <Logo />
            <span>Arrakis</span>
          </Link>
          <button
            type="button"
            className="sidebar-icon sidebar-close"
            aria-label="Close navigation"
            onClick={close}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <SearchButton onOpen={close} />

        <nav className="sidebar-nav" aria-label="Main">
          <ul>
            <li>
              <NavLink
                href="/"
                icon={House}
                label="Home"
                active={pathname === '/'}
                onNavigate={close}
              />
            </li>
            <li className="nav-group">
              <NavLink
                href="/dashboards"
                icon={LayoutDashboard}
                label="Dashboards"
                active={pathname === '/dashboards'}
                onNavigate={close}
              />
              <ul className="nav-children">
                {folders.map((folder) => {
                  const entries =
                    dashboards?.filter(
                      (entry) => entry.folderId === folder.id,
                    ) ?? [];
                  const active = entries.some(
                    (entry) => entry.slug === currentDashboard,
                  );
                  return (
                    <li key={`${folder.id}-${active}`}>
                      <details
                        className="nav-folder"
                        open={active || undefined}
                      >
                        <summary title={folder.name}>
                          <Folder size={15} aria-hidden="true" />
                          <span>{folder.name}</span>
                        </summary>
                        <ul>
                          {entries.map(dashboardLink)}
                          {entries.length === 0 && (
                            <li className="nav-empty">Empty folder</li>
                          )}
                        </ul>
                      </details>
                    </li>
                  );
                })}
                {dashboards
                  ?.filter((entry) => !entry.folderId)
                  .map(dashboardLink)}
                {dashboards?.length === 0 && (
                  <li className="nav-empty">None yet</li>
                )}
              </ul>
            </li>
            <li>
              <NavLink
                href="/queries"
                icon={Database}
                label="Queries"
                active={within('/queries')}
                onNavigate={close}
              />
            </li>
            <li>
              <NavLink
                href="/lineage"
                icon={Workflow}
                label="Lineage"
                active={within('/lineage')}
                onNavigate={close}
              />
            </li>
            <li className="nav-group">
              <NavLink
                href="/settings"
                icon={Settings}
                label="Settings"
                active={pathname === '/settings'}
                onNavigate={close}
              />
              <ul className="nav-children">
                {SETTINGS_PAGES.map((page) => (
                  <li key={page.href}>
                    <NavLink
                      href={page.href}
                      icon={page.icon}
                      label={page.title}
                      active={within(page.href)}
                      onNavigate={close}
                      locked={page.editorOnly && user === null}
                    />
                  </li>
                ))}
              </ul>
            </li>
            <li>
              <NavLink
                href="/guide"
                icon={BookOpen}
                label="Guide"
                active={within('/guide')}
                onNavigate={close}
              />
            </li>
          </ul>
        </nav>

        <div className="sidebar-foot">
          <div className="appearance">
            <StyleSwitch />
            <ThemeSwitch />
          </div>
          {user === undefined ? null : user ? (
            <button
              type="button"
              className="nav-link"
              title="Sign out"
              onClick={() => void signOut().then(() => router.refresh())}
            >
              <LogOut size={16} aria-hidden="true" />
              <span>Sign out</span>
            </button>
          ) : (
            <Link
              className="nav-link"
              title="Sign in"
              href={`/login?next=${encodeURIComponent(pathname)}`}
              onClick={close}
            >
              <LogIn size={16} aria-hidden="true" />
              <span>Sign in</span>
            </Link>
          )}
          <button
            type="button"
            className="nav-link sidebar-fold"
            aria-pressed={folded}
            title={folded ? 'Expand the sidebar' : 'Fold the sidebar'}
            onClick={() => setFolded(!folded)}
          >
            {folded ? (
              <PanelLeftOpen size={16} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={16} aria-hidden="true" />
            )}
            <span>{folded ? 'Expand' : 'Fold'}</span>
          </button>
        </div>
      </aside>
      {open && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={close}
        />
      )}
    </>
  );
}

/** Says so, on every page, when the query store cannot be reached at all. */
export function StudioBanner() {
  const { unavailable } = useSession();
  return unavailable ? (
    <output className="studio-banner">{unavailable}</output>
  ) : null;
}

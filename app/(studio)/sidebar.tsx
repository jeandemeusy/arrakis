'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  BookOpen,
  Database,
  House,
  LayoutDashboard,
  LogIn,
  LogOut,
  Menu,
  PackageOpen,
  Activity,
  PanelLeftClose,
  PanelLeftOpen,
  ListChecks,
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

/**
 * The studio's navigation: home, every dashboard (with the sections of the
 * one on screen), queries and settings, plus the style switch and the
 * editing lock. Folds to icons on wide screens; a drawer on narrow ones.
 */

type DashboardLink = { slug: string; title: string; official: boolean };

function NavLink({
  href,
  icon: Icon,
  label,
  active,
  className,
  onNavigate,
}: {
  href: string;
  icon?: LucideIcon;
  label: string;
  active: boolean;
  className?: string;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={href}
      className={`nav-link ${className ?? ''}`}
      aria-current={active ? 'page' : undefined}
      title={label}
      onClick={onNavigate}
    >
      {Icon && <Icon size={16} aria-hidden="true" />}
      <span>{label}</span>
    </Link>
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
  const activeSection = useActiveSection(
    dashboard?.sections.map((section) => section.id) ?? [],
  );

  useEffect(() => {
    let live = true;
    api<{ dashboards: DashboardLink[] }>('/api/v1/dashboards')
      .then(({ dashboards: list }) => live && setDashboards(list))
      .catch(() => live && setDashboards([]));
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
              <span className="nav-heading" title="Dashboards">
                <LayoutDashboard size={16} aria-hidden="true" />
                <span>Dashboards</span>
              </span>
              <ul className="nav-children">
                {dashboards?.map((entry) => {
                  const here = currentDashboard === entry.slug;
                  const sections =
                    here && dashboard?.slug === entry.slug
                      ? dashboard.sections
                      : [];
                  return (
                    <li key={entry.slug}>
                      <NavLink
                        href={`/dashboards/${entry.slug}`}
                        label={entry.title}
                        active={here}
                        onNavigate={close}
                      />
                      {sections.length > 0 && (
                        <ul
                          className="nav-sections"
                          aria-label={`${entry.title} sections`}
                        >
                          {sections.map((section) => (
                            <li key={section.id}>
                              <a
                                href={`#${section.id}`}
                                className="nav-section"
                                aria-current={
                                  activeSection === section.id
                                    ? 'location'
                                    : undefined
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
                })}
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
                <li>
                  <NavLink
                    href="/settings/lists"
                    icon={ListChecks}
                    label="Lists"
                    active={within('/settings/lists')}
                    onNavigate={close}
                  />
                </li>
                {user && (
                  <li>
                    <NavLink
                      href="/settings/bundles"
                      icon={PackageOpen}
                      label="Bundles"
                      active={within('/settings/bundles')}
                      onNavigate={close}
                    />
                  </li>
                )}
                {user && (
                  <li>
                    <NavLink
                      href="/settings/runs"
                      icon={Activity}
                      label="Running now"
                      active={within('/settings/runs')}
                      onNavigate={close}
                    />
                  </li>
                )}
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
              title="Lock editing"
              onClick={() => void signOut().then(() => router.refresh())}
            >
              <LogOut size={16} aria-hidden="true" />
              <span>Lock editing</span>
            </button>
          ) : (
            <Link
              className="nav-link"
              title="Unlock editing"
              href={`/login?next=${encodeURIComponent(pathname)}`}
              onClick={close}
            >
              <LogIn size={16} aria-hidden="true" />
              <span>Unlock editing</span>
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

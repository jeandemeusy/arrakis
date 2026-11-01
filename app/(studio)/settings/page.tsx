import type { Metadata } from 'next';
import Link from 'next/link';
import { Activity, ArrowRight, PackageOpen, Waypoints } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Settings',
  robots: { index: false, follow: false },
};

const PAGES = [
  {
    href: '/settings/networks',
    icon: Waypoints,
    title: 'Exits',
    text: 'The exit nodes of each network. Downstream volume counts only the exits named here; nothing is guessed.',
  },
  {
    href: '/settings/bundles',
    icon: PackageOpen,
    title: 'Bundled dashboards',
    text: 'Dashboards that ship with arrakis, ready to install as saved queries and charts, or to bring back to their bundled version. Editors only.',
  },
  {
    href: '/settings/runs',
    icon: Activity,
    title: 'Running now',
    text: 'Every query running at this moment — previews, stored runs and scheduled refreshes — with a way to cancel any of them. Editors only.',
  },
];

export default function SettingsPage() {
  return (
    <main className="studio-page studio-medium">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="studio-muted">
            What the queries need to know that is not on chain.
          </p>
        </div>
      </header>
      <div className="settings-cards">
        {PAGES.map((page) => (
          <Link key={page.href} href={page.href} className="settings-card">
            <span className="dashboard-card-head">
              <page.icon size={16} aria-hidden="true" />
              {page.title}
              <ArrowRight className="card-arrow" size={15} aria-hidden="true" />
            </span>
            <span>{page.text}</span>
          </Link>
        ))}
      </div>
    </main>
  );
}

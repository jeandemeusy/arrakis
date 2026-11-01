import type { Metadata } from 'next';
import Link from 'next/link';
import { Activity, ArrowRight, ListChecks, PackageOpen } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Settings',
  robots: { index: false, follow: false },
};

const PAGES = [
  {
    href: '/settings/lists',
    icon: ListChecks,
    title: 'Lists',
    text: 'Values queries read as {{list:name}}, kept per data source or for all of them. Changing one reruns the queries that read it. Editors only.',
  },
  {
    href: '/settings/bundles',
    icon: PackageOpen,
    title: 'Bundles',
    text: 'Import a dashboard, its charts and its queries from a bundle file or URL. Export any dashboard as one from its Share menu. Editors only.',
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

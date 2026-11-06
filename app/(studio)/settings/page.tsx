import type { Metadata } from 'next';

import { SettingsCards } from './settings-cards';

export const metadata: Metadata = {
  title: 'Settings',
  robots: { index: false, follow: false },
};

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
      <SettingsCards />
    </main>
  );
}

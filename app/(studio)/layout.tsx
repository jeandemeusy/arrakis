import type { Metadata } from 'next';

import { NavProvider } from './nav';
import { SearchPalette } from './search';
import { SessionProvider } from './session';
import { Sidebar, StudioBanner } from './sidebar';
import './studio.css';

export const metadata: Metadata = {
  title: { template: '%s · Arrakis', default: 'Arrakis' },
};

/**
 * Every page: the dashboards, the queries behind
 * them and the settings, with the sidebar beside them. Readable by anyone for
 * what is public; editing needs Google Workspace sign-in.
 */
export default function StudioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SessionProvider>
      <NavProvider>
        <div className="studio studio-shell">
          <a className="skip-link" href="#studio-content">
            Skip to content
          </a>
          <Sidebar />
          <div className="studio-main">
            <StudioBanner />
            <div id="studio-content" className="studio-content">
              {children}
            </div>
          </div>
          <SearchPalette />
        </div>
      </NavProvider>
    </SessionProvider>
  );
}

import type { Metadata } from 'next';

import { SessionProvider } from './session';
import { StudioBar } from './studio-bar';
import './studio.css';

export const metadata: Metadata = {
  title: { template: '%s · Arrakis studio', default: 'Arrakis studio' },
  // Editing surfaces are not something a search engine should index.
  robots: { index: false, follow: false },
};

/**
 * The studio: where queries are written, versioned and run, and where the
 * exits are configured. Readable by anyone for public queries; editing needs
 * the password.
 */
export default function StudioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SessionProvider>
      <div className="studio">
        <a className="skip-link" href="#studio-content">
          Skip to content
        </a>
        <StudioBar />
        <div id="studio-content" className="studio-content">
          {children}
        </div>
      </div>
    </SessionProvider>
  );
}

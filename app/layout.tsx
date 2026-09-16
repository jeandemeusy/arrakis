import type { Metadata } from 'next';
import './globals.css';

import { DEFAULT_STYLE, STYLE_STORAGE_KEY, STYLES } from './chart-theme';

export const metadata: Metadata = {
  title: 'Arrakis',
  description:
    'Public, on-chain Gnosis VPN adoption and HOPR network metrics powered by Blokli.',
  openGraph: {
    title: 'Arrakis',
    description:
      'Private access. Public proof. Finalized on-chain metrics powered by Blokli.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Arrakis',
    description:
      'Private access. Public proof. Finalized on-chain metrics powered by Blokli.',
  },
};

/**
 * Stamps the remembered style onto <html> before the first paint.
 *
 * It has to be a blocking inline script in the head, not an effect: the page is
 * server-rendered in the default style, so anything that runs after hydration
 * shows the wrong one for a frame first. The value is checked against the known
 * styles rather than trusted, since it comes back out of the visitor's own
 * storage, and the whole thing is wrapped in a try so a browser that blocks
 * storage renders the default instead of nothing.
 */
const STYLE_BOOTSTRAP = `try{var s=localStorage.getItem(${JSON.stringify(
  STYLE_STORAGE_KEY,
)});if(${JSON.stringify(
  STYLES.map((entry) => entry.id),
)}.indexOf(s)<0)s=${JSON.stringify(
  DEFAULT_STYLE,
)};document.documentElement.dataset.style=s}catch(e){document.documentElement.dataset.style=${JSON.stringify(
  DEFAULT_STYLE,
)}}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-style={DEFAULT_STYLE}>
      <head>
        <script
          // oxlint-disable-next-line react/no-danger -- a literal built from constants above
          dangerouslySetInnerHTML={{ __html: STYLE_BOOTSTRAP }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

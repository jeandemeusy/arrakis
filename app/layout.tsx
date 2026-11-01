import type { Metadata } from 'next';
import './globals.css';

import {
  DEFAULT_STYLE,
  DEFAULT_THEME,
  STYLE_STORAGE_KEY,
  STYLES,
  THEME_STORAGE_KEY,
  THEMES,
} from './chart-theme';

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

/**
 * Light or dark, the same way: the remembered choice, `system` by default,
 * resolved against the system's setting before the first paint.
 */
const THEME_BOOTSTRAP = `try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(${JSON.stringify(
  THEMES.map((entry) => entry.id),
)}.indexOf(t)<0)t=${JSON.stringify(
  DEFAULT_THEME,
)};var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.themeChoice=t;document.documentElement.dataset.theme=d?'dark':'light'}catch(e){document.documentElement.dataset.theme='light'}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // The script below may restyle <html> before React hydrates it, on
    // purpose; only this element's own attributes are exempt from the check.
    <html
      lang="en"
      data-style={DEFAULT_STYLE}
      data-theme="light"
      suppressHydrationWarning
    >
      <head>
        <script
          // oxlint-disable-next-line react/no-danger -- a literal built from constants above
          dangerouslySetInnerHTML={{
            __html: STYLE_BOOTSTRAP + THEME_BOOTSTRAP,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

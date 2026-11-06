import type { Metadata } from 'next';
import { headers } from 'next/headers';
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
    'Query a database in SQL, keep the answers as charts, and arrange them on dashboards.',
  icons: { icon: '/favicon.svg' },
  openGraph: {
    title: 'Arrakis',
    description: 'SQL in, charts and dashboards out.',
    type: 'website',
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

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // The nonce `proxy.ts` put in this request's Content-Security-Policy; the
  // pre-paint script runs only with it. Reading it also renders every page per
  // request, which a nonce needs: a page built ahead of time would carry none.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
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
          nonce={nonce}
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

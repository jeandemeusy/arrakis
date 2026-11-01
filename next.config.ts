import type { NextConfig } from 'next';

const production = process.env.NODE_ENV === 'production';

/**
 * Headers every response carries. The content policy keeps the page to its own
 * origin: scripts, styles, data and images come from here (images may also be
 * data: and blob: URLs, which the PNG export draws with). Inline scripts stay
 * allowed — Next's hydration and the pre-paint style script are inline — and
 * the dev server also needs eval and its websocket for hot reload.
 */
const SECURITY_HEADERS = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${production ? '' : " 'unsafe-eval'"}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self'${production ? '' : ' ws: wss:'}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  // Only once served over HTTPS for good: a browser that saw it keeps to
  // HTTPS for this host for six months.
  ...(production
    ? [
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=15552000; includeSubDomains',
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  // Emits .next/standalone with a self-contained server and only the traced
  // dependencies, which is what the container image ships.
  // The package derivation enables standalone output for the container. The
  // development shell keeps ordinary output because its dependencies are
  // symlinks into the read-only Nix store, which Next's standalone tracer
  // cannot copy safely.
  output: process.env.NEXT_STANDALONE === '1' ? 'standalone' : undefined,

  // Auto-memoises client components, so a re-render caused by one widget's state
  // does not reconcile every chart and table on the page. The repo already lints
  // `react/react-compiler` as an error, so the code was written to be eligible.
  reactCompiler: true,

  // The sidebar's controls sit in the bottom-left corner, where the dev
  // indicator would cover them.
  devIndicators: { position: 'bottom-right' },

  async headers() {
    return [
      { source: '/:path*', headers: SECURITY_HEADERS },
      {
        // The page renders per request — it must not be prerendered at build
        // time, where there is no index database and it would bake a "database
        // connection pending" dashboard into the image. But the snapshot behind
        // it only changes once a minute, so the render is identical for every
        // visitor within that window and a cache in front should be allowed to
        // say so. Next sends `no-store` for a dynamic page, which this replaces.
        source: '/classic',
        headers: [
          {
            key: 'cache-control',
            value: 'public, max-age=0, s-maxage=60, stale-while-revalidate=120',
          },
        ],
      },
    ];
  },
};

export default nextConfig;

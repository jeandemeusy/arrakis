import type { NextConfig } from 'next';

const production = process.env.NODE_ENV === 'production';

/**
 * Headers every response carries. The Content-Security-Policy is not among
 * them: it needs a fresh nonce per request, so `proxy.ts` sets it.
 */
const SECURITY_HEADERS = [
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
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;

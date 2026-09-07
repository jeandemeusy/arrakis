import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Emits .next/standalone with a self-contained server and only the traced
  // dependencies, which is what the container image ships.
  output: 'standalone',

  // Auto-memoises client components, so a re-render caused by one widget's state
  // does not reconcile every chart and table on the page. The repo already lints
  // `react/react-compiler` as an error, so the code was written to be eligible.
  reactCompiler: true,

  async headers() {
    return [
      {
        // The page renders per request — it must not be prerendered at build
        // time, where there is no index database and it would bake a "database
        // connection pending" dashboard into the image. But the snapshot behind
        // it only changes once a minute, so the render is identical for every
        // visitor within that window and a cache in front should be allowed to
        // say so. Next sends `no-store` for a dynamic page, which this replaces.
        source: '/',
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

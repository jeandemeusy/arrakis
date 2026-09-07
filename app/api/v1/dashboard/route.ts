import { NextResponse } from 'next/server';

import { loadDashboard, publicDashboard } from '@/lib/analytics';

export const dynamic = 'force-dynamic';

/**
 * The dashboard data.
 *
 * `?network=<id>` returns one network's snapshot; `?network=all` the combined one.
 * Without the parameter the whole payload is returned, every network at once.
 *
 * The per-client drill-down is not included — it is one record per client and
 * dwarfs everything else — and is served by `/api/v1/client` instead.
 */
export async function GET(request: Request) {
  const dashboard = publicDashboard(await loadDashboard());
  const requested = new URL(request.url).searchParams.get('network');

  const body = requested ? dashboard.snapshots[requested] : dashboard;
  if (!body) {
    return NextResponse.json(
      { error: `Unknown network: ${requested}`, networks: dashboard.networks },
      { status: 404, headers: { 'cache-control': 'no-store' } },
    );
  }

  const unavailable = requested
    ? dashboard.snapshots[requested].source === 'unavailable'
    : Object.values(dashboard.snapshots).every(
        (snapshot) => snapshot.source === 'unavailable',
      );

  return NextResponse.json(body, {
    status: unavailable ? 503 : 200,
    headers: {
      'cache-control': 'public, max-age=30, stale-while-revalidate=120',
    },
  });
}

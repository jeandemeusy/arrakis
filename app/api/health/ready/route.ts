import { NextResponse } from 'next/server';

import { networks } from '@/lib/query/networks';
import { runReadOnly } from '@/lib/query/runner';

export const dynamic = 'force-dynamic';

/**
 * Ready when the app's own database answers (if one is configured) and at
 * least one data source does. A source that is down is reported, but does not
 * take the whole app out of rotation: the others still serve.
 */
export async function GET() {
  let app: 'ok' | 'unavailable' | 'not configured' = 'not configured';
  if (process.env.APP_DATABASE_URL?.trim()) {
    try {
      const { appDb } = await import('@/lib/db/app');
      await (await appDb()).query('SELECT 1');
      app = 'ok';
    } catch {
      app = 'unavailable';
    }
  }
  const sources = await Promise.all(
    networks().map(async (source) => {
      try {
        await runReadOnly({
          network: source,
          text: 'SELECT 1',
          values: [],
          rowLimit: 1,
          timeoutMs: 3_000,
        });
        return [source.id, 'ok'] as const;
      } catch {
        return [source.id, 'unavailable'] as const;
      }
    }),
  );
  const ready =
    app !== 'unavailable' && sources.some(([, state]) => state === 'ok');
  return NextResponse.json(
    {
      status: ready ? 'ready' : 'unavailable',
      app,
      sources: Object.fromEntries(sources),
      observedAt: new Date().toISOString(),
    },
    { status: ready ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}

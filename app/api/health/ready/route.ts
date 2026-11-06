import { NextResponse } from 'next/server';

import { networks } from '@/lib/query/networks';
import { runReadOnly } from '@/lib/query/runner';

export const dynamic = 'force-dynamic';

/**
 * Ready when the app's own database answers (if one is configured) and at
 * least one data source does. A source that is down is reported, but does not
 * take the whole app out of rotation: the others still serve.
 *
 * Anyone can ask, and a check takes a connection on every data source, whose
 * pools are small (ARRAKIS_QUERY_CONCURRENCY). So the answer is computed at
 * most once every few seconds and shared by every caller in between: a flood
 * of health checks cannot starve real queries of connections.
 */

const FRESH_MS = 10_000;

type Readiness = { status: number; body: Record<string, unknown> };

let latest: { at: number; readiness: Readiness } | undefined;
let pending: Promise<Readiness> | undefined;

async function check(): Promise<Readiness> {
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
  return {
    status: ready ? 200 : 503,
    body: {
      status: ready ? 'ready' : 'unavailable',
      app,
      sources: Object.fromEntries(sources),
      observedAt: new Date().toISOString(),
    },
  };
}

export async function GET() {
  if (!latest || Date.now() - latest.at > FRESH_MS) {
    pending ??= check().finally(() => {
      pending = undefined;
    });
    const readiness = await pending;
    latest = { at: Date.now(), readiness };
  }
  return NextResponse.json(latest.readiness.body, {
    status: latest.readiness.status,
    headers: { 'cache-control': 'no-store' },
  });
}

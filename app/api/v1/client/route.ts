import { NextResponse } from 'next/server';

import { loadClientDetail } from '@/lib/analytics';

export const dynamic = 'force-dynamic';

/**
 * One client's record, for the drill-down.
 *
 * `?network=<snapshot id>&key=<client key>`, where the key is the one the
 * snapshot's `clients` and `deployments` rows carry. Both are needed: a client
 * key is only unique within its own snapshot, and the combined view keys the same
 * address on two networks as two participants.
 *
 * Served out of the same cached snapshot the page was rendered from, so a click
 * costs a lookup rather than a query. The whole map used to be shipped with the
 * page, which paid for every client to answer for the one that gets clicked.
 */
export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const network = parameters.get('network');
  const key = parameters.get('key');

  if (!network || !key) {
    return NextResponse.json(
      { error: 'Both `network` and `key` are required' },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const detail = await loadClientDetail(network, key);
  if (!detail) {
    return NextResponse.json(
      { error: `No record for ${key} on ${network}` },
      { status: 404, headers: { 'cache-control': 'no-store' } },
    );
  }

  return NextResponse.json(detail, {
    headers: {
      'cache-control': 'public, max-age=30, stale-while-revalidate=120',
    },
  });
}

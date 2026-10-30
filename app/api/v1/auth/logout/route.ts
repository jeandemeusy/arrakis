import { assertSameOrigin, noStore, route } from '@/lib/api/handler';
import { clearedSessionCookie, endSession } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  await endSession(request);
  return noStore(request, { ok: true }, 200, {
    'set-cookie': clearedSessionCookie(),
  });
});

import { HttpError, badRequest } from '@/lib/api/errors';
import { assertSameOrigin, noStore, readBody, route } from '@/lib/api/handler';
import { authenticate, sessionCookie } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * Signs in.
 *
 * `{ "password": "…" }` signs in as the single `editor` account. A `username`
 * is accepted too, so the form only has to grow a field once there are more
 * accounts.
 */
export const POST = route(async (request: Request) => {
  assertSameOrigin(request);
  const body = await readBody(request);
  const password = body.password;
  const username = body.username;
  if (typeof password !== 'string' || !password) {
    throw badRequest('password is required');
  }
  if (password.length > 1024) throw new HttpError(401, 'Invalid credentials.');
  if (username !== undefined && typeof username !== 'string') {
    throw badRequest('username must be a string');
  }
  const { token, expiresAt, principal } = await authenticate(
    { password, username },
    request,
  );
  return noStore(
    request,
    { user: { username: principal.username, role: principal.role }, expiresAt },
    200,
    { 'set-cookie': sessionCookie(token, expiresAt) },
  );
});

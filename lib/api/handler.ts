import 'server-only';

import { currentPrincipal, type Principal } from '../auth/session';
import { json } from '../http';
import { HttpError, badRequest } from './errors';

/**
 * Shared plumbing for the query-store routes: error mapping, JSON bodies, the
 * same-origin check and the editor guard.
 */

/**
 * Whether an unexpected error is the app database being out of reach — down,
 * restarting, refusing connections — rather than a bug. Those answer 503, so
 * the studio can say the store is unavailable instead of "Internal error".
 */
function unreachable(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (typeof code !== 'string') return false;
  return (
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'ENOTFOUND',
      'ETIMEDOUT',
      'EAI_AGAIN',
    ].includes(code) || /^(08|57P0)/.test(code)
  );
}

type Handler<C> = (request: Request, context: C) => Promise<Response>;

/**
 * Wraps a route handler so an HttpError becomes its status and message, and
 * anything else becomes an opaque 500 that is logged server-side.
 */
export function route<C>(handler: Handler<C>): Handler<C> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      if (error instanceof HttpError) {
        return json(
          request,
          { error: error.message, ...error.details },
          {
            status: error.status,
            headers: { 'cache-control': 'no-store', ...error.headers },
          },
        );
      }
      console.error(
        `${request.method} ${new URL(request.url).pathname}`,
        error,
      );
      if (unreachable(error)) {
        return json(
          request,
          { error: 'Query storage is unavailable right now.' },
          { status: 503, headers: { 'cache-control': 'no-store' } },
        );
      }
      return json(
        request,
        { error: 'Internal error' },
        { status: 500, headers: { 'cache-control': 'no-store' } },
      );
    }
  };
}

export function noStore(
  request: Request,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Promise<Response> {
  return json(request, body, {
    status,
    headers: { 'cache-control': 'no-store', ...headers },
  });
}

/** Reads a JSON object body, or throws a 400 that says what was wrong. */
export async function readBody(
  request: Request,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw badRequest('Body must be JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('Body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function allowedHosts(request: Request): Set<string> {
  const hosts = new Set<string>();
  const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0];
  const host = request.headers.get('host');
  if (forwarded) hosts.add(forwarded.trim().toLowerCase());
  if (host) hosts.add(host.trim().toLowerCase());
  for (const origin of (process.env.ARRAKIS_ALLOWED_ORIGINS ?? '').split(',')) {
    const trimmed = origin.trim();
    if (!trimmed) continue;
    try {
      hosts.add(new URL(trimmed).host.toLowerCase());
    } catch {
      // Ignored rather than fatal: a typo here only narrows what is accepted.
    }
  }
  return hosts;
}

/**
 * Refuses a state-changing request sent from another site.
 *
 * The session cookie is SameSite=Strict, which already keeps it off cross-site
 * requests in current browsers; this is the second lock. Browsers always send
 * Origin on these methods, so a request without one is not a browser and has no
 * ambient cookie to abuse.
 */
export function assertSameOrigin(request: Request): void {
  if (!UNSAFE_METHODS.has(request.method)) return;
  const origin = request.headers.get('origin');
  if (!origin) return;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    throw new HttpError(403, 'Cross-origin request refused');
  }
  if (!allowedHosts(request).has(host)) {
    throw new HttpError(403, 'Cross-origin request refused');
  }
}

/**
 * The editor guard: every route that runs SQL ad hoc or changes stored state
 * goes through here, and nothing else decides who may edit.
 */
export async function requireEditor(request: Request): Promise<Principal> {
  assertSameOrigin(request);
  const principal = await currentPrincipal(request);
  if (!principal) throw new HttpError(401, 'Sign in to edit.');
  return principal;
}

/** The editor, if one is signed in; public routes use it to widen what they show. */
export async function optionalEditor(
  request: Request,
): Promise<Principal | null> {
  return currentPrincipal(request).catch(() => null);
}

/** Parameter values from a query string: `?p.start=2026-01-01&p.client=0x…`. */
export function suppliedFromSearch(url: URL): Record<string, unknown> {
  const supplied: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (key.startsWith('p.')) supplied[key.slice(2)] = value;
  }
  return supplied;
}

/** Parameter values from a JSON body's `values` object. */
export function suppliedFromBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const values = body.values;
  if (values === undefined || values === null) return {};
  if (typeof values !== 'object' || Array.isArray(values)) {
    throw badRequest('values must be an object');
  }
  return values as Record<string, unknown>;
}

export function integerParam(
  url: URL,
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw badRequest(`${name} must be an integer from 0 to ${max}`);
  }
  return value;
}

/** Dashboard variables from a query string: `?v.range=30d&v.client=0x…`. */
export function varsFromSearch(url: URL): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key.startsWith('v.')) vars[key.slice(2)] = value;
  }
  return vars;
}

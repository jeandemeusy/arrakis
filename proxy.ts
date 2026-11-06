import { NextResponse, type NextRequest } from 'next/server';

/**
 * The Content-Security-Policy, with a fresh nonce for every request.
 *
 * Scripts run only from this origin or when they carry the nonce: Next reads
 * it from the request's policy and stamps it on its own inline scripts (the
 * hydration data, the runtime), and the root layout puts it on the pre-paint
 * style script. An injected `<script>` has no nonce, so it does not run, even
 * if something ever got markup onto a page. `'strict-dynamic'` lets the
 * chunks those scripts load run too.
 *
 * Styles keep `'unsafe-inline'`: charts and layout set `style` attributes,
 * which a nonce cannot cover, and a style cannot run code.
 *
 * The page then has to render per request, which the root layout does by
 * reading the nonce. It runs on every route but the build's own static files,
 * so API responses carry the same policy.
 */

const production = process.env.NODE_ENV === 'production';

export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${production ? '' : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${production ? '' : ' ws: wss:'}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const policy = contentSecurityPolicy(nonce);

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', policy);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', policy);
  return response;
}

export const config = {
  // Everything but hashed build output and the favicon, which have no inline
  // scripts to allow. Prefetches included: a prefetched page is still a page.
  matcher: ['/((?!_next/static|_next/image|favicon\\.svg).*)'],
};

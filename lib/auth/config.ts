import 'server-only';

import { HttpError } from '../api/errors';

/** One Workspace, never a wildcard or an email-suffix check. */
export function workspaceDomain(): string {
  const domain =
    process.env.ARRAKIS_GOOGLE_WORKSPACE_DOMAIN?.trim().toLowerCase();
  if (
    !domain ||
    domain.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
  ) {
    throw new HttpError(503, 'Google Workspace editing is not configured.');
  }
  return domain;
}

export function googleSettings() {
  const domain = workspaceDomain();
  const clientId = process.env.ARRAKIS_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.ARRAKIS_GOOGLE_CLIENT_SECRET?.trim();
  let url: URL;
  try {
    url = new URL(process.env.ARRAKIS_PUBLIC_ORIGIN?.trim() ?? '');
  } catch {
    throw new HttpError(503, 'Google sign-in needs ARRAKIS_PUBLIC_ORIGIN.');
  }
  const local =
    process.env.NODE_ENV !== 'production' &&
    url.protocol === 'http:' &&
    url.hostname === 'localhost';
  if (
    !clientId ||
    !clientSecret ||
    (url.protocol !== 'https:' && !local) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new HttpError(503, 'Google sign-in is not configured correctly.');
  }
  return { domain, clientId, clientSecret, origin: url.origin };
}

/** Redirects stay local, including browser normalization of backslashes. */
export function safeReturnPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    // oxlint-disable-next-line no-control-regex -- reject controls before URL normalization
    /[\\\u0000-\u0020\u007f]/.test(value)
  )
    return '/';
  const url = new URL(value, 'https://arrakis.invalid');
  return url.origin === 'https://arrakis.invalid' &&
    !url.pathname.startsWith('//')
    ? `${url.pathname}${url.search}${url.hash}`
    : '/';
}

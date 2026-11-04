import type { Metadata } from 'next';
import { KeyRound } from 'lucide-react';

import { HttpError } from '@/lib/api/errors';
import { googleSettings, safeReturnPath } from '@/lib/auth/google';

export const metadata: Metadata = {
  title: 'Unlock editing',
  robots: { index: false, follow: false },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const target = safeReturnPath(params.next);
  let domain: string | null = null;
  try {
    domain = googleSettings().domain;
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 503) throw error;
  }
  const error =
    params.error === 'access_denied'
      ? 'Access denied. Sign in with an account belonging to the configured Google Workspace. If access is still denied, contact your administrator.'
      : params.error === 'login_failed'
        ? 'Google sign-in could not be completed. Please try again.'
        : null;

  return (
    <main className="studio-page studio-narrow">
      <div className="studio-card login-card">
        <h1>
          <KeyRound size={18} aria-hidden="true" /> Unlock editing
        </h1>
        <p className="studio-muted">
          Reading public queries needs no account. Sign in with Google Workspace
          to write and run queries and edit the private/shared studio.
          {domain && <> All members of {domain} can edit.</>}
        </p>
        {error && (
          <p className="studio-error" role="alert">
            {error}
          </p>
        )}
        {domain ? (
          <a
            className="studio-button primary"
            href={`/api/v1/auth/login?next=${encodeURIComponent(target)}`}
          >
            Sign in with Google
          </a>
        ) : (
          <>
            <p className="studio-error" role="alert">
              Google Workspace sign-in is unavailable. Ask your administrator to
              check the Google OAuth client settings and public origin. Public
              queries remain readable without signing in.
            </p>
            <button className="studio-button primary" type="button" disabled>
              Sign in with Google
            </button>
          </>
        )}
      </div>
    </main>
  );
}

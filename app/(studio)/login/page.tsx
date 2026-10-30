import type { Metadata } from 'next';

import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Unlock editing' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = (await searchParams).next;
  // Only same-site paths: an open redirect would make the login page a
  // convenient way to send someone anywhere after they typed a password.
  const target =
    typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')
      ? next
      : '/queries';
  return <LoginForm next={target} />;
}

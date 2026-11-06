'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { KeyRound } from 'lucide-react';

import { api, ApiError } from '../api';
import { useSession } from '../session';

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const { refresh } = useSession();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/v1/auth/login', { method: 'POST', body: { password } });
      await refresh();
      router.push(next);
    } catch (failure) {
      setError(
        failure instanceof ApiError ? failure.message : 'Could not sign in.',
      );
      setBusy(false);
    }
  };

  return (
    <main className="studio-page studio-narrow">
      <form
        className="studio-card login-card"
        onSubmit={(event) => void submit(event)}
      >
        <h1>
          <KeyRound size={18} aria-hidden="true" /> Unlock editing
        </h1>
        <p className="studio-muted">
          Reading public queries needs nothing. Writing, running and changing
          exits needs the editor password.
        </p>
        <label className="studio-field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- the page's only purpose
            autoFocus
          />
        </label>
        {error && (
          <p className="studio-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="studio-button primary"
          type="submit"
          disabled={busy || !password}
        >
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </main>
  );
}

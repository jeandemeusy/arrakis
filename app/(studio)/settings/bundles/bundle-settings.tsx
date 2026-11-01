'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PackageOpen } from 'lucide-react';

import { api, ApiError } from '../../api';
import { useNav } from '../../nav';
import { useSession } from '../../session';

type Bundle = {
  name: string;
  title: string;
  dashboard: string;
  installed: boolean;
};

/**
 * Dashboards that ship with arrakis. Installing one writes its queries,
 * charts and layout into the app database, where they are edited like any
 * other; updating brings what it created back to the bundled version.
 */
export function BundleSettings() {
  const { user } = useSession();
  const { dashboardsChanged } = useNav();
  const router = useRouter();
  const [bundles, setBundles] = useState<Bundle[] | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let live = true;
    api<{ bundles: Bundle[] }>('/api/v1/bundles')
      .then(({ bundles: list }) => live && setBundles(list))
      .catch((failure: ApiError) => live && setError(failure.message));
    return () => {
      live = false;
    };
  }, [user, message]);

  const install = async (bundle: Bundle) => {
    setInstalling(bundle.name);
    setError(null);
    try {
      const { report } = await api<{
        report: { created: string[]; updated: string[]; unchanged: string[] };
      }>('/api/v1/bundles', { method: 'POST', body: { name: bundle.name } });
      setMessage(
        `${bundle.title}: ${report.created.length} created, ${report.updated.length} updated, ${report.unchanged.length} unchanged. Its queries are running now; charts fill in as their results are stored.`,
      );
      dashboardsChanged();
      if (!bundle.installed) router.push(`/dashboards/${bundle.dashboard}`);
    } catch (failure) {
      setError((failure as ApiError).message);
    } finally {
      setInstalling(null);
    }
  };

  return (
    <main className="studio-page studio-medium">
      <header className="page-head">
        <div>
          <h1>Bundled dashboards</h1>
          <p className="studio-muted">
            Ready-made dashboards, installed as ordinary saved queries and
            charts you can open and change.
          </p>
        </div>
      </header>
      {user === null && (
        <p className="studio-muted">
          <Link href="/login?next=/settings/bundles">Unlock editing</Link> to
          install or update them.
        </p>
      )}
      {error && <p className="studio-error">{error}</p>}
      {bundles?.map((bundle) => (
        <div key={bundle.name} className="bundle">
          <PackageOpen size={18} aria-hidden="true" />
          <div>
            <strong>{bundle.title}</strong>
            <p className="studio-muted">
              {bundle.installed ? (
                <>
                  Installed as{' '}
                  <Link href={`/dashboards/${bundle.dashboard}`}>
                    {bundle.dashboard}
                  </Link>
                  . Updating brings its queries, charts and layout back to the
                  bundled version; anything else is left alone.
                </>
              ) : (
                'Not installed yet.'
              )}
            </p>
          </div>
          <button
            type="button"
            className={`studio-button ${bundle.installed ? '' : 'primary'}`}
            disabled={installing !== null}
            onClick={() => void install(bundle)}
          >
            {installing === bundle.name
              ? 'Installing…'
              : bundle.installed
                ? 'Update'
                : 'Install'}
          </button>
        </div>
      ))}
      {message && <output className="studio-muted">{message}</output>}
    </main>
  );
}

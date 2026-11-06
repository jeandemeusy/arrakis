'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Folder, LayoutDashboard, Plus } from 'lucide-react';

import { api, ApiError, type DashboardRecord } from '../api';
import { useNav } from '../nav';
import { useSession } from '../session';

type Summary = Omit<DashboardRecord, 'widgets'> & {
  official: boolean;
  charts: number;
  folderId: string | null;
};
type FolderRecord = { id: string; name: string };

const UPDATED = new Intl.DateTimeFormat('en', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Home: every dashboard as a card, the bundled ones first. */
export function DashboardList() {
  const { user } = useSession();
  const { dashboardsChanged, dashboardsRevision } = useNav();
  const router = useRouter();
  const [dashboards, setDashboards] = useState<Summary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [creating, setCreating] = useState(false);
  const [folders, setFolders] = useState<FolderRecord[]>([]);
  const [folderName, setFolderName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let live = true;
    api<{ dashboards: Summary[] }>('/api/v1/dashboards')
      .then(({ dashboards: list }) => live && setDashboards(list))
      .catch((failure: ApiError) => live && setError(failure.message));
    api<{ folders: FolderRecord[] }>('/api/v1/dashboard-folders')
      .then(({ folders: list }) => live && setFolders(list))
      .catch((failure: ApiError) => live && setError(failure.message));
    return () => {
      live = false;
    };
  }, [user, dashboardsRevision]);

  const changeFolder = async (path: string, method: string, body?: unknown) => {
    setWorking(true);
    setError(null);
    try {
      await api(path, { method, body });
      setFolderName('');
      setRenaming(null);
      dashboardsChanged();
    } catch (failure) {
      setError((failure as ApiError).message);
    } finally {
      setWorking(false);
    }
  };

  const cards = (items: Summary[]) =>
    items.map((dashboard) => (
      <div className="dashboard-card dashboard-folder-card" key={dashboard.id}>
        <Link
          href={`/dashboards/${dashboard.slug}`}
          className="dashboard-card-link"
        >
          <span className="dashboard-card-head">
            <LayoutDashboard size={16} aria-hidden="true" />
            <strong>{dashboard.title}</strong>
          </span>
          {dashboard.description && <span>{dashboard.description}</span>}
          <small>
            {dashboard.charts} chart{dashboard.charts === 1 ? '' : 's'} ·
            updated {UPDATED.format(new Date(dashboard.updatedAt))}
            {dashboard.official && ' · from a bundle'}
            {dashboard.visibility !== 'public' && (
              <span className={`badge ${dashboard.visibility}`}>
                {dashboard.visibility}
              </span>
            )}
          </small>
        </Link>
        {user && (
          <label className="dashboard-move">
            Folder
            <select
              className="studio-input"
              aria-label={`Move ${dashboard.title} to folder`}
              value={dashboard.folderId ?? ''}
              disabled={working}
              onChange={(event) =>
                void changeFolder(
                  `/api/v1/dashboards/${encodeURIComponent(dashboard.slug)}/folder`,
                  'PUT',
                  { folderId: event.target.value || null },
                )
              }
            >
              <option value="">No folder</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    ));

  const create = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const { dashboard } = await api<{ dashboard: DashboardRecord }>(
        '/api/v1/dashboards',
        { method: 'POST', body: { title, slug } },
      );
      dashboardsChanged();
      router.push(`/dashboards/${dashboard.slug}?edit=1`);
    } catch (failure) {
      setError((failure as ApiError).message);
      setCreating(false);
    }
  };

  return (
    <main className="studio-page">
      <header className="page-head">
        <div>
          <h1>Dashboards</h1>
          <p className="studio-muted">
            Every figure on a dashboard comes from a saved, versioned query:
            open a chart&rsquo;s title to see the query behind it.
          </p>
        </div>
      </header>
      {error && <p className="studio-error">{error}</p>}
      {dashboards === null && !error && (
        <p className="studio-muted">Loading…</p>
      )}
      {user && (
        <form
          className="dashboard-folder-create"
          onSubmit={(event) => {
            event.preventDefault();
            void changeFolder('/api/v1/dashboard-folders', 'POST', {
              name: folderName,
            });
          }}
        >
          <input
            className="studio-input"
            aria-label="New folder name"
            placeholder="Folder name"
            value={folderName}
            onChange={(event) => setFolderName(event.target.value)}
            required
            maxLength={200}
          />
          <button className="studio-button" type="submit" disabled={working}>
            <Plus size={15} /> New folder
          </button>
        </form>
      )}
      {dashboards &&
        folders.map((folder) => (
          <section key={folder.id} className="dashboard-folder">
            <div className="dashboard-folder-heading">
              {renaming === folder.id ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void changeFolder(
                      `/api/v1/dashboard-folders/${folder.id}`,
                      'PATCH',
                      { name: renameValue },
                    );
                  }}
                >
                  <input
                    className="studio-input"
                    aria-label="Folder name"
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    required
                    maxLength={200}
                  />
                  <button
                    className="studio-button"
                    type="submit"
                    disabled={working}
                  >
                    Save
                  </button>
                  <button
                    className="studio-button"
                    type="button"
                    onClick={() => setRenaming(null)}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <h2>
                  <Folder size={19} aria-hidden="true" /> {folder.name}
                </h2>
              )}
              {user && renaming !== folder.id && (
                <div className="dashboard-folder-actions">
                  <button
                    className="studio-button"
                    type="button"
                    onClick={() => {
                      setRenaming(folder.id);
                      setRenameValue(folder.name);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    className="studio-button"
                    type="button"
                    disabled={working}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Delete “${folder.name}”? Its dashboards will move out of the folder.`,
                        )
                      )
                        void changeFolder(
                          `/api/v1/dashboard-folders/${folder.id}`,
                          'DELETE',
                        );
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
            {dashboards.some(
              (dashboard) => dashboard.folderId === folder.id,
            ) ? (
              <div className="dashboard-cards">
                {cards(
                  dashboards.filter(
                    (dashboard) => dashboard.folderId === folder.id,
                  ),
                )}
              </div>
            ) : (
              <p className="studio-muted">No dashboards in this folder yet.</p>
            )}
          </section>
        ))}
      {dashboards && (
        <section className="dashboard-folder">
          {folders.length > 0 && <h2>Other dashboards</h2>}
          <div className="dashboard-cards">
            {cards(dashboards.filter((dashboard) => !dashboard.folderId))}
            {user && (
              <form
                className="dashboard-card new-dashboard"
                onSubmit={(event) => void create(event)}
              >
                <span className="dashboard-card-head">
                  <Plus size={16} aria-hidden="true" />
                  <strong>New dashboard</strong>
                </span>
                <input
                  className="studio-input"
                  placeholder="Title"
                  aria-label="Dashboard title"
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setSlug(
                      event.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '-')
                        .replace(/^-+|-+$/g, ''),
                    );
                  }}
                  required
                />
                <input
                  className="studio-input mono"
                  placeholder="address, e.g. my-dashboard"
                  aria-label="Dashboard slug"
                  value={slug}
                  onChange={(event) => setSlug(event.target.value)}
                  required
                />
                <button
                  className="studio-button primary"
                  type="submit"
                  disabled={creating}
                >
                  Create
                </button>
              </form>
            )}
          </div>
        </section>
      )}
      {dashboards?.length === 0 && (
        <p className="studio-muted">
          No dashboards yet.{' '}
          {user ? (
            <>
              Create one above, or import one somebody shared as a bundle from{' '}
              <Link href="/settings/bundles">Bundles</Link>.
            </>
          ) : (
            <>
              <Link href="/login?next=/">Sign in</Link> to create one.
            </>
          )}
        </p>
      )}
    </main>
  );
}

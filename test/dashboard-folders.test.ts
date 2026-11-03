import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { adminUrl, createTestDatabases, request } from './support';

describe(
  'dashboard folders',
  { skip: !adminUrl && 'TEST_ADMIN_DATABASE_URL not set' },
  () => {
    let db: typeof import('../lib/db/app');
    let folders: typeof import('../lib/viz/folders');
    let store: typeof import('../lib/viz/store');

    before(async () => {
      const databases = await createTestDatabases('arrakis_folders');
      process.env.APP_DATABASE_URL = databases.appUrl;
      db = await import('../lib/db/app');
      folders = await import('../lib/viz/folders');
      store = await import('../lib/viz/store');
    });

    after(async () => {
      if (db) await db.closeAppDb();
    });

    it('organizes dashboards without exposing private folders and retains them when a folder is deleted', async () => {
      const connection = await db.appDb();
      await connection.query(
        "INSERT INTO dashboards (slug, title, visibility) VALUES ('public-folder-test', 'Public', 'public'), ('private-folder-test', 'Private', 'private')",
      );
      const visible = await folders.saveFolder(null, 'Visible');
      const hidden = await folders.saveFolder(null, 'Hidden');
      await folders.moveDashboard('public-folder-test', visible.id);
      await folders.moveDashboard('private-folder-test', hidden.id);
      assert.deepEqual(
        (await folders.listFolders(false)).map((folder) => folder.name),
        ['Visible'],
      );
      assert.equal(
        (await store.listDashboards(false)).find(
          (dashboard) => dashboard.slug === 'public-folder-test',
        )?.folderId,
        visible.id,
      );
      await folders.saveFolder(visible.id, 'Renamed');
      await assert.rejects(() => folders.saveFolder(null, 'renamed'));
      await assert.rejects(() =>
        folders.moveDashboard('public-folder-test', 'not-an-id'),
      );
      await folders.deleteFolder(visible.id);
      assert.equal(
        (await store.listDashboards(false)).find(
          (dashboard) => dashboard.slug === 'public-folder-test',
        )?.folderId,
        null,
      );
      assert.equal((await folders.listFolders(true)).length, 1);
    });

    it('requires an editor to create or move folders', async () => {
      const folderRoutes =
        await import('../app/api/v1/dashboard-folders/route');
      const moveRoute =
        await import('../app/api/v1/dashboards/[slug]/folder/route');
      const created = await folderRoutes.POST(
        request('POST', '/api/v1/dashboard-folders', {
          body: { name: 'Unauthorized' },
        }),
        undefined,
      );
      const moved = await moveRoute.PUT(
        request('PUT', '/api/v1/dashboards/public-folder-test/folder', {
          body: { folderId: null },
        }),
        { params: Promise.resolve({ slug: 'public-folder-test' }) },
      );
      assert.equal(created.status, 401);
      assert.equal(moved.status, 401);
    });
  },
);

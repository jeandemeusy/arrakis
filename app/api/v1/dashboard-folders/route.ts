import {
  noStore,
  optionalEditor,
  readBody,
  requireEditor,
  route,
} from '@/lib/api/handler';
import { listFolders, saveFolder } from '@/lib/viz/folders';

export const GET = route(async (request: Request) =>
  noStore(request, {
    folders: await listFolders(Boolean(await optionalEditor(request))),
  }),
);

export const POST = route(async (request: Request) => {
  await requireEditor(request);
  const body = await readBody(request);
  return noStore(request, { folder: await saveFolder(null, body.name) }, 201);
});

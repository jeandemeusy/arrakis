import { noStore, optionalEditor, route } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/** Whether the caller can edit. Never fails: the answer is just "no". */
export const GET = route(async (request: Request) => {
  const principal = await optionalEditor(request);
  return noStore(request, {
    user: principal
      ? { username: principal.username, role: principal.role }
      : null,
  });
});

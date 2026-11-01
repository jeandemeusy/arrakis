import { noStore, optionalEditor, route } from '@/lib/api/handler';
import { dependents } from '@/lib/query/dependents';
import { requireQuery } from '@/lib/query/store';

export const dynamic = 'force-dynamic';

/** The queries that inline this fragment, directly or not, and their charts. */
export const GET = route(
  async (request: Request, context: { params: Promise<{ slug: string }> }) => {
    const { slug } = await context.params;
    const editor = Boolean(await optionalEditor(request));
    await requireQuery(slug, editor);
    return noStore(request, { dependents: await dependents(slug, editor) });
  },
);

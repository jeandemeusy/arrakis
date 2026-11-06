import { noStore, route } from '@/lib/api/handler';
import { networks } from '@/lib/query/networks';

export const dynamic = 'force-dynamic';

/** The networks queries can run on. Ids and labels only, never connection strings. */
export const GET = route(async (request: Request) =>
  noStore(request, {
    networks: networks().map(({ id, label }) => ({ id, label })),
  }),
);

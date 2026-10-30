import { badRequest } from '@/lib/api/errors';
import {
  noStore,
  readBody,
  requireEditor,
  route,
  suppliedFromBody,
} from '@/lib/api/handler';
import { preview } from '@/lib/query/execute';
import { targetNetworks } from '@/lib/query/networks';
import { parseDefinitions } from '@/lib/query/params';

export const dynamic = 'force-dynamic';

const PREVIEW_ROWS = 10_000;

/**
 * Runs unsaved SQL for the editor and returns the rows. Nothing is stored.
 *
 * `{ "sql": "…", "parameters": [...], "values": {...}, "network": "jura" | "all" }`
 */
export const POST = route(async (request: Request) => {
  await requireEditor(request);
  const body = await readBody(request);
  if (typeof body.sql !== 'string' || !body.sql.trim()) {
    throw badRequest('sql is required');
  }
  if (body.sql.length > 200_000) throw badRequest('sql is too long');
  const network = typeof body.network === 'string' ? body.network : null;
  const result = await preview(
    { sql: body.sql, parameters: parseDefinitions(body.parameters) },
    suppliedFromBody(body),
    targetNetworks(network),
    PREVIEW_ROWS,
  );
  return noStore(request, result);
});

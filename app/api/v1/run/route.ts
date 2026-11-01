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
 * `{ "sql": "…", "parameters": [...], "values": {...}, "network": "jura" | "all",
 *    "timeoutSeconds"?: 60, "runKey"?: "…", "query"?: "slug",
 *    "explain"?: "plan" | "analyze" }` — the run key lets the page cancel the
 * run through /api/v1/runs/cancel; `explain` returns the query plan, one line
 * per row, instead of the rows (`analyze` runs the query to measure it).
 */
export const POST = route(async (request: Request) => {
  const principal = await requireEditor(request);
  const body = await readBody(request);
  if (typeof body.sql !== 'string' || !body.sql.trim()) {
    throw badRequest('sql is required');
  }
  if (body.sql.length > 200_000) throw badRequest('sql is too long');
  const network = typeof body.network === 'string' ? body.network : null;
  const timeoutSeconds =
    typeof body.timeoutSeconds === 'number' &&
    Number.isInteger(body.timeoutSeconds) &&
    body.timeoutSeconds > 0
      ? Math.min(body.timeoutSeconds, 3_600)
      : null;
  const result = await preview(
    { sql: body.sql, parameters: parseDefinitions(body.parameters) },
    suppliedFromBody(body),
    targetNetworks(network),
    PREVIEW_ROWS,
    {
      timeoutSeconds,
      // The page's own token, so it can cancel this very run.
      runKey:
        typeof body.runKey === 'string' ? body.runKey.slice(0, 64) : undefined,
      query:
        typeof body.query === 'string' ? body.query.slice(0, 80) : undefined,
      startedBy: principal.username,
      explain:
        body.explain === 'plan' || body.explain === 'analyze'
          ? body.explain
          : undefined,
    },
  );
  return noStore(request, result);
});

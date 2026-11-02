import 'server-only';

import { Client } from 'pg';

import { appDb } from '../db/app';
import { networks } from './networks';

/**
 * Runs in progress, and stopping them.
 *
 * A run is listed in `active_runs` by the replica running it (runner.ts),
 * with the backend serving it. Any replica can then stop it: it connects to
 * that data source as the same read-only role and asks the backend to cancel
 * — which a role may always do to its own sessions. The run ends with a
 * "Query cancelled" error, recorded like any failure.
 */

export type ActiveRun = {
  id: string;
  network: string;
  kind: 'preview' | 'store' | 'schedule';
  query: string | null;
  startedBy: string | null;
  startedAt: string;
};

/**
 * A row left behind by a process that died mid-run, once it can be no run.
 *
 * Stored runs are capped at ten minutes and the scheduler already considers a
 * fifteen-minute claim abandoned. Keeping a dead tracker for two hours made
 * the Running now page claim that a refresh was still in progress long after
 * it could have finished.
 */
const ABANDONED = "interval '15 minutes'";

export async function listActiveRuns(): Promise<ActiveRun[]> {
  const db = await appDb();
  // The monitor polls independently of the scheduler, so clear an abandoned
  // tracker as soon as an editor opens it instead of waiting for the next
  // housekeeping tick.
  await db.query(
    `DELETE FROM active_runs WHERE started_at < now() - ${ABANDONED}`,
  );
  const { rows } = await db.query<{
    id: string;
    network: string;
    kind: ActiveRun['kind'];
    query_slug: string | null;
    started_by: string | null;
    started_at: Date;
  }>(
    `SELECT id, network, kind, query_slug, started_by, started_at
     FROM active_runs WHERE started_at > now() - ${ABANDONED}
     ORDER BY started_at`,
  );
  return rows.map((row) => ({
    id: row.id,
    network: row.network,
    kind: row.kind,
    query: row.query_slug,
    startedBy: row.started_by,
    startedAt: row.started_at.toISOString(),
  }));
}

/**
 * Cancels the runs matching every given filter — one run by id, a preview by
 * its page's key, or everything running for a query — and says how many it
 * reached.
 */
export async function cancelRuns(filter: {
  id?: string;
  runKey?: string;
  query?: string;
}): Promise<number> {
  if (!filter.id && !filter.runKey && !filter.query) return 0;
  const db = await appDb();
  const { rows } = await db.query<{ network: string; pid: number }>(
    `SELECT network, pid FROM active_runs
     WHERE started_at > now() - ${ABANDONED}
       AND ($1::uuid IS NULL OR id = $1)
       AND ($2::text IS NULL OR run_key = $2)
       AND ($3::text IS NULL OR query_slug = $3)`,
    [filter.id ?? null, filter.runKey ?? null, filter.query ?? null],
  );
  const byNetwork = new Map(networks().map((network) => [network.id, network]));
  let cancelled = 0;
  await Promise.all(
    rows.map(async (row) => {
      const network = byNetwork.get(row.network);
      if (!network) return;
      // Its own short connection: the data source's pool may be full of the
      // very runs being cancelled.
      const client = new Client({
        connectionString: network.queryDatabaseUrl,
        application_name: 'arrakis-cancel',
        connectionTimeoutMillis: 5_000,
      });
      try {
        await client.connect();
        const result = await client.query<{ ok: boolean }>(
          'SELECT pg_cancel_backend($1) AS ok',
          [row.pid],
        );
        if (result.rows[0]?.ok) cancelled += 1;
      } catch (error) {
        console.error(
          `Could not cancel a run on ${row.network}:`,
          (error as Error).message,
        );
      } finally {
        await client.end().catch(() => undefined);
      }
    }),
  );
  return cancelled;
}

/** Drops rows whose process died before it could remove them. */
export async function pruneActiveRuns(): Promise<void> {
  const db = await appDb();
  await db.query(
    `DELETE FROM active_runs WHERE started_at < now() - ${ABANDONED}`,
  );
}

import 'server-only';

import { Client } from 'pg';

import { ensureEnvUsers, pruneAuthState } from '../auth/session';
import { appDb } from '../db/app';
import { resolveNetworks, type NetworkConfig } from '../networks';
import { compile } from './compile';
import { inputsFingerprint, parameterKey } from './execute';
import { pruneActiveRuns } from './cancel';
import { limits } from './limits';
import { materialize, pruneResults } from './results';
import { fragmentResolver, listQueries, type QueryRecord } from './store';

/**
 * Keeps scheduled queries' results fresh.
 *
 * One replica leads: it holds a session-level advisory lock on a dedicated
 * connection, and loses it only with that connection. The others keep trying
 * on every tick and take over within one tick if the leader goes away.
 *
 * A result is due when it has never been attempted, when its refresh interval
 * has passed since the last attempt, or when what shaped it changed — a new
 * query version, a new fragment version, a different exit set. The last case
 * is how "change the exits, the dashboard follows" works without any
 * notification between replicas: the fingerprint no longer matches, so the next
 * tick reruns it. Failures are retried on the normal interval rather than in a
 * tight loop.
 */

const LEADER_LOCK = 0x61_72_72_62; // 'arrb'
const PRUNE_EVERY_MS = 10 * 60_000;
const STUCK_MS = 15 * 60_000;

let started = false;
let leader: Client | null = null;
let ticking = false;
let again = false;
let lastPrune = 0;

function tickMs(): number {
  const value = Number.parseInt(
    process.env.ARRAKIS_SCHEDULER_TICK_MS ?? '',
    10,
  );
  return Number.isFinite(value) && value >= 1_000 ? value : 10_000;
}

async function holdLeadership(): Promise<boolean> {
  if (leader) return true;
  const client = new Client({
    connectionString: process.env.APP_DATABASE_URL,
    application_name: 'arrakis-scheduler',
  });
  client.on('error', () => {
    // The lock went with the connection; contend again on the next tick.
    if (leader === client) leader = null;
  });
  try {
    await client.connect();
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [LEADER_LOCK],
    );
    if (rows[0]?.locked) {
      leader = client;
      return true;
    }
  } catch (error) {
    console.error(
      'Scheduler could not reach the app database:',
      (error as Error).message,
    );
  }
  await client.end().catch(() => undefined);
  return false;
}

type Job = { query: QueryRecord; network: NetworkConfig };

async function dueJobs(networks: NetworkConfig[]): Promise<Job[]> {
  const queries = (await listQueries({ editor: true, kind: 'query' })).filter(
    (query) => query.refreshSeconds !== null && query.current,
  );
  if (!queries.length) return [];
  const db = await appDb();
  const jobs: Array<Job & { overdue: number }> = [];

  for (const query of queries) {
    const version = query.current;
    if (!version || query.refreshSeconds === null) continue;
    let compiled;
    let key;
    try {
      compiled = await compile(
        version.sql,
        version.parameters,
        fragmentResolver(),
      );
      key = parameterKey(compiled, {});
    } catch (error) {
      // Typically a parameter without a default, or a fragment that was
      // archived. Nothing to run until an editor fixes it.
      console.error(`Scheduler skips ${query.slug}:`, (error as Error).message);
      continue;
    }
    const { rows } = await db.query<{
      network: string;
      attempt_status: string | null;
      attempt_started_at: Date | null;
      attempt_inputs_hash: string | null;
    }>(
      `SELECT network, attempt_status, attempt_started_at, attempt_inputs_hash
       FROM query_results WHERE query_version_id = $1 AND parameters_hash = $2`,
      [version.id, key.hash],
    );
    const byNetwork = new Map(rows.map((row) => [row.network, row]));
    for (const network of networks) {
      const row = byNetwork.get(network.id);
      const started = row?.attempt_started_at?.getTime() ?? 0;
      if (
        row?.attempt_status === 'running' &&
        Date.now() - started < STUCK_MS
      ) {
        continue;
      }
      const overdue = Date.now() - (started + query.refreshSeconds * 1000);
      const changed =
        row?.attempt_inputs_hash !==
        (await inputsFingerprint(compiled, network));
      if (!row || overdue >= 0 || changed) {
        jobs.push({ query, network, overdue: changed ? Infinity : overdue });
      }
    }
  }
  return jobs.sort((a, b) => b.overdue - a.overdue);
}

async function runDue(): Promise<void> {
  let networks: NetworkConfig[];
  try {
    networks = resolveNetworks();
  } catch (error) {
    console.error('Scheduler has no networks:', (error as Error).message);
    return;
  }
  const jobs = await dueJobs(networks);
  // One scheduled run per data source at a time, sources in parallel but at
  // most ARRAKIS_SCHEDULER_CONCURRENCY at once overall: refreshes never take
  // more than one of a source's query connections, leaving the rest to
  // editors, and many sources do not mean many heavy runs together.
  const slots = semaphore(limits().schedulerConcurrency);
  const byNetwork = new Map<string, Job[]>();
  for (const job of jobs) {
    const list = byNetwork.get(job.network.id) ?? [];
    list.push(job);
    byNetwork.set(job.network.id, list);
  }
  await Promise.all(
    [...byNetwork.values()].map(async (list) => {
      for (const job of list) {
        const release = await slots();
        try {
          await materialize({
            query: job.query,
            network: job.network,
            supplied: {},
            trigger: 'schedule',
            startedBy: 'scheduler',
          });
        } catch (error) {
          // Already recorded on the result row, where an editor will see it.
          console.error(
            `Scheduled run of ${job.query.slug} on ${job.network.id} failed:`,
            (error as Error).message,
          );
        } finally {
          release();
        }
      }
    }),
  );
}

/** At most `size` holders at once; `acquire()` resolves with the release. */
function semaphore(size: number): () => Promise<() => void> {
  let free = Math.max(1, size);
  const waiting: Array<() => void> = [];
  return async () => {
    if (free > 0) free -= 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next) next();
      else free += 1;
    };
  };
}

async function tick(): Promise<void> {
  if (ticking) {
    again = true;
    return;
  }
  ticking = true;
  try {
    do {
      again = false;
      if (!(await holdLeadership())) return;
      await ensureEnvUsers();
      await runDue();
      if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
        lastPrune = Date.now();
        await pruneAuthState();
        await pruneResults();
        await pruneActiveRuns();
      }
    } while (again);
  } catch (error) {
    console.error('Scheduler tick failed:', error);
  } finally {
    ticking = false;
  }
}

/** Starts the loop once per process. A no-op without an app database. */
export function startScheduler(): void {
  if (started || !process.env.APP_DATABASE_URL?.trim()) return;
  started = true;
  const timer = setInterval(() => void tick(), tickMs());
  timer.unref();
  setTimeout(() => void tick(), 1_000).unref();
}

/**
 * Asks for a tick now rather than at the next interval, after something that
 * makes results due — new exits, a new version. Only speeds things up on the
 * leader; elsewhere the leader's own next tick catches it.
 */
export function nudgeScheduler(): void {
  if (started) void tick();
}

/** Tests only: one synchronous pass, as the leader. */
export async function runSchedulerOnce(): Promise<void> {
  await tick();
}

/** Tests only. */
export async function releaseLeadership(): Promise<void> {
  const client = leader;
  leader = null;
  await client?.end().catch(() => undefined);
}

import 'server-only';

import { HttpError, badRequest } from '../api/errors';
import type { Principal } from '../auth/session';
import { appDb } from '../db/app';
import type { NetworkConfig } from '../networks';
import { runReadOnly } from './runner';

/**
 * Exit nodes, per indexed network, as editors configure them.
 *
 * Nothing on chain tells an exit from a relay — both announce — so downstream
 * volume can only be attributed if the exits are named. They are named here,
 * and only here: queries read them as `{{exits}}`, and with none configured a
 * network simply has no downstream figure. Nothing is guessed.
 *
 * A removal is recorded rather than deleted, because the exit set decides what
 * the dashboard counts and every change to it should stay traceable.
 */

const ADDRESS = /^0x[0-9a-f]{40}$/;

export type Exit = {
  address: string;
  label: string;
  addedAt: string;
  addedBy: string | null;
};

export function parseAddress(input: unknown): Buffer {
  const address = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (!ADDRESS.test(address)) {
    throw badRequest('address must be a 0x-prefixed 20-byte hex address');
  }
  return Buffer.from(address.slice(2), 'hex');
}

export async function listExits(network: string): Promise<Exit[]> {
  const db = await appDb();
  const { rows } = await db.query<{
    address: Buffer;
    label: string;
    added_at: Date;
    added_by: string | null;
  }>(
    `SELECT e.address, e.label, e.added_at, u.username AS added_by
     FROM network_exits e LEFT JOIN users u ON u.id = e.added_by
     WHERE e.network = $1 AND e.removed_at IS NULL
     ORDER BY e.address`,
    [network],
  );
  return rows.map((row) => ({
    address: `0x${row.address.toString('hex')}`,
    label: row.label,
    addedAt: row.added_at.toISOString(),
    addedBy: row.added_by,
  }));
}

/** The active exits as bind values, sorted so equal sets hash equally. */
export async function exitBytes(network: string): Promise<Buffer[]> {
  const db = await appDb();
  const { rows } = await db.query<{ address: Buffer }>(
    `SELECT address FROM network_exits
     WHERE network = $1 AND removed_at IS NULL ORDER BY address`,
    [network],
  );
  return rows.map((row) => row.address);
}

/**
 * Whether the address ever announced on this network.
 *
 * An exit must announce to be reachable, so one that never did is almost
 * certainly a typo or an address from another network. That is a warning, not
 * a refusal: an exit can be configured ahead of its first announcement.
 */
async function announced(
  network: NetworkConfig,
  address: Buffer,
): Promise<boolean | null> {
  try {
    const { rows } = await runReadOnly({
      network,
      text: `SELECT EXISTS (
        SELECT 1 FROM account
        JOIN announcement ON announcement.account_id = account.id
        WHERE account.chain_key = $1::bytea
      )`,
      values: [address],
      rowLimit: 1,
      timeoutMs: 10_000,
    });
    return rows[0]?.[0] === true;
  } catch {
    return null;
  }
}

export async function addExit(
  network: NetworkConfig,
  input: { address: unknown; label: unknown },
  principal: Principal,
): Promise<{ exit: Exit; warning: string | null }> {
  const address = parseAddress(input.address);
  const label =
    typeof input.label === 'string' ? input.label.trim().slice(0, 100) : '';
  const db = await appDb();
  try {
    await db.query(
      `INSERT INTO network_exits (network, address, label, added_by)
       VALUES ($1, $2, $3, $4)`,
      [network.id, address, label, principal.userId],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new HttpError(409, 'That exit is already configured');
    }
    throw error;
  }
  const seen = await announced(network, address);
  const exit = (await listExits(network.id)).find(
    (entry) => entry.address === `0x${address.toString('hex')}`,
  );
  if (!exit) throw new Error('exit vanished after insert');
  return {
    exit,
    warning:
      seen === false
        ? `This address never announced on ${network.label}. Check that it is the right address and network.`
        : seen === null
          ? `Could not check whether this address announced on ${network.label}.`
          : null,
  };
}

export async function removeExit(
  network: string,
  input: unknown,
  principal: Principal,
): Promise<void> {
  const address = parseAddress(input);
  const db = await appDb();
  const { rowCount } = await db.query(
    `UPDATE network_exits SET removed_at = now(), removed_by = $3
     WHERE network = $1 AND address = $2 AND removed_at IS NULL`,
    [network, address, principal.userId],
  );
  if (!rowCount) throw new HttpError(404, 'No such exit on this network');
}

export type ExitActivity = {
  address: string;
  lastBlock: string | null;
  lastAt: string | null;
  redemptions: string;
};

/**
 * When each configured exit was last seen paying a relay, and how often.
 *
 * Replaces the old "exits named vs. exits seen" figure: an exit that has gone
 * quiet stands out by its date, and its traffic is missing from downstream.
 * Runs through the same template path as any saved query, so `{{exits}}` and
 * `{{block_time()}}` mean exactly what they mean there.
 */
const ACTIVITY_SQL = `
WITH exit_channel AS (
  SELECT channel.id, source_account.chain_key AS exit
  FROM channel
  JOIN account AS source_account ON source_account.id = channel.source
  WHERE source_account.chain_key = ANY ({{exits}})
),
ordered AS (
  SELECT
    exit_channel.exit,
    cs.published_block,
    cs.epoch,
    cs.ticket_index,
    LAG(cs.epoch) OVER w AS previous_epoch,
    LAG(cs.ticket_index) OVER w AS previous_ticket_index
  FROM channel_state cs
  JOIN exit_channel ON exit_channel.id = cs.channel_id
  WHERE cs.corrupted_state = FALSE AND cs.reorg_correction = FALSE
  WINDOW w AS (
    PARTITION BY cs.channel_id
    ORDER BY cs.published_block, cs.published_tx_index, cs.published_log_index
  )
),
per_exit AS (
  SELECT exit, MAX(published_block) AS last_block, COUNT(*) AS redemptions
  FROM ordered
  WHERE previous_ticket_index IS NOT NULL
    AND epoch = previous_epoch
    AND ticket_index > previous_ticket_index
  GROUP BY exit
)
SELECT exit, last_block, {{block_time(last_block)}} AS last_at, redemptions
FROM per_exit`;

export async function exitActivity(
  network: NetworkConfig,
): Promise<ExitActivity[]> {
  const { prepare } = await import('./execute');
  const prepared = await prepare(
    { sql: ACTIVITY_SQL, parameters: [] },
    {},
    network,
    async () => null,
  );
  const { rows } = await runReadOnly({
    network,
    text: prepared.compiled.text,
    values: prepared.values,
    rowLimit: 1_000,
  });
  const seen = new Map(
    rows.map((row) => [`0x${(row[0] as Buffer).toString('hex')}`, row]),
  );
  return (await listExits(network.id)).map((exit) => {
    const row = seen.get(exit.address);
    return {
      address: exit.address,
      lastBlock: row ? String(row[1]) : null,
      lastAt: row?.[2] instanceof Date ? row[2].toISOString() : null,
      redemptions: row ? String(row[3]) : '0',
    };
  });
}

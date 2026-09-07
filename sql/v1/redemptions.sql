-- Ticket redemptions caused by Gnosis VPN client traffic.
--
-- Blokli writes one channel_state row per on-chain channel event. A TicketRedeemed
-- event is the only event that advances ticket_index, so a row whose ticket_index
-- is greater than its predecessor's marks a redemption on that channel.
--
-- The increment is not the number of tickets redeemed. A client numbers a
-- ticket for every packet it sends and only winning tickets are redeemed, and the
-- contract advances the index past the winner to block replay — so the jump
-- swallows every losing ticket issued in between. `tickets` is therefore an
-- estimate of the packets that redemption paid for, and its ratio to the number of
-- redemptions should track the winning probability. One ticket is redeemed per
-- redemption.
--
-- Redemptions paid TO an announced node, tagged with whether the payer announced.
-- The caller classifies from there, because the classification needs the whole
-- set at once:
--
--   unannounced -> announced   a client paying a relay: upstream VPN traffic.
--   announced   -> announced   either an exit paying a relay on the return path,
--                              or a node probing the network. Which one it is
--                              depends on whether the payer is itself a relay,
--                              and that is only knowable after the relay set has
--                              been derived from the upstream rows.
--
-- A relay announces itself; an account that never announced is not infrastructure,
-- so it is a VPN client paying for its own sessions.
--
-- $1 is the configured exit addresses. Given any, only the two directions that
-- carry VPN traffic are returned — clients paying relays, and those exits paying
-- relays. Everything else on this table is nodes probing each other, which on a
-- real network outnumbers client traffic by an order of magnitude and is used for
-- nothing once the exits are known. Fetching it costs hundreds of megabytes of
-- heap to build rows nobody reads. Given none, the caller falls back to guessing
-- the exits by elimination, and that needs the probe traffic to calibrate with,
-- so the whole set is returned.
--
-- Which channels qualify is decided FIRST, in `client_channel`, and the window
-- function then runs over those channels only. Every one of those predicates is a
-- property of the channel rather than of the event row, and the window partitions
-- by channel, so dropping a channel outright cannot change the LAG of any row that
-- survives. Applied after the window instead — as they read more naturally — they
-- cannot be pushed down through it, and the partition sort ends up running over
-- every event in the table on a network where client traffic is a small fraction
-- of it.
WITH client_channel AS (
  SELECT
    channel.id,
    source_account.chain_key AS source,
    destination_account.chain_key AS destination,
    -- Whether the payer announced: an announced payer is a relay or an exit.
    EXISTS (
      SELECT 1 FROM announcement WHERE announcement.account_id = channel.source
    ) AS source_announced
  FROM channel
  JOIN account AS source_account ON source_account.id = channel.source
  JOIN account AS destination_account ON destination_account.id = channel.destination
  -- Traffic is only paid for hop by hop, and every hop that gets paid terminates
  -- at an announced node. A channel to an unannounced account carries no relayed
  -- traffic, so it is not a hop anyone is being paid for.
  WHERE EXISTS (
    SELECT 1 FROM announcement WHERE announcement.account_id = channel.destination
  )
  AND (
    CARDINALITY($1::bytea[]) = 0
    -- Upstream: the payer never announced, so it is a client.
    OR NOT EXISTS (
      SELECT 1 FROM announcement WHERE announcement.account_id = channel.source
    )
    -- Downstream: the payer is a known exit.
    OR source_account.chain_key = ANY ($1::bytea[])
  )
),
ordered AS (
  SELECT
    cs.channel_id,
    cs.published_block,
    cs.epoch,
    cs.ticket_index,
    LAG(cs.epoch) OVER w AS previous_epoch,
    LAG(cs.ticket_index) OVER w AS previous_ticket_index
  FROM channel_state cs
  JOIN client_channel ON client_channel.id = cs.channel_id
  WHERE cs.corrupted_state = FALSE
    AND cs.reorg_correction = FALSE
  WINDOW w AS (
    PARTITION BY cs.channel_id
    ORDER BY cs.published_block, cs.published_tx_index, cs.published_log_index
  )
)
SELECT
  client_channel.source,
  client_channel.destination,
  client_channel.source_announced,
  ordered.published_block,
  ordered.ticket_index - ordered.previous_ticket_index AS tickets
FROM ordered
JOIN client_channel ON client_channel.id = ordered.channel_id
WHERE ordered.previous_ticket_index IS NOT NULL
  AND ordered.epoch = ordered.previous_epoch
  AND ordered.ticket_index > ordered.previous_ticket_index
ORDER BY ordered.published_block ASC;

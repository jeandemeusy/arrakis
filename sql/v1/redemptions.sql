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
-- Only channels opened BY a client are counted. Nodes that relay traffic announce
-- themselves on chain; an account that never announced is not part of the network
-- infrastructure, so it is a VPN client paying for its own sessions. Channels
-- sourced by announced accounts are relay-to-relay hops, not client usage.
WITH ordered AS (
  SELECT
    cs.channel_id,
    cs.published_block,
    cs.epoch,
    cs.ticket_index,
    cs.balance,
    LAG(cs.epoch) OVER w AS previous_epoch,
    LAG(cs.ticket_index) OVER w AS previous_ticket_index,
    LAG(cs.balance) OVER w AS previous_balance
  FROM channel_state cs
  WHERE cs.corrupted_state = FALSE
    AND cs.reorg_correction = FALSE
  WINDOW w AS (
    PARTITION BY cs.channel_id
    ORDER BY cs.published_block, cs.published_tx_index, cs.published_log_index
  )
)
SELECT
  channel.concrete_channel_id AS channel_id,
  source_account.chain_key AS source,
  destination_account.chain_key AS destination,
  ordered.published_block,
  ordered.ticket_index - ordered.previous_ticket_index AS tickets,
  ordered.previous_balance AS balance_before,
  ordered.balance AS balance_after
FROM ordered
JOIN channel ON channel.id = ordered.channel_id
JOIN account AS source_account ON source_account.id = channel.source
JOIN account AS destination_account ON destination_account.id = channel.destination
WHERE ordered.previous_ticket_index IS NOT NULL
  AND ordered.epoch = ordered.previous_epoch
  AND ordered.ticket_index > ordered.previous_ticket_index
  AND NOT EXISTS (
    SELECT 1 FROM announcement WHERE announcement.account_id = channel.source
  )
ORDER BY ordered.published_block ASC;

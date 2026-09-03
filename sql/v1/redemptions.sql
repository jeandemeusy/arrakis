-- Ticket redemptions reconstructed from the append-only channel_state history.
--
-- Blokli writes one channel_state row per on-chain channel event. A TicketRedeemed
-- event is the only event that advances ticket_index, so a row whose ticket_index
-- is greater than its predecessor's marks a redemption on that channel. The wxHOPR
-- paid out is the drop in channel balance across the same pair of rows.
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
  AND ordered.balance < ordered.previous_balance
ORDER BY ordered.published_block ASC;

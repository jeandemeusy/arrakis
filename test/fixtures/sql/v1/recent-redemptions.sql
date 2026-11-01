-- The most recent client redemptions.
--
-- Same definition of a client as the panels: an unannounced payer, paying an
-- announced node. Node-to-node probing and the exits' return traffic are left
-- out, so the feed lists the same population every figure above it counts.
--
-- It stays its own query even so, because it is the only consumer that needs a
-- channel id. The panels read hundreds of thousands of rows and would retain a
-- 64-character identifier on each to render at most five hundred of them; this
-- reads the newest few hundred and nothing else.
--
-- The client channels are selected FIRST so the window function runs over their
-- events alone — see the note in redemptions.sql for why that is safe and why it
-- matters.
WITH client_channel AS (
  SELECT
    channel.id,
    channel.concrete_channel_id AS channel_id,
    source_account.chain_key AS source,
    destination_account.chain_key AS destination
  FROM channel
  JOIN account AS source_account ON source_account.id = channel.source
  JOIN account AS destination_account ON destination_account.id = channel.destination
  WHERE NOT EXISTS (
    SELECT 1 FROM announcement WHERE announcement.account_id = channel.source
  )
  AND EXISTS (
    SELECT 1 FROM announcement WHERE announcement.account_id = channel.destination
  )
),
ordered AS (
  SELECT
    cs.channel_id,
    cs.published_block,
    cs.published_tx_index,
    cs.published_log_index,
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
  client_channel.channel_id,
  client_channel.source,
  client_channel.destination,
  ordered.published_block,
  ordered.ticket_index - ordered.previous_ticket_index AS tickets
FROM ordered
JOIN client_channel ON client_channel.id = ordered.channel_id
WHERE ordered.previous_ticket_index IS NOT NULL
  AND ordered.epoch = ordered.previous_epoch
  AND ordered.ticket_index > ordered.previous_ticket_index
ORDER BY
  ordered.published_block DESC,
  ordered.published_tx_index DESC,
  ordered.published_log_index DESC
LIMIT 500;

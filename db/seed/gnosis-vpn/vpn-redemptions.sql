-- Ticket redemptions that carried Gnosis VPN traffic, one row each.
--
-- Blokli writes one channel_state row per on-chain channel event. Only a
-- TicketRedeemed event advances ticket_index, so a row whose index is above
-- its predecessor's, in the same epoch, marks a redemption on that channel.
-- The jump is not the tickets redeemed: a client numbers a ticket for every
-- packet and only winners are redeemed, so it estimates the packets paid for.
--
-- Payment follows the sender of each hop and a packet's destination is never
-- paid, so one VPN session leaves two paid hops on chain:
--
--   upstream     a client — an account that never announced — paying a relay
--   downstream   one of the network's configured exits paying a relay for
--                the answer
--
-- Everything else on these channels is announced nodes ({{> vpn-nodes}})
-- probing each other, and is left out. Exits are read from Settings → Exits
-- ({{exits}}); none configured means no downstream at all rather than a guess.
--
-- The qualifying channels are picked FIRST, so the window function runs over
-- their events only: every predicate is a property of the channel, and the
-- window partitions by channel, so dropping a channel cannot change the LAG of
-- a row that survives.
WITH node AS {{> vpn-nodes}},
vpn_channel AS (
  SELECT
    channel.id,
    channel.concrete_channel_id,
    payer.chain_key AS payer,
    relay.chain_key AS relay,
    CASE
      WHEN channel.source NOT IN (SELECT account_id FROM node) THEN 'upstream'
      ELSE 'downstream'
    END AS direction
  FROM channel
  JOIN account AS payer ON payer.id = channel.source
  JOIN account AS relay ON relay.id = channel.destination
  WHERE channel.destination IN (SELECT account_id FROM node)
    AND (
      channel.source NOT IN (SELECT account_id FROM node)
      OR payer.chain_key = ANY ({{exits}})
    )
),
ordered AS (
  -- The channel's own columns ride along with its events, so the result needs
  -- no second join back to vpn_channel — which the planner, unable to
  -- estimate how many channels qualify, would turn into a nested loop.
  SELECT
    vpn_channel.direction,
    vpn_channel.payer,
    vpn_channel.relay,
    vpn_channel.concrete_channel_id,
    cs.published_block,
    cs.published_tx_index,
    cs.published_log_index,
    cs.epoch,
    cs.ticket_index,
    LAG(cs.epoch) OVER w AS previous_epoch,
    LAG(cs.ticket_index) OVER w AS previous_ticket_index
  FROM channel_state AS cs
  JOIN vpn_channel ON vpn_channel.id = cs.channel_id
  WHERE cs.corrupted_state = FALSE
    AND cs.reorg_correction = FALSE
  WINDOW w AS (
    PARTITION BY cs.channel_id
    ORDER BY cs.published_block, cs.published_tx_index, cs.published_log_index
  )
)
SELECT
  direction,
  payer,
  relay,
  concrete_channel_id AS channel,
  published_block AS block,
  published_tx_index AS tx_index,
  published_log_index AS log_index,
  ticket_index - previous_ticket_index AS tickets
FROM ordered
WHERE previous_ticket_index IS NOT NULL
  AND epoch = previous_epoch
  AND ticket_index > previous_ticket_index

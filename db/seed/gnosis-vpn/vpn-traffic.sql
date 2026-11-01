-- Every Gnosis VPN redemption, dated and converted to data volume.
--
-- One row per redemption from {{> vpn-redemptions}}: upstream (a client paying
-- a relay) and downstream (a configured exit paying a relay for the answer).
-- Most of the dashboard is drawn from this one result: volume, redemptions,
-- the hour-of-week grids, the relay breakdowns, the client ranking and each
-- client's own record.
--
-- Volume: a redemption pays for one winning ticket, and with winning
-- probability p a winner stands for 1/p tickets of 650 bytes each, so it
-- accounts for 650 / (2^30 × p) GB at the p in force at its block. Before the
-- oracle's first update p is unknown, and the redemption counts with no volume.
--
-- Dates come from {{block_time()}}: interpolated between RPC-timestamped
-- anchor blocks, or estimated at five seconds a block when there is no RPC.
SELECT
  {{block_time(r.block)}} AS redeemed_at,
  ({{block_time(r.block)}})::date AS day,
  r.block,
  r.direction,
  {{> hex(r.payer)}} AS payer,
  {{> hex(r.relay)}} AS relay,
  r.tickets,
  COALESCE(w.probability, 0) AS win_probability,
  CASE
    WHEN w.probability > 0 THEN 650::float8 / 1073741824 / w.probability
    ELSE 0
  END AS gigabytes
FROM {{> vpn-redemptions}} AS r
LEFT JOIN {{> win-probability}} AS w
  ON r.block >= w.from_block AND r.block < w.to_block
ORDER BY r.block, r.tx_index, r.log_index

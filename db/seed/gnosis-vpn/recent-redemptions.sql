-- The 500 most recent client redemptions, with the channel they were on.
--
-- The same population as the upstream rows of vpn-traffic — a client paying
-- an announced relay — but read newest first and capped, because it is the
-- only result that needs the channel id, and carrying a 64-character id on
-- every row of the full history would cost far more than this feed shows.
SELECT
  {{block_time(r.block)}} AS redeemed_at,
  r.block,
  {{> hex(r.payer)}} AS client,
  {{> hex(r.relay)}} AS relay,
  '0x' || r.channel AS channel,
  r.tickets
FROM {{> vpn-redemptions}} AS r
WHERE r.direction = 'upstream'
ORDER BY r.block DESC, r.tx_index DESC, r.log_index DESC
LIMIT 500

-- History of the network ticket price.
--
-- Blokli keeps only the latest value, in chain_info.ticket_price, so the timeline is
-- recovered from the raw TicketPriceUpdated logs emitted by the ticket price oracle.
-- Topics are concatenated 32-byte words, so the first word is the event signature
-- hash of TicketPriceUpdated(uint256,uint256). Neither argument is indexed: data
-- word 0 is the old price and word 1 the new one.
SELECT
  block_number,
  SUBSTRING(data FROM 33 FOR 32) AS ticket_price
FROM log
WHERE SUBSTRING(topics FROM 1 FOR 32) =
  '\xd4c5e06b1ae097ba02372652a7adaa6e4a8e00be527497a3ad0ebc3f761ef3fb'::bytea
  AND removed = FALSE
  AND OCTET_LENGTH(data) >= 64
ORDER BY block_number ASC, tx_index ASC, log_index ASC;

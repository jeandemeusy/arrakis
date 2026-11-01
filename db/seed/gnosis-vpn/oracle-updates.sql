-- Every update of the two oracle values the dashboard prices traffic with,
-- oldest first: `ticket-price` (value: the new price, 32 bytes, in wei) and
-- `win-prob` (value: the new winning probability, 7 bytes; decode it with
-- {{> decode-win-prob(value)}}).
--
-- Blokli keeps only the latest of each, in chain_info, so the history is read
-- back from the raw logs. Topics are concatenated 32-byte words, so the first
-- is the event signature:
--
--   TicketPriceUpdated(uint256,uint256)  d4c5e06b…f3fb
--   WinProbUpdated(uint56,uint56)        02728c4a…3800
--
-- Neither event indexes its arguments, so data word 1 is the new value: the
-- price is the whole word, at offset 33; a uint56 is right-aligned in its
-- word, so the probability is its last 7 bytes, at offset 58. The signatures
-- are matched as prefix ranges, which an index on `topics` can answer.
SELECT
  block_number,
  tx_index,
  log_index,
  CASE
    WHEN topics < '\x02728c4a80373f4765559dc3a046edea88186424827238bb46245668315d3801'::bytea
      THEN 'win-prob'
    ELSE 'ticket-price'
  END AS kind,
  CASE
    WHEN topics < '\x02728c4a80373f4765559dc3a046edea88186424827238bb46245668315d3801'::bytea
      THEN SUBSTRING(data FROM 58 FOR 7)
    ELSE SUBSTRING(data FROM 33 FOR 32)
  END AS value
FROM log
WHERE removed = FALSE
  AND OCTET_LENGTH(data) >= 64
  AND (
    (
      topics >= '\xd4c5e06b1ae097ba02372652a7adaa6e4a8e00be527497a3ad0ebc3f761ef3fb'::bytea
      AND topics < '\xd4c5e06b1ae097ba02372652a7adaa6e4a8e00be527497a3ad0ebc3f761ef3fc'::bytea
    )
    OR (
      topics >= '\x02728c4a80373f4765559dc3a046edea88186424827238bb46245668315d3800'::bytea
      AND topics < '\x02728c4a80373f4765559dc3a046edea88186424827238bb46245668315d3801'::bytea
    )
  )
ORDER BY block_number, tx_index, log_index

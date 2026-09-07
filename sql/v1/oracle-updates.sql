-- History of the two oracle values: network ticket price and minimum winning
-- probability.
--
-- Blokli keeps only the latest of each, in chain_info.ticket_price and
-- chain_info.min_incoming_ticket_win_prob, so both timelines are recovered from
-- the raw oracle logs. Topics are stored as concatenated 32-byte words, so the
-- first word is the event signature hash:
--
--   TicketPriceUpdated(uint256,uint256)  d4c5e06b…f3fb  ticket price oracle
--   WinProbUpdated(uint56,uint56)        02728c4a…3800  winning probability oracle
--
-- Neither event indexes either argument, so data word 0 is the old value and word
-- 1 the new one. The price is a full uint256 — 32 bytes at offset 33. A uint56 is
-- right-aligned in its word, so the new probability is the trailing 7 bytes of the
-- second word, at offset 58.
--
-- One query rather than two, over the largest table in the schema. Both signatures
-- are matched as PREFIX RANGES rather than with `SUBSTRING(topics FROM 1 FOR 32) =
-- …`: wrapping the column in a function makes the predicate unindexable and costs
-- a sequential scan of `log`, once per signature. bytea compares byte by byte, so
-- `topics >= hash AND topics < hash + 1` selects exactly the rows whose first word
-- is that hash and can be answered from an index on `topics`. Extracting the value
-- still needs SUBSTRING, but that runs in the select list, where it costs nothing
-- an index could have saved.
SELECT
  block_number,
  CASE SUBSTRING(topics FROM 1 FOR 32)
    WHEN '\xd4c5e06b1ae097ba02372652a7adaa6e4a8e00be527497a3ad0ebc3f761ef3fb'::bytea
      THEN 'ticket-price'
    ELSE 'win-prob'
  END AS kind,
  CASE SUBSTRING(topics FROM 1 FOR 32)
    WHEN '\xd4c5e06b1ae097ba02372652a7adaa6e4a8e00be527497a3ad0ebc3f761ef3fb'::bytea
      THEN SUBSTRING(data FROM 33 FOR 32)
    ELSE SUBSTRING(data FROM 58 FOR 7)
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
ORDER BY block_number ASC, tx_index ASC, log_index ASC;

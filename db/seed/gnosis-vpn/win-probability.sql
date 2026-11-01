-- The winning probability in force over each range of blocks.
--
-- Each update in {{> oracle-updates}} holds from its block until the next
-- one's. Blocks before the first update have no probability on record: they
-- match no row here, and the queries that join this price them at zero rather
-- than guess. With no history at all, the one value chain_info has covers
-- every block (or 1 when that is unset either).
WITH update AS (
  SELECT
    block_number,
    tx_index,
    log_index,
    {{> decode-win-prob(value)}} AS probability
  FROM {{> oracle-updates}} AS oracle
  WHERE kind = 'win-prob'
)
SELECT
  block_number AS from_block,
  COALESCE(
    LEAD(block_number) OVER (ORDER BY block_number, tx_index, log_index),
    9223372036854775807
  ) AS to_block,
  probability
FROM update
UNION ALL
SELECT
  0,
  9223372036854775807,
  COALESCE(
    (
      SELECT NULLIF(GREATEST(min_incoming_ticket_win_prob, 0), 0)
      FROM chain_info
      ORDER BY id
      LIMIT 1
    ),
    1
  )
WHERE NOT EXISTS (SELECT 1 FROM update)

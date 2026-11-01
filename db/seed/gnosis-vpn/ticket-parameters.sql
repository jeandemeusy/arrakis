-- The oracle values as they stand: winning probability, ticket price, and
-- what a ticket is worth for one remaining hop (price ÷ probability). One row.
--
-- The newest update of each in {{> oracle-updates}}, so the figures match the
-- history the volume is priced with; both are null when the oracle has never
-- been indexed. Per network only: each network sets its own price and
-- probability, so a combined figure would be a fiction.
WITH latest_probability AS (
  SELECT {{> decode-win-prob(value)}} AS value
  FROM {{> oracle-updates}} AS oracle
  WHERE kind = 'win-prob'
  ORDER BY block_number DESC, tx_index DESC, log_index DESC
  LIMIT 1
),
latest_price AS (
  SELECT {{> uint256(value)}} AS wei
  FROM {{> oracle-updates}} AS oracle
  WHERE kind = 'ticket-price'
  ORDER BY block_number DESC, tx_index DESC, log_index DESC
  LIMIT 1
)
SELECT
  (SELECT value FROM latest_probability) AS win_probability,
  (SELECT ROUND(wei) FROM latest_price) AS ticket_price,
  (
    SELECT ROUND(latest_price.wei / latest_probability.value::numeric)
    FROM latest_price, latest_probability
    WHERE latest_probability.value > 0
  ) AS ticket_value

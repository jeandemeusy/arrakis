-- The network as it stands at the last indexed block: one row.
--
-- Balances are 32-byte big-endian integers in wei, summed as exact numerics
-- ({{> uint256(balance)}}).
WITH amount AS (
  SELECT 'channel' AS kind, {{> uint256(balance)}} AS wei FROM channel_current
  WHERE status = 1 AND corrupted_state = FALSE
  UNION ALL
  SELECT 'safe', {{> uint256(balance)}} FROM hopr_balance
  WHERE address IN (SELECT address FROM hopr_safe_contract)
)
SELECT
  (SELECT last_indexed_block FROM chain_info ORDER BY id LIMIT 1) AS indexed_block,
  {{block_time((SELECT last_indexed_block FROM chain_info ORDER BY id LIMIT 1))}} AS indexed_at,
  COALESCE((SELECT version FROM schema_version ORDER BY id DESC LIMIT 1), 'unknown') AS schema_version,
  (SELECT COUNT(*) FROM account) AS accounts,
  (SELECT COUNT(*) FROM hopr_safe_contract) AS safes,
  (SELECT COUNT(*) FROM channel_current WHERE status = 1 AND corrupted_state = FALSE) AS open_channels,
  COALESCE((SELECT ROUND(SUM(wei)) FROM amount WHERE kind = 'channel'), 0) AS channel_balance,
  COALESCE((SELECT ROUND(SUM(wei)) FROM amount WHERE kind = 'safe'), 0) AS safe_balance

SELECT
  COALESCE((SELECT version FROM schema_version ORDER BY id DESC LIMIT 1), 'unknown') AS schema_version,
  COALESCE((SELECT last_indexed_block FROM chain_info ORDER BY id LIMIT 1), 0) AS block_number,
  (SELECT COUNT(*) FROM account) AS accounts,
  (SELECT COUNT(*) FROM hopr_safe_contract) AS safes,
  (SELECT COUNT(*) FROM channel_current WHERE status = 1 AND corrupted_state = FALSE) AS open_channels,
  (
    SELECT COUNT(*)
    FROM service_entry_current
    WHERE deregistered = FALSE
      AND SUBSTRING(service_type FROM 1 FOR 9) = CONVERT_TO('gvpn:exit', 'UTF8')
  ) AS exits;

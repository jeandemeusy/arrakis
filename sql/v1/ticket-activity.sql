SELECT
  safe_address,
  node_address,
  redeemed_amount,
  published_block,
  published_tx_index,
  published_log_index
FROM hopr_safe_redeemed_stat_event
ORDER BY published_block ASC, published_tx_index ASC, published_log_index ASC;

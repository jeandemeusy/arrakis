-- The contracts this index subscribes to.
--
-- Blokli records one row per (contract, event topic) pair it watches, so the
-- distinct addresses are exactly the contracts being indexed, and the topics say
-- what each one is. Topics are 32-byte event signature hashes.
SELECT
  address,
  ARRAY_AGG(DISTINCT ENCODE(topic, 'hex')) AS topics
FROM log_topic_info
GROUP BY address
ORDER BY address;

-- History of the network minimum ticket winning probability.
--
-- Blokli keeps only the latest value, in chain_info.min_incoming_ticket_win_prob,
-- so the timeline is recovered from the raw WinProbUpdated logs emitted by the
-- winning probability oracle. Topics are stored as concatenated 32-byte words, so
-- the first word is the event signature hash of WinProbUpdated(uint56,uint56).
-- Neither argument is indexed: data word 0 is oldWinProb and word 1 is newWinProb,
-- each a uint56 right-aligned in its word, hence the trailing 7 bytes at offset 58.
SELECT
  block_number,
  SUBSTRING(data FROM 58 FOR 7) AS win_prob
FROM log
WHERE SUBSTRING(topics FROM 1 FOR 32) =
  '\x02728c4a80373f4765559dc3a046edea88186424827238bb46245668315d3800'::bytea
  AND removed = FALSE
  AND OCTET_LENGTH(data) >= 64
ORDER BY block_number ASC, tx_index ASC, log_index ASC;

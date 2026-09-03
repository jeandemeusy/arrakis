-- First appearance of every VPN client.
--
-- Blokli creates an account row from the KeyBinding event, so account.published_block
-- is the block a node was first deployed. Clients are the accounts that bound a key
-- but never announced an address: announced accounts are relay infrastructure.
SELECT
  account.chain_key AS account,
  account.published_block
FROM account
WHERE NOT EXISTS (
  SELECT 1 FROM announcement WHERE announcement.account_id = account.id
)
ORDER BY account.published_block ASC;

-- VPN clients: accounts that bound a key but never announced an address, so
-- they are not infrastructure. Blokli creates the account row from the
-- KeyBinding event, so its block is when the client was deployed.
SELECT
  account.id AS account_id,
  account.chain_key AS client,
  account.published_block AS deployed_block
FROM account
WHERE account.id NOT IN (SELECT account_id FROM {{> vpn-nodes}} AS node)

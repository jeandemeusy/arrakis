-- Accounts that announced an address: the network's infrastructure, relays
-- and exits alike. Nothing on chain tells the two apart; the exits are the
-- ones named in Settings → Exits ({{exits}}).
SELECT account.id AS account_id, account.chain_key AS address
FROM account
WHERE EXISTS (
  SELECT 1 FROM announcement WHERE announcement.account_id = account.id
)

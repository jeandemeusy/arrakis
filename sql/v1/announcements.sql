-- Every node announcement, used as the second half of the active-user definition:
-- an account is active in a window if it announced in that window.
SELECT
  account.chain_key AS account,
  announcement.published_block
FROM announcement
JOIN account ON account.id = announcement.account_id
ORDER BY announcement.published_block ASC;

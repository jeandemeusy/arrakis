-- Every VPN client deployment ({{> vpn-clients}}), newest first.
SELECT
  {{block_time(deployed_block)}} AS deployed_at,
  ({{block_time(deployed_block)}})::date AS deployed_on,
  deployed_block AS block,
  {{> hex(client)}} AS client
FROM {{> vpn-clients}} AS clients
ORDER BY deployed_block DESC, account_id DESC

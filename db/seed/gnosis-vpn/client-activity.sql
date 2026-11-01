-- Each day each VPN client was active, with when it was deployed.
--
-- A client ({{> vpn-clients}}) is active on a day when a relay redeemed one of
-- its tickets that day, or when it was deployed that day — so a new client
-- counts at once rather than only after its first redemption. One row per
-- client and day:
--
--   kind          `new` on the deployment day, `returning` on any other
--   redemptions   0 on a deployment day with no traffic
--   deployed_on   the client's deployment day, on every row
--
-- Feeds the active-user counts, new versus returning, and the deployment
-- cohorts.
WITH deployment AS (
  SELECT
    client,
    ({{block_time(deployed_block)}})::date AS deployed_on
  FROM {{> vpn-clients}} AS clients
),
redeemed AS (
  SELECT
    r.payer AS client,
    ({{block_time(r.block)}})::date AS day,
    COUNT(*) AS redemptions
  FROM {{> vpn-redemptions}} AS r
  WHERE r.direction = 'upstream'
  GROUP BY 1, 2
),
active AS (
  SELECT client, day, redemptions FROM redeemed
  UNION ALL
  SELECT client, deployed_on, 0 FROM deployment
)
SELECT
  {{> hex(active.client)}} AS client,
  active.day,
  deployment.deployed_on,
  CASE WHEN active.day = deployment.deployed_on THEN 'new' ELSE 'returning' END AS kind,
  SUM(active.redemptions)::integer AS redemptions
FROM active
LEFT JOIN deployment ON deployment.client = active.client
GROUP BY active.client, active.day, deployment.deployed_on
ORDER BY active.day, client

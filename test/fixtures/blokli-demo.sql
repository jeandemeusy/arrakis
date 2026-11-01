-- A realistic synthetic Blokli index, generated rather than written out.
--
--   psql -f test/fixtures/blokli-demo.sql
--   psql -c "SET demo.seed = 'jura'" -c "SET demo.clients = '150'" -f test/fixtures/blokli-demo.sql
--
-- Where blokli.sql is small and exact, this one is shaped like a live network:
-- eleven months of clients deploying at a growing rate, using the VPN in
-- daytime hours and less at weekends, some churning after a month; relays
-- redeeming their tickets; three exits paying the return path seconds after
-- each request; relays and two probe-only nodes probing each other; winning
-- probability and ticket price changing over time, with traffic indexed before
-- the first oracle update. Channels also carry what the queries must skip:
-- funding events, a reopened epoch, corrupted and reorg-corrected rows.
--
-- Deterministic for a given seed: every draw is a hash of the seed and what
-- is being drawn. Block numbers are placed from the time of generation at the
-- five-second Gnosis cadence, so with no RPC configured the estimated clock
-- dates the newest block "now" and the history lines up with the calendar.
--
-- Settings, all optional: demo.seed (text, default demo), demo.clients
-- (default 400), demo.head (the last indexed block, default 46000000).
-- Accounts 1-12 are relays, 13-15 exits, 16-17 probe-only nodes.

SET client_min_messages = warning;
DO $$
BEGIN
  PERFORM set_config('demo.seed', COALESCE(NULLIF(current_setting('demo.seed', true), ''), 'demo'), false);
  PERFORM set_config('demo.clients', COALESCE(NULLIF(current_setting('demo.clients', true), ''), '400'), false);
  PERFORM set_config('demo.head', COALESCE(NULLIF(current_setting('demo.head', true), ''), '46000000'), false);
END
$$;

CREATE TABLE schema_version (id serial PRIMARY KEY, version text NOT NULL);
INSERT INTO schema_version (version) VALUES ('m005');

CREATE TABLE chain_info (
  id serial PRIMARY KEY,
  last_indexed_block bigint NOT NULL,
  ticket_price bytea,
  min_incoming_ticket_win_prob double precision
);

CREATE TABLE account (
  id serial PRIMARY KEY,
  chain_key bytea NOT NULL,
  published_block bigint NOT NULL
);

CREATE TABLE announcement (
  id serial PRIMARY KEY,
  account_id integer NOT NULL REFERENCES account (id),
  multiaddress text NOT NULL,
  published_block bigint NOT NULL
);

CREATE TABLE channel (
  id serial PRIMARY KEY,
  concrete_channel_id text NOT NULL,
  source integer NOT NULL REFERENCES account (id),
  destination integer NOT NULL REFERENCES account (id)
);

CREATE TABLE channel_state (
  id serial PRIMARY KEY,
  channel_id integer NOT NULL REFERENCES channel (id),
  published_block bigint NOT NULL,
  published_tx_index bigint NOT NULL,
  published_log_index bigint NOT NULL,
  epoch bigint NOT NULL,
  ticket_index bigint NOT NULL,
  balance bytea NOT NULL,
  status smallint NOT NULL,
  corrupted_state boolean NOT NULL DEFAULT FALSE,
  reorg_correction boolean NOT NULL DEFAULT FALSE
);

CREATE TABLE channel_current (
  channel_id integer PRIMARY KEY REFERENCES channel (id),
  balance bytea NOT NULL,
  status smallint NOT NULL,
  corrupted_state boolean NOT NULL DEFAULT FALSE
);

CREATE TABLE hopr_safe_contract (id serial PRIMARY KEY, address bytea NOT NULL);
CREATE TABLE hopr_balance (address bytea PRIMARY KEY, balance bytea NOT NULL);

CREATE TABLE log (
  id serial PRIMARY KEY,
  block_number bigint NOT NULL,
  tx_index bigint NOT NULL,
  log_index bigint NOT NULL,
  address bytea NOT NULL,
  topics bytea NOT NULL,
  data bytea NOT NULL,
  removed boolean NOT NULL DEFAULT FALSE
);
CREATE INDEX log_topics ON log (topics);

CREATE TABLE log_topic_info (id serial PRIMARY KEY, address bytea NOT NULL, topic bytea NOT NULL);

-- A uniform draw in [0, 1) named by `key`: the same key always draws the same.
CREATE FUNCTION pg_temp.r(key text) RETURNS double precision LANGUAGE sql STABLE AS $$
  SELECT ('x' || substr(md5(current_setting('demo.seed') || ':' || key), 1, 13))::bit(52)::bigint
         / 4503599627370496.0
$$;

-- 20 bytes named by `key`, for addresses.
CREATE FUNCTION pg_temp.address(key text) RETURNS bytea LANGUAGE sql STABLE AS $$
  SELECT decode(substr(md5(current_setting('demo.seed') || ':addr:' || key)
                       || md5(current_setting('demo.seed') || ':addr2:' || key), 1, 40), 'hex')
$$;

-- An unsigned integer as a 32-byte big-endian word, the way Blokli stores amounts.
CREATE FUNCTION pg_temp.word(n numeric) RETURNS bytea LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  out bytea := '\x'::bytea;
BEGIN
  FOR i IN 1..32 LOOP
    out := set_byte('\x00'::bytea, 0, (n % 256)::int) || out;
    n := floor(n / 256);
  END LOOP;
  RETURN out;
END
$$;

-- A winning probability in HOPR's 7-byte encoding, as the trailing bytes of a word.
CREATE FUNCTION pg_temp.win_prob(p double precision) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p >= 1 THEN pg_temp.word(72057594037927935)
    ELSE pg_temp.word(floor(p * 72057594037927936)::numeric - 1)
  END
$$;

CREATE TEMP TABLE demo AS
SELECT
  current_setting('demo.head')::bigint AS head,
  floor(extract(epoch FROM now()))::bigint AS now_s,
  floor(extract(epoch FROM now()) / 86400)::int AS today,
  current_setting('demo.clients')::int AS clients;

-- Seconds since the epoch to a block number, at five seconds a block.
CREATE FUNCTION pg_temp.block_at(ts bigint) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT head - (now_s - ts) / 5 FROM demo
$$;

-- Accounts: relays 1-12, exits 13-15, probe-only nodes 16-17, clients after.
INSERT INTO account (id, chain_key, published_block)
SELECT n, pg_temp.address('node' || n),
       pg_temp.block_at((SELECT now_s FROM demo) - 335 * 86400 + n * 600)
FROM generate_series(1, 17) AS n;

CREATE TEMP TABLE client AS
SELECT
  17 + c AS id,
  c,
  -- Deployments accelerate: the newest months get the most.
  (SELECT now_s FROM demo)
    - floor(320 * 86400 * (1 - sqrt(pg_temp.r('deploy' || c))))::bigint AS deployed_s,
  0.12 + 0.55 * pg_temp.r('base' || c) AS base,
  pg_temp.r('churn' || c) < 0.3 AS churns,
  1 + (c % 12) AS primary_relay,
  1 + ((c * 7 + 3) % 12) AS secondary_relay,
  13 + (c % 3) AS exit_id
FROM generate_series(1, (SELECT clients FROM demo)) AS c;

INSERT INTO account (id, chain_key, published_block)
SELECT id, pg_temp.address('client' || c), pg_temp.block_at(deployed_s)
FROM client;
DO $$ BEGIN PERFORM setval('account_id_seq', (SELECT max(id) FROM account)); END $$;

INSERT INTO announcement (account_id, multiaddress, published_block)
SELECT id, '/dns4/node-' || id || '.example.net/tcp/9091', published_block + 10
FROM account WHERE id <= 17;

-- Days each client was active: likelier soon after deploying, less at weekends,
-- and close to never after the first month for the clients that churn.
CREATE TEMP TABLE active_day AS
SELECT client.id, client.c, client.relay_a, client.relay_b, client.exit_id,
       client.deployed_s, day, 1 + floor(4 * pg_temp.r('n' || client.c || ':' || day))::int AS n
FROM (
  SELECT *, primary_relay AS relay_a, secondary_relay AS relay_b,
         floor(deployed_s / 86400.0)::int AS deployed_day
  FROM client
) AS client
CROSS JOIN LATERAL generate_series(client.deployed_day, (SELECT today FROM demo)) AS day
WHERE pg_temp.r('a' || client.c || ':' || day) <
  client.base
  * CASE
      WHEN client.churns THEN CASE WHEN day - client.deployed_day < 30 THEN 1 ELSE 0.02 END
      ELSE 0.35 + 0.65 * exp(-(day - client.deployed_day) / 90.0)
    END
  * CASE WHEN extract(isodow FROM to_timestamp(day * 86400.0)) >= 6 THEN 0.65 ELSE 1 END;

-- Payments: (payer account, paid account, second, tickets).
CREATE TEMP TABLE payment (payer int, paid int, ts bigint, tickets int);

-- Upstream: a client paying a relay, mostly in waking hours (UTC).
INSERT INTO payment
SELECT id,
       CASE WHEN pg_temp.r('rel' || c || ':' || day || ':' || k) < 0.7 THEN relay_a ELSE relay_b END,
       ts,
       1 + floor(12 * pg_temp.r('t' || c || ':' || day || ':' || k))::int
FROM (
  SELECT ad.*, k,
         day * 86400::bigint
         + 3600 * CASE
             WHEN pg_temp.r('h' || c || ':' || day || ':' || k) < 0.85
               THEN 6 + floor(16 * pg_temp.r('hh' || c || ':' || day || ':' || k))
             ELSE floor(24 * pg_temp.r('hh' || c || ':' || day || ':' || k))
           END
         + floor(3600 * pg_temp.r('s' || c || ':' || day || ':' || k))::bigint AS ts
  FROM active_day AS ad CROSS JOIN LATERAL generate_series(1, ad.n) AS k
) AS draw
WHERE ts > deployed_s + 60 AND ts < (SELECT now_s FROM demo) - 120;

-- Downstream: the client's exit paying a relay for the answer, seconds later.
INSERT INTO payment
SELECT client.exit_id,
       1 + floor(12 * pg_temp.r('dr' || p.payer || ':' || p.ts || ':' || leg))::int,
       p.ts + 2 + leg * 25 + floor(20 * pg_temp.r('ds' || p.payer || ':' || p.ts || ':' || leg))::bigint,
       1 + floor(20 * pg_temp.r('dt' || p.payer || ':' || p.ts || ':' || leg))::int
FROM payment AS p
JOIN client ON client.id = p.payer
CROSS JOIN generate_series(0, 1) AS leg
WHERE pg_temp.r('dk' || p.payer || ':' || p.ts || ':' || leg) < CASE leg WHEN 0 THEN 0.9 ELSE 0.55 END
  AND p.ts + 60 < (SELECT now_s FROM demo) - 60;

-- Probing: relays and the probe-only nodes paying relays, round the clock.
INSERT INTO payment
SELECT payer,
       1 + ((payer + floor(11 * pg_temp.r('pd' || payer || ':' || day || ':' || k))::int) % 12),
       day * 86400::bigint + floor(86400 * pg_temp.r('ps' || payer || ':' || day || ':' || k))::bigint,
       1 + floor(6 * pg_temp.r('pt' || payer || ':' || day || ':' || k))::int
FROM (SELECT generate_series(1, 12) AS payer UNION ALL SELECT 16 UNION ALL SELECT 17) AS payers
CROSS JOIN generate_series((SELECT today FROM demo) - 330, (SELECT today FROM demo) - 1) AS day
CROSS JOIN generate_series(1, 3) AS k;

-- One channel per payer and payee that ever paid.
INSERT INTO channel (concrete_channel_id, source, destination)
SELECT md5(current_setting('demo.seed') || ':channel:' || payer || ':' || paid), payer, paid
FROM (SELECT DISTINCT payer, paid FROM payment WHERE payer <> paid) AS pairs
ORDER BY payer, paid;

-- Channel events. Each channel opens at ticket index 0 an hour before its first
-- payment, and every payment advances the index by its tickets. Every tenth
-- channel is closed and reopened halfway — a new epoch restarting the index —
-- and every seventh gets a funding event that leaves the index where it was.
CREATE TEMP TABLE event AS
WITH numbered AS (
  SELECT channel.id AS channel_id, p.ts, p.tickets,
         row_number() OVER (PARTITION BY channel.id ORDER BY p.ts, p.tickets) AS seq,
         count(*) OVER (PARTITION BY channel.id) AS total
  FROM payment AS p
  JOIN channel ON channel.source = p.payer AND channel.destination = p.paid
),
epoched AS (
  SELECT *, CASE WHEN channel_id % 10 = 0 AND seq > total / 2 THEN 2 ELSE 1 END AS epoch
  FROM numbered
)
SELECT channel_id, ts, epoch,
       sum(tickets) OVER (PARTITION BY channel_id, epoch ORDER BY seq) AS ticket_index
FROM epoched
UNION ALL
SELECT channel_id, min(ts) - 3600, 1, 0 FROM numbered GROUP BY channel_id
UNION ALL
SELECT channel_id, ts + 7, epoch, ticket_index
FROM (
  SELECT channel_id, ts, 1 AS epoch,
         sum(tickets) OVER (PARTITION BY channel_id ORDER BY seq) AS ticket_index, seq
  FROM numbered WHERE channel_id % 7 = 0 AND channel_id % 10 <> 0
) AS funded
WHERE seq % 5 = 0;

INSERT INTO channel_state (
  channel_id, published_block, published_tx_index, published_log_index,
  epoch, ticket_index, balance, status, corrupted_state, reorg_correction
)
SELECT channel_id,
       pg_temp.block_at(ts),
       row_number() OVER (PARTITION BY pg_temp.block_at(ts) ORDER BY channel_id, ts, ticket_index),
       0,
       epoch,
       ticket_index,
       pg_temp.word((100 + channel_id % 400) * 1000000000000000000::numeric),
       1,
       pg_temp.r('corrupt' || channel_id || ':' || ts) < 0.004,
       pg_temp.r('reorg' || channel_id || ':' || ts) < 0.002
FROM event
ORDER BY 2, 3;

INSERT INTO channel_current (channel_id, balance, status, corrupted_state)
SELECT id,
       pg_temp.word(floor(1 + 400 * pg_temp.r('bal' || id))::numeric * 1000000000000000000
                    + floor(1000000 * pg_temp.r('balf' || id))::numeric * 1000000000000),
       CASE WHEN pg_temp.r('open' || id) < 0.85 THEN 1 ELSE 3 END,
       pg_temp.r('cc' || id) < 0.01
FROM channel;

INSERT INTO hopr_safe_contract (address)
SELECT pg_temp.address('safe' || n) FROM generate_series(1, 40) AS n;
INSERT INTO hopr_balance (address, balance)
SELECT address, pg_temp.word(floor(5000 * pg_temp.r('safe-bal' || id))::numeric * 1000000000000000000)
FROM hopr_safe_contract
WHERE pg_temp.r('safe-funded' || id) < 0.9;
-- A balance that is not a safe's, which the safe total must leave out.
INSERT INTO hopr_balance (address, balance)
VALUES (pg_temp.address('not-a-safe'), pg_temp.word(123456 * 1000000000000000000::numeric));

-- Oracle history: winning probability falls from 1 to 0.2 in steps, the first
-- update arriving after the earliest traffic; the ticket price changes twice.
CREATE TEMP TABLE oracle AS
SELECT * FROM (VALUES
  ('win', 300, 1.0::double precision),
  ('win', 200, 0.5),
  ('win', 90, 0.25),
  ('win', 21, 0.2),
  ('price', 310, 0.1),
  ('price', 100, 0.15)
) AS o (kind, days_ago, value);

INSERT INTO log (block_number, tx_index, log_index, address, topics, data)
SELECT pg_temp.block_at((SELECT now_s FROM demo) - days_ago * 86400 + 3600),
       0, 0,
       pg_temp.address(kind || '-oracle'),
       CASE kind
         WHEN 'win' THEN '\x02728c4a80373f4765559dc3a046edea88186424827238bb46245668315d3800'::bytea
         ELSE '\xd4c5e06b1ae097ba02372652a7adaa6e4a8e00be527497a3ad0ebc3f761ef3fb'::bytea
       END,
       CASE kind
         WHEN 'win' THEN pg_temp.win_prob(1) || pg_temp.win_prob(value)
         ELSE pg_temp.word(0) || pg_temp.word(round(value::numeric * 1000000000000000000))
       END
FROM oracle;

-- Unrelated events, so the oracle lookup has a table to search.
INSERT INTO log (block_number, tx_index, log_index, address, topics, data)
SELECT pg_temp.block_at((SELECT now_s FROM demo) - floor(330 * 86400 * pg_temp.r('noise' || n))::bigint),
       1, n % 4,
       pg_temp.address('channels-contract'),
       decode(md5('noise' || (n % 9)) || md5('noise2' || (n % 9)), 'hex'),
       pg_temp.word(n) || pg_temp.word(n * 2)
FROM generate_series(1, 3000) AS n;

INSERT INTO log_topic_info (address, topic)
SELECT pg_temp.address(name), decode(topic, 'hex')
FROM (VALUES
  ('channels-contract', 'ed22f34d154d253a7f6fd477439be59080a1554aa0d0642686d64223ab544c8a'),
  ('channels-contract', '004c0177ad15bb302b4419e9ac96065d6f436e0f61972f97bbe272834c40f934'),
  ('announcements-contract', 'c4df5ba16814838ab2618829d68f8623bb897302f24dbdba2279dbe45adb3d14'),
  ('registry-contract', '776da40cbf2c223552661bd48502ceb72409b3362bb0c66d8989bd7e20e4497d'),
  ('price-oracle', 'd4c5e06b1ae097ba02372652a7adaa6e4a8e00be527497a3ad0ebc3f761ef3fb'),
  ('win-oracle', '02728c4a80373f4765559dc3a046edea88186424827238bb46245668315d3800'),
  ('token-contract', '06b541ddaa720db2b10a4d0cdac39b8d360425fc073085fac19bc82614677987'),
  ('factory-contract', '83a5c31bfee49d254d95e3946d8e8434e5975382fa8b849182db9e251aaaaa26'),
  ('mystery-contract', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
) AS c (name, topic);

INSERT INTO chain_info (last_indexed_block, ticket_price, min_incoming_ticket_win_prob)
SELECT head, pg_temp.word(150000000000000000), 0.2 FROM demo;

ANALYZE;

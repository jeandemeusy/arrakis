-- A small, synthetic Blokli index.
--
-- Only the relations and columns the dashboard's queries read, with enough rows
-- to exercise them: relays and exits that announce, clients that do not, client
-- channels with ticket redemptions, relay-to-relay probing, and the two oracle
-- event streams. Values are deterministic so test assertions can be exact.
--
-- This is test scaffolding, not a schema reference: column types follow what the
-- dashboard decodes, and anything it never reads is left out.

CREATE TABLE schema_version (id serial PRIMARY KEY, version text NOT NULL);
INSERT INTO schema_version (version) VALUES ('m005');

CREATE TABLE chain_info (
  id serial PRIMARY KEY,
  last_indexed_block bigint NOT NULL,
  ticket_price bytea,
  min_incoming_ticket_win_prob double precision
);
INSERT INTO chain_info (last_indexed_block, ticket_price, min_incoming_ticket_win_prob)
VALUES (40000000, decode(lpad(to_hex(100000000000000000), 64, '0'), 'hex'), 0.5);

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

-- Accounts 1-3 are relays, 4-5 exits, 6-25 clients. Addresses are the account id
-- left-padded, so 0x…01 is account 1 and tests can name them without lookups.
INSERT INTO account (chain_key, published_block)
SELECT decode(lpad(to_hex(n), 40, '0'), 'hex'), 39000000 + n * 1000
FROM generate_series(1, 25) AS n;

INSERT INTO announcement (account_id, multiaddress, published_block)
SELECT n, '/ip4/10.0.0.' || n || '/tcp/9091', 39000000 + n * 1000 + 10
FROM generate_series(1, 5) AS n;

CREATE TABLE channel (
  id serial PRIMARY KEY,
  concrete_channel_id text NOT NULL,
  source integer NOT NULL REFERENCES account (id),
  destination integer NOT NULL REFERENCES account (id)
);

-- Every client opens one channel to a relay; each exit opens one to each relay;
-- relays 1 and 2 probe each other.
INSERT INTO channel (concrete_channel_id, source, destination)
SELECT md5('client-' || c), c, 1 + (c % 3) FROM generate_series(6, 25) AS c;
INSERT INTO channel (concrete_channel_id, source, destination)
SELECT md5('exit-' || e || '-' || r), e, r
FROM generate_series(4, 5) AS e, generate_series(1, 3) AS r;
INSERT INTO channel (concrete_channel_id, source, destination)
VALUES (md5('probe-1-2'), 1, 2), (md5('probe-2-1'), 2, 1);

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

-- Ten events per channel: an open at ticket index 0, then nine redemptions that
-- advance the index by (channel id) tickets each.
INSERT INTO channel_state (
  channel_id, published_block, published_tx_index, published_log_index,
  epoch, ticket_index, balance, status
)
SELECT
  ch.id,
  39500000 + ch.id * 100 + step * 10000,
  0,
  0,
  1,
  step * ch.id,
  decode(lpad(to_hex(1000000000000000000), 64, '0'), 'hex'),
  1
FROM channel AS ch, generate_series(0, 9) AS step;

CREATE TABLE channel_current (
  channel_id integer PRIMARY KEY REFERENCES channel (id),
  balance bytea NOT NULL,
  status smallint NOT NULL,
  corrupted_state boolean NOT NULL DEFAULT FALSE
);
INSERT INTO channel_current (channel_id, balance, status)
SELECT id, decode(lpad(to_hex(1000000000000000000), 64, '0'), 'hex'), 1
FROM channel;

CREATE TABLE hopr_safe_contract (id serial PRIMARY KEY, address bytea NOT NULL);
INSERT INTO hopr_safe_contract (address)
SELECT decode(lpad(to_hex(1000 + n), 40, '0'), 'hex') FROM generate_series(1, 5) AS n;

CREATE TABLE hopr_balance (address bytea PRIMARY KEY, balance bytea NOT NULL);
INSERT INTO hopr_balance (address, balance)
SELECT address, decode(lpad(to_hex(5000000000000000000), 64, '0'), 'hex')
FROM hopr_safe_contract;

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

-- Two winning-probability updates (1.0 then 0.5) and one ticket price update.
-- uint56 values are right-aligned in their 32-byte word; 1.0 is 0xffffffffffffff.
INSERT INTO log (block_number, tx_index, log_index, address, topics, data)
VALUES
  (39400000, 0, 0, '\x00000000000000000000000000000000000000aa',
   '\x02728c4a80373f4765559dc3a046edea88186424827238bb46245668315d3800',
   decode(repeat('00', 32) || repeat('00', 25) || 'ffffffffffffff', 'hex')),
  (39800000, 0, 0, '\x00000000000000000000000000000000000000aa',
   '\x02728c4a80373f4765559dc3a046edea88186424827238bb46245668315d3800',
   decode(repeat('00', 25) || 'ffffffffffffff' || repeat('00', 25) || '7fffffffffffff', 'hex')),
  (39400001, 0, 0, '\x00000000000000000000000000000000000000bb',
   '\xd4c5e06b1ae097ba02372652a7adaa6e4a8e00be527497a3ad0ebc3f761ef3fb',
   decode(repeat('00', 32) || lpad(to_hex(100000000000000000), 64, '0'), 'hex'));

CREATE TABLE log_topic_info (id serial PRIMARY KEY, address bytea NOT NULL, topic bytea NOT NULL);
INSERT INTO log_topic_info (address, topic)
VALUES
  ('\x00000000000000000000000000000000000000aa', '\x02728c4a80373f4765559dc3a046edea88186424827238bb46245668315d3800'),
  ('\x00000000000000000000000000000000000000bb', '\xd4c5e06b1ae097ba02372652a7adaa6e4a8e00be527497a3ad0ebc3f761ef3fb');

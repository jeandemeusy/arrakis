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
SELECT md5('client-' || c) || md5('client2-' || c), c, 1 + (c % 3) FROM generate_series(6, 25) AS c;
INSERT INTO channel (concrete_channel_id, source, destination)
SELECT md5('exit-' || e || '-' || r) || md5('exit2-' || e || '-' || r), e, r
FROM generate_series(4, 5) AS e, generate_series(1, 3) AS r;
INSERT INTO channel (concrete_channel_id, source, destination)
VALUES (md5('probe-1-2') || md5('probe2-1-2'), 1, 2), (md5('probe-2-1') || md5('probe2-2-1'), 2, 1);

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

-- ---------------------------------------------------------------------------
-- The raw events. Blokli keeps every log of the contracts it watches in `log`
-- and derives the tables above from them; these are the logs the state above
-- would have come from, encoded as the contracts emit them, so a query that
-- reads the events rather than Blokli's tables sees the same history.
--
-- `topics` is the concatenated 32-byte topics, the event signature first;
-- `data` the ABI-encoded rest. Channel events all carry the channel's packed
-- state: status (byte 6), epoch (7-9), closure time (10-13), ticket index
-- (14-19) and balance (20-31). A corrupted state row stands for an event on a
-- channel Blokli never saw opened; a reorg-corrected one for a removed log.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE raw_topic (name text PRIMARY KEY, topic bytea NOT NULL);
INSERT INTO raw_topic (name, topic) VALUES
  ('key-binding', '\x11d94653de52fc143887956fe4b5e4120a850b1300ece0533dee6bd8ff91f732'),
  ('announcement', '\xc4df5ba16814838ab2618829d68f8623bb897302f24dbdba2279dbe45adb3d14'),
  ('revoke', '\xa4de30a528becadf82649d1395c0e30dd18ae35b5a96ce71e9295bb14bc9f3bc'),
  ('opened', '\x004c0177ad15bb302b4419e9ac96065d6f436e0f61972f97bbe272834c40f934'),
  ('redeemed', '\xed22f34d154d253a7f6fd477439be59080a1554aa0d0642686d64223ab544c8a'),
  ('increased', '\xec21547ca1e22edc3f9b4f4e0da94638b5b94dcb18d52dcc072abe5801a8013c'),
  ('closed', '\x197bba684a6afb7ba24f1d265605414b1d0051a6e295d6ff7b6e78e870d7a7f0'),
  ('safe', '\x83a5c31bfee49d254d95e3946d8e8434e5975382fa8b849182db9e251aaaaa26'),
  ('registered', '\x113517b01f8948e66b44bc59b45e47477fb89b357e7d1939b0d211dd15b698fe'),
  ('updated', '\xd290c349227ff04b271178af5d66f5375b072d8acfecd2ffcc80ec7ea77c69f5'),
  ('deregistered', '\xc156047b6a581b0578bc0cf242ee21ab84be919cf764ffd68ce50ded302323a7');

CREATE FUNCTION pg_temp.raw_topic(name text) RETURNS bytea LANGUAGE sql STABLE AS $$
  SELECT topic FROM raw_topic WHERE raw_topic.name = $1
$$;

-- A contract's address, named.
CREATE FUNCTION pg_temp.raw_contract(name text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT decode(substr(md5('contract:' || name) || md5('contract2:' || name), 1, 40), 'hex')
$$;

-- Bytes, or a hex number, right-aligned in a 32-byte word.
CREATE FUNCTION pg_temp.raw_word(value bytea) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT decode(lpad(encode(value, 'hex'), 64, '0'), 'hex')
$$;
CREATE FUNCTION pg_temp.raw_word(hex text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT decode(lpad(hex, 64, '0'), 'hex')
$$;

-- 32 bytes named by `key`, for signatures, keys and unknown channel ids.
CREATE FUNCTION pg_temp.raw_bytes32(key text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT decode(md5('b:' || key) || md5('b2:' || key), 'hex')
$$;

-- A channel's state, packed the way the Channels contract emits it.
CREATE FUNCTION pg_temp.raw_channel(status int, epoch bigint, ticket_index bigint, balance bytea)
RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT decode(
    repeat('00', 6)
    || lpad(to_hex(status), 2, '0')
    || lpad(to_hex(epoch), 6, '0')
    || '00000000'
    || lpad(to_hex(ticket_index), 12, '0')
    || right(encode(balance, 'hex'), 24),
    'hex')
$$;

-- KeyBinding(bytes32 ed25519_sig_0, bytes32 ed25519_sig_1, bytes32 ed25519_pub_key,
--            address chain_key, uint256 key_id): one per account, where Blokli
-- creates it, the key id being the account's id.
INSERT INTO log (block_number, tx_index, log_index, address, topics, data)
SELECT published_block, 0, 0,
       pg_temp.raw_contract('announcements'),
       pg_temp.raw_topic('key-binding'),
       pg_temp.raw_bytes32('sig0:' || id) || pg_temp.raw_bytes32('sig1:' || id)
       || pg_temp.raw_bytes32('key:' || id)
       || pg_temp.raw_word(chain_key) || pg_temp.raw_word(to_hex(id))
FROM account;

-- AddressAnnouncement(address node, string baseMultiaddr), for each announcement.
CREATE FUNCTION pg_temp.raw_announcement(node bytea, multiaddress text) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $$
  SELECT pg_temp.raw_word(node) || pg_temp.raw_word('40')
         || pg_temp.raw_word(to_hex(octet_length(multiaddress)))
         || decode(rpad(encode(convert_to(multiaddress, 'UTF8'), 'hex'),
                        64 * ceil(octet_length(multiaddress) / 32.0)::int, '0'), 'hex')
$$;

INSERT INTO log (block_number, tx_index, log_index, address, topics, data)
SELECT announcement.published_block, 0, 1,
       pg_temp.raw_contract('announcements'),
       pg_temp.raw_topic('announcement'),
       pg_temp.raw_announcement(account.chain_key, announcement.multiaddress)
FROM announcement
JOIN account ON account.id = announcement.account_id;

-- What leaves no announcement behind: the newest account announced and then
-- revoked (RevokeAnnouncement(address node)), the one before it announced an
-- empty address, which Blokli skips.
INSERT INTO log (block_number, tx_index, log_index, address, topics, data)
SELECT published_block + step, 0, 1,
       pg_temp.raw_contract('announcements'),
       pg_temp.raw_topic(kind),
       CASE kind
         WHEN 'revoke' THEN pg_temp.raw_word(chain_key)
         ELSE pg_temp.raw_announcement(chain_key, address)
       END
FROM (
  SELECT account.*, row_number() OVER (ORDER BY id DESC) AS rank
  FROM account
  WHERE id NOT IN (SELECT account_id FROM announcement)
) AS client
CROSS JOIN LATERAL (VALUES
  (1, 1, 'announcement', '/ip4/192.0.2.1/tcp/9091'),
  (1, 2, 'revoke', NULL),
  (2, 1, 'announcement', '')
) AS planted (rank, step, kind, address)
WHERE client.rank = planted.rank;

-- Channel events: one log per channel state row, of the kind its change from
-- the previous valid row implies. The first row of an epoch is the channel
-- (re)opened, with its source and destination as topics.
INSERT INTO log (block_number, tx_index, log_index, address, topics, data, removed)
SELECT cs.published_block, cs.published_tx_index, cs.published_log_index,
       pg_temp.raw_contract('channels'),
       CASE
         WHEN cs.corrupted_state
           THEN pg_temp.raw_topic('increased') || pg_temp.raw_bytes32('orphan:' || cs.id)
         WHEN cs.kind = 'opened'
           THEN pg_temp.raw_topic('opened') || decode(channel.concrete_channel_id, 'hex')
                || pg_temp.raw_word(source.chain_key) || pg_temp.raw_word(destination.chain_key)
         ELSE pg_temp.raw_topic(cs.kind) || decode(channel.concrete_channel_id, 'hex')
       END,
       pg_temp.raw_channel(cs.status, cs.epoch, cs.ticket_index, cs.balance),
       cs.reorg_correction
FROM (
  SELECT *,
         CASE
           WHEN corrupted_state OR reorg_correction THEN 'increased'
           WHEN epoch IS DISTINCT FROM LAG(epoch) OVER valid THEN 'opened'
           WHEN status = 0 THEN 'closed'
           WHEN ticket_index > LAG(ticket_index) OVER valid THEN 'redeemed'
           ELSE 'increased'
         END AS kind
  FROM channel_state
  WINDOW valid AS (
    PARTITION BY channel_id, corrupted_state OR reorg_correction
    ORDER BY published_block, published_tx_index, published_log_index
  )
) AS cs
JOIN channel ON channel.id = cs.channel_id
JOIN account AS source ON source.id = channel.source
JOIN account AS destination ON destination.id = channel.destination;

-- NewHoprNodeStakeModuleForSafe(address module, address safe): one per safe.
INSERT INTO log (block_number, tx_index, log_index, address, topics, data)
SELECT (SELECT min(published_block) FROM account) + id, 0, 0,
       pg_temp.raw_contract('stake-factory'),
       pg_temp.raw_topic('safe'),
       pg_temp.raw_word(pg_temp.raw_contract('module:' || id)) || pg_temp.raw_word(address)
FROM hopr_safe_contract;

-- Service registry: Registered / Updated / Deregistered(bytes32 indexed serviceType,
-- address indexed node, address indexed safe[, bytes metadata, uint48 registeredAt,
-- uint256 burn]). The service type is 'gvpn:exit' right-padded with zeros; the data is
-- the metadata's offset, two words, then its length and its bytes padded to words.
CREATE FUNCTION pg_temp.raw_service(kind text, node bytea, metadata bytea) RETURNS bytea[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY[
    pg_temp.raw_topic(kind)
      || decode(rpad(encode('gvpn:exit'::bytea, 'hex'), 64, '0'), 'hex')
      || pg_temp.raw_word(node) || pg_temp.raw_word(pg_temp.raw_contract('safe-of:' || encode(node, 'hex'))),
    CASE WHEN kind = 'deregistered' THEN '\x'::bytea
    ELSE pg_temp.raw_word('60') || pg_temp.raw_word('0') || pg_temp.raw_word('0')
         || pg_temp.raw_word(to_hex(octet_length(metadata)))
         || decode(rpad(encode(metadata, 'hex'), ((octet_length(metadata) + 31) / 32) * 64, '0'), 'hex')
    END
  ]
$$;

-- The exits (accounts 4-5) are registered as gvpn:exit, the node being the exit and
-- the metadata a JSON object naming it and saying where it is reached. Account 5 updates
-- its metadata after registering; account 6 (a client) registers and deregisters;
-- account 7 registers with metadata that is not JSON, which costs it its name only.
CREATE FUNCTION pg_temp.raw_exit_metadata(id integer, name text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT convert_to(
    E'{\n    "version":1,\n    "gnosis_vpn_server":"172.30.0.' || id || ':8000",\n    "wireguard_server":"172.30.0.' || id
    || ':51820",\n    "meta":{"name":"' || name || '"}\n  }', 'UTF8')
$$;
INSERT INTO log (block_number, tx_index, log_index, address, topics, data)
SELECT published_block + 500, 0, 0, pg_temp.raw_contract('service-registry'),
       (raw_service)[1], (raw_service)[2]
FROM (
  SELECT account.published_block,
         pg_temp.raw_service('registered', account.chain_key,
           pg_temp.raw_exit_metadata(account.id, 'GVPN-OLD-' || account.id)) AS raw_service
  FROM account WHERE id BETWEEN 4 AND 5
) AS registered;
INSERT INTO log (block_number, tx_index, log_index, address, topics, data)
SELECT published_block + 600, 0, 0, pg_temp.raw_contract('service-registry'),
       (raw_service)[1], (raw_service)[2]
FROM (
  SELECT account.published_block,
         pg_temp.raw_service('updated', account.chain_key,
           pg_temp.raw_exit_metadata(account.id, 'GVPN-KR-' || account.id)) AS raw_service
  FROM account WHERE id = 5
) AS updated;
INSERT INTO log (block_number, tx_index, log_index, address, topics, data)
SELECT published_block + 500 + step, 0, 0, pg_temp.raw_contract('service-registry'),
       (raw_service)[1], (raw_service)[2]
FROM (
  SELECT account.published_block, steps.step,
         pg_temp.raw_service(
           CASE steps.step WHEN 0 THEN 'registered' ELSE 'deregistered' END,
           account.chain_key, pg_temp.raw_exit_metadata(account.id, 'GVPN-GONE')) AS raw_service
  FROM account, (VALUES (0), (1)) AS steps (step) WHERE id = 6
) AS short_lived;
INSERT INTO log (block_number, tx_index, log_index, address, topics, data)
SELECT published_block + 500, 0, 0, pg_temp.raw_contract('service-registry'),
       (raw_service)[1], (raw_service)[2]
FROM (
  SELECT account.published_block,
         pg_temp.raw_service('registered', account.chain_key, convert_to('not json', 'UTF8')) AS raw_service
  FROM account WHERE id = 7
) AS junk;

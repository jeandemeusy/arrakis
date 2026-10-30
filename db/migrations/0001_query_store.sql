-- The application's own state: who may edit, the saved queries and their
-- immutable versions, the exits per network, and the materialized results.
--
-- None of this lives in a Blokli database. Those are read through a read-only
-- role and never written; everything Arrakis owns is here.

-- Accounts allowed to edit. Today there is exactly one, `editor`, whose password
-- hash comes from ARRAKIS_EDITOR_PASSWORD_HASH and is re-synced on every start
-- (`managed_by_env`). More users are more rows: nothing else in the schema or
-- the code assumes there is only one.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  display_name text,
  password_hash text,
  role text NOT NULL DEFAULT 'editor' CHECK (role IN ('editor', 'admin')),
  managed_by_env boolean NOT NULL DEFAULT FALSE,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Sessions live here rather than in process memory so every replica honours a
-- login. Only a SHA-256 of the cookie token is stored: a leaked table cannot be
-- replayed as cookies.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text,
  user_agent text
);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

-- Failed and successful logins, for rate limiting across replicas.
CREATE TABLE login_attempts (
  id bigserial PRIMARY KEY,
  ip text NOT NULL,
  username text NOT NULL,
  succeeded boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_ip_time ON login_attempts (ip, attempted_at);
CREATE INDEX login_attempts_time ON login_attempts (attempted_at);

-- A saved query or a fragment. The SQL is not here: it lives in
-- query_versions, which are immutable, and `current_version_id` points at the
-- one in force. A fragment is never run on its own schedule; other queries
-- inline it with {{> slug}}.
CREATE TABLE queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'query' CHECK (kind IN ('query', 'fragment')),
  visibility text NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'unlisted', 'public')),
  official boolean NOT NULL DEFAULT FALSE,
  -- How a result is presented for "All networks": stacked with a network
  -- column, or not at all (a per-network figure that has no combined meaning).
  combine text NOT NULL DEFAULT 'concat' CHECK (combine IN ('concat', 'hidden')),
  -- Null means not scheduled: it only runs when an editor runs it.
  refresh_seconds integer CHECK (refresh_seconds IS NULL OR refresh_seconds >= 60),
  forked_from uuid REFERENCES queries (id) ON DELETE SET NULL,
  current_version_id uuid,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK (kind = 'query' OR refresh_seconds IS NULL)
);

CREATE TABLE query_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id uuid NOT NULL REFERENCES queries (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  sql text NOT NULL,
  -- Declared parameters: [{name, type, label?, default?, options?}].
  parameters jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (query_id, version)
);

ALTER TABLE queries
  ADD CONSTRAINT queries_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES query_versions (id)
  DEFERRABLE INITIALLY DEFERRED;

-- A published version is methodology: it is never edited in place, only
-- superseded. Enforced here as well as in the code, so a hand-written UPDATE
-- cannot rewrite history either.
CREATE FUNCTION query_versions_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'query versions are immutable; save a new version instead';
END;
$$;
CREATE TRIGGER query_versions_no_update
  BEFORE UPDATE ON query_versions
  FOR EACH ROW EXECUTE FUNCTION query_versions_immutable();

-- Exit nodes, per indexed network. Removal is a timestamp rather than a DELETE:
-- the exit set decides what counts as downstream volume, so every change to it
-- stays on record.
CREATE TABLE network_exits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network text NOT NULL,
  address bytea NOT NULL CHECK (octet_length(address) = 20),
  label text NOT NULL DEFAULT '',
  added_by uuid REFERENCES users (id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_by uuid REFERENCES users (id) ON DELETE SET NULL,
  removed_at timestamptz
);
CREATE UNIQUE INDEX network_exits_active
  ON network_exits (network, address) WHERE removed_at IS NULL;

-- Results are materialized as real tables in this schema, one per run, so that
-- many visualizations can aggregate one result without re-reading Blokli.
CREATE SCHEMA results;

-- The latest result of one query version, on one network, for one set of
-- parameter values. The `table_name` columns describe the last SUCCESSFUL run,
-- which keeps serving while a newer run is in flight or after one fails; the
-- `attempt_*` columns describe the most recent run of any outcome.
CREATE TABLE query_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_version_id uuid NOT NULL REFERENCES query_versions (id) ON DELETE CASCADE,
  network text NOT NULL,
  parameters_hash text NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,

  table_name text,
  -- Kept one generation so a reader that resolved the old name just before a
  -- swap can still finish reading it; dropped at the next swap.
  previous_table_name text,
  columns jsonb,
  row_count bigint,
  truncated boolean,
  -- Fingerprint of everything outside the SQL text that shaped the result: the
  -- fragment versions inlined and the exit set. A mismatch makes it stale.
  inputs_hash text,
  timebase text CHECK (timebase IS NULL OR timebase IN ('rpc', 'estimated')),
  finished_at timestamptz,
  duration_ms integer,

  attempt_started_at timestamptz,
  attempt_finished_at timestamptz,
  attempt_status text CHECK (attempt_status IN ('running', 'succeeded', 'failed')),
  attempt_error text,
  attempt_inputs_hash text,
  attempt_trigger text,

  UNIQUE (query_version_id, network, parameters_hash)
);

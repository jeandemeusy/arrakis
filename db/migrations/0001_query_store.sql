-- The application's own state: who may edit, the saved queries and their
-- immutable versions, the charts and dashboards built on stored results, the
-- lists queries read, and the materialized results themselves.
--
-- None of this lives in a data source. Those are read through a read-only
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
  -- Shipped with arrakis (or a bundle), so the home page can list it first.
  official boolean NOT NULL DEFAULT FALSE,
  -- Where the item came from: the bundle that created it, so importing a newer
  -- version of the same bundle updates it, and importing another bundle that
  -- happens to use the same slug does not overwrite it unannounced.
  bundle text,
  -- How a result is presented for "All networks": stacked with a network
  -- column, or not at all (a per-network figure that has no combined meaning).
  combine text NOT NULL DEFAULT 'concat' CHECK (combine IN ('concat', 'hidden')),
  -- Null means not scheduled: it only runs when an editor runs it.
  refresh_seconds integer CHECK (refresh_seconds IS NULL OR refresh_seconds >= 60),
  -- Limits of the query's own, under the server-wide ones: how long a run may
  -- take, and how many rows a stored result keeps. Null takes the defaults.
  timeout_seconds integer
    CHECK (timeout_seconds IS NULL OR timeout_seconds BETWEEN 1 AND 3600),
  row_limit bigint CHECK (row_limit IS NULL OR row_limit > 0),
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

-- Results are materialized as real tables in this schema, one per run, so that
-- many visualizations can aggregate one result without re-reading the source.
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
  -- fragment versions inlined and the lists read. A mismatch makes it stale.
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

-- Visualizations of stored results, and the dashboards that arrange them.
--
-- A visualization belongs to one query and reads that query's materialized
-- result: one query, one result table, any number of charts. Its `config`
-- holds the transform steps that shape the rows (filter, bucket, aggregate,
-- rolling windows, …) and how the shaped columns map onto the chart. The
-- server turns the steps into SQL over the result table; nothing a
-- visualization does ever reaches a data source.
CREATE TABLE visualizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id uuid NOT NULL REFERENCES queries (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  type text NOT NULL CHECK (
    type IN ('number', 'line', 'area', 'bar', 'share', 'pie', 'heatmap', 'cohort', 'table')
  ),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- A stable name for a chart installed from a bundle (its key in the bundle
  -- file), so importing the bundle again updates the charts it created instead
  -- of adding copies. Charts made in the studio have none.
  seed_key text,
  bundle text,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX visualizations_query ON visualizations (query_id);
CREATE UNIQUE INDEX visualizations_seed_key ON visualizations (seed_key)
  WHERE seed_key IS NOT NULL AND archived_at IS NULL;

-- A dashboard: an ordered grid of widgets, with variables (a time range, a
-- network, anything a widget filters on) that its viewers can change.
CREATE TABLE dashboards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  visibility text NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'unlisted', 'public')),
  official boolean NOT NULL DEFAULT FALSE,
  bundle text,
  -- [{name, label, type: 'range' | 'network' | 'text', default, options?}]
  variables jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

-- Widgets flow left to right on a twelve-column grid, in `position` order, and
-- are resized by dragging a twelfth of the grid at a time. A widget is a
-- visualization or a block of text (a section heading, a methodology note).
CREATE TABLE dashboard_widgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id uuid NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
  position integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('visualization', 'text')),
  visualization_id uuid REFERENCES visualizations (id) ON DELETE CASCADE,
  text text NOT NULL DEFAULT '',
  width integer NOT NULL DEFAULT 6 CHECK (width BETWEEN 1 AND 12),
  height integer NOT NULL DEFAULT 260 CHECK (height BETWEEN 80 AND 1200),
  -- Optional title override, click-through and visibility rules:
  -- {title?, link?: {column, var, dashboard?}, requires?: var}
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK ((kind = 'visualization') = (visualization_id IS NOT NULL))
);
CREATE INDEX dashboard_widgets_order ON dashboard_widgets (dashboard_id, position);

-- Hand-written visualization SQL runs as this role, which can read the result
-- tables and nothing else in this database: not the users, not the sessions.
-- Creating it needs CREATEROLE; without that the SQL mode is simply disabled
-- and the step builder, which never runs user SQL, works as before.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arrakis_results_reader') THEN
    CREATE ROLE arrakis_results_reader NOLOGIN;
  END IF;
  GRANT USAGE ON SCHEMA results TO arrakis_results_reader;
  GRANT SELECT ON ALL TABLES IN SCHEMA results TO arrakis_results_reader;
  ALTER DEFAULT PRIVILEGES IN SCHEMA results
    GRANT SELECT ON TABLES TO arrakis_results_reader;
  -- From PostgreSQL 16 a role created under CREATEROLE is granted to its
  -- creator without the right to SET ROLE to it; ask for that explicitly.
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE format('GRANT arrakis_results_reader TO %I WITH SET TRUE', current_user);
  ELSE
    EXECUTE format('GRANT arrakis_results_reader TO %I', current_user);
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'arrakis_results_reader could not be set up; SQL visualizations are disabled';
END
$$;

-- Every run in progress, on whichever replica: enough to cancel it from any of
-- them (with pg_cancel_backend, as the same read-only role), and to list what
-- is running. A row outlives its run only if the process died; those are
-- pruned.
CREATE TABLE active_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network text NOT NULL,
  pid integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('preview', 'store', 'schedule')),
  query_slug text,
  -- A preview's own token, chosen by the page that started it, so the page
  -- can cancel exactly that run.
  run_key text,
  started_by text,
  started_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX active_runs_query ON active_runs (query_slug);
CREATE INDEX active_runs_key ON active_runs (run_key);

-- Lists: named sets of values an editor keeps, which queries read as
-- {{list:name}} — the accounts to leave out, the regions that count, the
-- addresses that are exits. A value belongs to one data source, or to every
-- one (source NULL). Removal is a timestamp rather than a DELETE, so every
-- change to what a query counted stays on record.
CREATE TABLE lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (name ~ '^[a-z_][a-z0-9_]{0,62}$'),
  type text NOT NULL CHECK (type IN ('text', 'number', 'bytes')),
  description text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE list_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id uuid NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
  source text,
  -- As written: text, a decimal number, or 0x-hex for bytes.
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 1000),
  label text NOT NULL DEFAULT '',
  added_by uuid REFERENCES users (id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_by uuid REFERENCES users (id) ON DELETE SET NULL,
  removed_at timestamptz
);
CREATE UNIQUE INDEX list_values_active
  ON list_values (list_id, coalesce(source, ''), value) WHERE removed_at IS NULL;

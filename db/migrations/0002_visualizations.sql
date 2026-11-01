-- Visualizations of stored results, and the dashboards that arrange them.
--
-- A visualization belongs to one query and reads that query's materialized
-- result: one query, one result table, any number of charts. Its `config`
-- holds the transform steps that shape the rows (filter, bucket, aggregate,
-- rolling windows, …) and how the shaped columns map onto the chart. The
-- server turns the steps into SQL over the result table; nothing a
-- visualization does ever reaches a Blokli database.

CREATE TABLE visualizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id uuid NOT NULL REFERENCES queries (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  type text NOT NULL CHECK (
    type IN ('number', 'line', 'area', 'bar', 'share', 'heatmap', 'cohort', 'table')
  ),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX visualizations_query ON visualizations (query_id);

-- A dashboard: an ordered grid of widgets, with variables (a time range, a
-- network, anything a widget filters on) that its viewers can change.
CREATE TABLE dashboards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  visibility text NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'unlisted', 'public')),
  -- [{name, label, type: 'range' | 'network' | 'text', default, options?}]
  variables jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

-- Widgets flow left to right on the twelve-column grid the dashboard page
-- already uses, in `position` order. A widget is a visualization or a block of
-- text (a section heading, a methodology note).
CREATE TABLE dashboard_widgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id uuid NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
  position integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('visualization', 'text')),
  visualization_id uuid REFERENCES visualizations (id) ON DELETE CASCADE,
  text text NOT NULL DEFAULT '',
  width integer NOT NULL DEFAULT 6 CHECK (width IN (2, 3, 4, 6, 8, 12)),
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

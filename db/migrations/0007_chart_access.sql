-- Hand-written chart SQL no longer runs on the app's own connection. It runs
-- on a separate login (APP_CHARTS_DATABASE_URL) whose role holds nothing in
-- this database but the right to call one function: chart_access.result_rows,
-- which hands back the rows of a single stored result, and only for a ticket
-- the app issued for that run. The role reads no table, so it cannot read
-- another query's result, private or not, nor anything else here; and since
-- it logs in as itself there is no more privileged role to switch back to.

CREATE SCHEMA chart_access;
REVOKE ALL ON SCHEMA chart_access FROM PUBLIC;

-- One row per stored table a chart run may read, deleted when the run ends.
-- Tickets are random and passed as bind parameters, so they never show in
-- pg_stat_activity, where another chart run of the same role could see them.
CREATE TABLE chart_access.tickets (
  ticket text PRIMARY KEY,
  table_name text NOT NULL,
  expires_at timestamptz NOT NULL
);
REVOKE ALL ON chart_access.tickets FROM PUBLIC;

CREATE FUNCTION chart_access.result_rows(ticket text)
RETURNS SETOF record
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  target text;
BEGIN
  SELECT t.table_name INTO target
  FROM chart_access.tickets t
  WHERE t.ticket = result_rows.ticket AND t.expires_at > now();
  IF target IS NULL OR target !~ '^r_[0-9a-z]+_[0-9a-f]{8}$' THEN
    RAISE EXCEPTION 'That SQL reads something other than {{result}}, which is not allowed'
      USING ERRCODE = '42501';
  END IF;
  RETURN QUERY EXECUTE format('SELECT * FROM results.%I', target);
END
$$;
REVOKE ALL ON FUNCTION chart_access.result_rows(text) FROM PUBLIC;

-- The role chart SQL used to switch to could read every result table. It is
-- no longer used; take back what it was given, where this role may.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arrakis_results_reader') THEN
    ALTER DEFAULT PRIVILEGES IN SCHEMA results
      REVOKE SELECT ON TABLES FROM arrakis_results_reader;
    REVOKE SELECT ON ALL TABLES IN SCHEMA results FROM arrakis_results_reader;
    REVOKE USAGE ON SCHEMA results FROM arrakis_results_reader;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'arrakis_results_reader keeps its grants; revoke them by hand';
END
$$;

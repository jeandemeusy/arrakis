-- Limits of a query's own, under the server-wide ones: how long a run may
-- take, and how many rows a stored result keeps. Null takes the defaults.
ALTER TABLE queries
  ADD COLUMN timeout_seconds integer
    CHECK (timeout_seconds IS NULL OR timeout_seconds BETWEEN 1 AND 3600),
  ADD COLUMN row_limit bigint
    CHECK (row_limit IS NULL OR row_limit > 0);

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

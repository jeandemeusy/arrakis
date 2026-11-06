CREATE TABLE query_run_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  result_id uuid NOT NULL REFERENCES query_results (id) ON DELETE CASCADE,
  query_version_id uuid NOT NULL REFERENCES query_versions (id) ON DELETE CASCADE,
  network text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  trigger text,
  error text,
  duration_ms integer,
  row_count bigint,
  UNIQUE (result_id, started_at)
);
CREATE INDEX query_run_history_recent ON query_run_history (started_at DESC);

CREATE FUNCTION record_query_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.attempt_status IS NOT NULL AND NEW.attempt_started_at IS NOT NULL THEN
    INSERT INTO query_run_history (result_id, query_version_id, network, started_at, finished_at, status, trigger, error, duration_ms, row_count)
    VALUES (NEW.id, NEW.query_version_id, NEW.network, NEW.attempt_started_at, NEW.attempt_finished_at, NEW.attempt_status, NEW.attempt_trigger, NEW.attempt_error,
      CASE WHEN NEW.attempt_status = 'succeeded' THEN NEW.duration_ms END,
      CASE WHEN NEW.attempt_status = 'succeeded' THEN NEW.row_count END)
    ON CONFLICT (result_id, started_at) DO UPDATE SET finished_at = EXCLUDED.finished_at, status = EXCLUDED.status,
      error = EXCLUDED.error, duration_ms = EXCLUDED.duration_ms, row_count = EXCLUDED.row_count;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER query_result_run_history AFTER INSERT OR UPDATE OF attempt_status ON query_results
  FOR EACH ROW EXECUTE FUNCTION record_query_run();

ALTER TABLE query_run_history ALTER COLUMN result_id DROP NOT NULL;
ALTER TABLE query_run_history DROP CONSTRAINT query_run_history_result_id_fkey;
ALTER TABLE query_run_history ADD CONSTRAINT query_run_history_result_id_fkey
  FOREIGN KEY (result_id) REFERENCES query_results (id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION record_query_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.attempt_status = 'running'
     AND OLD.attempt_started_at IS DISTINCT FROM NEW.attempt_started_at THEN
    UPDATE query_run_history SET status = 'failed', finished_at = now(),
      error = 'Run was interrupted before completion'
    WHERE result_id = OLD.id AND started_at = OLD.attempt_started_at AND status = 'running';
  END IF;
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

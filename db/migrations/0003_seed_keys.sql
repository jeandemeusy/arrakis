-- A stable name for a visualization installed from a bundled dashboard
-- (db/seed/<name>), so installing the bundle again updates the charts it
-- created instead of adding copies. Charts made in the studio have none.
ALTER TABLE visualizations ADD COLUMN seed_key text;
CREATE UNIQUE INDEX visualizations_seed_key ON visualizations (seed_key)
  WHERE seed_key IS NOT NULL AND archived_at IS NULL;

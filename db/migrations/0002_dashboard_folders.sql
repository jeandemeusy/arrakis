CREATE TABLE dashboard_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX dashboard_folders_name ON dashboard_folders (lower(name));
ALTER TABLE dashboards ADD COLUMN folder_id uuid REFERENCES dashboard_folders (id) ON DELETE SET NULL;
CREATE INDEX dashboards_folder_id ON dashboards (folder_id);

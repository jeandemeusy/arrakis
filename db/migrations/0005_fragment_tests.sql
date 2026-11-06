CREATE TABLE fragment_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id uuid NOT NULL REFERENCES queries (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  sql text NOT NULL CHECK (length(sql) BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fragment_tests_name ON fragment_tests (query_id, lower(name));

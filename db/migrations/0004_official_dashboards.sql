-- Dashboards that ship with arrakis are marked, as their queries are, so the
-- home page can list them first.
ALTER TABLE dashboards ADD COLUMN official boolean NOT NULL DEFAULT FALSE;

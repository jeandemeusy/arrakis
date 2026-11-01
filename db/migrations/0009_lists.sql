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

-- The exits page this replaces kept addresses per network: they become the
-- list "exits", of bytes, with each address kept for its data source.
-- It is created when exits were kept, or a query reads {{exits}}.
INSERT INTO lists (name, type, description)
SELECT 'exits', 'bytes', 'Exit node addresses, per data source.'
WHERE EXISTS (SELECT 1 FROM network_exits)
   OR EXISTS (SELECT 1 FROM query_versions WHERE sql ~ '\{\{\s*exits\s*\}\}');

INSERT INTO list_values
  (list_id, source, value, label, added_by, added_at, removed_by, removed_at)
SELECT l.id, e.network, '0x' || encode(e.address, 'hex'), e.label,
       e.added_by, e.added_at, e.removed_by, e.removed_at
FROM network_exits e CROSS JOIN lists l
WHERE l.name = 'exits';

DROP TABLE network_exits;

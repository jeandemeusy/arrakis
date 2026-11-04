-- Keep old user rows for authorship, but no password-era session survives cutover.
DELETE FROM sessions;
UPDATE users SET disabled_at = COALESCE(disabled_at, now()) WHERE password_hash IS NOT NULL OR managed_by_env;
ALTER TABLE users DROP COLUMN password_hash, DROP COLUMN managed_by_env;
DROP TABLE login_attempts;

ALTER TABLE users ADD COLUMN google_subject text UNIQUE;
ALTER TABLE users ADD COLUMN email text;
ALTER TABLE sessions ADD COLUMN workspace_domain text NOT NULL;

-- The cookie carries only a random lookup token; PKCE secrets stay server-side.
-- DELETE ... RETURNING at callback consumes the transaction once across replicas.
CREATE TABLE oauth_transactions (
  token_hash bytea PRIMARY KEY,
  state text NOT NULL,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  return_path text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX oauth_transactions_expires_at ON oauth_transactions (expires_at);

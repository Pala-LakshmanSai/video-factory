-- Access keys (docs/SYNC.md "Access keys"): a team member uses one key instead of a GitHub account, for sync,
-- the installers and the connector sign-in. Only a hash is stored; the owner creates and revokes them.
CREATE TABLE IF NOT EXISTS access_keys (
  name TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);

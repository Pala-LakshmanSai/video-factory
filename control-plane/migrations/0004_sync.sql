-- Cross-account sync (docs/SYNC.md). Additive: older Workers ignore these tables.
-- sync_files is the live index of every synced file (skills, style kits). File bytes live in GitHub release assets
-- (content-addressed by sha256); a row with sha NULL is a deletion tombstone. ver comes from sync_meta and lets a
-- client fetch only what changed since its last pull.
CREATE TABLE sync_meta (id INTEGER PRIMARY KEY CHECK (id = 1), ver INTEGER NOT NULL);
INSERT INTO sync_meta (id, ver) VALUES (1, 0);

CREATE TABLE sync_roots (
  name TEXT PRIMARY KEY,
  target TEXT NOT NULL,          -- "~/.claude/skills/<name>" or "@repo/<dir>", resolved on each machine
  exclude_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE sync_files (
  root TEXT NOT NULL,
  path TEXT NOT NULL,
  sha TEXT,                      -- sha256 hex; NULL = deleted
  size INTEGER NOT NULL DEFAULT 0,
  mode INTEGER NOT NULL DEFAULT 420,
  asset INTEGER,                 -- GitHub release asset id holding the bytes (0 for empty files)
  ver INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (root, path)
);
CREATE INDEX sync_files_ver ON sync_files (ver);

-- Owner preferences, live for every Claude account (Claude Code via scripts/vf, claude.ai via MCP).
CREATE TABLE prefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,           -- "global" or a style id (flatglow, paper-style, gta, ...)
  text TEXT NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  retired_reason TEXT
);
CREATE INDEX prefs_scope ON prefs (scope, retired_at);

-- Docs published from git main by CI (style docs, project instructions), served live to claude.ai via MCP.
CREATE TABLE docs (name TEXT PRIMARY KEY, body TEXT NOT NULL, sha TEXT NOT NULL, updated_at INTEGER NOT NULL);

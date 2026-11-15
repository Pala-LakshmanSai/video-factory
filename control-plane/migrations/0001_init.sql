-- D1 schema (SPEC §17 jobs, pods, events; + previews, config, catalog_cache). Times are epoch ms.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  chat_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  title TEXT NOT NULL,
  style TEXT NOT NULL,
  voiceover_json TEXT NOT NULL,
  plan_json TEXT,
  job_token_sha256 TEXT,
  token_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,          -- pod replacements after heartbeat loss
  render_errors TEXT NOT NULL DEFAULT '{}',     -- {"<scene>": count}
  last_render_error TEXT,                       -- {"scene","log_tail","stage"} not yet shown to Claude
  qa_rounds INTEGER NOT NULL DEFAULT 1,         -- preview round; +1 per revise_scene
  rerender_scene INTEGER,
  approved INTEGER NOT NULL DEFAULT 0,          -- 1 after approve: a replacement pod goes straight on to final_render
  pending_cmd TEXT,
  reuploads INTEGER NOT NULL DEFAULT 0,
  skip_dcs TEXT NOT NULL DEFAULT '[]',
  stage TEXT,
  pct REAL NOT NULL DEFAULT 0,
  scene INTEGER,
  gpu_label TEXT NOT NULL DEFAULT '',
  ttl_min INTEGER NOT NULL DEFAULT 30,
  dev_mode TEXT,                                -- 'dummy' | 'renderer' for /dev/acquire jobs
  cost_usd REAL NOT NULL DEFAULT 0,
  gpu_seconds REAL NOT NULL DEFAULT 0,
  drive_file_id TEXT,
  drive_link TEXT,
  size INTEGER,
  md5 TEXT,
  error_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_state ON jobs(state);

CREATE TABLE pods (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  gpu_type_id TEXT,
  data_center_id TEXT,
  cloud_type TEXT,
  compute_type TEXT,
  cost_per_hr REAL NOT NULL,
  created_at INTEGER NOT NULL,
  hello_at INTEGER,
  last_heartbeat_at INTEGER,
  deleted_at INTEGER,
  delete_reason TEXT
);
CREATE INDEX pods_job ON pods(job_id);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data_json TEXT
);
CREATE INDEX events_job ON events(job_id, ts);

CREATE TABLE previews (
  job_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  scene INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  jpeg BLOB NOT NULL,
  PRIMARY KEY (job_id, round, scene, idx)
);

CREATE TABLE config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);

CREATE TABLE catalog_cache (id INTEGER PRIMARY KEY CHECK (id = 1), fetched_at INTEGER NOT NULL, json TEXT NOT NULL);

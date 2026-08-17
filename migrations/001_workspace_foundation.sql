CREATE TABLE IF NOT EXISTS workspace_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO workspace_meta (key, value, created_at)
VALUES ('foundation_version', '0.1.0', CURRENT_TIMESTAMP);

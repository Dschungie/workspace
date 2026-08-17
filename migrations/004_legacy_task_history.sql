CREATE TABLE legacy_task_history (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  legacy_task_id TEXT NOT NULL UNIQUE,
  legacy_chat_id INTEGER,
  target_chat_id TEXT,
  requested_by_subject_id TEXT NOT NULL,
  legacy_state TEXT NOT NULL,
  intent TEXT NOT NULL,
  source_payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX legacy_task_history_by_workspace_created_at ON legacy_task_history(workspace_id, created_at DESC);

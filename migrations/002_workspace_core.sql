-- Workspace owns private work state. Living references are opaque external IDs;
-- this schema deliberately contains no Living credentials, sessions, or data.
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'suspended', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workspace_memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  living_subject_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, living_subject_id)
);

CREATE TABLE workspace_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  living_subject_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'group', 'system')),
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE chat_memberships (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  living_subject_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, living_subject_id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  author_subject_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT
);

CREATE TABLE chip_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by_subject_id TEXT NOT NULL,
  assigned_to TEXT,
  state TEXT NOT NULL CHECK (state IN ('draft', 'planned', 'in_progress', 'awaiting_approval', 'completed', 'blocked', 'cancelled')),
  title TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES chip_tasks(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'cancelled')),
  decided_by_subject_id TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  note TEXT
);

CREATE TABLE workspace_audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  actor_subject_id TEXT,
  event_type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  created_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX messages_by_chat_created_at ON messages(chat_id, created_at);
CREATE INDEX chip_tasks_by_workspace_state ON chip_tasks(workspace_id, state, updated_at);
CREATE INDEX workspace_audit_events_by_workspace_created_at ON workspace_audit_events(workspace_id, created_at);

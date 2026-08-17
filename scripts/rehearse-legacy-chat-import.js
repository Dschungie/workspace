#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { runMigrations } = require("../server");

const importMode = String(process.env.WORKSPACE_IMPORT_MODE || "").trim();
if (!new Set(["rehearsal", "commit"]).has(importMode)) {
  process.stderr.write("Refusing import: set WORKSPACE_IMPORT_MODE=rehearsal or commit.\n");
  process.exit(2);
}
const sourcePath = String(process.env.LEGACY_DB_PATH || "").trim();
const targetPath = String(process.env.WORKSPACE_REHEARSAL_DB_PATH || "").trim();
if (!sourcePath || !targetPath || !fs.existsSync(sourcePath)) {
  process.stderr.write("LEGACY_DB_PATH and WORKSPACE_REHEARSAL_DB_PATH are required.\n");
  process.exit(2);
}

function stableId(type, sourceId) {
  const hex = crypto.createHash("sha256").update(`${type}:${sourceId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function timestamp(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? new Date(numeric).toISOString() : new Date(0).toISOString();
}
function sourceSubject(value, accounts) {
  const raw = String(value || "").trim().toLowerCase();
  return String(accounts.get(raw) || `legacy-subject:${crypto.createHash("sha256").update(raw || "unknown").digest("hex").slice(0, 24)}`);
}

const source = new DatabaseSync(sourcePath, { readOnly: true });
const target = new DatabaseSync(targetPath);
target.exec("PRAGMA foreign_keys = ON");
runMigrations(target, path.join(__dirname, "..", "migrations"));

const snapshotSha = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
if (importMode === "commit" && String(process.env.WORKSPACE_IMPORT_SOURCE_SHA256 || "").trim() !== snapshotSha) {
  process.stderr.write("Refusing import: WORKSPACE_IMPORT_SOURCE_SHA256 does not match the current source snapshot.\n");
  process.exit(3);
}
const accounts = new Map();
for (const row of source.prepare("SELECT email,user_id FROM user_accounts").all()) {
  accounts.set(String(row.email || "").trim().toLowerCase(), String(row.user_id || ""));
}
const chats = source.prepare(
  `SELECT c.id,c.type,c.title,c.created_at,c.updated_at,b.org_id
   FROM chats c JOIN chat_org_bindings b ON b.chat_id=c.id
   ORDER BY c.id ASC`
).all();
const members = source.prepare(
  `SELECT cm.chat_id,cm.username,cm.role
   FROM chat_members cm JOIN chats c ON c.id=cm.chat_id ORDER BY cm.chat_id,cm.username`
).all();
const messages = source.prepare(
  `SELECT m.id,m.chat_id,m.sender,m.body,m.at,m.edited_at,m.deleted_at
   FROM messages m JOIN chats c ON c.id=m.chat_id ORDER BY m.id ASC`
).all();

const seenWorkspace = new Set();
let importedChats = 0;
let importedMemberships = 0;
let importedMessages = 0;
target.exec("BEGIN IMMEDIATE");
try {
  const writeLedger = target.prepare(
    "INSERT OR IGNORE INTO legacy_migration_ledger(source_system,source_type,source_id,target_id,source_snapshot_sha256,imported_at) VALUES(?,?,?,?,?,?)"
  );
  const upsertWorkspace = target.prepare(
    `INSERT INTO workspaces(id,display_name,state,created_at,updated_at) VALUES(?,?, 'active', ?, ?)
     ON CONFLICT(id) DO NOTHING`
  );
  const insertChat = target.prepare("INSERT OR IGNORE INTO chats(id,workspace_id,kind,title,created_at,updated_at) VALUES(?,?,?,?,?,?)");
  const insertMembership = target.prepare("INSERT OR IGNORE INTO chat_memberships(chat_id,living_subject_id,role,joined_at) VALUES(?,?,?,?)");
  const insertMessage = target.prepare("INSERT OR IGNORE INTO messages(id,chat_id,author_subject_id,body,created_at,edited_at,deleted_at) VALUES(?,?,?,?,?,?,?)");
  const chatByLegacy = new Map();

  for (const row of chats) {
    const workspaceId = String(row.org_id || "").trim();
    if (!workspaceId) throw new Error(`legacy_chat_${row.id}_has_no_workspace`);
    if (!seenWorkspace.has(workspaceId)) {
      upsertWorkspace.run(workspaceId, workspaceId, timestamp(row.created_at), timestamp(row.updated_at));
      seenWorkspace.add(workspaceId);
    }
    const chatId = stableId("legacy-chat", row.id);
    chatByLegacy.set(Number(row.id), { id: chatId, workspaceId });
    const kind = String(row.type || "").toLowerCase() === "direct" ? "direct" : "group";
    const title = String(row.title || "").trim() || "Untitled legacy chat";
    const result = insertChat.run(chatId, workspaceId, kind, title, timestamp(row.created_at), timestamp(row.updated_at));
    if (result.changes) importedChats += 1;
    writeLedger.run("nessha-legacy", "chat", String(row.id), chatId, snapshotSha, new Date().toISOString());
  }
  for (const row of members) {
    const chat = chatByLegacy.get(Number(row.chat_id));
    if (!chat) continue;
    const role = String(row.role || "").toLowerCase() === "owner" ? "owner" : "member";
    const result = insertMembership.run(chat.id, sourceSubject(row.username, accounts), role, new Date().toISOString());
    if (result.changes) importedMemberships += 1;
  }
  for (const row of messages) {
    const chat = chatByLegacy.get(Number(row.chat_id));
    if (!chat) continue;
    const messageId = stableId("legacy-message", row.id);
    const result = insertMessage.run(
      messageId,
      chat.id,
      sourceSubject(row.sender, accounts),
      String(row.body || ""),
      timestamp(row.at),
      row.edited_at ? timestamp(row.edited_at) : null,
      row.deleted_at ? timestamp(row.deleted_at) : null
    );
    if (result.changes) importedMessages += 1;
    writeLedger.run("nessha-legacy", "message", String(row.id), messageId, snapshotSha, new Date().toISOString());
  }
  target.exec("COMMIT");
} catch (error) {
  target.exec("ROLLBACK");
  throw error;
}

const output = {
  contract_version: "workspace_legacy_chat_rehearsal.v1",
  mode: importMode,
  source_snapshot_sha256: snapshotSha,
  imported: { workspaces: seenWorkspace.size, chats: importedChats, memberships: importedMemberships, messages: importedMessages },
  target: {
    workspaces: target.prepare("SELECT COUNT(*) AS n FROM workspaces").get().n,
    chats: target.prepare("SELECT COUNT(*) AS n FROM chats").get().n,
    memberships: target.prepare("SELECT COUNT(*) AS n FROM chat_memberships").get().n,
    messages: target.prepare("SELECT COUNT(*) AS n FROM messages").get().n,
    ledger: target.prepare("SELECT COUNT(*) AS n FROM legacy_migration_ledger").get().n,
  },
  excluded: ["chip_tasks", "browser artifacts", "provider credentials", "Living identity and Coin data"],
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

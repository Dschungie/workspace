#!/usr/bin/env node
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const sourceRaw = String(process.env.LEGACY_DB_PATH || "").trim();
const sourcePath = sourceRaw ? path.resolve(sourceRaw) : "";
if (!sourcePath || !fs.existsSync(sourcePath)) {
  process.stderr.write("LEGACY_DB_PATH must name an existing legacy SQLite database.\n");
  process.exit(2);
}

const db = new DatabaseSync(sourcePath, { readOnly: true });
const count = (sql, ...params) => Number(db.prepare(sql).get(...params)?.n || 0);
const tablePresent = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type=? AND name=?").get("table", name);
const columns = (name) => tablePresent(name) ? db.prepare(`PRAGMA table_info(${name})`).all().map((column) => column.name) : [];
const digest = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");

const report = {
  contract_version: "workspace_legacy_snapshot_inventory.v1",
  generated_at: new Date().toISOString(),
  source: {
    filename: path.basename(sourcePath),
    bytes: fs.statSync(sourcePath).size,
    sha256: digest,
  },
  tables: {},
  scope: {
    workspace_private_candidates: ["chats", "messages", "chat_members", "chat_member_roles", "hidden_messages"],
    review_required_before_import: ["chip_tasks", "browse_artifacts", "gmail_connections", "social_post_drafts"],
    excluded_from_workspace: ["user_accounts", "living_entities", "public_coin_profiles", "public_coin_audit_events"],
  },
};

for (const table of ["chats", "messages", "chip_tasks", "chat_members", "chat_member_roles", "chat_org_bindings", "private_chat_workspace_scopes", "hidden_messages"]) {
  report.tables[table] = tablePresent(table)
    ? { present: true, count: count(`SELECT COUNT(*) AS n FROM ${table}`), columns: columns(table) }
    : { present: false, count: 0, columns: [] };
}

if (tablePresent("chats") && tablePresent("chat_org_bindings")) {
  report.chat_binding = {
    bound_chats: count("SELECT COUNT(*) AS n FROM chats c JOIN chat_org_bindings b ON b.chat_id=c.id"),
    unbound_chats: count("SELECT COUNT(*) AS n FROM chats c LEFT JOIN chat_org_bindings b ON b.chat_id=c.id WHERE b.chat_id IS NULL"),
  };
}
if (tablePresent("chip_tasks")) {
  report.task_states = db.prepare("SELECT state, COUNT(*) AS count FROM chip_tasks GROUP BY state ORDER BY state").all();
  report.task_orgs = db.prepare("SELECT org_id, COUNT(*) AS count FROM chip_tasks GROUP BY org_id ORDER BY count DESC, org_id ASC").all();
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

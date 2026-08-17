const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const port = Number.parseInt(process.env.PORT || "3000", 10);
const dataDir = path.resolve(process.env.DATA_DIR || "/data");
const dbPath = path.join(dataDir, "workspace.sqlite");

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ level: "info", event, ...fields, at: new Date().toISOString() })}\n`);
}

function runMigrations(db, migrationsDir = path.join(__dirname, "migrations")) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(db.prepare("SELECT id FROM schema_migrations").all().map((row) => row.id));
  const migrations = fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  const record = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
  for (const id of migrations) {
    if (applied.has(id)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, id), "utf8");
    db.transaction(() => {
      db.exec(sql);
      record.run(id, new Date().toISOString());
    })();
    log("migration_applied", { migration: id });
  }
}

function createWorkspaceServer({ dbPath: customDbPath = dbPath } = {}) {
  fs.mkdirSync(path.dirname(customDbPath), { recursive: true });
  const db = new Database(customDbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const migrationCount = () => db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n;
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(200, { ok: true, service: "workspace", version: "0.1.0" });
    }
    if (req.method === "GET" && url.pathname === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        return json(200, { ok: true, service: "workspace", migrations: migrationCount(), database_persistent: fs.existsSync(customDbPath) });
      } catch {
        return json(503, { ok: false, service: "workspace" });
      }
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/workspace")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Workspace</title><style>body{margin:0;background:#11110f;color:#f4f0e8;font:16px system-ui,sans-serif}main{max-width:680px;margin:18vh auto;padding:32px}h1{font-size:clamp(3rem,10vw,7rem);letter-spacing:-.08em;margin:0}p{max-width:38rem;color:#c8c1b5;line-height:1.55}small{color:#938d84}</style><main><small>NESSHA / WORKSPACE</small><h1>Workspace</h1><p>Private work foundation. Identity exchange, collaboration, and integrations are not enabled yet.</p></main></html>");
    }
    return json(404, { ok: false, error: "not_found" });
  });
}

if (require.main === module) {
  const server = createWorkspaceServer();
  server.listen(port, "0.0.0.0", () => log("workspace_started", { port, data_dir: dataDir }));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

module.exports = { createWorkspaceServer, runMigrations };

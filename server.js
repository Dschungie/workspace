const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const port = Number.parseInt(process.env.PORT || "3000", 10);
const dataDir = path.resolve(process.env.DATA_DIR || "/data");
const dbPath = path.join(dataDir, "workspace.sqlite");
const livingExchangeUrl = String(process.env.LIVING_AUTH_EXCHANGE_URL || "").trim();
const livingExchangeSecret = String(process.env.WORKSPACE_AUTH_EXCHANGE_SECRET || "").trim();
const sessionTtlSeconds = Math.max(300, Number.parseInt(process.env.WORKSPACE_SESSION_TTL_SECONDS || "604800", 10) || 604800);

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
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      record.run(id, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    log("migration_applied", { migration: id });
  }
}

function parseCookies(rawHeader = "") {
  const values = {};
  for (const part of String(rawHeader || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    values[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return values;
}

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function localRole(livingRole = "") {
  const role = String(livingRole || "").trim().toLowerCase();
  if (role === "workspace_owner" || role === "nessha_owner") return "owner";
  if (role === "workspace_admin" || role === "nessha_admin") return "admin";
  if (role === "workspace_member" || role === "workspace_team_leader") return "member";
  return "viewer";
}

function setWorkspaceSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `workspace_session=${encodeURIComponent(token)}; Path=/workspace; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionTtlSeconds}`);
}

function clearWorkspaceSessionCookie(res) {
  res.setHeader("Set-Cookie", "workspace_session=; Path=/workspace; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
}

function createWorkspaceServer({
  dbPath: customDbPath = dbPath,
  exchangeUrl = livingExchangeUrl,
  exchangeSecret = livingExchangeSecret,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  fs.mkdirSync(path.dirname(customDbPath), { recursive: true });
  const db = new DatabaseSync(customDbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);

  const sessionForRequest = (req) => {
    const token = parseCookies(req.headers.cookie).workspace_session;
    if (!token) return null;
    const timestamp = new Date(now()).toISOString();
    return db.prepare(
      `SELECT s.id, s.workspace_id, s.living_subject_id, m.role, w.display_name
       FROM workspace_sessions s
       JOIN workspace_memberships m ON m.workspace_id=s.workspace_id AND m.living_subject_id=s.living_subject_id
       JOIN workspaces w ON w.id=s.workspace_id
       WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND m.state='active' AND w.state='active'
       LIMIT 1`
    ).get(tokenHash(token), timestamp) || null;
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const migrationCount = () => db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n;
    const coreCounts = () => ({
      workspaces: db.prepare("SELECT COUNT(*) AS n FROM workspaces").get().n,
      memberships: db.prepare("SELECT COUNT(*) AS n FROM workspace_memberships").get().n,
      chats: db.prepare("SELECT COUNT(*) AS n FROM chats").get().n,
      tasks: db.prepare("SELECT COUNT(*) AS n FROM chip_tasks").get().n,
    });
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
    if (req.method === "GET" && url.pathname === "/api/v1/workspace/status") {
      return json(200, {
        ok: true,
        service: "workspace",
        mode: "isolated_foundation",
        authorization: "not_configured",
        legacy_data_migration: "not_started",
        migrations: migrationCount(),
        records: coreCounts(),
      });
    }
    if (req.method === "POST" && url.pathname === "/workspace/session/exchange") {
      const livingSession = parseCookies(req.headers.cookie).nessha_session;
      if (!livingSession) return json(401, { ok: false, reason_code: "living_session_required" });
      if (!exchangeUrl || !exchangeSecret) return json(503, { ok: false, reason_code: "workspace_exchange_not_configured" });
      let response;
      try {
        response = await fetchImpl(exchangeUrl, {
          method: "POST",
          headers: {
            cookie: `nessha_session=${encodeURIComponent(livingSession)}`,
            "x-workspace-exchange-secret": exchangeSecret,
          },
        });
      } catch {
        return json(503, { ok: false, reason_code: "living_exchange_unreachable" });
      }
      let exchange = null;
      try { exchange = await response.json(); } catch {}
      if (!response.ok || !exchange?.ok) {
        return json(response.status || 502, { ok: false, reason_code: String(exchange?.reason_code || "living_exchange_failed") });
      }
      const subjectId = String(exchange.subject_id || "").trim();
      const workspaceId = String(exchange.workspace?.id || "").trim();
      const displayName = String(exchange.workspace?.label || "Workspace").trim().slice(0, 160) || "Workspace";
      if (!subjectId || !workspaceId || String(exchange.contract_version || "") !== "living_workspace_auth_exchange.v1") {
        return json(502, { ok: false, reason_code: "living_exchange_contract_invalid" });
      }
      const timestamp = new Date(now()).toISOString();
      const role = localRole(exchange.workspace?.role);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT INTO workspaces(id,display_name,state,created_at,updated_at) VALUES(?,?, 'active', ?, ?)
           ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, state='active', updated_at=excluded.updated_at`
        ).run(workspaceId, displayName, timestamp, timestamp);
        db.prepare(
          `INSERT INTO workspace_memberships(workspace_id,living_subject_id,role,state,created_at,updated_at) VALUES(?,?,?,'active',?,?)
           ON CONFLICT(workspace_id,living_subject_id) DO UPDATE SET role=excluded.role, state='active', updated_at=excluded.updated_at`
        ).run(workspaceId, subjectId, role, timestamp, timestamp);
        db.prepare("DELETE FROM workspace_sessions WHERE expires_at<=? OR revoked_at IS NOT NULL").run(timestamp);
        const token = crypto.randomBytes(32).toString("base64url");
        const expiresAt = new Date(now() + sessionTtlSeconds * 1000).toISOString();
        db.prepare(
          "INSERT INTO workspace_sessions(id,workspace_id,living_subject_id,token_hash,issued_at,expires_at) VALUES(?,?,?,?,?,?)"
        ).run(crypto.randomUUID(), workspaceId, subjectId, tokenHash(token), timestamp, expiresAt);
        db.exec("COMMIT");
        setWorkspaceSessionCookie(res, token);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return json(200, { ok: true, workspace: { id: workspaceId, label: displayName, role } });
    }
    if (req.method === "GET" && url.pathname === "/workspace/me") {
      const session = sessionForRequest(req);
      if (!session) return json(401, { ok: false, reason_code: "workspace_session_required" });
      return json(200, { ok: true, workspace: { id: session.workspace_id, label: session.display_name, role: session.role } });
    }
    if (req.method === "POST" && url.pathname === "/workspace/logout") {
      const token = parseCookies(req.headers.cookie).workspace_session;
      if (token) db.prepare("UPDATE workspace_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL").run(new Date(now()).toISOString(), tokenHash(token));
      clearWorkspaceSessionCookie(res);
      return json(200, { ok: true });
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/workspace")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Workspace</title><style>body{margin:0;background:#11110f;color:#f4f0e8;font:16px system-ui,sans-serif}main{max-width:720px;margin:14vh auto;padding:32px}small{color:#938d84;letter-spacing:.08em}h1{font-size:clamp(3rem,10vw,7rem);letter-spacing:-.08em;line-height:.9;margin:20px 0}p{max-width:38rem;color:#c8c1b5;line-height:1.55}section{border-top:1px solid #3a3834;margin-top:40px;padding-top:16px;color:#c8c1b5}strong{color:#f4f0e8;font-weight:600}button{margin-top:24px;background:#f4f0e8;color:#11110f;border:0;border-radius:999px;padding:11px 17px;font:inherit;font-weight:650;cursor:pointer}</style><main><small>NESSHA / WORKSPACE</small><h1>Workspace</h1><p>A private work surface with its own records, audit trail, and Workspace Chip boundary.</p><section><strong>Enter Workspace.</strong> Living verifies access once; Workspace then keeps its own session and private records.</section><button id=\"enter\">Continue</button><script>document.querySelector('#enter').onclick=async()=>{const r=await fetch('/workspace/session/exchange',{method:'POST'});if(r.ok)return location.assign('/workspace/app');const b=await r.json().catch(()=>({}));if(r.status===401)return location.assign('/login?return_to=/workspace');alert(b.reason_code||'Workspace access could not be verified.');};</script></main></html>");
    }
    if (req.method === "GET" && url.pathname === "/workspace/app") {
      const session = sessionForRequest(req);
      if (!session) {
        res.writeHead(302, { location: "/workspace", "cache-control": "no-store" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workspace</title><style>body{margin:0;background:#11110f;color:#f4f0e8;font:16px system-ui,sans-serif}main{max-width:720px;margin:14vh auto;padding:32px}small{color:#938d84;letter-spacing:.08em}h1{font-size:clamp(2.5rem,8vw,5rem);letter-spacing:-.07em;margin:18px 0}p{color:#c8c1b5;line-height:1.55}section{border-top:1px solid #3a3834;margin-top:36px;padding-top:16px}button{background:transparent;color:#c8c1b5;border:1px solid #605d57;border-radius:999px;padding:8px 13px;font:inherit;cursor:pointer}</style><main><small>PRIVATE WORKSPACE</small><h1>${session.display_name.replace(/[<>&"]/g, "")}</h1><p>Signed in with a Workspace-local session. Private work has not been migrated from Living.</p><section><small>ROLE</small><p>${session.role}</p><button id="logout">Sign out</button></section><script>document.querySelector('#logout').onclick=async()=>{await fetch('/workspace/logout',{method:'POST'});location.assign('/workspace');};</script></main></html>`);
    }
    return json(404, { ok: false, error: "not_found" });
  };

  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      log("request_failed", { path: req.url, reason: String(error?.message || "internal_error") });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      }
      res.end(JSON.stringify({ ok: false, reason_code: "internal_error" }));
    });
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

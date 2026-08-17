const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWorkspaceServer } = require("../server");

test("health and readiness work with a persistent SQLite database", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-test-"));
  const dbPath = path.join(dir, "workspace.sqlite");
  const server = createWorkspaceServer({ dbPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.json());
  const ready = await fetch(`http://127.0.0.1:${port}/readyz`).then((response) => response.json());
  const status = await fetch(`http://127.0.0.1:${port}/api/v1/workspace/status`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(ready.ok, true);
  assert.equal(ready.database_persistent, true);
  assert.equal(status.mode, "isolated_foundation");
  assert.equal(status.authorization, "not_configured");
  assert.equal(status.legacy_data_migration, "not_started");
  assert.equal(status.records.workspaces, 0);
  assert.equal(status.records.tasks, 0);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(fs.existsSync(dbPath), true);
});

test("Living exchange creates an isolated Workspace session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-exchange-"));
  const dbPath = path.join(dir, "workspace.sqlite");
  const server = createWorkspaceServer({
    dbPath,
    exchangeUrl: "http://living.test/api/workspace-auth/exchange",
    exchangeSecret: "exchange-secret",
    fetchImpl: async (url, init) => {
      assert.equal(url, "http://living.test/api/workspace-auth/exchange");
      assert.match(init.headers.cookie, /nessha_session=living-token/);
      assert.equal(init.headers["x-workspace-exchange-secret"], "exchange-secret");
      return new Response(JSON.stringify({
        ok: true,
        contract_version: "living_workspace_auth_exchange.v1",
        subject_id: "living-subject-1",
        workspace: { id: "workspace:demo", label: "Demo Workspace", role: "workspace_owner" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const exchange = await fetch(`http://127.0.0.1:${port}/workspace/session/exchange`, {
    method: "POST",
    headers: { cookie: "nessha_session=living-token" },
  });
  assert.equal(exchange.status, 200);
  const cookie = exchange.headers.get("set-cookie");
  assert.match(cookie, /workspace_session=/);
  assert.match(cookie, /Path=\/workspace/);
  const me = await fetch(`http://127.0.0.1:${port}/workspace/me`, {
    headers: { cookie: cookie.split(";")[0] },
  }).then((response) => response.json());
  assert.equal(me.ok, true);
  assert.equal(me.workspace.id, "workspace:demo");
  assert.equal(me.workspace.role, "owner");
  await new Promise((resolve) => server.close(resolve));
});

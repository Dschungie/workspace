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
  assert.equal(health.ok, true);
  assert.equal(ready.ok, true);
  assert.equal(ready.database_persistent, true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(fs.existsSync(dbPath), true);
});

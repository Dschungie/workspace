const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-smoke-"));
const child = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: "3115", DATA_DIR: dataDir }, stdio: "inherit" });
const deadline = Date.now() + 10_000;

async function run() {
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:3115/readyz");
      if (response.ok) {
        child.kill("SIGTERM");
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGTERM");
  process.exitCode = 1;
}

run();

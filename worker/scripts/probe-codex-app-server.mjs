import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const command = process.env.OPENCLAW_CODEX_APP_SERVER_BIN || "codex";
const home = await mkdtemp(join(tmpdir(), "tiangong-codex-app-server-"));
const child = spawn(command, ["app-server", "--listen", "stdio://"], {
  cwd: process.cwd(),
  env: { ...process.env, CODEX_HOME: home },
  stdio: ["pipe", "pipe", "pipe"],
});

if (!child.stdout || !child.stdin || !child.stderr) {
  throw new Error("Codex app-server did not expose stdio pipes");
}

let settled = false;
let stdout = "";
let stderr = "";
let timer;

const finish = async (error) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  child.kill("SIGTERM");
  await rm(home, { recursive: true, force: true });
  if (error) throw error;
};

const result = new Promise((resolve, reject) => {
  timer = setTimeout(() => reject(new Error(`Codex app-server initialize timed out${stderr ? `: ${stderr.trim()}` : ""}`)), 15_000);
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === 1 && message.result && typeof message.result === "object") {
        resolve(message);
        return;
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (!settled) reject(new Error(`Codex app-server exited before initialize (code=${code}, signal=${signal})${stderr ? `: ${stderr.trim()}` : ""}`));
  });
});

try {
  child.stdin.write(JSON.stringify({
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "tiangong-worker-probe", version: "0.0.0" },
      capabilities: {},
    },
  }) + "\n");
  await result;
  await finish();
  console.log("codex app-server initialize: ok");
} catch (error) {
  await finish(error).catch(() => {});
  console.error(`codex app-server initialize: ${error.message}`);
  process.exitCode = 1;
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const proxy = fileURLToPath(new URL("../scripts/codex-app-server-proxy.mjs", import.meta.url));

test("rewrites only Codex thread provider fields to the scoped AgentTeams provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-codex-proxy-test-"));
  const echo = join(directory, "echo.mjs");
  await writeFile(echo, [
    "import { createInterface } from 'node:readline';",
    "const input = createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "input.on('line', (line) => process.stdout.write(`${line}\\n`));",
  ].join("\n"));
  const child = spawn(process.execPath, [proxy, echo], {
    env: { ...process.env, CODEX_PATH: process.execPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      output.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  child.stderr.resume();
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "thread/start", params: { modelProvider: "openai" } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "turn/start", params: { modelProvider: "openai" } })}\n`);
  child.stdin.end();
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  await rm(directory, { recursive: true, force: true });
  assert.equal(output[0].params.modelProvider, "agentteams-gateway");
  assert.equal(output[1].params.modelProvider, "openai");
});

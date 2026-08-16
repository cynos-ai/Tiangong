import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const codexPath = process.env.CODEX_PATH || "/opt/tiangong-worker/node_modules/.bin/codex";
const child = spawn(codexPath, process.argv.slice(2), {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    child.stdin.write(`${line}\n`);
    return;
  }
  child.stdin.write(`${JSON.stringify(rewriteProvider(message))}\n`);
});
input.on("close", () => child.stdin.end());

const forwardSignal = (signal) => child.kill(signal);
process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));
child.on("error", (error) => {
  process.stderr.write(`[tiangong-worker] codex app-server proxy failed: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});

function rewriteProvider(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return message;
  if (message.method !== "thread/start" && message.method !== "thread/resume") return message;
  const params = message.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return message;
  if (!["openai", "openai-codex", "codex"].includes(params.modelProvider)) return message;
  return { ...message, params: { ...params, modelProvider: "agentteams-gateway" } };
}

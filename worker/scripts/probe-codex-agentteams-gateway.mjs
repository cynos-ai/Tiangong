import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const input = JSON.parse(await new Promise((resolve, reject) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { value += chunk; });
  process.stdin.on("end", () => resolve(value));
  process.stdin.on("error", reject);
}));
if (typeof input.baseUrl !== "string" || !input.baseUrl || typeof input.consumerToken !== "string" || !input.consumerToken) {
  throw new Error("A gateway base URL and scoped consumer token are required");
}

const home = await mkdtemp(join(tmpdir(), "tiangong-codex-gateway-probe-"));
const events = [];
let buffer = "";
let child;
try {
  await writeFile(join(home, "config.toml"), `model_provider = "openai"\nopenai_base_url = ${JSON.stringify(input.baseUrl)}\n`, { mode: 0o600 });
  const env = { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: input.consumerToken };
  delete env.DEEPSEEK_API_KEY;
  delete env.OPENAI_BASE_URL;
  child = spawn("codex", ["app-server", "--listen", "stdio://"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const message = JSON.parse(line);
        if (message.id === 1 || message.id === 2 || message.method === "turn/completed" || message.method === "error") events.push(message);
      } catch {
        // Codex diagnostics are intentionally not surfaced by this bounded probe.
      }
    }
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "tiangong-gateway-probe", title: "Tiangong Gateway Probe", version: "0" }, capabilities: { experimentalApi: true } } });
  send({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { model: "deepseek-v4-pro", modelProvider: "openai", approvalPolicy: "never", cwd: "/tmp" } });
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const threadResponse = events.find((message) => message.id === 2);
  const thread = threadResponse?.result?.thread?.id ?? threadResponse?.result?.id;
  if (!thread) {
    console.log(JSON.stringify({ status: "thread_start_failed", provider: "agentteams-gateway", model: "deepseek-v4-pro", seen: events.map((message) => ({ id: message.id ?? null, method: message.method ?? null, errorCode: message.error?.code ?? null, errorMessage: typeof message.error?.message === "string" ? message.error.message.slice(0, 160) : null })) }));
    process.exit(1);
  }
  send({ jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId: thread, input: [{ type: "text", text: "Reply with OK" }] } });
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  const completed = events.some((message) => message.method === "turn/completed");
  const error = events.find((message) => message.error)?.error;
  console.log(JSON.stringify({ status: completed ? "ok" : "no_completion", provider: "agentteams-gateway", model: "deepseek-v4-pro", errorCode: error?.code ?? null }));
  if (!completed) process.exitCode = 1;
} finally {
  child?.kill("SIGTERM");
  await rm(home, { recursive: true, force: true });
}

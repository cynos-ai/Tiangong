import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const input = JSON.parse(await new Promise((resolve, reject) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { value += chunk; });
  process.stdin.on("end", () => resolve(value.replace(/^\uFEFF/u, "")));
  process.stdin.on("error", reject);
}));
if (typeof input.baseUrl !== "string" || !input.baseUrl || typeof input.consumerToken !== "string" || !input.consumerToken) {
  throw new Error("A gateway base URL and scoped consumer token are required");
}

const home = await mkdtemp(join(tmpdir(), "tiangong-codex-gateway-probe-"));
const events = [];
let buffer = "";
let stderr = "";
let child;
const waitFor = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = events.find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return events.find(predicate) ?? null;
};
try {
  await writeFile(join(home, "config.toml"), `model_provider = "agentteams-gateway"\n\n[model_providers.agentteams-gateway]\nname = "agentteams-gateway"\nbase_url = ${JSON.stringify(input.baseUrl)}\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"\nsupports_websockets = false\n\n[features]\nresponses_websockets = false\nresponses_websockets_v2 = false\nplugins = false\napps = false\n`, { mode: 0o600 });
  const env = { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: input.consumerToken };
  delete env.DEEPSEEK_API_KEY;
  delete env.OPENAI_BASE_URL;
  child = spawn("codex", [
    "--disable", "responses_websockets",
    "--disable", "responses_websockets_v2",
    "app-server", "--listen", "stdio://",
  ], {
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
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4096);
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "tiangong-gateway-probe", title: "Tiangong Gateway Probe", version: "0" }, capabilities: { experimentalApi: true } } });
  const initializeResponse = await waitFor((message) => message.id === 1, 15_000);
  if (!initializeResponse?.result) {
    console.log(JSON.stringify({ status: "initialize_failed", provider: "agentteams-gateway", model: "deepseek-v4-pro", errorCode: initializeResponse?.error?.code ?? null, stderr: stderr.replace(/[^\x20-\x7e]/g, " ").slice(-240) }));
    process.exitCode = 1;
    throw new Error("Codex gateway initialize failed");
  }
  send({ jsonrpc: "2.0", id: 2, method: "thread/start", params: { model: "deepseek-v4-pro", modelProvider: "agentteams-gateway", approvalPolicy: "never", cwd: "/tmp" } });
  const threadResponse = await waitFor((message) => message.id === 2, 20_000);
  const thread = threadResponse?.result?.thread?.id ?? threadResponse?.result?.id;
  if (!thread) {
    console.log(JSON.stringify({ status: "thread_start_failed", provider: "agentteams-gateway", model: "deepseek-v4-pro", seen: events.map((message) => ({ id: message.id ?? null, method: message.method ?? null, errorCode: message.error?.code ?? null, errorMessage: typeof message.error?.message === "string" ? message.error.message.slice(0, 160) : null })), stderr: stderr.replace(/[^\x20-\x7e]/g, " ").slice(-240) }));
    process.exitCode = 1;
    throw new Error("Codex gateway thread/start failed");
  }
  send({ jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId: thread, input: [{ type: "text", text: "Reply with OK" }] } });
  await waitFor((message) => message.method === "turn/completed" || (message.id === 3 && message.error), 30_000);
  const completed = events.some((message) => message.method === "turn/completed");
  const error = events.find((message) => message.error)?.error;
  console.log(JSON.stringify({ status: completed ? "ok" : "no_completion", provider: "agentteams-gateway", model: "deepseek-v4-pro", errorCode: error?.code ?? null, stderr: stderr.replace(/[^\x20-\x7e]/g, " ").slice(-240) }));
  if (!completed) process.exitCode = 1;
} finally {
  if (child && !child.killed) child.kill("SIGKILL");
  await Promise.race([rm(home, { recursive: true, force: true }), new Promise((resolve) => setTimeout(resolve, 2_000))]);
}

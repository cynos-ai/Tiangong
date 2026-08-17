import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/u;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/u;
const TOKEN = /^[^\r\n\t ]{8,4096}$/u;
const DEFAULT_NETWORK = "agentteams-net";
const DEFAULT_STATE_DIR = "/var/lib/tiangong-opencodex";
const DEFAULT_GATEWAY_BASE_URL = "http://agentteams-controller:8080/v1";
const MAX_RESPONSE_BYTES = 16 * 1024;

export class OpenCodexSidecarAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpenCodexSidecarAdapterError";
    this.code = code;
  }
}

function fail(code, message) { throw new OpenCodexSidecarAdapterError(code, message); }

function demand(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) fail("sidecar-adapter-invalid", `${label} is invalid.`);
  return value;
}

function endpointParts(endpoint) {
  let parsed;
  try { parsed = new URL(endpoint); } catch { fail("sidecar-adapter-invalid", "The sidecar endpoint is invalid."); }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.search || parsed.hash || !HOST.test(parsed.hostname) || !parsed.port) {
    fail("sidecar-adapter-invalid", "The sidecar endpoint must be an internal HTTP origin with an explicit port.");
  }
  return parsed;
}

function sidecarContainerName(workerId) {
  const suffix = workerId.replace(/[^A-Za-z0-9_.-]/gu, "-").slice(0, 96);
  return `tiangong-opencodex-${suffix}`;
}

function sidecarIdFor(workerId) { return `opencodex-${workerId}`; }

async function runProcess(command, args, { input, timeoutMs = 30_000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
    const stdout = [];
    let stdoutBytes = 0;
    child.stdout?.on("data", chunk => { stdoutBytes += chunk.length; if (stdoutBytes <= 256 * 1024) stdout.push(chunk); });
    child.stderr?.resume();
    const timer = setTimeout(() => { child.kill(); reject(new OpenCodexSidecarAdapterError("sidecar-command-timeout", "The sidecar lifecycle command timed out.")); }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(new OpenCodexSidecarAdapterError("sidecar-command-failed", `The sidecar lifecycle command could not start (${error.code ?? "spawn"}).`)); });
    child.once("close", code => {
      clearTimeout(timer);
      const result = Buffer.concat(stdout).toString("utf8");
      if (code !== 0) reject(new OpenCodexSidecarAdapterError("sidecar-command-rejected", "The sidecar lifecycle command was rejected."));
      else resolve(result);
    });
    if (input !== undefined) { child.stdin.end(input); }
  });
}

function createDockerRunner(dockerPath) {
  return async (args, options) => runProcess(dockerPath, args, options);
}

async function boundedFetch(url, token, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "x-opencodex-api-key": token },
      signal: controller.signal,
    });
    if (!response || response.status !== 200) return null;
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) fail("sidecar-response-unbounded", "The OpenCodex sidecar response exceeded the bounded limit.");
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("sidecar-state-invalid", "The OpenCodex sidecar state could not be read.");
  }
}

function assertCredential(value) {
  if (typeof value !== "string" || !TOKEN.test(value)) fail("sidecar-credential-unavailable", "The scoped AgentTeams consumer credential is unavailable.");
  return value;
}

function inspectContainerState(raw) {
  try { return JSON.parse(raw); } catch { fail("sidecar-state-invalid", "The Docker sidecar state was not valid JSON."); }
}

/**
 * Real deployment adapter for the controller contract. The adapter owns a
 * dedicated Docker container on agentteams-net and starts OpenCodex only
 * after projecting the Worker-scoped consumer token through stdin into a
 * short-lived tmpfs file. The token is never a Docker argument, label, image
 * environment, config value, receipt, or lifecycle record.
 */
export function createDockerOpenCodexSidecarAdapter({
  dockerPath = process.env.DOCKER_PATH || "docker",
  network = process.env.TIANGONG_OPENCODEX_NETWORK || DEFAULT_NETWORK,
  stateDir = process.env.TIANGONG_OPENCODEX_STATE_DIR || DEFAULT_STATE_DIR,
  gatewayBaseUrl = process.env.TIANGONG_CODEX_GATEWAY_BASE_URL || DEFAULT_GATEWAY_BASE_URL,
  credentialProvider,
  fetchImpl = globalThis.fetch,
} = {}) {
  const docker = createDockerRunner(dockerPath);
  const gateway = new URL(gatewayBaseUrl);
  if (gateway.protocol !== "http:" || gateway.username || gateway.password || gateway.search || gateway.hash || !HOST.test(gateway.hostname)) {
    throw new TypeError("OpenCodex gateway base URL must be a credential-free internal HTTP URL");
  }
  if (typeof credentialProvider !== "function") {
    credentialProvider = async ({ binding }) => {
      const workerContainer = process.env.TIANGONG_OPENCODEX_WORKER_CONTAINER || binding.workerId;
      try {
        const output = await docker(["exec", workerContainer, "sh", "-c", "printenv AGENTTEAMS_WORKER_GATEWAY_KEY"], { timeoutMs: 5_000 });
        return output.trim();
      } catch {
        // Embedded AgentTeams v1.2.2 can stop a Worker before the deployment
        // adapter is reconciled. The scoped consumer token is already owned by
        // AgentTeams; this read-only fallback obtains it without putting it in
        // a Docker argument, label, config, receipt, or lifecycle record.
        const output = await docker(["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", workerContainer], { timeoutMs: 5_000 });
        return output.split(/\r?\n/u).find(line => line.startsWith("AGENTTEAMS_WORKER_GATEWAY_KEY="))?.slice("AGENTTEAMS_WORKER_GATEWAY_KEY=".length) ?? "";
      }
    };
  }

  async function containerInfo(containerName) {
    try {
      const raw = await docker(["inspect", "--format", "{{json .State}}|{{json .Config.Labels}}", containerName], { timeoutMs: 5_000 });
      const divider = raw.indexOf("|");
      return { state: inspectContainerState(raw.slice(0, divider)), labels: inspectContainerState(raw.slice(divider + 1)) || {} };
    } catch (error) {
      if (error?.code === "sidecar-command-rejected") return null;
      throw error;
    }
  }

  async function execIn(containerName, script, options = {}) {
    return docker(["exec", ...(options.input === undefined ? [] : ["-i"]), containerName, "sh", "-c", script], options);
  }

  async function processExists(containerName) {
    try {
      await execIn(containerName, "test -s /run/opencodex/pid && kill -0 \"$(cat /run/opencodex/pid)\"");
      return true;
    } catch { return false; }
  }

  async function waitForContainerRunning(containerName) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const info = await containerInfo(containerName);
      if (info?.state?.Running) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    fail("sidecar-container-not-running", "The OpenCodex sidecar container did not reach running state.");
  }

  async function credential(binding) {
    return assertCredential(await credentialProvider({ binding: Object.freeze({ ...binding }) }));
  }

  async function writeSecret(containerName, token) {
    try {
      await execIn(containerName, "umask 077; cat > /run/opencodex/token", { input: `${assertCredential(token)}\n`, timeoutMs: 5_000 });
    } catch { fail("sidecar-credential-projection-failed", "The scoped AgentTeams credential could not be projected into the sidecar tmpfs."); }
  }

  function configFor(binding, port) {
    return {
      port,
      hostname: "0.0.0.0",
      providers: {
        [binding.provider]: {
          adapter: "openai-chat",
          baseUrl: gateway.toString().replace(/\/$/u, ""),
          apiKey: "$TIANGONG_SCOPED_TOKEN",
          defaultModel: binding.model,
          models: [binding.model],
          discoverModels: false,
          allowPrivateNetwork: true,
        },
      },
      defaultProvider: binding.provider,
      clientIntegrations: { codex: false },
    };
  }

  async function stopProcess(containerName, { force = false } = {}) {
    const signal = force ? "KILL" : "TERM";
    try { await execIn(containerName, `if test -s /run/opencodex/pid; then kill -${signal} "$(cat /run/opencodex/pid)" 2>/dev/null || true; fi`); } catch { /* already stopped */ }
    const deadline = Date.now() + (force ? 2_000 : 30_000);
    while (Date.now() < deadline) {
      if (!(await processExists(containerName))) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!force) {
      await stopProcess(containerName, { force: true });
      return;
    }
    fail("sidecar-stop-timeout", "The OpenCodex sidecar process did not stop after the bounded force timeout.");
  }

  async function startProcess(binding, containerName, token) {
    const parsed = endpointParts(binding.endpoint);
    await writeSecret(containerName, token);
    const config = JSON.stringify(configFor(binding, Number(parsed.port)));
    try {
      await execIn(containerName, "umask 077; mkdir -p /run/opencodex/home; cat > /run/opencodex/home/config.json", { input: `${config}\n`, timeoutMs: 5_000 });
    } catch { fail("sidecar-config-projection-failed", "The OpenCodex sidecar configuration could not be projected into the sidecar tmpfs."); }
    const generation = binding.generation;
    const script = [
      "set -eu",
      "token=$(cat /run/opencodex/token)",
      "rm -f /run/opencodex/token",
      "export TIANGONG_SCOPED_TOKEN=\"$token\" OPENCODEX_API_AUTH_TOKEN=\"$token\" OPENCODEX_HOME=/run/opencodex/home",
      "unset token",
      `printf '%s' '${generation}' > /run/opencodex/generation`,
      "rm -f /run/opencodex/draining",
      "echo $$ > /run/opencodex/pid",
      `exec ocx start --port ${Number(parsed.port)}`,
    ].join("; ");
    try { await docker(["exec", "-d", containerName, "sh", "-c", script], { timeoutMs: 5_000 }); }
    catch { fail("sidecar-process-start-failed", "The OpenCodex sidecar process could not be started."); }
  }

  async function assertOwned(containerName, binding, info) {
    if (!info) return;
    const expected = {
      "io.tiangong.owner": "agentteams-deployment",
      "io.tiangong.component": "opencodex-sidecar",
      "io.tiangong.team-id": binding.teamId,
      "io.tiangong.worker-id": binding.workerId,
    };
    for (const [key, value] of Object.entries(expected)) if (info.labels?.[key] !== value) fail("sidecar-ownership-conflict", `The existing container ${containerName} is not owned by this binding.`);
    if (info.labels?.["io.tiangong.image"] !== binding.image) fail("sidecar-binding-conflict", "The existing OpenCodex sidecar image does not match the binding.");
  }

  async function statePath(sidecarId) { return join(stateDir, `${sidecarId}.json`); }

  return Object.freeze({
    async provision(binding) {
      demand(binding.image, IMAGE, "image");
      const parsed = endpointParts(binding.endpoint);
      const containerName = sidecarContainerName(binding.workerId);
      const sidecarId = sidecarIdFor(binding.workerId);
      const info = await containerInfo(containerName);
      await assertOwned(containerName, binding, info);
      if (!info) {
        await docker([
          "run", "-d", "--name", containerName, "--network", network,
          "--read-only", "--tmpfs", "/run/opencodex:rw,noexec,nosuid,nodev,size=16m",
          "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "1g",
          "--label", "io.tiangong.owner=agentteams-deployment",
          "--label", "io.tiangong.component=opencodex-sidecar",
          "--label", `io.tiangong.team-id=${binding.teamId}`,
          "--label", `io.tiangong.worker-id=${binding.workerId}`,
          "--label", `io.tiangong.image=${binding.image}`,
          "--label", `io.tiangong.endpoint=${binding.endpoint}`,
          "--label", "io.tiangong.schema=1",
          binding.image, "sh", "-c", "exec sleep infinity",
        ], { timeoutMs: 60_000 });
        await waitForContainerRunning(containerName);
      }
      if (!(await processExists(containerName))) await startProcess(binding, containerName, await credential(binding));
      await atomicJson(await statePath(sidecarId), { schemaVersion: 1, sidecarId, containerName, endpoint: binding.endpoint, image: binding.image, teamId: binding.teamId, workerId: binding.workerId, provider: binding.provider, model: binding.model, transport: binding.transport, bridge: binding.bridge, credentialSource: binding.credentialSource, generation: binding.generation, phase: "provisioning" });
      return { endpoint: binding.endpoint, image: binding.image, sidecarId };
    },

    async probe({ sidecarId, binding }) {
      const info = await containerInfo(sidecarContainerName(binding.workerId));
      if (!info?.state?.Running) fail("sidecar-not-ready", "The OpenCodex sidecar container is not running.");
      const token = await credential(binding);
      const parsed = endpointParts(binding.endpoint);
      let readyz;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const healthz = await boundedFetch(new URL("healthz", `${parsed.origin}/`).toString(), token, fetchImpl);
        readyz = await boundedFetch(new URL("readyz", `${parsed.origin}/`).toString(), token, fetchImpl);
        if (healthz && readyz?.status === "ready") break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!readyz || readyz.status !== "ready") fail("sidecar-not-ready", "The OpenCodex sidecar did not report ready within the bounded startup window.");
      const state = await readJson(await statePath(sidecarId));
      if (state && state.generation !== binding.generation) fail("sidecar-generation-invalid", "The OpenCodex sidecar generation does not match the binding.");
      await atomicJson(await statePath(sidecarId), { ...(state ?? {}), generation: binding.generation, phase: "ready" });
      return { generation: binding.generation, healthz: "pass", readyz: "pass", model: binding.model, provider: binding.provider };
    },

    async status({ sidecarId, binding }) {
      const containerName = sidecarContainerName(binding.workerId);
      const info = await containerInfo(containerName);
      const state = await readJson(await statePath(sidecarId));
      if (!info) return { generation: state?.generation ?? binding.generation, phase: "removed" };
      if (state?.phase === "drained" || !info.state?.Running) return { generation: state?.generation ?? binding.generation, phase: state?.phase === "drained" ? "drained" : "provisioning" };
      if (await processExists(containerName)) return { generation: state?.generation ?? binding.generation, phase: state?.phase === "ready" ? "ready" : "provisioning" };
      return { generation: state?.generation ?? binding.generation, phase: "provisioning" };
    },

    async rotate({ sidecarId, credentialRef, generation }) {
      const state = await readJson(await statePath(sidecarId));
      if (!state) fail("sidecar-state-missing", "The OpenCodex sidecar state is missing for rotation.");
      const binding = { ...state, credentialRef, generation };
      const containerName = state.containerName;
      await stopProcess(containerName);
      await startProcess(binding, containerName, await credential(binding));
      await atomicJson(await statePath(sidecarId), { ...state, generation, phase: "provisioning" });
      return { status: "pass", generation };
    },

    async drain({ sidecarId, binding }) {
      const stateFile = await statePath(sidecarId);
      const state = await readJson(stateFile);
      const containerName = sidecarContainerName(binding.workerId);
      if (state) await atomicJson(stateFile, { ...state, phase: "draining" });
      await execIn(containerName, "touch /run/opencodex/draining");
      await stopProcess(containerName);
      await atomicJson(stateFile, { ...(state ?? {}), sidecarId, containerName, generation: binding.generation, phase: "drained" });
      return { status: "pass", generation: binding.generation };
    },

    async remove({ sidecarId }) {
      const state = await readJson(await statePath(sidecarId));
      if (!state) return { status: "pass", generation: 1 };
      const info = await containerInfo(state.containerName);
      if (info) {
        for (const [key, value] of Object.entries({ "io.tiangong.owner": "agentteams-deployment", "io.tiangong.component": "opencodex-sidecar" })) if (info.labels?.[key] !== value) fail("sidecar-ownership-conflict", "Refusing to remove a container outside the sidecar ownership boundary.");
        await docker(["rm", "-f", state.containerName], { timeoutMs: 30_000 });
      }
      await rm(await statePath(sidecarId), { force: true });
      return { status: "pass", generation: state.generation };
    },
  });
}

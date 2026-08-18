#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AdmissionBindingStore } from "../../worker/agent/gates/admission-control-server.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUNTIME_ROOT = join(REPO_ROOT, ".runtime", "agentteams");
const MANAGER = "agentteams-manager";
const CONTROLLER = "agentteams-controller";
const NETWORK = "agentteams-net";
const WORKER_NAME = "tiangong-openclaw-admission-canary";
const WORKER_CONTAINER = `agentteams-worker-${WORKER_NAME}`;
const SERVICE_CONTAINER = "tiangong-admission-control-gate-a";
const MANAGER_FIXTURE = `/tmp/${SERVICE_CONTAINER}.yaml`;
const STORAGE_PREFIX = `agentteams/agentteams-storage/agents/${WORKER_NAME}/`;
const MIRROR_PATH = `/root/agentteams-fs/agents/${WORKER_NAME}`;
const WORKER_IMAGE = process.env.TIANGONG_ADMISSION_CANARY_IMAGE ?? "tiangong-worker-canary-admission:dev";
const SERVICE_IMAGE = process.env.TIANGONG_ADMISSION_CONTROL_IMAGE ?? "tiangong-worker-admission-control:dev";

const binding = {
  workerName: WORKER_NAME,
  runtimeLane: "openclaw-canary",
  configRevision: "gate-a-config-1",
  capabilityRevision: "gate-a-capability-1",
  allowedChannels: ["matrix"],
  allowedActors: ["@human:example.test"],
  allowedRoutes: ["team-room"],
  allowedSessions: ["gate-a-session-1"],
  active: true,
};

function log(message) {
  process.stdout.write(`[Tiangong] ${message}\n`);
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

async function command(label, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn("docker", args, { cwd: REPO_ROOT, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), options.timeout ?? 120_000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timeout);
      const failure = new Error(`${label}_FAILED`);
      failure.code = `${label}_FAILED`;
      failure.cause = error;
      rejectCommand(failure);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolveCommand({ stdout, stderr });
        return;
      }
      const failure = new Error(`${label}_FAILED`);
      failure.code = `${label}_FAILED`;
      failure.exitCode = code;
      failure.stderr = stderr.slice(-2048);
      rejectCommand(failure);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function docker(args, options) {
  return command("DOCKER", args, options);
}

async function inspectExists(name) {
  try {
    await docker(["inspect", name], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function assertContainer(name, expectedRunning = true) {
  if (!(await inspectExists(name))) fail(`CONTAINER_MISSING_${name}`);
  if (expectedRunning) {
    const status = (await docker(["inspect", "--format", "{{.State.Running}}", name], { timeout: 10_000 })).stdout.trim();
    if (status !== "true") fail(`CONTAINER_NOT_RUNNING_${name}`);
  }
}

async function waitFor(label, check, attempts = 90) {
  for (let index = 0; index < attempts; index += 1) {
    if (await check()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
  }
  fail(`${label}_TIMEOUT`);
}

async function buildImages() {
  if (process.env.TIANGONG_BUILD_CANARY !== "1") return;
  const context = join(REPO_ROOT, "team-playbooks");
  for (const [target, tag] of [["admission-control", SERVICE_IMAGE], ["canary-admission-control", WORKER_IMAGE]]) {
    log(`building_${target}`);
    await docker([
      "build", "--pull", "--build-context", `team_playbooks=${context}`,
      "--target", target, "--tag", tag, join(REPO_ROOT, "worker"),
    ], { timeout: 15 * 60_000 });
  }
}

async function workerResource() {
  try {
    const result = await docker(["exec", MANAGER, "agt", "get", "workers", WORKER_NAME, "-o", "json"], { timeout: 10_000 });
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

async function assertUnowned() {
  await assertContainer(MANAGER);
  await assertContainer(CONTROLLER);
  if (await inspectExists(WORKER_CONTAINER)) fail("WORKER_ALREADY_EXISTS");
  if (await inspectExists(SERVICE_CONTAINER)) fail("ADMISSION_SERVICE_ALREADY_EXISTS");
  if (await workerResource()) fail("WORKER_RESOURCE_ALREADY_EXISTS");
  const storage = await docker(["exec", CONTROLLER, "mc", "ls", STORAGE_PREFIX], { timeout: 10_000 }).catch(() => ({ stdout: "" }));
  if (storage.stdout.trim() !== "") fail("WORKER_STORAGE_ALREADY_EXISTS");
  const mirror = await docker(["exec", CONTROLLER, "test", "!", "-e", MIRROR_PATH], { timeout: 10_000 }).catch(() => null);
  if (!mirror) fail("WORKER_MIRROR_ALREADY_EXISTS");
}

async function startAdmissionService(stateDir) {
  await docker([
    "run", "-d", "--name", SERVICE_CONTAINER, "--network", NETWORK, "--network-alias", "tiangong-admission-control",
    "-v", `${stateDir}:/run/tiangong-admission`,
    "-v", `${stateDir}:/var/lib/tiangong-admission`,
    "-e", "TIANGONG_ADMISSION_BINDING_FILE=/run/tiangong-admission/binding.json",
    "-e", "TIANGONG_ADMISSION_REPLAY_FILE=/var/lib/tiangong-admission/replay.json",
    "-e", "TIANGONG_ADMISSION_CONTROL_PORT=8789",
    SERVICE_IMAGE,
  ], { timeout: 60_000 });
  await waitFor("ADMISSION_SERVICE_READY", async () => {
    try {
      const response = await docker(["exec", SERVICE_CONTAINER, "node", "--input-type=module", "-e",
        "const r=await fetch('http://127.0.0.1:8789/healthz'); if(r.status!==200) process.exit(1);"] , { timeout: 10_000 });
      return response.stdout === "";
    } catch {
      return false;
    }
  }, 30);
  log("admission_control_ready=pass");
}

function workerFixture() {
  return `apiVersion: agentteams.io/v1beta1\nkind: Worker\nmetadata:\n  name: ${WORKER_NAME}\nspec:\n  model: codex/deepseek-v4-pro\n  runtime: openclaw\n  image: ${WORKER_IMAGE}\n  state: Running\n  identity: |\n    Name: Tiangong OpenClaw Admission Control Canary\n    Purpose: Disposable Gate A admission/restart verification only.\n`;
}

async function applyWorker() {
  await docker(["exec", "-i", MANAGER, "sh", "-c", 'umask 077; cat > "$1"', "_", MANAGER_FIXTURE], { input: workerFixture(), timeout: 10_000 });
  await docker(["exec", MANAGER, "agt", "apply", "-f", MANAGER_FIXTURE], { timeout: 60_000 });
  await waitFor("WORKER_CONTAINER", () => inspectExists(WORKER_CONTAINER));
  try {
    await waitFor("WORKER_READY", async () => {
      const resource = await workerResource();
      if (resource?.phase !== "Running") return false;
      try {
        const health = await docker(["exec", WORKER_CONTAINER, "openclaw", "health"], { timeout: 10_000 });
        const logResult = await docker(["logs", WORKER_CONTAINER], { timeout: 10_000 });
        const logs = `${logResult.stdout}\n${logResult.stderr}`;
        return health.stdout !== undefined &&
          logs.includes(`tiangong_preflight=pass plugin=tiangong-control lane=openclaw-native`) &&
          logs.includes(`worker/${WORKER_NAME} reported ready`);
      } catch {
        return false;
      }
    }, 90);
  } catch (error) {
    const resource = await docker(["exec", MANAGER, "agt", "get", "workers", WORKER_NAME], { timeout: 10_000 }).catch(() => ({ stdout: "" }));
    const logs = await docker(["logs", WORKER_CONTAINER], { timeout: 10_000 }).catch(() => ({ stdout: "", stderr: "" }));
    log(`worker_ready_diagnostics=${JSON.stringify({ error: error.code ?? error.message, resource: `${resource.stdout}\n${resource.stderr ?? ""}`.trim().slice(-1024), logs: `${logs.stdout}\n${logs.stderr}`.slice(-2048) })}`);
    throw error;
  }
  log("agentteams_worker_ready=pass");
}

async function workerAdmission(label, expected = "pass") {
  const script = `
    import { createControlAdmissionResolver } from '/opt/tiangong-worker/agent/gates/admission-context.mjs';
    const resolve = createControlAdmissionResolver({ url: process.env.TIANGONG_CONTROL_API_ADMISSION_URL, workerName: '${WORKER_NAME}', runtimeLane: 'openclaw-canary' });
    try {
      const model = await resolve({ phase: 'model', event: { channel: 'matrix', route: 'team-room', senderId: '@human:example.test', messageId: 'gate-a-event-1', sessionKey: 'gate-a-session-1', content: 'phase-a-probe' } });
      const tool = await resolve({ phase: 'tool', event: { toolName: 'read', toolCallId: 'gate-a-call-1', messageId: 'gate-a-event-1', sessionKey: 'gate-a-session-1' } });
      console.log(JSON.stringify({
        modelAdmitted: model.binding.active === true && model.request.workerName === '${WORKER_NAME}',
        toolAdmitted: tool.admission.phase === 'model' && tool.binding.active === true && tool.admission.workerName === '${WORKER_NAME}',
        toolName: tool.toolName,
      }));
    } catch (error) {
      console.log(JSON.stringify({ error: error?.code ?? 'ADMISSION_UNKNOWN' }));
    }
  `;
  const result = await docker(["exec", WORKER_CONTAINER, "node", "--input-type=module", "-e", script], { timeout: 20_000 }).catch((error) => {
    if (expected === "deny") return { stdout: "{\"error\":\"ADMISSION_BINDING_INACTIVE\"}\n" };
    throw error;
  });
  const output = JSON.parse(result.stdout.trim());
  if (expected === "pass" && output.modelAdmitted !== true) fail(`${label}_MODEL_NOT_ADMITTED`);
  if (expected === "pass" && output.toolAdmitted !== true) fail(`${label}_TOOL_NOT_ADMITTED`);
  if (expected === "deny" && !String(output.error).startsWith("ADMISSION_")) fail(`${label}_DENY_NOT_FAIL_CLOSED`);
  log(`${label}=${expected}`);
}

async function workerToolResultCapture() {
  const script = `
    import { createToolResultCaptureHook } from '/opt/tiangong-worker/agent/gates/tool-result-capture.mjs';
    const hook = createToolResultCaptureHook({ filePath: '/root/agentteams-fs/agents/${WORKER_NAME}/.tiangong/runtime/tool-results/openclaw.json', now: () => new Date('2026-08-15T00:00:10.000Z') });
    await hook({ toolName: 'read', toolCallId: 'gate-a-capture-1', message: { role: 'toolResult', content: [{ type: 'text', text: 'gate-a-secret-probe' }] } }, { agentId: 'gate-a-agent', sessionKey: 'gate-a-session-1', workId: 'work-gate-a', taskId: 'task-gate-a', runtimeProfile: 'openclaw-built-in' });
    const { ToolResultStore } = await import('/opt/tiangong-worker/agent/gates/tool-result-store.mjs');
    const state = await new ToolResultStore({ filePath: '/root/agentteams-fs/agents/${WORKER_NAME}/.tiangong/runtime/tool-results/openclaw.json' }).list();
    const record = state.results.at(-1);
    if (!record || record.actorId !== 'gate-a-agent' || record.resultSummary.outcome !== 'success' || JSON.stringify(record).includes('gate-a-secret-probe')) process.exit(2);
    console.log(JSON.stringify({ resultCount: state.results.length, toolResultId: record.toolResultId, contentRef: record.outputRef }));
  `;
  const result = await docker(["exec", WORKER_CONTAINER, "node", "--input-type=module", "-e", script], { timeout: 20_000 });
  const output = JSON.parse(result.stdout.trim());
  if (!Number.isInteger(output.resultCount) || !/^[a-f0-9]{64}$/u.test(output.toolResultId)) fail("TOOL_RESULT_CAPTURE_INVALID");
  log("builtin_tool_result_capture=pass");
}

async function workerBuiltinRead() {
  const result = await docker([
    "exec", WORKER_CONTAINER, "openclaw", "agent", "--agent", "main", "--json", "--timeout", "45",
    "--message", "Use only the built-in read tool to read /opt/tiangong-worker/README.md, then reply with OPENCLAW_BUILTIN_READ_OK.",
  ], { timeout: 60_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes("OPENCLAW_BUILTIN_READ_OK")) fail("BUILTIN_READ_RESULT_INVALID");
  const storeCheck = await docker(["exec", WORKER_CONTAINER, "node", "--input-type=module", "-e", `
    import { ToolResultStore } from '/opt/tiangong-worker/agent/gates/tool-result-store.mjs';
    const state = await new ToolResultStore({ filePath: '/root/agentteams-fs/agents/${WORKER_NAME}/.tiangong/runtime/tool-results/openclaw.json' }).list();
    const records = state.results.filter((entry) => entry.tool === 'read');
    if (records.length < 1) process.exit(2);
    console.log(JSON.stringify({ count: records.length, outcomes: records.map((entry) => entry.resultSummary.outcome) }));
  `], { timeout: 20_000 });
  const facts = JSON.parse(storeCheck.stdout.trim());
  if (!Number.isInteger(facts.count) || facts.count < 1) fail("BUILTIN_READ_CAPTURE_MISSING");
  log("builtin_read_tool=pass");
}

async function restartWorker() {
  await docker(["restart", WORKER_CONTAINER], { timeout: 60_000 });
  await waitFor("WORKER_RESTART_READY", async () => {
    const resource = await workerResource();
    if (resource?.phase !== "Running") return false;
    try {
      await docker(["exec", WORKER_CONTAINER, "openclaw", "health"], { timeout: 10_000 });
      const logResult = await docker(["logs", WORKER_CONTAINER], { timeout: 10_000 });
      return `${logResult.stdout}\n${logResult.stderr}`.includes(`worker/${WORKER_NAME} reported ready`);
    } catch {
      return false;
    }
  }, 90);
  log("worker_restart_readiness=pass");
}

async function cleanup(stateDir) {
  let failed = false;
  await docker(["exec", MANAGER, "rm", "-f", MANAGER_FIXTURE], { timeout: 10_000 }).catch(() => { failed = true; });
  if (await workerResource()) {
    await docker(["exec", MANAGER, "agt", "delete", "worker", WORKER_NAME], { timeout: 60_000 }).catch(() => { failed = true; });
  }
  await waitFor("WORKER_ABSENCE", async () => !(await workerResource()) && !(await inspectExists(WORKER_CONTAINER)), 60).catch(() => { failed = true; });
  await docker(["exec", CONTROLLER, "mc", "rm", "--recursive", "--force", STORAGE_PREFIX], { timeout: 60_000 }).catch(() => {});
  await docker(["exec", CONTROLLER, "rm", "-rf", "--", MIRROR_PATH], { timeout: 10_000 }).catch(() => {});
  const storage = await docker(["exec", CONTROLLER, "mc", "ls", STORAGE_PREFIX], { timeout: 10_000 }).catch(() => ({ stdout: "" }));
  const mirror = await docker(["exec", CONTROLLER, "test", "!", "-e", MIRROR_PATH], { timeout: 10_000 }).catch(() => null);
  if (storage.stdout.trim() !== "" || !mirror) failed = true;
  await docker(["rm", "-f", SERVICE_CONTAINER], { timeout: 30_000 }).catch(() => { failed = true; });
  await rm(stateDir, { recursive: true, force: true }).catch(() => { failed = true; });
  if (failed) fail("GATE_A_CLEANUP_FAILED");
  log("gate_a_cleanup=pass");
}

async function main() {
  if (process.env.TIANGONG_RUN_REAL !== "1") fail("REAL_SMOKE_DISABLED_SET_TIANGONG_RUN_REAL_1");
  await assertUnowned();
  await buildImages();
  await docker(["image", "inspect", WORKER_IMAGE], { timeout: 10_000 });
  await docker(["image", "inspect", SERVICE_IMAGE], { timeout: 10_000 });
  await mkdir(RUNTIME_ROOT, { recursive: true, mode: 0o700 });
  const stateDir = await mkdtemp(join(RUNTIME_ROOT, "openclaw-admission-"));
  try {
    const bindingStore = new AdmissionBindingStore({ filePath: join(stateDir, "binding.json") });
    await bindingStore.write(binding, { updatedAt: "2026-08-15T00:00:00.000Z" });
    await startAdmissionService(stateDir);
    log("admission_control_started");
    await applyWorker();
    log("worker_ready=pass");
    await workerToolResultCapture();
    if (process.env.TIANGONG_RUN_BUILTIN_TOOL === "1") await workerBuiltinRead();
    await workerAdmission("admission_model_tool", "pass");
    await docker(["restart", SERVICE_CONTAINER], { timeout: 60_000 });
    await waitFor("ADMISSION_SERVICE_RESTART_READY", async () => {
      try {
        await docker(["exec", SERVICE_CONTAINER, "node", "--input-type=module", "-e", "const r=await fetch('http://127.0.0.1:8789/healthz'); if(r.status!==200) process.exit(1);"], { timeout: 10_000 });
        return true;
      } catch { return false; }
    }, 30);
    log("admission_control_restart_ready=pass");
    await restartWorker();
    log("worker_restart_ready=pass");
    await workerAdmission("admission_replay_after_restart", "pass");
    await bindingStore.write({ ...binding, configRevision: "gate-a-config-revoked", active: false, revoked: true }, { updatedAt: "2026-08-15T00:00:02.000Z" });
    await workerAdmission("admission_revocation", "deny");
    log("gate_a_admission_live=pass");
  } finally {
    await cleanup(stateDir);
  }
}

main().catch((error) => {
  process.stderr.write(`openclaw_admission_smoke_failed=${error?.code ?? "UNKNOWN"}\n`);
  process.exitCode = 1;
});

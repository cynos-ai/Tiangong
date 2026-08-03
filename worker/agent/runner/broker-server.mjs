import { createServer } from "node:http";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { createDisposableDockerExecutor, createDockerCommandRunner } from "./docker-executor.mjs";
import { RunnerJournal } from "./journal.mjs";
import { assertNoForbiddenEnv, validateCommandRequest, validateExecutionPlan } from "./runner-policy.mjs";
import { ChangeRevisionStore } from "./revision-store.mjs";
import { runCommand, runnerInvocationIdentity, runnerRunIdForTask } from "./runner-port.mjs";
import { isProjectBinding, isTaskBinding } from "../team/manifest.mjs";

const CONFIG_PATH = "/run/tiangong-runner-broker/config.json";
const FIXTURE_ROOT = "/opt/tiangong-runner-fixtures";
const STATE_ROOT = "/var/lib/tiangong-runner-broker";
const REVISION_ROOT_NAME = "change-revisions";
const DOCKER_PATH = "/usr/local/bin/docker";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RESOURCE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/u;
const IMAGE = /^sha256:[0-9a-f]{64}$/u;
const RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ROLES = new Set(["implementor", "assessor"]);
const REQUEST_KEYS = [
  "command", "cwd", "env", "invocationKey", "outputLimitBytes", "runId", "schemaVersion", "taskId", "timeoutMs",
];
const CONFIG_KEYS = ["bindings", "listenPort", "network", "schemaVersion"];
const PREPARATION_KEYS = ["leaderImageId", "runnerImageIds"];
const BINDING_KEYS = [
  "containerName", "execution", "fixtureId", "inputRevisionTaskId", "revisionIndex", "role", "runId", "runnerImageId",
  "taskId", "workerImageId", "workerName",
];
const EXECUTION_KEYS = ["command", "outputLimitBytes", "timeoutMs"];
const PLAN_REQUEST_KEYS = ["runId", "schemaVersion", "taskId"];
const BINDING_STATE_KEYS = ["bindings", "schemaVersion"];
const PREPARATION_ENDPOINT_DIGEST = sha256("http://tiangong-runner-broker:8787/v1/execute");
const FIXED_PREPARATION_COMMAND = Object.freeze(["node", "probe.mjs"]);
const FIXED_PREPARATION_TIMEOUT_MS = 30_000;
const FIXED_PREPARATION_OUTPUT_LIMIT_BYTES = 65_536;
const FIXED_WORKER_CONTAINER_PREFIX = "agentteams-worker-";

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function demand(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} has an invalid format`);
  return value;
}

function normalizeAddress(value) {
  if (typeof value !== "string" || value === "") throw new Error("RUNNER_BROKER_PEER_UNAVAILABLE");
  const address = value.startsWith("::ffff:") ? value.slice(7) : value;
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(address)) throw new Error("RUNNER_BROKER_PEER_INVALID");
  return address;
}

function executionPlan(binding) {
  const base = {
    schemaVersion: 1,
    taskId: binding.taskId,
    runId: binding.runId,
    command: binding.execution.command,
    cwd: binding.role === "implementor" ? "scratch/revision" : "fixture",
    timeoutMs: binding.execution.timeoutMs,
    outputLimitBytes: binding.execution.outputLimitBytes,
  };
  return Object.freeze({ ...base, contentDigest: sha256(canonicalJson(base)) });
}

export function runnerBrokerBindingDigest(binding) {
  return sha256({
    workerName: binding.workerName,
    role: binding.role,
    taskId: binding.taskId,
    runId: binding.runId,
    runnerImageId: binding.runnerImageId,
    executionPlanDigest: executionPlan(binding).contentDigest,
  });
}

const bindingId = runnerBrokerBindingDigest;

function validatePreparationConfig(value) {
  exactKeys(value, PREPARATION_KEYS, "Runner broker preparation config");
  if (!IMAGE.test(value.leaderImageId) || !value.runnerImageIds || typeof value.runnerImageIds !== "object" ||
      Array.isArray(value.runnerImageIds) || Object.keys(value.runnerImageIds).sort().join("\n") !== ["assessor", "implementor"].join("\n") ||
      !IMAGE.test(value.runnerImageIds.implementor) || !IMAGE.test(value.runnerImageIds.assessor)) {
    throw new Error("Runner broker preparation config is invalid");
  }
  return Object.freeze({
    leaderImageId: value.leaderImageId,
    runnerImageIds: Object.freeze({
      implementor: value.runnerImageIds.implementor,
      assessor: value.runnerImageIds.assessor,
    }),
  });
}

export function validateBrokerConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runner broker config is invalid");
  }
  const keys = Object.keys(value).sort().join("\n");
  const baseKeys = [...CONFIG_KEYS].sort().join("\n");
  const preparedKeys = [...CONFIG_KEYS, "preparation"].sort().join("\n");
  if (keys !== baseKeys && keys !== preparedKeys) {
    throw new Error("Runner broker config has missing or unknown fields");
  }
  if (value.schemaVersion !== 1 || !NETWORK.test(value.network) ||
      !Number.isInteger(value.listenPort) || value.listenPort < 1 || value.listenPort > 65535 ||
      !Array.isArray(value.bindings) || value.bindings.length > 32 ||
      (value.bindings.length === 0 && !value.preparation)) {
    throw new Error("Runner broker config is invalid");
  }
  const preparation = value.preparation === undefined || value.preparation === null
    ? null
    : validatePreparationConfig(value.preparation);
  const workers = new Set();
  const containers = new Set();
  const tasks = new Set();
  const bindings = value.bindings.map((entry) => {
    exactKeys(entry, BINDING_KEYS, "Runner broker binding");
    const binding = Object.freeze({
      workerName: demand(entry.workerName, RESOURCE, "workerName"),
      containerName: demand(entry.containerName, RESOURCE, "containerName"),
      workerImageId: demand(entry.workerImageId, IMAGE, "workerImageId"),
      role: ROLES.has(entry.role) ? entry.role : (() => { throw new Error("Runner broker role is invalid"); })(),
      taskId: demand(entry.taskId, ID, "taskId"),
      runId: demand(entry.runId, RUN_ID, "runId"),
      runnerImageId: demand(entry.runnerImageId, IMAGE, "runnerImageId"),
      execution: (() => {
        exactKeys(entry.execution, EXECUTION_KEYS, "Runner broker execution plan");
        return validateExecutionPlan(entry.execution);
      })(),
      revisionIndex: Number.isInteger(entry.revisionIndex) && entry.revisionIndex >= 0
        ? entry.revisionIndex
        : (() => { throw new Error("Runner broker revisionIndex is invalid"); })(),
      fixtureId: entry.fixtureId === null ? null : demand(entry.fixtureId, RESOURCE, "fixtureId"),
      inputRevisionTaskId: entry.inputRevisionTaskId === null
        ? null
        : demand(entry.inputRevisionTaskId, ID, "inputRevisionTaskId"),
    });
    if ((binding.role === "implementor" && (binding.fixtureId === null || binding.inputRevisionTaskId !== null)) ||
        (binding.role === "assessor" && (binding.fixtureId !== null || binding.inputRevisionTaskId === null))) {
      throw new Error("Runner broker fixture binding does not match the professional role");
    }
    if (workers.has(binding.workerName) || containers.has(binding.containerName) || tasks.has(binding.taskId)) {
      throw new Error("Runner broker bindings must have unique Worker, container, and Task identities");
    }
    workers.add(binding.workerName);
    containers.add(binding.containerName);
    tasks.add(binding.taskId);
    return binding;
  });
  const byTask = new Map(bindings.map((binding) => [binding.taskId, binding]));
  for (const binding of bindings) {
    if (binding.role === "assessor") {
      const input = byTask.get(binding.inputRevisionTaskId);
      if (!input || input.role !== "implementor" || input.revisionIndex !== binding.revisionIndex) {
        throw new Error("Assessor input must reference the Implementor Task for the same revision");
      }
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    network: value.network,
    listenPort: value.listenPort,
    bindings: Object.freeze(bindings),
    preparation,
  });
}

async function readBoundedJson(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || metadata.size > MAX_CONFIG_BYTES) {
    throw new Error("Runner broker config must be a bounded regular file");
  }
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeAtomicJson(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${canonicalJson(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function bindingState(value) {
  exactKeys(value, BINDING_STATE_KEYS, "Runner broker binding state");
  if (value.schemaVersion !== 1 || !Array.isArray(value.bindings)) {
    throw new Error("Runner broker binding state is invalid");
  }
  return value.bindings;
}

function configInput(config, bindings) {
  return {
    schemaVersion: 1,
    network: config.network,
    listenPort: config.listenPort,
    bindings,
    ...(config.preparation ? { preparation: config.preparation } : {}),
  };
}

export async function createRunnerBrokerBindingRegistry({ config, stateRoot }) {
  const validated = validateBrokerConfig(config);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const statePath = join(resolve(stateRoot), "bindings.json");
  let bindings = [...validated.bindings];
  try {
    const persisted = bindingState(await readBoundedJson(statePath));
    const persistedConfig = validateBrokerConfig(configInput(validated, persisted));
    for (const initial of validated.bindings) {
      const matching = persistedConfig.bindings.find((entry) => entry.taskId === initial.taskId);
      if (!matching || canonicalJson(matching) !== canonicalJson(initial)) {
        throw new Error("Runner broker binding state conflicts with the immutable startup config");
      }
    }
    bindings = [...persistedConfig.bindings];
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeAtomicJson(statePath, { schemaVersion: 1, bindings });
  }

  let tail = Promise.resolve();
  const withMutationLock = (operation) => {
    const next = tail.then(operation, operation);
    tail = next.catch(() => {});
    return next;
  };
  const snapshot = () => validateBrokerConfig(configInput(validated, bindings));
  return Object.freeze({
    config: snapshot,
    get(taskId) {
      return bindings.find((entry) => entry.taskId === taskId);
    },
    async register(binding) {
      return withMutationLock(async () => {
        const existing = bindings.find((entry) => entry.taskId === binding.taskId);
        if (existing) {
          if (canonicalJson(existing) !== canonicalJson(binding)) {
            throw new Error("RUNNER_BROKER_BINDING_CONFLICT");
          }
          return { binding: existing, replayed: true };
        }
        const nextBindings = [...bindings, binding];
        const nextConfig = validateBrokerConfig(configInput(validated, nextBindings));
        await writeAtomicJson(statePath, { schemaVersion: 1, bindings: nextConfig.bindings });
        bindings = [...nextConfig.bindings];
        return { binding: bindings.find((entry) => entry.taskId === binding.taskId), replayed: false };
      });
    },
  });
}

function addressFromNetworkEntry(entry) {
  const value = entry?.IPv4Address;
  return typeof value === "string" ? value.split("/", 1)[0] : undefined;
}

export function createDockerPeerAuthenticator({ config, runDocker }) {
  if (typeof runDocker !== "function") throw new TypeError("Docker peer authentication requires a Docker command runner");
  const byContainer = new Map(config.bindings.map((binding) => [binding.containerName, binding]));
  return async function authenticate(remoteAddress) {
    const address = normalizeAddress(remoteAddress);
    const inspected = await runDocker(["network", "inspect", config.network], { outputLimitBytes: 1024 * 1024 });
    if (inspected.timedOut || inspected.exitCode !== 0) throw new Error("RUNNER_BROKER_NETWORK_INSPECT_FAILED");
    let network;
    try {
      const parsed = JSON.parse(inspected.stdout);
      if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0]?.Name !== config.network) {
        throw new Error("invalid network inspect response");
      }
      [network] = parsed;
    } catch {
      throw new Error("RUNNER_BROKER_NETWORK_INSPECT_INVALID");
    }
    const peers = Object.values(network?.Containers ?? {})
      .filter((entry) => addressFromNetworkEntry(entry) === address);
    if (peers.length !== 1) throw new Error("RUNNER_BROKER_PEER_NOT_UNIQUE");
    const binding = byContainer.get(peers[0].Name);
    if (!binding) throw new Error("RUNNER_BROKER_PEER_UNAUTHORIZED");

    const containerResult = await runDocker(["container", "inspect", binding.containerName], {
      outputLimitBytes: 1024 * 1024,
    });
    if (containerResult.timedOut || containerResult.exitCode !== 0) {
      throw new Error("RUNNER_BROKER_PEER_INSPECT_FAILED");
    }
    let container;
    try {
      const parsed = JSON.parse(containerResult.stdout);
      if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("invalid container inspect response");
      [container] = parsed;
    } catch {
      throw new Error("RUNNER_BROKER_PEER_INSPECT_INVALID");
    }
    const environment = container?.Config?.Env ?? [];
    const workerIdentity = environment.filter((entry) => entry.startsWith("AGENTTEAMS_WORKER_NAME="));
    if (container?.Name !== `/${binding.containerName}` || container?.Image !== binding.workerImageId ||
        container?.State?.Running !== true ||
        container?.NetworkSettings?.Networks?.[config.network]?.IPAddress !== address ||
        workerIdentity.length !== 1 || workerIdentity[0] !== `AGENTTEAMS_WORKER_NAME=${binding.workerName}`) {
      throw new Error("RUNNER_BROKER_PEER_IDENTITY_MISMATCH");
    }
    return binding;
  };
}

async function dockerJson(runDocker, args, code) {
  const result = await runDocker(args, { outputLimitBytes: 1024 * 1024 });
  if (result.timedOut || result.exitCode !== 0) throw new Error(code);
  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error(code);
    return parsed[0];
  } catch {
    throw new Error(code);
  }
}

async function networkInspect(config, runDocker) {
  return dockerJson(runDocker, ["network", "inspect", config.network], "RUNNER_BROKER_NETWORK_INSPECT_FAILED");
}

function networkPeer(network, address) {
  if (typeof address !== "string" || address === "") return [];
  return Object.values(network?.Containers ?? {})
    .filter((entry) => addressFromNetworkEntry(entry) === address);
}

function envValue(container, name) {
  const entries = (container?.Config?.Env ?? []).filter((entry) => entry.startsWith(`${name}=`));
  return entries.length === 1 ? entries[0].slice(name.length + 1) : undefined;
}

async function authenticatePreparationLeader({ config, runDocker, remoteAddress, projectBinding }) {
  const address = normalizeAddress(remoteAddress);
  const network = await networkInspect(config, runDocker);
  const peers = networkPeer(network, address);
  if (peers.length !== 1) throw new Error("RUNNER_BROKER_PREPARATION_PEER_NOT_UNIQUE");
  const expectedName = `${FIXED_WORKER_CONTAINER_PREFIX}${projectBinding.roleBindings.team_leader}`;
  if (peers[0].Name !== expectedName) throw new Error("RUNNER_BROKER_PREPARATION_PEER_UNAUTHORIZED");
  const container = await dockerJson(runDocker, ["container", "inspect", expectedName], "RUNNER_BROKER_PREPARATION_PEER_INSPECT_FAILED");
  const networkEntry = container?.NetworkSettings?.Networks?.[config.network];
  if (container?.Name !== `/${expectedName}` || container?.Image !== config.preparation.leaderImageId ||
      container?.State?.Running !== true || networkEntry?.IPAddress !== address ||
      envValue(container, "AGENTTEAMS_WORKER_NAME") !== projectBinding.roleBindings.team_leader) {
    throw new Error("RUNNER_BROKER_PREPARATION_PEER_IDENTITY_MISMATCH");
  }
  return Object.freeze({ containerName: expectedName, address });
}

async function inspectPreparationWorker({ config, runDocker, workerName }) {
  const containerName = `${FIXED_WORKER_CONTAINER_PREFIX}${workerName}`;
  if (!RESOURCE.test(containerName)) throw new Error("RUNNER_BROKER_WORKER_IDENTITY_INVALID");
  const container = await dockerJson(runDocker, ["container", "inspect", containerName], "RUNNER_BROKER_WORKER_NOT_READY");
  const network = await networkInspect(config, runDocker);
  const networkEntry = container?.NetworkSettings?.Networks?.[config.network];
  const address = networkEntry?.IPAddress;
  const peers = networkPeer(network, address);
  if (container?.Name !== `/${containerName}` || container?.State?.Running !== true ||
      typeof container?.Image !== "string" || !IMAGE.test(container.Image) ||
      envValue(container, "AGENTTEAMS_WORKER_NAME") !== workerName ||
      typeof address !== "string" || address === "" || peers.length !== 1 || peers[0].Name !== containerName) {
    throw new Error("RUNNER_BROKER_WORKER_NOT_READY");
  }
  return Object.freeze({ containerName, workerImageId: container.Image, address });
}

export function createRunnerBrokerPreparationService({ config, registry, runDocker }) {
  const validated = validateBrokerConfig(config);
  if (!validated.preparation || typeof registry?.register !== "function" || typeof registry?.config !== "function" ||
      typeof runDocker !== "function") {
    throw new TypeError("Runner broker preparation requires enabled registry and Docker authority");
  }
  return async function prepare(remoteAddress, value) {
    try {
      exactKeys(value, ["inputTaskBinding", "projectBinding", "schemaVersion", "taskBinding"], "Runner broker preparation request");
      if (value.schemaVersion !== 1 || !isProjectBinding(value.projectBinding) || !isTaskBinding(value.taskBinding)) {
        throw new Error("RUNNER_BROKER_PREPARATION_BINDING_INVALID");
      }
      const projectBinding = value.projectBinding;
      const taskBinding = value.taskBinding;
      const role = taskBinding.taskKind === "implement" ? "implementor"
        : taskBinding.taskKind === "assess" ? "assessor" : undefined;
      if (!role || projectBinding.projectId !== taskBinding.projectId || projectBinding.roleBindings[role] !== taskBinding.assignee) {
        throw new Error("RUNNER_BROKER_PREPARATION_BINDING_INVALID");
      }
      let inputTaskBinding = null;
      if (role === "assessor") {
        inputTaskBinding = value.inputTaskBinding;
        if (!isTaskBinding(inputTaskBinding) || inputTaskBinding.taskKind !== "implement" ||
            inputTaskBinding.projectId !== taskBinding.projectId || inputTaskBinding.revisionIndex !== taskBinding.revisionIndex ||
            !taskBinding.inputRefs.includes(inputTaskBinding.taskId) ||
            projectBinding.roleBindings.implementor !== inputTaskBinding.assignee) {
          throw new Error("RUNNER_BROKER_PREPARATION_INPUT_INVALID");
        }
        const registeredInput = registry.get(inputTaskBinding.taskId);
        if (!registeredInput || registeredInput.role !== "implementor" ||
            registeredInput.runId !== runnerRunIdForTask(inputTaskBinding) ||
            registeredInput.revisionIndex !== inputTaskBinding.revisionIndex) {
          throw new Error("RUNNER_BROKER_PREPARATION_INPUT_NOT_REGISTERED");
        }
      } else if (value.inputTaskBinding !== null) {
        throw new Error("RUNNER_BROKER_PREPARATION_INPUT_INVALID");
      }
      await authenticatePreparationLeader({ config: validated, runDocker, remoteAddress, projectBinding });
      const worker = await inspectPreparationWorker({ config: validated, runDocker, workerName: taskBinding.assignee });
      const binding = {
        workerName: taskBinding.assignee,
        containerName: worker.containerName,
        workerImageId: worker.workerImageId,
        role,
        taskId: taskBinding.taskId,
        runId: runnerRunIdForTask(taskBinding),
        runnerImageId: validated.preparation.runnerImageIds[role],
        execution: {
          command: [...FIXED_PREPARATION_COMMAND],
          timeoutMs: FIXED_PREPARATION_TIMEOUT_MS,
          outputLimitBytes: FIXED_PREPARATION_OUTPUT_LIMIT_BYTES,
        },
        revisionIndex: taskBinding.revisionIndex,
        fixtureId: role === "implementor" ? "isolation" : null,
        inputRevisionTaskId: role === "assessor" ? inputTaskBinding.taskId : null,
      };
      const registration = await registry.register(binding);
      const authenticateWorker = createDockerPeerAuthenticator({ config: registry.config(), runDocker });
      await authenticateWorker(worker.address);
      return {
        schemaVersion: 1,
        status: "ready",
        taskId: taskBinding.taskId,
        taskBindingDigest: taskBinding.contentDigest,
        bindingDigest: runnerBrokerBindingDigest(registration.binding),
        endpointDigest: PREPARATION_ENDPOINT_DIGEST,
        replayed: registration.replayed,
      };
    } catch (error) {
      if (error && typeof error.code !== "string" && typeof error.message === "string" &&
          /^RUNNER_[A-Z0-9_]{1,63}$/u.test(error.message)) error.code = error.message;
      throw error;
    }
  };
}

function planFromBody(value, binding) {
  exactKeys(value, PLAN_REQUEST_KEYS, "Runner broker plan request");
  if (value.schemaVersion !== 1 || value.taskId !== binding.taskId || value.runId !== binding.runId) {
    throw new Error("RUNNER_BROKER_BINDING_MISMATCH");
  }
  return executionPlan(binding);
}

function requestFromBody(value, binding) {
  exactKeys(value, REQUEST_KEYS, "Runner broker request");
  if (value.schemaVersion !== 1 || value.taskId !== binding.taskId || value.runId !== binding.runId) {
    throw new Error("RUNNER_BROKER_BINDING_MISMATCH");
  }
  assertNoForbiddenEnv(value.env);
  const validated = validateCommandRequest(value);
  const expected = executionPlan(binding);
  if (canonicalJson({
    schemaVersion: 1,
    taskId: value.taskId,
    runId: validated.runId,
    command: validated.command,
    cwd: validated.cwd,
    timeoutMs: validated.timeoutMs,
    outputLimitBytes: validated.outputLimitBytes,
  }) !== canonicalJson({
    schemaVersion: expected.schemaVersion,
    taskId: expected.taskId,
    runId: expected.runId,
    command: expected.command,
    cwd: expected.cwd,
    timeoutMs: expected.timeoutMs,
    outputLimitBytes: expected.outputLimitBytes,
  })) {
    throw new Error("RUNNER_BROKER_EXECUTION_PLAN_MISMATCH");
  }
  const identity = runnerInvocationIdentity(validated);
  if (value.invocationKey !== identity.invocationKey) throw new Error("RUNNER_BROKER_INVOCATION_MISMATCH");
  return { ...validated, env: value.env, invocationKey: identity.invocationKey };
}

async function readRequestBody(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("RUNNER_BROKER_REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("RUNNER_BROKER_REQUEST_INVALID");
  }
}

function send(response, statusCode, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

export function createRunnerBrokerHandler({ authenticatePeer, execute, prepare }) {
  if (typeof authenticatePeer !== "function" || typeof execute !== "function" ||
      (prepare !== undefined && typeof prepare !== "function")) {
    throw new TypeError("Runner broker requires peer authentication and execution adapters");
  }
  return async function handle(request, response) {
    let stage = "route";
    try {
      const preparationRoute = request.url === "/v1/prepare" && typeof prepare === "function";
      if (request.method !== "POST" ||
          (!preparationRoute && !["/v1/plan", "/v1/execute"].includes(request.url)) ||
          request.headers["content-type"] !== "application/json") {
        send(response, 404, { error: "RUNNER_BROKER_ROUTE_NOT_FOUND" });
        return;
      }
      const body = await readRequestBody(request);
      if (preparationRoute) {
        stage = "prepare";
        send(response, 200, await prepare(request.socket.remoteAddress, body));
        return;
      }
      stage = "authenticate";
      const binding = await authenticatePeer(request.socket.remoteAddress);
      stage = request.url === "/v1/plan" ? "plan" : "request";
      if (request.url === "/v1/plan") {
        send(response, 200, planFromBody(body, binding));
        return;
      }
      const command = requestFromBody(body, binding);
      stage = "execute";
      const result = await execute(binding, command);
      if (result.outcome === "completed") {
        send(response, 200, {
          status: "completed",
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          runnerEvidence: {
            ...result.runnerEvidence,
            executionPlanDigest: executionPlan(binding).contentDigest,
          },
          ...(result.changeRevisionRef ? { changeRevisionRef: result.changeRevisionRef } : {}),
        });
      } else {
        const reason = typeof result.reason === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(result.reason)
          ? result.reason
          : "UNKNOWN";
        process.stderr.write(`runner_broker_execution_uncertain reason=${reason}\n`);
        if (reason === "RUNNER_COMMAND_INTERRUPTED") send(response, 200, { status: "interrupted" });
        else send(response, 503, { error: "RUNNER_BROKER_OUTCOME_UNCERTAIN" });
      }
    } catch (error) {
      const code = typeof error?.code === "string" && /^RUNNER_[A-Z0-9_]{1,63}$/u.test(error.code)
        ? error.code
        : "RUNNER_BROKER_REQUEST_REJECTED";
      process.stderr.write(`runner_broker_request_failed stage=${stage} code=${code}\n`);
      if (!response.headersSent) send(response, 403, { error: "RUNNER_BROKER_REQUEST_REJECTED" });
      else response.destroy();
    }
  };
}

export function createBrokerExecutionAdapter({ fixtureRoot, stateRoot, runDocker }) {
  const fixtures = resolve(fixtureRoot);
  const state = resolve(stateRoot);
  const journals = new Map();
  const revisionStore = new ChangeRevisionStore({ rootDir: join(state, REVISION_ROOT_NAME), runDocker });
  return async function execute(binding, request) {
    const id = bindingId(binding);
    let journal = journals.get(id);
    if (!journal) {
      journal = new RunnerJournal({ filePath: join(state, "journals", `${id}.jsonl`) });
      journals.set(id, journal);
    }

    let fixtureDirectory;
    let executor;
    if (binding.role === "implementor") {
      fixtureDirectory = resolve(fixtures, binding.fixtureId);
      if (fixtureDirectory !== join(fixtures, binding.fixtureId) ||
          (!fixtureDirectory.startsWith(`${fixtures}${sep}`))) {
        throw new Error("RUNNER_BROKER_FIXTURE_ESCAPE");
      }
      await revisionStore.assertAvailable(binding.taskId, request.invocationKey);
      executor = createDisposableDockerExecutor({
        imageId: binding.runnerImageId,
        fixtureSource: fixtureDirectory,
        executionMode: "capture-revision",
        captureRevision: ({ containerName, invocationKey }) => revisionStore.capture({
          containerName,
          producerTaskId: binding.taskId,
          revision: binding.revisionIndex,
          invocationKey,
        }),
        runDocker,
      });
    } else {
      const materialized = await revisionStore.lookup(binding.inputRevisionTaskId);
      if (!materialized || materialized.ref.revision !== binding.revisionIndex) {
        throw new Error("RUNNER_BROKER_REVISION_UNAVAILABLE");
      }
      fixtureDirectory = materialized.directory;
      executor = createDisposableDockerExecutor({
        imageId: binding.runnerImageId,
        fixtureSource: fixtureDirectory,
        inputChangeRevisionRef: materialized.ref,
        runDocker,
      });
    }
    const executeDisposable = executor;
    executor = async (runnerRequest) => {
      const result = await executeDisposable(runnerRequest);
      if (result?.status !== "completed") return result;
      return {
        ...result,
        runnerEvidence: {
          ...result.runnerEvidence,
          executionPlanDigest: executionPlan(binding).contentDigest,
        },
      };
    };
    return runCommand(request, { executor, journal, env: request.env });
  };
}

export async function startRunnerBroker({
  configPath = CONFIG_PATH,
  fixtureRoot = FIXTURE_ROOT,
  stateRoot = STATE_ROOT,
  dockerPath = DOCKER_PATH,
} = {}) {
  const config = validateBrokerConfig(await readBoundedJson(configPath));
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const runDocker = createDockerCommandRunner({ dockerPath });
  const registry = await createRunnerBrokerBindingRegistry({ config, stateRoot });
  const authenticatePeer = async (remoteAddress) => createDockerPeerAuthenticator({
    config: registry.config(),
    runDocker,
  })(remoteAddress);
  const execute = createBrokerExecutionAdapter({ fixtureRoot, stateRoot, runDocker });
  const prepare = config.preparation
    ? createRunnerBrokerPreparationService({ config, registry, runDocker })
    : undefined;
  const server = createServer(createRunnerBrokerHandler({ authenticatePeer, execute, prepare }));
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(config.listenPort, "0.0.0.0", () => {
      server.off("error", reject);
      resolveReady();
    });
  });
  return { server, config, registry };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { server, config } = await startRunnerBroker();
  process.stdout.write(`runner_broker_ready=pass port=${config.listenPort}\n`);
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

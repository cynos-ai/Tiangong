import { createServer } from "node:http";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "../canonical-json.mjs";
import { createDisposableDockerExecutor, createDockerCommandRunner } from "./docker-executor.mjs";
import { RunnerJournal } from "./journal.mjs";
import { assertNoForbiddenEnv, validateCommandRequest } from "./runner-policy.mjs";
import { ChangeRevisionStore } from "./revision-store.mjs";
import { runCommand, runnerInvocationIdentity } from "./runner-port.mjs";

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
const BINDING_KEYS = [
  "containerName", "fixtureId", "inputRevisionTaskId", "revisionIndex", "role", "runId", "runnerImageId",
  "taskId", "workerImageId", "workerName",
];

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

function bindingId(binding) {
  return sha256({
    workerName: binding.workerName,
    role: binding.role,
    taskId: binding.taskId,
    runId: binding.runId,
    runnerImageId: binding.runnerImageId,
  });
}

export function validateBrokerConfig(value) {
  exactKeys(value, CONFIG_KEYS, "Runner broker config");
  if (value.schemaVersion !== 1 || !NETWORK.test(value.network) ||
      !Number.isInteger(value.listenPort) || value.listenPort < 1 || value.listenPort > 65535 ||
      !Array.isArray(value.bindings) || value.bindings.length === 0 || value.bindings.length > 32) {
    throw new Error("Runner broker config is invalid");
  }
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
  });
}

async function readBoundedJson(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || metadata.size > MAX_CONFIG_BYTES) {
    throw new Error("Runner broker config must be a bounded regular file");
  }
  return JSON.parse(await readFile(filePath, "utf8"));
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

function requestFromBody(value, binding) {
  exactKeys(value, REQUEST_KEYS, "Runner broker request");
  if (value.schemaVersion !== 1 || value.taskId !== binding.taskId || value.runId !== binding.runId) {
    throw new Error("RUNNER_BROKER_BINDING_MISMATCH");
  }
  assertNoForbiddenEnv(value.env);
  const validated = validateCommandRequest(value);
  const expectedCwd = binding.role === "implementor" ? "scratch/revision" : "fixture";
  if (validated.cwd !== expectedCwd) throw new Error("RUNNER_BROKER_WORKDIR_MISMATCH");
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

export function createRunnerBrokerHandler({ authenticatePeer, execute }) {
  if (typeof authenticatePeer !== "function" || typeof execute !== "function") {
    throw new TypeError("Runner broker requires peer authentication and execution adapters");
  }
  return async function handle(request, response) {
    let stage = "route";
    try {
      if (request.method !== "POST" || request.url !== "/v1/execute" ||
          request.headers["content-type"] !== "application/json") {
        send(response, 404, { error: "RUNNER_BROKER_ROUTE_NOT_FOUND" });
        return;
      }
      stage = "authenticate";
      const binding = await authenticatePeer(request.socket.remoteAddress);
      stage = "request";
      const body = await readRequestBody(request);
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
          runnerEvidence: result.runnerEvidence,
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
  const authenticatePeer = createDockerPeerAuthenticator({ config, runDocker });
  const execute = createBrokerExecutionAdapter({ fixtureRoot, stateRoot, runDocker });
  const server = createServer(createRunnerBrokerHandler({ authenticatePeer, execute }));
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(config.listenPort, "0.0.0.0", () => {
      server.off("error", reject);
      resolveReady();
    });
  });
  return { server, config };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { server, config } = await startRunnerBroker();
  process.stdout.write(`runner_broker_ready=pass port=${config.listenPort}\n`);
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

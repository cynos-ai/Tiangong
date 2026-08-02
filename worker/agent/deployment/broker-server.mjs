import { createServer } from "node:http";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../canonical-json.mjs";
import { createDockerCommandRunner } from "../runner/docker-executor.mjs";
import { createDockerPeerAuthenticator } from "../runner/broker-server.mjs";
import { createChangeRevisionRef } from "../work/change-revision-ref.mjs";
import { createDeploymentOutcome, isDeploymentOutcome } from "./client.mjs";

const CONFIG_PATH = "/run/tiangong-deployment-broker/config.json";
const DOCKER_PATH = "/usr/local/bin/docker";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_TARGET_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RESOURCE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/u;
const IMAGE = /^sha256:[0-9a-f]{64}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const CAPABILITY = /^[A-Za-z0-9._~-]{32,256}$/u;
const CONFIG_KEYS = ["bindings", "listenPort", "network", "schemaVersion"];
const BINDING_KEYS = ["changeRevisionRef", "containerName", "previousDigest", "targetCapability", "targetEndpoint", "targetId", "taskId", "workerImageId", "workerName"];

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}
function demand(value, pattern, label) { if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`); return value; }
function targetEndpoint(value) {
  let url; try { url = new URL(value); } catch { throw new Error("targetEndpoint is invalid"); }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || url.pathname !== "" && url.pathname !== "/" || !RESOURCE.test(url.hostname) || !url.port) {
    throw new Error("targetEndpoint must be a credential-free internal HTTP origin");
  }
  return url.origin;
}

export function validateDeploymentBrokerConfig(value) {
  exact(value, CONFIG_KEYS, "Deployment broker config");
  if (value.schemaVersion !== 1 || !NETWORK.test(value.network) || !Number.isInteger(value.listenPort) || value.listenPort < 1 || value.listenPort > 65535 ||
      !Array.isArray(value.bindings) || value.bindings.length === 0 || value.bindings.length > 16) throw new Error("Deployment broker config is invalid");
  const workers = new Set(); const containers = new Set(); const tasks = new Set();
  const bindings = value.bindings.map((entry) => {
    exact(entry, BINDING_KEYS, "Deployment broker binding");
    const binding = Object.freeze({
      workerName: demand(entry.workerName, RESOURCE, "workerName"), containerName: demand(entry.containerName, RESOURCE, "containerName"),
      workerImageId: demand(entry.workerImageId, IMAGE, "workerImageId"), taskId: demand(entry.taskId, ID, "taskId"),
      changeRevisionRef: createChangeRevisionRef(entry.changeRevisionRef), targetId: demand(entry.targetId, ID, "targetId"),
      previousDigest: demand(entry.previousDigest, DIGEST, "previousDigest"), targetEndpoint: targetEndpoint(entry.targetEndpoint),
      targetCapability: demand(entry.targetCapability, CAPABILITY, "targetCapability"), role: "operator",
    });
    if (workers.has(binding.workerName) || containers.has(binding.containerName) || tasks.has(binding.taskId)) throw new Error("Deployment broker bindings must be unique");
    workers.add(binding.workerName); containers.add(binding.containerName); tasks.add(binding.taskId); return binding;
  });
  return Object.freeze({ schemaVersion: 1, network: value.network, listenPort: value.listenPort, bindings: Object.freeze(bindings) });
}

async function readBoundedJson(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || metadata.size > MAX_CONFIG_BYTES || (metadata.mode & 0o077) !== 0) {
    throw new Error("Deployment broker config must be a bounded owner-only regular file");
  }
  return JSON.parse(await readFile(path, "utf8"));
}
async function body(request) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.byteLength; if (bytes > MAX_REQUEST_BYTES) throw new Error("DEPLOYMENT_BROKER_REQUEST_TOO_LARGE"); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("DEPLOYMENT_BROKER_REQUEST_INVALID"); }
}
async function bounded(response) {
  if (!response?.body || typeof response.body[Symbol.asyncIterator] !== "function") throw new Error("DEPLOYMENT_TARGET_RESPONSE_INVALID");
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { const part = Buffer.from(chunk); bytes += part.byteLength; if (bytes > MAX_TARGET_BYTES) throw new Error("DEPLOYMENT_TARGET_RESPONSE_TOO_LARGE"); chunks.push(part); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("DEPLOYMENT_TARGET_RESPONSE_INVALID"); }
}
function send(response, status, value) { const text = `${JSON.stringify(value)}\n`; response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" }); response.end(text); }

export function createDeploymentTargetClient({ endpoint, capability, fetchImpl = globalThis.fetch }) {
  return async function call(path, requestBody) {
    const response = await fetchImpl(`${endpoint}${path}`, {
      method: requestBody === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${capability}`, ...(requestBody === undefined ? {} : { "content-type": "application/json" }) },
      ...(requestBody === undefined ? {} : { body: canonicalJson(requestBody) }),
    });
    if (!response || response.status !== 200) throw new Error("DEPLOYMENT_TARGET_REQUEST_REJECTED");
    return bounded(response);
  };
}

export function createDeploymentBrokerExecutor({ fetchImpl = globalThis.fetch } = {}) {
  return async function execute(binding, request) {
    const call = createDeploymentTargetClient({ endpoint: binding.targetEndpoint, capability: binding.targetCapability, fetchImpl });
    const operationId = `deploy-${request.actionDigest.slice(0, 48)}`;
    const status = (await call("/v1/status")).status;
    if (status.targetId !== binding.targetId || ![binding.previousDigest, binding.changeRevisionRef.artifactDigest].includes(status.currentDigest)) {
      throw new Error("DEPLOYMENT_TARGET_PRECONDITION_MISMATCH");
    }
    const staged = await call("/v1/stage", { operationId, artifactDigest: binding.changeRevisionRef.artifactDigest, expectedCurrentDigest: binding.previousDigest, rollbackDigest: binding.previousDigest });
    const activated = await call("/v1/activate", { operationId });
    const verified = await call("/v1/verify", { operationId, phase: "post_deploy", expectedDigest: binding.changeRevisionRef.artifactDigest });
    const post = verified.event;
    let disposition = "DELIVERED"; let rollbackPerformed = false; let previousVerifyHealthy = null; let currentDigest = post.currentDigest;
    if (!post.healthy) {
      disposition = "RECOVERY_REQUIRED";
      try {
        const rollback = (await call("/v1/rollback", { operationId })).event;
        rollbackPerformed = true; currentDigest = rollback.toDigest;
        const previous = (await call("/v1/verify", { operationId, phase: "previous", expectedDigest: binding.previousDigest })).event;
        previousVerifyHealthy = previous.healthy;
        if (previous.healthy) disposition = "FAILED_SAFE";
      } catch { /* Recovery-required is the only safe claim after a failed rollback path. */ }
    }
    return {
      outcome: createDeploymentOutcome({ taskId: binding.taskId, targetId: binding.targetId, operationDigest: request.actionDigest,
        previousDigest: binding.previousDigest, currentDigest, changeRevisionRef: binding.changeRevisionRef, disposition,
        postVerifyHealthy: post.healthy, rollbackPerformed, previousVerifyHealthy }),
      replayed: staged.replayed === true && activated.replayed === true && verified.replayed === true,
    };
  };
}

function isDeploymentExecutionResult(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === ["outcome", "replayed"].sort().join("\n") &&
    typeof value.replayed === "boolean" && isDeploymentOutcome(value.outcome);
}

export function createDeploymentBrokerHandler({ authenticatePeer, execute }) {
  return async function handle(request, response) {
    try {
      if (request.method !== "POST" || !["/v1/plan", "/v1/deploy"].includes(request.url) || request.headers["content-type"] !== "application/json") { send(response, 404, { error: "DEPLOYMENT_BROKER_ROUTE_NOT_FOUND" }); return; }
      const binding = await authenticatePeer(request.socket.remoteAddress);
      const value = await body(request);
      const requestKeys = request.url === "/v1/plan"
        ? ["changeRevisionRef", "schemaVersion", "taskId"]
        : ["actionDigest", "changeRevisionRef", "schemaVersion", "taskId"];
      exact(value, requestKeys, "Deployment request");
      if (value.schemaVersion !== 1 || value.taskId !== binding.taskId ||
          (request.url === "/v1/deploy" && !DIGEST.test(value.actionDigest ?? "")) ||
          canonicalJson(createChangeRevisionRef(value.changeRevisionRef)) !== canonicalJson(binding.changeRevisionRef)) throw new Error("DEPLOYMENT_BROKER_BINDING_MISMATCH");
      if (request.url === "/v1/plan") {
        send(response, 200, { targetId: binding.targetId, previousDigest: binding.previousDigest, changeRevisionRef: binding.changeRevisionRef });
        return;
      }
      const result = await execute(binding, value);
      if (!result || !isDeploymentExecutionResult(result)) throw new Error("DEPLOYMENT_BROKER_RESULT_INVALID");
      send(response, 200, result);
    } catch {
      process.stderr.write("deployment_broker_request_rejected\n");
      if (!response.headersSent) send(response, 503, { error: "DEPLOYMENT_BROKER_REQUEST_REJECTED" }); else response.destroy();
    }
  };
}

export async function startDeploymentBroker({ configPath = CONFIG_PATH, dockerPath = DOCKER_PATH } = {}) {
  const config = validateDeploymentBrokerConfig(await readBoundedJson(configPath));
  const runDocker = createDockerCommandRunner({ dockerPath });
  const authenticatePeer = createDockerPeerAuthenticator({ config, runDocker });
  const server = createServer(createDeploymentBrokerHandler({ authenticatePeer, execute: createDeploymentBrokerExecutor() }));
  await new Promise((ready, reject) => { server.once("error", reject); server.listen(config.listenPort, "0.0.0.0", () => { server.off("error", reject); ready(); }); });
  return { server, config };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { server, config } = await startDeploymentBroker();
  process.stdout.write(`deployment_broker_ready=pass port=${config.listenPort}\n`);
  const stop = () => server.close(() => process.exit(0)); process.once("SIGTERM", stop); process.once("SIGINT", stop);
}

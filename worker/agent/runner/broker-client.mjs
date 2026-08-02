import { canonicalJson } from "../canonical-json.mjs";
import { MAX_OUTPUT_BYTES, assertNoForbiddenEnv, validateCommandRequest } from "./runner-policy.mjs";

const ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/u;
const MAX_RESPONSE_BYTES = (MAX_OUTPUT_BYTES * 2) + (256 * 1024);

function validateEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("Runner broker endpoint must be an absolute URL");
  }
  if (endpoint.protocol !== "http:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.pathname !== "/v1/execute" || !HOST.test(endpoint.hostname)) {
    throw new Error("Runner broker endpoint must be a credential-free internal HTTP /v1/execute URL");
  }
  return endpoint.toString();
}

function validateTaskId(value) {
  if (typeof value !== "string" || !ID.test(value)) throw new TypeError("taskId has an invalid format");
  return value;
}

async function readBoundedResponse(response) {
  if (!response.body || typeof response.body[Symbol.asyncIterator] !== "function") {
    throw new Error("RUNNER_BROKER_RESPONSE_INVALID");
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) throw new Error("RUNNER_BROKER_RESPONSE_TOO_LARGE");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validateResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("RUNNER_BROKER_RESPONSE_INVALID");
  }
  const allowed = value.status === "completed"
    ? new Set(["status", "exitCode", "stdout", "stderr", "durationMs", "runnerEvidence"])
    : new Set(["status"]);
  if ([...Object.keys(value)].some((key) => !allowed.has(key)) ||
      !["completed", "interrupted"].includes(value.status) ||
      (value.status === "completed" && (
        !Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255 ||
        typeof value.stdout !== "string" || typeof value.stderr !== "string" ||
        !Number.isSafeInteger(value.durationMs) || value.durationMs < 0 ||
        !value.runnerEvidence || typeof value.runnerEvidence !== "object" || Array.isArray(value.runnerEvidence)
      ))) {
    throw new Error("RUNNER_BROKER_RESPONSE_INVALID");
  }
  return value;
}

export function createRunnerBrokerExecutor({ endpoint, taskId, fetchImpl = globalThis.fetch } = {}) {
  const brokerEndpoint = validateEndpoint(endpoint);
  const boundTaskId = validateTaskId(taskId);
  if (typeof fetchImpl !== "function") throw new TypeError("Runner broker client requires fetch");

  return async function executeThroughBroker(request) {
    const validated = validateCommandRequest(request);
    if (typeof request.invocationKey !== "string" || !/^[0-9a-f]{64}$/u.test(request.invocationKey)) {
      throw new Error("Runner broker request requires an invocation key");
    }
    assertNoForbiddenEnv(request.env);
    const body = canonicalJson({
      schemaVersion: 1,
      taskId: boundTaskId,
      invocationKey: request.invocationKey,
      runId: validated.runId,
      command: validated.command,
      cwd: validated.cwd,
      timeoutMs: validated.timeoutMs,
      outputLimitBytes: validated.outputLimitBytes,
      env: request.env,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), validated.timeoutMs + 30_000);
    timer.unref?.();
    let response;
    try {
      response = await fetchImpl(brokerEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response || response.status !== 200) throw new Error("RUNNER_BROKER_REQUEST_REJECTED");
    const text = await readBoundedResponse(response);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("RUNNER_BROKER_RESPONSE_INVALID");
    }
    return validateResponse(parsed);
  };
}

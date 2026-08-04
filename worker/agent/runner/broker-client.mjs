import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { isChangeRevisionRef } from "../work/change-revision-ref.mjs";
import { MAX_OUTPUT_BYTES, assertNoForbiddenEnv, validateCommandRequest } from "./runner-policy.mjs";

const ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/u;
const BROKER_ROLES = new Set(["implementor", "assessor"]);
const RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const PLAN_KEYS = ["command", "contentDigest", "cwd", "outputLimitBytes", "runId", "schemaVersion", "taskId", "timeoutMs"];
const MAX_RESPONSE_BYTES = (MAX_OUTPUT_BYTES * 2) + (256 * 1024);
export const DEFAULT_AGENTTEAMS_RUNNER_BROKER_ENDPOINT = "http://tiangong-runner-broker:8787/v1/execute";

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

export function runnerBrokerEndpointForWorker({ role, env = process.env } = {}) {
  if (!BROKER_ROLES.has(role)) return undefined;
  const configured = env.TIANGONG_RUNNER_BROKER_ENDPOINT;
  if (configured !== undefined) {
    if (typeof configured !== "string" || configured === "") {
      throw new Error("Configured Runner broker endpoint is empty");
    }
    return validateEndpoint(configured);
  }
  if (typeof env.AGENTTEAMS_WORKER_NAME !== "string" || env.AGENTTEAMS_WORKER_NAME === "") {
    return undefined;
  }
  return DEFAULT_AGENTTEAMS_RUNNER_BROKER_ENDPOINT;
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

function validatePlan(value, { taskId, runId }) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\n") !== [...PLAN_KEYS].sort().join("\n") ||
      value.schemaVersion !== 1 || value.taskId !== taskId || value.runId !== runId || !DIGEST.test(value.contentDigest)) {
    throw new Error("RUNNER_BROKER_PLAN_INVALID");
  }
  const execution = validateCommandRequest({
    runId: value.runId,
    command: value.command,
    cwd: value.cwd,
    timeoutMs: value.timeoutMs,
    outputLimitBytes: value.outputLimitBytes,
  });
  const base = {
    schemaVersion: 1,
    taskId: value.taskId,
    runId: execution.runId,
    command: execution.command,
    cwd: execution.cwd,
    timeoutMs: execution.timeoutMs,
    outputLimitBytes: execution.outputLimitBytes,
  };
  if (sha256(canonicalJson(base)) !== value.contentDigest) throw new Error("RUNNER_BROKER_PLAN_INVALID");
  return Object.freeze({ ...base, contentDigest: value.contentDigest });
}

function validateResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("RUNNER_BROKER_RESPONSE_INVALID");
  }
  const allowed = value.status === "completed"
    ? new Set(["status", "exitCode", "stdout", "stderr", "durationMs", "runnerEvidence", "changeRevisionRef"])
    : new Set(["status"]);
  if ([...Object.keys(value)].some((key) => !allowed.has(key)) ||
      !["completed", "interrupted"].includes(value.status) ||
      (value.status === "completed" && (
        !Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255 ||
        typeof value.stdout !== "string" || typeof value.stderr !== "string" ||
        !Number.isSafeInteger(value.durationMs) || value.durationMs < 0 ||
        !value.runnerEvidence || typeof value.runnerEvidence !== "object" || Array.isArray(value.runnerEvidence) ||
        (value.changeRevisionRef !== undefined && !isChangeRevisionRef(value.changeRevisionRef))
      ))) {
    throw new Error("RUNNER_BROKER_RESPONSE_INVALID");
  }
  return value;
}

export function createRunnerBrokerExecutor({ endpoint, taskId, fetchImpl = globalThis.fetch } = {}) {
  const brokerEndpoint = validateEndpoint(endpoint);
  const planEndpoint = new URL(brokerEndpoint);
  planEndpoint.pathname = "/v1/plan";
  const boundTaskId = validateTaskId(taskId);
  if (typeof fetchImpl !== "function") throw new TypeError("Runner broker client requires fetch");
  let boundPlan;

  async function post(url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    timer.unref?.();
    let text;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: canonicalJson(body),
        signal: controller.signal,
      });
      if (!response || response.status !== 200) throw new Error("RUNNER_BROKER_REQUEST_REJECTED");
      text = await readBoundedResponse(response);
    } finally {
      clearTimeout(timer);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("RUNNER_BROKER_RESPONSE_INVALID");
    }
  }

  async function plan({ runId } = {}) {
    if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error("Runner broker plan requires a run-scoped uuid");
    const received = validatePlan(await post(planEndpoint, { schemaVersion: 1, taskId: boundTaskId, runId }), {
      taskId: boundTaskId,
      runId,
    });
    if (boundPlan && canonicalJson(boundPlan) !== canonicalJson(received)) {
      throw new Error("RUNNER_BROKER_PLAN_CHANGED");
    }
    boundPlan = received;
    return received;
  }

  async function executeThroughBroker(request) {
    const validated = validateCommandRequest(request);
    if (!boundPlan || canonicalJson({
      runId: validated.runId,
      command: validated.command,
      cwd: validated.cwd,
      timeoutMs: validated.timeoutMs,
      outputLimitBytes: validated.outputLimitBytes,
    }) !== canonicalJson({
      runId: boundPlan.runId,
      command: boundPlan.command,
      cwd: boundPlan.cwd,
      timeoutMs: boundPlan.timeoutMs,
      outputLimitBytes: boundPlan.outputLimitBytes,
    })) {
      throw new Error("RUNNER_BROKER_PLAN_REQUIRED");
    }
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
    let text;
    try {
      const response = await fetchImpl(brokerEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (!response || response.status !== 200) throw new Error("RUNNER_BROKER_REQUEST_REJECTED");
      text = await readBoundedResponse(response);
    } finally {
      clearTimeout(timer);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("RUNNER_BROKER_RESPONSE_INVALID");
    }
    const result = validateResponse(parsed);
    if (result.status === "completed" && result.runnerEvidence?.executionPlanDigest !== boundPlan.contentDigest) {
      throw new Error("RUNNER_BROKER_PLAN_EVIDENCE_MISMATCH");
    }
    return result;
  }
  executeThroughBroker.plan = plan;
  return executeThroughBroker;
}

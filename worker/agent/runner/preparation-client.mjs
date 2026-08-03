import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { isProjectBinding, isTaskBinding } from "../team/manifest.mjs";
import { DEFAULT_AGENTTEAMS_RUNNER_BROKER_ENDPOINT } from "./broker-client.mjs";

const DIGEST = /^[0-9a-f]{64}$/u;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/u;
const MAX_RESPONSE_BYTES = 64 * 1024;
const PREPARATION_ROLES = new Set(["implement", "assess"]);
const REQUEST_KEYS = ["inputTaskBinding", "projectBinding", "schemaVersion", "taskBinding"];
const RESPONSE_KEYS = [
  "bindingDigest",
  "endpointDigest",
  "replayed",
  "schemaVersion",
  "status",
  "taskBindingDigest",
  "taskId",
];

export const DEFAULT_AGENTTEAMS_RUNNER_BROKER_PREPARATION_ENDPOINT =
  "http://tiangong-runner-broker:8787/v1/prepare";
export const RUNNER_BROKER_ENDPOINT_DIGEST = sha256(DEFAULT_AGENTTEAMS_RUNNER_BROKER_ENDPOINT);

function preparationEndpoint(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Runner broker preparation endpoint must be an absolute URL");
  }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== "/v1/prepare" || !HOST.test(parsed.hostname)) {
    throw new Error("Runner broker preparation endpoint must be a credential-free internal HTTP /v1/prepare URL");
  }
  return parsed.toString();
}

function errorWithCode(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function validBindingInput({ projectBinding, taskBinding, inputTaskBinding }) {
  if (!isProjectBinding(projectBinding) || !isTaskBinding(taskBinding)) {
    throw errorWithCode("RUNNER_BROKER_PREPARATION_BINDING_INVALID");
  }
  if (!PREPARATION_ROLES.has(taskBinding.taskKind) || taskBinding.projectId !== projectBinding.projectId) {
    throw errorWithCode("RUNNER_BROKER_PREPARATION_BINDING_INVALID");
  }
  if (taskBinding.taskKind === "implement") {
    if (inputTaskBinding !== null && inputTaskBinding !== undefined) {
      throw errorWithCode("RUNNER_BROKER_PREPARATION_INPUT_INVALID");
    }
    return { projectBinding, taskBinding, inputTaskBinding: null };
  }
  if (!isTaskBinding(inputTaskBinding) || inputTaskBinding.taskKind !== "implement" ||
      inputTaskBinding.projectId !== taskBinding.projectId ||
      inputTaskBinding.revisionIndex !== taskBinding.revisionIndex ||
      !taskBinding.inputRefs.includes(inputTaskBinding.taskId)) {
    throw errorWithCode("RUNNER_BROKER_PREPARATION_INPUT_INVALID");
  }
  return { projectBinding, taskBinding, inputTaskBinding };
}

async function readBoundedResponse(response) {
  if (!response?.body || typeof response.body[Symbol.asyncIterator] !== "function") {
    throw errorWithCode("RUNNER_BROKER_PREPARATION_RESPONSE_INVALID");
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) throw errorWithCode("RUNNER_BROKER_PREPARATION_RESPONSE_TOO_LARGE");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw errorWithCode("RUNNER_BROKER_PREPARATION_RESPONSE_INVALID");
  }
}

function validateReceipt(value, taskBinding) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\n") !== [...RESPONSE_KEYS].sort().join("\n") ||
      value.schemaVersion !== 1 || value.status !== "ready" || value.taskId !== taskBinding.taskId ||
      value.taskBindingDigest !== taskBinding.contentDigest || !DIGEST.test(value.bindingDigest ?? "") ||
      value.endpointDigest !== RUNNER_BROKER_ENDPOINT_DIGEST || typeof value.replayed !== "boolean") {
    throw errorWithCode("RUNNER_BROKER_PREPARATION_RESPONSE_INVALID");
  }
  return Object.freeze({ ...value });
}

export function createRunnerBrokerPreparationClient({
  endpoint = DEFAULT_AGENTTEAMS_RUNNER_BROKER_PREPARATION_ENDPOINT,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
} = {}) {
  const preparationUrl = preparationEndpoint(endpoint);
  if (typeof fetchImpl !== "function") throw new TypeError("Runner broker preparation requires fetch");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError("Runner broker preparation timeout is outside the bounded contract");
  }

  return Object.freeze({
    async prepare(input) {
      const normalized = validBindingInput(input ?? {});
      const body = {
        schemaVersion: 1,
        projectBinding: normalized.projectBinding,
        taskBinding: normalized.taskBinding,
        inputTaskBinding: normalized.inputTaskBinding,
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      let response;
      try {
        response = await fetchImpl(preparationUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: canonicalJson(body),
          signal: controller.signal,
        });
      } catch (cause) {
        throw errorWithCode(cause?.name === "AbortError"
          ? "RUNNER_BROKER_PREPARATION_TIMEOUT"
          : "RUNNER_BROKER_PREPARATION_NETWORK_ERROR", cause);
      } finally {
        clearTimeout(timer);
      }
      if (!response || response.status !== 200) {
        throw errorWithCode("RUNNER_BROKER_PREPARATION_REJECTED");
      }
      return validateReceipt(await readBoundedResponse(response), normalized.taskBinding);
    },
  });
}

export function validateRunnerPreparationReceipt(value, taskBinding) {
  if (!isTaskBinding(taskBinding)) throw new TypeError("Runner preparation receipt requires a valid Task binding");
  return validateReceipt(value, taskBinding);
}

export function runnerPreparationFailureCode(error) {
  const codes = new Set([
    "RUNNER_BROKER_BINDING_CONFLICT",
    "RUNNER_BROKER_PREPARATION_BINDING_INVALID",
    "RUNNER_BROKER_PREPARATION_INPUT_INVALID",
    "RUNNER_BROKER_PREPARATION_INPUT_NOT_REGISTERED",
    "RUNNER_BROKER_PREPARATION_NETWORK_ERROR",
    "RUNNER_BROKER_PREPARATION_REJECTED",
    "RUNNER_BROKER_PREPARATION_RESPONSE_INVALID",
    "RUNNER_BROKER_PREPARATION_RESPONSE_TOO_LARGE",
    "RUNNER_BROKER_PREPARATION_TIMEOUT",
    "RUNNER_BROKER_WORKER_NOT_READY",
  ]);
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.cause) {
    if (codes.has(current.code)) return current.code;
    if (current.name === "AbortError") return "RUNNER_BROKER_PREPARATION_TIMEOUT";
  }
  return "RUNNER_BROKER_PREPARATION_NETWORK_ERROR";
}

export { preparationEndpoint as validateRunnerPreparationEndpoint };
// RunnerPort policy: the structured command contract and the credential /
// control-plane isolation declaration for the demo-unsafe disposable runner.
//
// Implementor/Assessor arbitrary commands must run inside a run-owned
// disposable runner that only mounts the fixture/scratch, never host config,
// credentials, or the container-runtime socket, and cannot reach the
// AgentTeams/Matrix/Gateway/storage/Collector control planes. This module
// defines and validates that contract deterministically. It is not isolation
// by itself: no production executor is active until a disposable-container
// adapter proves mounts, credentials, ownership, and network boundaries in the
// real stack. cwd is only an initial directory, not a path-isolation policy.

const RUN_ID_PATTERN = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RELATIVE_CWD_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$/u;

const MAX_COMMAND_ARGS = 64;
const MAX_ARG_BYTES = 8192;
const MAX_TOTAL_COMMAND_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

// Host paths and the container-runtime socket a disposable runner must NOT mount.
export const FORBIDDEN_MOUNT_SOURCES = Object.freeze([
  "/var/run/docker.sock",
  "/run/containerd",
  "/run/agentteams",
  "/run/hiclaw",
  "/etc",
  "/root",
  "/home",
]);

// Network destinations a disposable runner must NOT reach (control planes).
export const FORBIDDEN_NETWORK_TARGETS = Object.freeze([
  "agentteams-controller",
  "agentteams-manager",
  "agentteams-net",
  "fs-local.agentteams.io",
  "aigw-local.agentteams.io",
  "matrix-local.agentteams.io",
]);

// Environment keys that must never be present in a disposable runner.
export const FORBIDDEN_ENV_KEYS = Object.freeze([
  "AGENTTEAMS_LLM_API_KEY",
  "AGENTTEAMS_AUTH_TOKEN",
  "AGENTTEAMS_ADMIN_PASSWORD",
  "AGENTTEAMS_LLM_API_KEY_FILE",
  "DASHSCOPE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ARMS_KEY",
  "OTEL_EXPORTER_OTLP_HEADERS",
]);

const SECRET_VALUE_HINTS = /(?:sk-[A-Za-z0-9]{12,}|Bearer\s+\S|-----BEGIN|[A-Za-z0-9_-]{40,})/u;

export function validateCommandRequest(input) {
  if (input === null || typeof input !== "object") {
    throw new TypeError("command request must be an object");
  }
  if (!RUN_ID_PATTERN.test(input.runId)) {
    throw new Error("runId must be a run-scoped uuid");
  }
  if (!Array.isArray(input.command) || input.command.length === 0) {
    throw new TypeError("command must be a non-empty string array");
  }
  if (input.command.length > MAX_COMMAND_ARGS) {
    throw new Error("command exceeds the maximum number of arguments");
  }
  let total = 0;
  for (const arg of input.command) {
    if (typeof arg !== "string" || arg === "") {
      throw new TypeError("command arguments must be non-empty strings");
    }
    const bytes = Buffer.byteLength(arg);
    if (bytes > MAX_ARG_BYTES) throw new Error("command argument exceeds the maximum length");
    total += bytes;
  }
  if (total > MAX_TOTAL_COMMAND_BYTES) {
    throw new Error("command exceeds the maximum total length");
  }
  const cwd = input.cwd ?? ".";
  if (typeof cwd !== "string" || cwd === "" || cwd.startsWith("/") || cwd.includes("..")) {
    throw new Error("cwd must be a relative path inside the runner workspace");
  }
  if (!RELATIVE_CWD_PATTERN.test(cwd)) {
    throw new Error("cwd has an invalid format");
  }
  const timeoutMs = input.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("timeoutMs must be a positive integer within the runner limit");
  }
  const outputLimitBytes = input.outputLimitBytes ?? MAX_OUTPUT_BYTES;
  if (!Number.isInteger(outputLimitBytes) || outputLimitBytes <= 0 || outputLimitBytes > MAX_OUTPUT_BYTES) {
    throw new Error("outputLimitBytes must be a positive integer within the runner limit");
  }
  return Object.freeze({
    runId: input.runId,
    command: Object.freeze([...input.command]),
    cwd,
    timeoutMs,
    outputLimitBytes,
  });
}

export function assertNoForbiddenEnv(env) {
  if (env === null || typeof env !== "object") throw new TypeError("env must be an object");
  for (const key of Object.keys(env)) {
    if (FORBIDDEN_ENV_KEYS.includes(key)) {
      throw new Error(`Forbidden credential key is present in the runner environment: ${key}`);
    }
    const value = String(env[key] ?? "");
    if (SECRET_VALUE_HINTS.test(value)) {
      throw new Error(`Runner environment value for ${key} looks like a secret and is forbidden`);
    }
  }
}

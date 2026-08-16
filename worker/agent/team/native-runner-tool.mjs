import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Type } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { createRunnerBrokerExecutor, runnerBrokerEndpointForWorker } from "../runner/broker-client.mjs";
import { FORBIDDEN_ENV_KEYS, FORBIDDEN_NETWORK_TARGETS } from "../runner/runner-policy.mjs";
import { runCommand } from "../runner/runner-port.mjs";
import { RunnerJournal } from "../runner/journal.mjs";

const ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const MEMBER_ID = /^[A-Za-z0-9@!#$%&*+./:=?_-]{1,160}$/u;
const RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const ROLE = "implementor";
const MAX_BINDING_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024;
const GENERIC_HOST_EXEC_TOOLS = new Set(["exec", "process", "shell"]);

const BINDING_KEYS = ["assigneeMemberId", "bindingDigest", "role", "runId", "schemaVersion", "taskId", "workId"];

function requirePattern(value, pattern, name) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function exactKeys(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${name} has missing or unknown fields`);
  }
}

function boundedText(value) {
  if (typeof value !== "string") return "";
  if (Buffer.byteLength(value) <= MAX_OUTPUT_BYTES) return value;
  return `${Buffer.from(value, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8")}\n[truncated]`;
}

function baseBinding(input) {
  return {
    schemaVersion: 1,
    taskId: requirePattern(input.taskId, ID, "taskId"),
    workId: requirePattern(input.workId, ID, "workId"),
    assigneeMemberId: requirePattern(input.assigneeMemberId, MEMBER_ID, "assigneeMemberId"),
    role: input.role === ROLE ? ROLE : (() => { throw new Error("native Runner binding role is invalid"); })(),
    runId: requirePattern(input.runId, RUN_ID, "runId"),
  };
}

export function createNativeRunnerBinding(input) {
  const base = baseBinding(input ?? {});
  return Object.freeze({ ...base, bindingDigest: sha256(canonicalJson(base)) });
}

export function validateNativeRunnerBinding(value) {
  exactKeys(value, BINDING_KEYS, "native Runner binding");
  const binding = createNativeRunnerBinding(value);
  if (value.bindingDigest !== binding.bindingDigest) throw new Error("native Runner binding digest mismatch");
  return binding;
}

async function readBinding(filePath) {
  if (typeof filePath !== "string" || filePath === "") throw new Error("native Runner binding file is required");
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0 || metadata.size > MAX_BINDING_BYTES) {
    throw new Error("native Runner binding file must be a bounded regular file");
  }
  let value;
  try {
    value = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error("native Runner binding file is not valid JSON");
  }
  return validateNativeRunnerBinding(value);
}

function resultText(result) {
  return JSON.stringify({
    taskId: result.taskId,
    workId: result.workId,
    outcome: result.outcome,
    replayed: result.replayed === true,
    exitCode: result.exitCode,
    stdout: boundedText(result.stdout),
    stderr: boundedText(result.stderr),
    durationMs: result.durationMs,
    changeRevisionRef: result.changeRevisionRef ?? null,
  });
}

export function createNativeRunnerTool({ bindingFile, journalFile, endpoint, memberId, fetchImpl = globalThis.fetch } = {}) {
  const actorId = requirePattern(memberId, MEMBER_ID, "memberId");
  const brokerEndpoint = endpoint;
  if (typeof brokerEndpoint !== "string" || brokerEndpoint === "") throw new TypeError("native Runner broker endpoint is required");
  if (typeof journalFile !== "string" || journalFile === "") throw new TypeError("native Runner journal file is required");
  const journal = new RunnerJournal({ filePath: journalFile });
  return Object.freeze({
    name: "tiangong_run_command",
    label: "Tiangong bounded Runner command",
    description: "Run the deployment-authored immutable command plan for the assigned Implementor Task through the Runner broker. The model cannot choose argv, cwd, timeout, environment, or output limits.",
    parameters: Type.Object({ taskId: Type.String({ pattern: ID.source }) }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      exactKeys(params, ["taskId"], "native Runner tool parameters");
      const taskId = requirePattern(params.taskId, ID, "taskId");
      const binding = await readBinding(bindingFile);
      if (binding.taskId !== taskId || binding.assigneeMemberId !== actorId) throw new Error("native Runner Task is not assigned to this Worker");
      const executor = createRunnerBrokerExecutor({ endpoint: brokerEndpoint, taskId, fetchImpl });
      const plan = await executor.plan({ runId: binding.runId });
      const result = await runCommand({
        runId: binding.runId,
        command: plan.command,
        cwd: plan.cwd,
        timeoutMs: plan.timeoutMs,
        outputLimitBytes: plan.outputLimitBytes,
      }, {
        executor,
        journal,
        env: {
          TIANGONG_FORBIDDEN_ENV_NAMES: FORBIDDEN_ENV_KEYS.join(","),
          TIANGONG_FORBIDDEN_NETWORK_TARGETS: FORBIDDEN_NETWORK_TARGETS.join(","),
        },
      });
      if (result.outcome !== "completed") {
        const error = new Error(`native Runner command outcome is uncertain (${result.reason})`);
        error.code = "TIANGONG_RUNNER_OUTCOME_UNCERTAIN";
        throw error;
      }
      return {
        content: [{ type: "text", text: resultText({ ...result, taskId, workId: binding.workId }) }],
        details: {
          taskId,
          workId: binding.workId,
          bindingDigest: binding.bindingDigest,
          executionPlanDigest: plan.contentDigest,
          invocationKey: result.invocationKey,
          replayed: result.replayed === true,
          runnerEvidence: result.runnerEvidence,
          changeRevisionRef: result.changeRevisionRef ?? null,
        },
      };
    },
  });
}

function toolNameFromHookEvent(event = {}) {
  return event.toolName ?? event.name ?? event.tool?.name;
}

/** Fail closed for OpenClaw's generic host-side execution surface. */
export function createNativeRunnerExecDenyHook() {
  return async (event = {}) => {
    const name = toolNameFromHookEvent(event);
    if (typeof name !== "string") return undefined;
    if (GENERIC_HOST_EXEC_TOOLS.has(name) || name.startsWith("exec_") || name.startsWith("process_")) {
      return { block: true, blockReason: "TIANGONG_NATIVE_RUNNER_EXEC_DENIED: use tiangong_run_command for the assigned Task" };
    }
    return undefined;
  };
}

export function registerNativeRunnerTool(api, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (env.TIANGONG_NATIVE_RUNNER_ENABLED !== "1") return { enabled: false };
  if (typeof api?.registerTool !== "function") throw new Error("OpenClaw registerTool API is unavailable");
  if (env.TIANGONG_NATIVE_RUNNER_EXEC_POLICY !== "deny") {
    throw new Error("native Runner requires generic host-side exec to be denied");
  }
  const endpoint = runnerBrokerEndpointForWorker({ role: ROLE, env });
  const bindingFile = env.TIANGONG_RUNNER_BINDING_FILE;
  const journalFile = env.TIANGONG_NATIVE_RUNNER_JOURNAL_FILE;
  const memberId = env.TIANGONG_MEMBER_ID;
  if (typeof bindingFile !== "string" || !isAbsolute(bindingFile) || typeof journalFile !== "string" || !isAbsolute(journalFile) || typeof memberId !== "string" || memberId === "") {
    throw new Error("native Runner requires a binding file, journal file, and member identity");
  }
  if (typeof api.on !== "function") throw new Error("native Runner requires OpenClaw before_tool_call hook API");
  api.registerTool(() => createNativeRunnerTool({ bindingFile, journalFile, endpoint, memberId, fetchImpl }), { name: "tiangong_run_command" });
  api.on("before_tool_call", createNativeRunnerExecDenyHook(), { priority: 110 });
  return { enabled: true, tool: "tiangong_run_command", hooks: ["before_tool_call"] };
}

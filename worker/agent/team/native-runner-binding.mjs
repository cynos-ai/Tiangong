import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { canonicalJson } from "../canonical-json.mjs";
import { runnerRunIdForTask } from "../runner/runner-port.mjs";
import { createRunnerBrokerPreparationClient } from "../runner/preparation-client.mjs";
import { isMemberConfig, isTaskSpec } from "./coordination-store.mjs";
import { isProjectBinding, isTaskBinding } from "./manifest.mjs";
import { createNativeRunnerBinding, validateNativeRunnerBinding } from "./native-runner-tool.mjs";

const MAX_RECEIPT_BYTES = 16 * 1024;
const ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const MEMBER_ID = /^[A-Za-z0-9@!#$%&*+./:=?_-]{1,160}$/u;

function requireString(value, pattern, name) {
  if (typeof value !== "string" || value === "" || !pattern.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function requireAbsolutePath(value, name) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new TypeError(`${name} must be absolute`);
  return value;
}

function coordinationTaskSpec(task) {
  const spec = task?.spec ?? task;
  if (!isTaskSpec(spec)) throw new Error("Native Runner deployment requires an immutable Coordination TaskSpec");
  return spec;
}

function assertImplementorAssignment({ task, member, projectBinding, taskBinding }) {
  const spec = coordinationTaskSpec(task);
  if (!isMemberConfig(member) || member.role !== "implementor" || !member.enabled) {
    throw new Error("Native Runner deployment requires an enabled Implementor MemberConfig");
  }
  if (!isProjectBinding(projectBinding) || !isTaskBinding(taskBinding)) {
    throw new Error("Native Runner deployment requires immutable legacy Project/Task bindings");
  }
  if (taskBinding.taskKind !== "implement" ||
      taskBinding.taskId !== spec.taskId ||
      taskBinding.projectId !== projectBinding.projectId ||
      taskBinding.assignee !== member.workerName ||
      projectBinding.roleBindings.implementor !== member.workerName) {
    throw new Error("Native Runner Coordination and deployment bindings do not match");
  }
  return spec;
}

/**
 * Convert the authoritative Coordination Task plus the deployment-owned
 * AgentTeams Project/Task binding into the small receipt mounted in a native
 * OpenClaw Worker. Capabilities and command policy stay in the broker; this
 * receipt only proves identity, assignment, and run ownership.
 */
export function createNativeRunnerDeploymentBinding({ task, member, projectBinding, taskBinding, runId } = {}) {
  const spec = assertImplementorAssignment({ task, member, projectBinding, taskBinding });
  const resolvedRunId = runId ?? runnerRunIdForTask(taskBinding);
  requireString(resolvedRunId, /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, "runId");
  const binding = createNativeRunnerBinding({
    taskId: spec.taskId,
    workId: spec.workId,
    assigneeMemberId: member.memberId,
    role: "implementor",
    runId: resolvedRunId,
  });
  return Object.freeze({
    binding,
    taskBindingDigest: taskBinding.contentDigest,
    memberId: requireString(member.memberId, MEMBER_ID, "memberId"),
    workerName: requireString(member.workerName, ID, "workerName"),
  });
}

/**
 * Ask the broker to register the immutable deployment binding before the
 * Worker is notified. The legacy Project/Task binding is deliberately an
 * explicit deployment input: Coordination TaskSpec does not own capability
 * or runner policy fields.
 */
export async function prepareNativeRunnerDeployment({
  task,
  member,
  projectBinding,
  taskBinding,
  preparationClient = createRunnerBrokerPreparationClient(),
  runId,
} = {}) {
  const prepared = createNativeRunnerDeploymentBinding({ task, member, projectBinding, taskBinding, runId });
  if (typeof preparationClient?.prepare !== "function") throw new TypeError("Runner preparation client is required");
  const brokerReceipt = await preparationClient.prepare({
    schemaVersion: 1,
    projectBinding,
    taskBinding,
    inputTaskBinding: null,
  });
  if (brokerReceipt.taskId !== prepared.binding.taskId || brokerReceipt.taskBindingDigest !== prepared.taskBindingDigest) {
    throw new Error("Runner preparation receipt does not match the native binding");
  }
  return Object.freeze({ ...prepared, brokerReceipt });
}

async function writeAtomic(filePath, text) {
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filePath);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** Write the deployment receipt once, allowing only an exact idempotent replay. */
export async function materializeNativeRunnerBinding({ filePath, binding } = {}) {
  const target = requireAbsolutePath(filePath, "native Runner binding file");
  const validated = validateNativeRunnerBinding(binding);
  const text = `${canonicalJson(validated)}\n`;
  if (Buffer.byteLength(text) > MAX_RECEIPT_BYTES) throw new Error("Native Runner binding receipt is too large");
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_RECEIPT_BYTES) {
      throw new Error("Native Runner binding receipt path is invalid");
    }
    const existing = validateNativeRunnerBinding(JSON.parse(await readFile(target, "utf8")));
    if (canonicalJson(existing) !== canonicalJson(validated)) throw new Error("NATIVE_RUNNER_BINDING_CONFLICT");
    return Object.freeze({ path: target, binding: existing, replayed: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeAtomic(target, text);
  return Object.freeze({ path: target, binding: validated, replayed: false });
}

/** Environment injected by the deployment layer into the Implementor Worker. */
export function nativeRunnerWorkerEnvironment({ bindingPath, journalPath, memberId, workerName } = {}) {
  const bindingFile = requireAbsolutePath(bindingPath, "native Runner binding file");
  const journalFile = requireAbsolutePath(journalPath, "native Runner journal file");
  return Object.freeze({
    TIANGONG_NATIVE_RUNNER_ENABLED: "1",
    TIANGONG_NATIVE_RUNNER_EXEC_POLICY: "deny",
    TIANGONG_RUNNER_BINDING_FILE: bindingFile,
    TIANGONG_NATIVE_RUNNER_JOURNAL_FILE: journalFile,
    TIANGONG_MEMBER_ID: requireString(memberId, MEMBER_ID, "memberId"),
    AGENTTEAMS_WORKER_NAME: requireString(workerName, ID, "workerName"),
  });
}

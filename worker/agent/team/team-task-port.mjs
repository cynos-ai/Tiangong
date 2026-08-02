import { canonicalJson, sha256 } from "../canonical-json.mjs";
import {
  appendTaskDecision,
  readProjectBinding,
  readTaskBinding,
  readTaskDecisions,
  readTaskResult,
  writeProjectBinding,
  writeTaskBinding,
  writeTaskResult,
} from "./manifest-store.mjs";
import { assertAssignee, assertLeaderForProject, loadWorkerIdentity } from "./team-context.mjs";

// TeamTaskPort: RoleProfile-scoped coordination operations over the
// AgentTeams v1.2.0 shared-filesystem + Matrix @mention + sync model, with
// Tiangong immutable manifests, authorization, idempotency, and Evidence.
//
// Leader operations: createProject, dispatchTask, checkResult,
// recordTaskDecision. Worker operations: resolveAssignedTask, submitResult.
// Side effects (@mention, storage sync, Evidence) are injected so the
// contract is deterministic and the real Matrix/sync adapters are wired
// when the Worker image is assembled.

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;
const DECISIONS = new Set(["accept", "revision", "blocked"]);
const SUMMARY_MAX = 4096;

function demandString(value, name) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} must be a non-empty string`);
}
function demandPattern(value, name, pattern) {
  demandString(value, name);
  if (!pattern.test(value)) throw new Error(`${name} has an invalid format: ${value}`);
  return value;
}
function frozen(record) {
  const base = Object.freeze({ ...record });
  return Object.freeze({ ...base, contentDigest: sha256(canonicalJson(base)) });
}
function frozenStringArray(input, name) {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input)) throw new TypeError(`${name} must be an array`);
  const items = input.map((item) => demandPattern(item, `${name} entry`, ID_PATTERN));
  if (new Set(items).size !== items.length) throw new Error(`${name} contains duplicates`);
  return Object.freeze(items);
}
function now(deps) {
  const value = deps?.now?.();
  return typeof value === "string" ? value : new Date().toISOString();
}
async function recordEvidence(deps, type, body) {
  deps?.evidence?.append?.({ type, ...body, at: now(deps) });
}
async function isEEXIST(error) {
  return error?.code === "EEXIST";
}

export function createTaskResult(input) {
  if (input === null || typeof input !== "object") throw new TypeError("result input must be an object");
  demandPattern(input.taskId, "taskId", ID_PATTERN);
  demandPattern(input.projectId, "projectId", ID_PATTERN);
  demandPattern(input.producer, "producer", ID_PATTERN);
  demandString(input.summary, "summary");
  if (input.summary.length > SUMMARY_MAX) throw new Error("summary exceeds the maximum length");
  demandPattern(input.createdAt, "createdAt", ISO_PATTERN);
  return frozen({
    kind: "tiangong.task-result",
    schemaVersion: 1,
    taskId: input.taskId,
    projectId: input.projectId,
    producer: input.producer,
    summary: input.summary,
    artifactRefs: frozenStringArray(input.artifactRefs, "artifactRefs"),
    createdAt: input.createdAt,
  });
}

export function createTaskDecision(input) {
  if (input === null || typeof input !== "object") throw new TypeError("decision input must be an object");
  demandPattern(input.decisionId, "decisionId", ID_PATTERN);
  demandPattern(input.taskId, "taskId", ID_PATTERN);
  demandPattern(input.projectId, "projectId", ID_PATTERN);
  if (!DECISIONS.has(input.decision)) throw new Error(`Unsupported decision: ${input.decision}`);
  if (!Number.isInteger(input.revisionIndex) || input.revisionIndex < 0) {
    throw new TypeError("revisionIndex must be a non-negative integer");
  }
  demandPattern(input.decidedBy, "decidedBy", ID_PATTERN);
  demandPattern(input.createdAt, "createdAt", ISO_PATTERN);
  if (input.resultDigest !== undefined && input.resultDigest !== null) {
    demandPattern(input.resultDigest, "resultDigest", DIGEST_PATTERN);
  }
  const record = {
    kind: "tiangong.task-decision",
    schemaVersion: 1,
    decisionId: input.decisionId,
    taskId: input.taskId,
    projectId: input.projectId,
    decision: input.decision,
    revisionIndex: input.revisionIndex,
    decidedBy: input.decidedBy,
    createdAt: input.createdAt,
  };
  if (input.resultDigest !== undefined && input.resultDigest !== null) {
    record.resultDigest = input.resultDigest;
  }
  if (input.note !== undefined && input.note !== null) {
    demandString(input.note, "note");
    if (input.note.length > SUMMARY_MAX) throw new Error("note exceeds the maximum length");
    record.note = input.note;
  }
  return frozen(record);
}

export async function createProject(projectBinding, deps) {
  const identity = loadWorkerIdentity(deps);
  assertLeaderForProject(identity, projectBinding);
  const manifestPath = await writeProjectBinding(projectBinding, deps);
  await deps?.sync?.afterWrite?.();
  await recordEvidence(deps, "team.project.created", {
    projectId: projectBinding.projectId,
    playbookDigest: projectBinding.playbookDigest,
    manifestDigest: projectBinding.contentDigest,
  });
  return { projectBinding, manifestPath };
}

export async function dispatchTask(taskBinding, deps) {
  const identity = loadWorkerIdentity(deps);
  const project = await readProjectBinding(taskBinding.projectId, deps);
  assertLeaderForProject(identity, project);
  try {
    await writeTaskBinding(taskBinding, deps);
    await deps?.sync?.afterWrite?.();
  } catch (error) {
    if (await isEEXIST(error)) {
      const existing = await readTaskBinding(taskBinding.taskId, deps);
      await recordEvidence(deps, "team.task.dispatch.replay", {
        taskId: taskBinding.taskId,
        manifestDigest: existing.contentDigest,
      });
      return { taskBinding: existing, replayed: true, notified: false };
    }
    throw error;
  }
  await deps?.channel?.notifyAssignee?.(taskBinding.assignee, taskBinding.taskId, taskBinding.contentDigest);
  await recordEvidence(deps, "team.task.dispatched", {
    taskId: taskBinding.taskId,
    assignee: taskBinding.assignee,
    manifestDigest: taskBinding.contentDigest,
  });
  return { taskBinding, replayed: false, notified: true };
}

export async function resolveAssignedTask(taskId, deps) {
  await deps?.sync?.beforeRead?.();
  const taskBinding = await readTaskBinding(taskId, deps);
  const identity = loadWorkerIdentity(deps);
  assertAssignee(identity, taskBinding);
  return { taskBinding };
}

export async function submitResult(result, deps) {
  const identity = loadWorkerIdentity(deps);
  await deps?.sync?.beforeRead?.();
  const taskBinding = await readTaskBinding(result.taskId, deps);
  assertAssignee(identity, taskBinding);
  if (result.projectId !== taskBinding.projectId) {
    throw new Error("Result projectId does not match the assigned task");
  }
  try {
    await writeTaskResult(result, deps);
    await deps?.sync?.afterWrite?.();
  } catch (error) {
    if (await isEEXIST(error)) {
      const existing = await readTaskResult(result.taskId, deps);
      await recordEvidence(deps, "team.result.submit.replay", {
        taskId: result.taskId,
        resultDigest: existing.contentDigest,
      });
      return { result: existing, replayed: true, notified: false };
    }
    throw error;
  }
  await deps?.channel?.notifyLeader?.(taskBinding.taskId, result.contentDigest);
  await recordEvidence(deps, "team.result.submitted", {
    taskId: result.taskId,
    producer: result.producer,
    resultDigest: result.contentDigest,
  });
  return { result, replayed: false, notified: true };
}

export async function checkResult(taskId, deps) {
  const identity = loadWorkerIdentity(deps);
  const taskBinding = await readTaskBinding(taskId, deps);
  const project = await readProjectBinding(taskBinding.projectId, deps);
  assertLeaderForProject(identity, project);
  await deps?.sync?.beforeRead?.();
  const result = await readTaskResult(taskId, deps);
  const decisions = await readTaskDecisions(taskId, deps);
  return { taskBinding, result, decisions };
}

export async function recordTaskDecision(decision, deps) {
  const identity = loadWorkerIdentity(deps);
  const taskBinding = await readTaskBinding(decision.taskId, deps);
  if (decision.projectId !== taskBinding.projectId) {
    throw new Error("Decision projectId does not match the task");
  }
  const project = await readProjectBinding(taskBinding.projectId, deps);
  assertLeaderForProject(identity, project);
  if (decision.decision === "accept") {
    await deps?.sync?.beforeRead?.();
    try {
      await readTaskResult(decision.taskId, deps);
    } catch {
      throw new Error("Cannot accept a task that has no submitted result");
    }
  }
  let manifestPath;
  try {
    manifestPath = await appendTaskDecision(decision, deps);
    await deps?.sync?.afterWrite?.();
  } catch (error) {
    if (await isEEXIST(error)) {
      await recordEvidence(deps, "team.task.decision.replay", {
        taskId: decision.taskId,
        decisionId: decision.decisionId,
      });
      return { decision, replayed: true };
    }
    throw error;
  }
  await recordEvidence(deps, "team.task.decision", {
    taskId: decision.taskId,
    decision: decision.decision,
    decidedBy: decision.decidedBy,
    decisionDigest: decision.contentDigest,
  });
  return { decision, manifestPath, replayed: false };
}

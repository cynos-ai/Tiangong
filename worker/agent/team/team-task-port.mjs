import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { assertDecisionResultCompatible, findRoleForWorker } from "../playbook/transition-policy.mjs";
import { isResultEnvelope } from "../work/result-envelope.mjs";
import {
  ensureAgentTeamsProject,
  ensureAgentTeamsResult,
  ensureAgentTeamsTask,
  applyAgentTeamsDecision,
} from "./agentteams-records.mjs";
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
import { verifyContentDigest } from "./manifest.mjs";

// TeamTaskPort adapts Tiangong's closed coordination operations to the real
// AgentTeams v1.2 shared Project/Task records. Immutable Tiangong bindings live
// under each upstream record's tiangong directory; meta.json, plan.md,
// spec.md, and result.md remain the AgentTeams coordination facts.

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
function now(deps) {
  const value = deps?.now?.();
  return typeof value === "string" ? value : new Date().toISOString();
}
function frozen(record) {
  const base = Object.freeze({ ...record });
  return Object.freeze({ ...base, contentDigest: sha256(canonicalJson(base)) });
}
function sameRecord(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}
function requirePortDependencies(deps, { channel = false } = {}) {
  if (!deps?.sync?.beforeRead || !deps?.sync?.afterWrite) {
    throw new TypeError("TeamTaskPort requires beforeRead/afterWrite synchronization");
  }
  if (!deps?.evidence?.append) throw new TypeError("TeamTaskPort requires durable Evidence");
  if (channel && (!deps?.channel || typeof deps.channel.assertTeamIdentity !== "function" ||
      typeof deps.channel.assertTeamRoster !== "function" || typeof deps.channel.notifyAssignee !== "function" ||
      typeof deps.channel.notifyLeader !== "function")) {
    throw new TypeError("TeamTaskPort requires the closed Matrix channel adapter");
  }
}
async function recordEvidence(deps, type, body) {
  await deps.evidence.append({ type, ...body, at: now(deps) });
}

function decisionIdentity(input) {
  return {
    projectId: input.projectId,
    playbookDigest: input.playbookDigest,
    sourceTaskId: input.taskId,
    decision: input.decision,
    revisionIndex: input.revisionIndex,
  };
}

export function createTaskDecision(input) {
  if (input === null || typeof input !== "object") throw new TypeError("decision input must be an object");
  demandPattern(input.taskId, "taskId", ID_PATTERN);
  demandPattern(input.projectId, "projectId", ID_PATTERN);
  demandPattern(input.playbookDigest, "playbookDigest", DIGEST_PATTERN);
  if (!DECISIONS.has(input.decision)) throw new Error(`Unsupported decision: ${input.decision}`);
  if (!Number.isInteger(input.revisionIndex) || input.revisionIndex < 0) {
    throw new TypeError("revisionIndex must be a non-negative integer");
  }
  demandPattern(input.decidedBy, "decidedBy", ID_PATTERN);
  demandPattern(input.createdAt, "createdAt", ISO_PATTERN);
  if (["accept", "revision"].includes(input.decision)) {
    demandPattern(input.resultDigest, "resultDigest", DIGEST_PATTERN);
  } else if (input.resultDigest !== undefined && input.resultDigest !== null) {
    demandPattern(input.resultDigest, "resultDigest", DIGEST_PATTERN);
  }
  const identity = decisionIdentity(input);
  const record = {
    kind: "tiangong.task-decision",
    schemaVersion: 1,
    decisionId: `transition-${sha256(canonicalJson(identity)).slice(0, 48)}`,
    ...identity,
    taskId: input.taskId,
    decidedBy: input.decidedBy,
    createdAt: input.createdAt,
  };
  if (input.resultDigest !== undefined && input.resultDigest !== null) record.resultDigest = input.resultDigest;
  if (input.note !== undefined && input.note !== null) {
    demandString(input.note, "note");
    if (input.note.length > SUMMARY_MAX) throw new Error("note exceeds the maximum length");
    record.note = input.note;
  }
  return frozen(record);
}

export function isTaskDecision(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const recreated = createTaskDecision({
      taskId: value.taskId,
      projectId: value.projectId,
      playbookDigest: value.playbookDigest,
      decision: value.decision,
      revisionIndex: value.revisionIndex,
      decidedBy: value.decidedBy,
      resultDigest: value.resultDigest,
      note: value.note,
      createdAt: value.createdAt,
    });
    return sameRecord(recreated, value);
  } catch {
    return false;
  }
}

async function exactReplay(readExisting, proposed, label) {
  const existing = await readExisting();
  if (!sameRecord(existing, proposed)) throw new Error(`${label} conflicts with an immutable existing record`);
  return existing;
}

async function readOptionalResult(taskId, deps) {
  try {
    return await readTaskResult(taskId, deps);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function validateResultBinding({ result, task, project, identity }) {
  if (!isResultEnvelope(result) || !verifyContentDigest(result)) {
    throw new Error("Task result must be a schema-valid ResultEnvelope");
  }
  const expectedRole = findRoleForWorker(project.roleBindings, identity.workerName);
  const checks = [
    [result.taskId, task.taskId, "taskId"],
    [result.projectId, task.projectId, "projectId"],
    [result.producer, identity.workerName, "producer"],
    [result.taskKind, task.taskKind, "taskKind"],
    [result.revisionIndex, task.revisionIndex, "revisionIndex"],
    [result.sourceRole, expectedRole, "sourceRole"],
    [result.playbookDigest, project.playbookDigest, "playbookDigest"],
    [result.taskBindingDigest, task.contentDigest, "taskBindingDigest"],
    [result.completionContractDigest, task.completionContractDigest, "completionContractDigest"],
    [result.sourceProfileDigest, task.sourceProfileDigest, "sourceProfileDigest"],
    [result.sourceSkillId, task.sourceSkillId, "sourceSkillId"],
    [result.skillDigest, task.sourceSkillDigest, "skillDigest"],
  ];
  for (const [actual, expected, field] of checks) {
    if (actual !== expected) throw new Error(`Result ${field} does not match the assigned task binding`);
  }
}

export async function createProject(projectBinding, deps) {
  requirePortDependencies(deps, { channel: true });
  const identity = loadWorkerIdentity(deps);
  assertLeaderForProject(identity, projectBinding);
  if (!identity.roomId) throw new Error("Authenticated Leader room is unavailable");
  await deps.channel.assertTeamIdentity("team_leader");
  const roster = await deps.channel.assertTeamRoster(Object.values(projectBinding.roleBindings));
  await deps.sync.beforeRead();
  let stored = projectBinding;
  let replayed = false;
  try {
    await writeProjectBinding(projectBinding, deps);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    stored = await exactReplay(() => readProjectBinding(projectBinding.projectId, deps), projectBinding, "Project binding");
    replayed = true;
  }
  await ensureAgentTeamsProject(stored, { ...deps, roomId: roster.roomId });
  await deps.sync.afterWrite({ projectIds: [stored.projectId] });
  await recordEvidence(deps, replayed ? "team.project.create.replay" : "team.project.created", {
    projectId: stored.projectId,
    playbookDigest: stored.playbookDigest,
    manifestDigest: stored.contentDigest,
  });
  return { projectBinding: stored, replayed };
}

export async function dispatchTask(taskBinding, deps) {
  requirePortDependencies(deps, { channel: true });
  const identity = loadWorkerIdentity(deps);
  if (!identity.roomId) throw new Error("Authenticated Leader room is unavailable");
  await deps.channel.assertTeamIdentity("team_leader");
  await deps.sync.beforeRead();
  const project = await readProjectBinding(taskBinding.projectId, deps);
  assertLeaderForProject(identity, project);
  const roster = await deps.channel.assertTeamRoster(Object.values(project.roleBindings));
  let stored = taskBinding;
  let replayed = false;
  try {
    await writeTaskBinding(taskBinding, deps);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    stored = await exactReplay(() => readTaskBinding(taskBinding.taskId, deps), taskBinding, "Task binding");
    replayed = true;
  }
  await ensureAgentTeamsTask(stored, project, { ...deps, roomId: roster.roomId });
  await deps.sync.afterWrite({ projectIds: [stored.projectId], taskIds: [stored.taskId] });
  const notification = await deps.channel.notifyAssignee(
    stored.assignee,
    stored.projectId,
    stored.taskId,
    stored.contentDigest,
  );
  await recordEvidence(deps, replayed ? "team.task.dispatch.replay" : "team.task.dispatched", {
    taskId: stored.taskId,
    assignee: stored.assignee,
    manifestDigest: stored.contentDigest,
    notificationQueued: notification?.queued === true,
    notificationDelivered: notification?.delivered === true,
  });
  return {
    taskBinding: stored,
    replayed,
    notified: notification?.delivered === true,
    notificationQueued: notification?.queued === true,
  };
}

export async function resolveAssignedTask(taskId, deps) {
  requirePortDependencies(deps, { channel: true });
  await deps.channel.assertTeamIdentity("worker");
  await deps.sync.beforeRead();
  const taskBinding = await readTaskBinding(taskId, deps);
  const identity = loadWorkerIdentity(deps);
  assertAssignee(identity, taskBinding);
  return { taskBinding };
}

export async function submitResult(result, deps) {
  requirePortDependencies(deps, { channel: true });
  const identity = loadWorkerIdentity(deps);
  await deps.channel.assertTeamIdentity("worker");
  await deps.sync.beforeRead();
  const taskBinding = await readTaskBinding(result.taskId, deps);
  assertAssignee(identity, taskBinding);
  const project = await readProjectBinding(taskBinding.projectId, deps);
  validateResultBinding({ result, task: taskBinding, project, identity });
  let stored = result;
  let replayed = false;
  try {
    await writeTaskResult(result, deps);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    stored = await exactReplay(() => readTaskResult(result.taskId, deps), result, "ResultEnvelope");
    replayed = true;
  }
  await ensureAgentTeamsResult(stored, deps);
  await deps.sync.afterWrite({ taskIds: [stored.taskId] });
  const notification = await deps.channel.notifyLeader(
    project.roleBindings.team_leader,
    stored.projectId,
    stored.taskId,
    stored.contentDigest,
  );
  await recordEvidence(deps, replayed ? "team.result.submit.replay" : "team.result.submitted", {
    taskId: stored.taskId,
    producer: stored.producer,
    resultDigest: stored.contentDigest,
    notificationQueued: notification?.queued === true,
    notificationDelivered: notification?.delivered === true,
  });
  return {
    result: stored,
    replayed,
    notified: notification?.delivered === true,
    notificationQueued: notification?.queued === true,
  };
}

export async function checkResult(taskId, deps) {
  requirePortDependencies(deps, { channel: true });
  const identity = loadWorkerIdentity(deps);
  await deps.channel.assertTeamIdentity("team_leader");
  await deps.sync.beforeRead();
  const taskBinding = await readTaskBinding(taskId, deps);
  const project = await readProjectBinding(taskBinding.projectId, deps);
  assertLeaderForProject(identity, project);
  const result = await readTaskResult(taskId, deps);
  validateResultBinding({ result, task: taskBinding, project, identity: { workerName: taskBinding.assignee } });
  const decisions = await readTaskDecisions(taskId, deps);
  if (!decisions.every(isTaskDecision)) throw new Error("Task has a malformed transition decision");
  if (decisions.length > 1) throw new Error("Task has conflicting terminal decisions");
  return { taskBinding, result, decisions };
}

export async function recordTaskDecision(decision, deps) {
  requirePortDependencies(deps, { channel: true });
  const identity = loadWorkerIdentity(deps);
  await deps.channel.assertTeamIdentity("team_leader");
  await deps.sync.beforeRead();
  const taskBinding = await readTaskBinding(decision.taskId, deps);
  const project = await readProjectBinding(taskBinding.projectId, deps);
  assertLeaderForProject(identity, project);
  if (!isTaskDecision(decision)) throw new Error("Decision schema or stable transition identity is invalid");
  if (decision.projectId !== taskBinding.projectId || decision.playbookDigest !== project.playbookDigest ||
      decision.revisionIndex !== taskBinding.revisionIndex) {
    throw new Error("Decision binding does not match the current Task/Project");
  }
  if (decision.decidedBy !== identity.workerName) {
    throw new Error("Decision decidedBy is not the authenticated Leader");
  }
  const result = await readOptionalResult(decision.taskId, deps);
  if (result) {
    validateResultBinding({ result, task: taskBinding, project, identity: { workerName: taskBinding.assignee } });
  }
  assertDecisionResultCompatible({ decision, taskBinding, result });
  const existing = await readTaskDecisions(decision.taskId, deps);
  if (!existing.every(isTaskDecision)) throw new Error("Task has a malformed transition decision");
  if (existing.length > 0) {
    if (existing.length === 1 && sameRecord(existing[0], decision)) {
      await applyAgentTeamsDecision(taskBinding, decision, deps);
      await deps.sync.afterWrite({ projectIds: [taskBinding.projectId], taskIds: [taskBinding.taskId] });
      await recordEvidence(deps, "team.task.decision.replay", {
        taskId: decision.taskId,
        decisionId: decision.decisionId,
      });
      return { decision: existing[0], replayed: true };
    }
    throw new Error("Task already has a different terminal decision");
  }
  await appendTaskDecision(decision, deps);
  await applyAgentTeamsDecision(taskBinding, decision, deps);
  await deps.sync.afterWrite({ projectIds: [taskBinding.projectId], taskIds: [taskBinding.taskId] });
  await recordEvidence(deps, "team.task.decision", {
    taskId: decision.taskId,
    decision: decision.decision,
    decidedBy: decision.decidedBy,
    decisionDigest: decision.contentDigest,
    resultDigest: decision.resultDigest ?? null,
  });
  return { decision, replayed: false };
}

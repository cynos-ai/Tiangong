import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { assertDecisionResultCompatible, findRoleForWorker } from "../playbook/transition-policy.mjs";
import {
  RUNNER_BROKER_ENDPOINT_DIGEST,
  runnerPreparationFailureCode,
  validateRunnerPreparationReceipt,
} from "../runner/preparation-client.mjs";
import { isResultEnvelope } from "../work/result-envelope.mjs";
import { createTaskDispatchState } from "./manifest.mjs";
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
  readTaskDispatchState,
  readTaskResult,
  writeProjectBinding,
  writeTaskBinding,
  writeTaskDispatchState,
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

async function waitForTeamIdentity(deps, expectedRole) {
  if (typeof deps.channel.waitForTeamIdentity === "function") {
    return deps.channel.waitForTeamIdentity(expectedRole);
  }
  return deps.channel.assertTeamIdentity(expectedRole);
}

async function persistRunnerPreparationFailure(taskBinding, deps, errorCode) {
  const state = createTaskDispatchState({
    taskId: taskBinding.taskId,
    projectId: taskBinding.projectId,
    taskBindingDigest: taskBinding.contentDigest,
    status: "preparation_failed",
    errorCode,
    createdAt: now(deps),
  });
  try {
    await writeTaskDispatchState(state, deps);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readTaskDispatchState(taskBinding.taskId, deps);
    if (!sameRecord(existing, state)) throw new Error("Task dispatch failure conflicts with an immutable existing state");
  }
  await deps.sync.afterWrite({ projectIds: [taskBinding.projectId], taskIds: [taskBinding.taskId] });
  await recordEvidence(deps, "runner.broker.preparation.failed", {
    taskId: taskBinding.taskId,
    taskBindingDigest: taskBinding.contentDigest,
    errorCode,
  });
  return state;
}

async function assertRunnerDispatchNotBlocked(taskBinding, deps) {
  let state;
  try {
    state = await readTaskDispatchState(taskBinding.taskId, deps);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (state.projectId !== taskBinding.projectId || state.taskBindingDigest !== taskBinding.contentDigest ||
      state.status !== "preparation_failed") {
    throw new Error("Task dispatch state does not match the immutable Task binding");
  }
  await recordEvidence(deps, "runner.broker.preparation.retry_blocked", {
    taskId: taskBinding.taskId,
    taskBindingDigest: taskBinding.contentDigest,
    errorCode: state.errorCode,
  });
  const error = new Error("Runner broker preparation failure is terminal for this Task; replay is blocked");
  error.code = "RUNNER_BROKER_PREPARATION_RETRY_BLOCKED";
  throw error;
}

async function prepareRunnerBinding(taskBinding, project, deps) {
  if (!new Set(["implement", "assess"]).has(taskBinding.taskKind)) return undefined;
  const fail = async (errorCode, error) => {
    await persistRunnerPreparationFailure(taskBinding, deps, errorCode);
    throw error;
  };
  if (typeof deps.runnerBrokerPreparation?.prepare !== "function") {
    const error = new Error("Runner broker preparation boundary is unavailable");
    error.code = "RUNNER_BROKER_PREPARATION_UNAVAILABLE";
    return fail(error.code, error);
  }
  let inputTaskBinding = null;
  try {
    if (taskBinding.taskKind === "assess") {
      const candidates = [];
      for (const inputRef of taskBinding.inputRefs) {
        let input;
        try {
          input = await readTaskBinding(inputRef, deps);
        } catch (error) {
          // Assessor inputRefs may contain an immutable ChangeRevision artifact
          // reference as well as the Implement Task ID. Only Task bindings are
          // eligible Runner inputs; an absent non-Task reference is ignored,
          // while malformed or unreadable Task state still fails closed.
          if (error?.code === "ENOENT") continue;
          const invalid = new Error("Assessor Runner preparation input is unavailable");
          invalid.code = "RUNNER_BROKER_PREPARATION_INPUT_INVALID";
          invalid.cause = error;
          throw invalid;
        }
        if (input.projectId === taskBinding.projectId && input.taskKind === "implement" &&
            input.revisionIndex === taskBinding.revisionIndex) candidates.push(input);
      }
      if (candidates.length !== 1) {
        const error = new Error("Assessor Runner preparation requires exactly one Implementor input");
        error.code = "RUNNER_BROKER_PREPARATION_INPUT_INVALID";
        throw error;
      }
      [inputTaskBinding] = candidates;
    }
    const receipt = validateRunnerPreparationReceipt(
      await deps.runnerBrokerPreparation.prepare({ projectBinding: project, taskBinding, inputTaskBinding }),
      taskBinding,
    );
    if (receipt.endpointDigest !== RUNNER_BROKER_ENDPOINT_DIGEST) {
      const error = new Error("Runner broker preparation returned a non-default execution endpoint");
      error.code = "RUNNER_BROKER_PREPARATION_RESPONSE_INVALID";
      throw error;
    }
    await recordEvidence(deps, "runner.broker.prepared", {
      taskId: taskBinding.taskId,
      taskBindingDigest: taskBinding.contentDigest,
      bindingDigest: receipt.bindingDigest,
      endpointDigest: receipt.endpointDigest,
      replayed: receipt.replayed,
    });
    return receipt;
  } catch (error) {
    const errorCode = runnerPreparationFailureCode(error);
    return fail(errorCode, error);
  }
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

async function validateResultBinding({ result, task, project, identity, deps }) {
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
  if (result.blocker || !["implement", "assess", "release"].includes(task.taskKind)) return;
  if (result.changeRevisionRef?.revision !== task.revisionIndex) {
    throw new Error("Result ChangeRevision does not match the Task revision");
  }
  if (task.taskKind === "implement") {
    if (result.changeRevisionRef.producerTaskId !== task.taskId) {
      throw new Error("Implementor Result must seal a ChangeRevision produced by its own Task");
    }
    return;
  }
  const producerTask = await readTaskBinding(result.changeRevisionRef.producerTaskId, deps);
  const producerResult = await readTaskResult(result.changeRevisionRef.producerTaskId, deps);
  const producerDecisions = await readTaskDecisions(result.changeRevisionRef.producerTaskId, deps);
  if (producerTask.projectId !== task.projectId || producerTask.taskKind !== "implement" ||
      producerTask.revisionIndex !== task.revisionIndex || !isResultEnvelope(producerResult) ||
      canonicalJson(producerResult.changeRevisionRef) !== canonicalJson(result.changeRevisionRef) ||
      producerDecisions.length !== 1 || !isTaskDecision(producerDecisions[0]) ||
      producerDecisions[0].decision !== "accept" ||
      producerDecisions[0].resultDigest !== producerResult.contentDigest) {
    throw new Error("Result ChangeRevision is not the accepted Implementor artifact for this revision");
  }
  if (task.taskKind === "release") {
    let acceptedAssessment = false;
    for (const inputTaskId of task.inputRefs) {
      const inputTask = await readTaskBinding(inputTaskId, deps);
      if (inputTask.taskKind !== "assess" || inputTask.projectId !== task.projectId || inputTask.revisionIndex !== task.revisionIndex) continue;
      const inputResult = await readTaskResult(inputTaskId, deps);
      const inputDecisions = await readTaskDecisions(inputTaskId, deps);
      if (isResultEnvelope(inputResult) && canonicalJson(inputResult.changeRevisionRef) === canonicalJson(result.changeRevisionRef) &&
          inputDecisions.length === 1 && isTaskDecision(inputDecisions[0]) && inputDecisions[0].decision === "accept" &&
          inputDecisions[0].resultDigest === inputResult.contentDigest) {
        acceptedAssessment = true;
        break;
      }
    }
    if (!acceptedAssessment) throw new Error("Release Result does not reference an accepted assessment for this revision");
  }
}

export async function acceptedChangeRevisionForRelease(taskBinding, deps) {
  if (taskBinding?.taskKind !== "release") throw new Error("Accepted release input requires a release Task");
  const accepted = [];
  for (const inputTaskId of taskBinding.inputRefs) {
    const inputTask = await readTaskBinding(inputTaskId, deps);
    if (inputTask.projectId !== taskBinding.projectId || inputTask.taskKind !== "assess" || inputTask.revisionIndex !== taskBinding.revisionIndex) continue;
    const inputResult = await readTaskResult(inputTaskId, deps);
    const inputDecisions = await readTaskDecisions(inputTaskId, deps);
    if (isResultEnvelope(inputResult) && !inputResult.blocker && inputResult.changeRevisionRef &&
        inputDecisions.length === 1 && isTaskDecision(inputDecisions[0]) && inputDecisions[0].decision === "accept" &&
        inputDecisions[0].resultDigest === inputResult.contentDigest) accepted.push(inputResult.changeRevisionRef);
  }
  if (accepted.length !== 1) throw new Error("Release Task must reference exactly one accepted assessment ChangeRevision");
  return accepted[0];
}

export async function createProject(projectBinding, deps) {
  requirePortDependencies(deps, { channel: true });
  const identity = loadWorkerIdentity(deps);
  assertLeaderForProject(identity, projectBinding);
  if (!identity.roomId) throw new Error("Authenticated Leader room is unavailable");
  await waitForTeamIdentity(deps, "team_leader");
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
  await waitForTeamIdentity(deps, "team_leader");
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
  if (["implement", "assess"].includes(stored.taskKind)) await assertRunnerDispatchNotBlocked(stored, deps);
  await ensureAgentTeamsTask(stored, project, { ...deps, roomId: roster.roomId });
  await deps.sync.afterWrite({ projectIds: [stored.projectId], taskIds: [stored.taskId] });
  await prepareRunnerBinding(stored, project, deps);
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
  await waitForTeamIdentity(deps, "worker");
  await deps.sync.beforeRead();
  const taskBinding = await readTaskBinding(taskId, deps);
  const identity = loadWorkerIdentity(deps);
  assertAssignee(identity, taskBinding);
  return { taskBinding };
}

export async function submitResult(result, deps) {
  requirePortDependencies(deps, { channel: true });
  const identity = loadWorkerIdentity(deps);
  await waitForTeamIdentity(deps, "worker");
  await deps.sync.beforeRead();
  const taskBinding = await readTaskBinding(result.taskId, deps);
  assertAssignee(identity, taskBinding);
  const project = await readProjectBinding(taskBinding.projectId, deps);
  await validateResultBinding({ result, task: taskBinding, project, identity, deps });
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
  await waitForTeamIdentity(deps, "team_leader");
  await deps.sync.beforeRead();
  const taskBinding = await readTaskBinding(taskId, deps);
  const project = await readProjectBinding(taskBinding.projectId, deps);
  assertLeaderForProject(identity, project);
  const result = await readTaskResult(taskId, deps);
  await validateResultBinding({ result, task: taskBinding, project, identity: { workerName: taskBinding.assignee }, deps });
  const decisions = await readTaskDecisions(taskId, deps);
  if (!decisions.every(isTaskDecision)) throw new Error("Task has a malformed transition decision");
  if (decisions.length > 1) throw new Error("Task has conflicting terminal decisions");
  return { taskBinding, result, decisions };
}

export async function recordTaskDecision(decision, deps) {
  requirePortDependencies(deps, { channel: true });
  const identity = loadWorkerIdentity(deps);
  await waitForTeamIdentity(deps, "team_leader");
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
    await validateResultBinding({ result, task: taskBinding, project, identity: { workerName: taskBinding.assignee }, deps });
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

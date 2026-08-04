import { Type } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { createDeploymentBrokerClient, createDeploymentOutcome } from "../deployment/client.mjs";
import { DeploymentApprovalGate } from "../deployment/approval-gate.mjs";
import { findRoleForWorker } from "../playbook/transition-policy.mjs";
import { TiangongToolRegistry } from "../tools/registry.mjs";
import { createGatedTool } from "../tools/wrapper.mjs";
import { createRunnerBrokerExecutor } from "../runner/broker-client.mjs";
import { FORBIDDEN_ENV_KEYS, FORBIDDEN_NETWORK_TARGETS } from "../runner/runner-policy.mjs";
import { runCommand, runnerRunIdForTask } from "../runner/runner-port.mjs";
import { readProjectBinding } from "../team/manifest-store.mjs";
import { assertProjectLeaderActor, loadWorkerIdentity } from "../team/team-context.mjs";
import { wrapTeamTool } from "../team/tool-wrapper.mjs";
import { acceptedChangeRevisionForRelease, resolveAssignedTask, submitResult } from "../team/team-task-port.mjs";
import { createChangeRevisionRef } from "./change-revision-ref.mjs";
import { createResultEnvelope } from "./result-envelope.mjs";
import { createWorkRun } from "./work-run.mjs";

const ID = Type.String({ pattern: "^[A-Za-z0-9._:-]{1,128}$" });
const DIGEST = Type.String({ pattern: "^[0-9a-f]{64}$" });
const PROFESSIONAL_ROLES = new Set(["designer", "implementor", "assessor", "operator"]);
const CHANGE_REVISION_REF = Type.Object({
  kind: Type.Literal("tiangong.change-revision-ref"),
  schemaVersion: Type.Literal(1),
  producerTaskId: ID,
  artifactPath: Type.String({
    minLength: 1,
    maxLength: 1024,
    pattern: "^(?!(?:\\.{1,2})(?:/|$))(?!.*\\/(?:\\.{1,2})(?:/|$))[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$",
  }),
  artifactDigest: DIGEST,
  revision: Type.Integer({ minimum: 0 }),
  contentDigest: DIGEST,
}, { additionalProperties: false });
const DEPLOYMENT_OUTCOME = Type.Object({
  kind: Type.Literal("tiangong.deployment-outcome"), schemaVersion: Type.Literal(1),
  taskId: ID, targetId: ID, operationDigest: DIGEST, previousDigest: DIGEST, currentDigest: DIGEST,
  changeRevisionRef: CHANGE_REVISION_REF,
  disposition: Type.Union([Type.Literal("DELIVERED"), Type.Literal("FAILED_SAFE"), Type.Literal("RECOVERY_REQUIRED")]),
  postVerifyHealthy: Type.Boolean(), rollbackPerformed: Type.Boolean(), previousVerifyHealthy: Type.Union([Type.Boolean(), Type.Null()]),
  contentDigest: DIGEST,
}, { additionalProperties: false });

function nowISO(deps) {
  const value = deps?.now?.();
  return typeof value === "string" ? value : new Date().toISOString();
}

function workRunIdForTask(taskBinding) {
  return `work-${sha256(taskBinding.contentDigest).slice(0, 48)}`;
}

function workRunScope(taskBinding) {
  return canonicalJson({ taskId: taskBinding.taskId, inputRefs: taskBinding.inputRefs });
}

function assertWorkRunBinding(state, taskBinding, sourceRole) {
  const binding = state?.binding;
  const expected = {
    runId: workRunIdForTask(taskBinding),
    taskId: taskBinding.taskId,
    role: sourceRole,
    skillId: taskBinding.sourceSkillId,
    skillDigest: taskBinding.sourceSkillDigest,
    objective: taskBinding.objective,
    scope: workRunScope(taskBinding),
    completionContractDigest: taskBinding.completionContractDigest,
    inputRefs: taskBinding.inputRefs,
  };
  const matches = Object.entries(expected).every(([field, value]) =>
    field === "inputRefs"
      ? canonicalJson(binding?.[field]) === canonicalJson(value)
      : binding?.[field] === value);
  if (!matches) throw new Error("Existing WorkRun binding conflicts with the assigned Task");
  return state;
}

async function ensureWorkRun(taskBinding, deps, sourceRole) {
  if (!deps.workRunStore) return undefined;
  const existing = await deps.workRunStore.latestForTask(taskBinding.taskId);
  if (existing) {
    assertWorkRunBinding(existing, taskBinding, sourceRole);
    if (existing.phase === "abandoned" || existing.phase === "conflict") {
      throw new Error(`WorkRun ${existing.binding.runId} requires recovery before task progress can continue`);
    }
    if (existing.phase === "planned" || existing.phase === "blocked") {
      return deps.workRunStore.transition(existing.binding.runId, "executing", { reason: "task-resolved" });
    }
    return existing;
  }
  const opened = await deps.workRunStore.open(createWorkRun({
    runId: workRunIdForTask(taskBinding),
    taskId: taskBinding.taskId,
    role: sourceRole,
    skillId: taskBinding.sourceSkillId,
    skillDigest: taskBinding.sourceSkillDigest,
    objective: taskBinding.objective,
    scope: workRunScope(taskBinding),
    completionContractDigest: taskBinding.completionContractDigest,
    inputRefs: taskBinding.inputRefs,
    createdAt: nowISO(deps),
  }));
  return opened.phase === "planned"
    ? deps.workRunStore.transition(opened.binding.runId, "executing", { reason: "task-resolved" })
    : opened;
}

async function finalizeWorkRun(taskBinding, deps, sourceRole) {
  if (!deps.workRunStore) return undefined;
  let state = await deps.workRunStore.latestForTask(taskBinding.taskId);
  if (!state) throw new Error("WorkRun is required before submitting a Task result");
  assertWorkRunBinding(state, taskBinding, sourceRole);
  if (state.terminal) return state;
  if (state.phase === "blocked" || state.phase === "conflict") {
    throw new Error(`WorkRun ${state.binding.runId} cannot finalize from ${state.phase}`);
  }
  if (state.phase === "executing" || state.phase === "waiting_approval") {
    state = await deps.workRunStore.transition(state.binding.runId, "verifying", { reason: "result-submitted" });
  }
  if (state.phase === "verifying") {
    state = await deps.workRunStore.transition(state.binding.runId, "finalized", { reason: "result-submitted" });
  }
  return state;
}

function ok(details) {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

function runnerUnavailable() {
  const error = new Error("Validated Runner broker is unavailable for this Worker");
  error.code = "TIANGONG_RUNNER_UNAVAILABLE";
  return error;
}

const RUNNER_PLAN_FAILURE_CODES = new Set([
  "RUNNER_BROKER_PLAN_CHANGED",
  "RUNNER_BROKER_PLAN_INVALID",
  "RUNNER_BROKER_PLAN_TIMEOUT",
  "RUNNER_BROKER_REQUEST_REJECTED",
  "RUNNER_BROKER_RESPONSE_INVALID",
  "RUNNER_BROKER_RESPONSE_TOO_LARGE",
]);
const RUNNER_PLAN_TRANSPORT_CODES = new Map([
  ["EAI_AGAIN", "RUNNER_BROKER_DNS_TEMPORARY_FAILURE"],
  ["ENOTFOUND", "RUNNER_BROKER_DNS_UNAVAILABLE"],
  ["ECONNREFUSED", "RUNNER_BROKER_CONNECTION_REFUSED"],
  ["ECONNRESET", "RUNNER_BROKER_CONNECTION_RESET"],
  ["EHOSTUNREACH", "RUNNER_BROKER_NETWORK_UNREACHABLE"],
  ["ENETUNREACH", "RUNNER_BROKER_NETWORK_UNREACHABLE"],
  ["ETIMEDOUT", "RUNNER_BROKER_PLAN_TIMEOUT"],
  ["UND_ERR_CONNECT_TIMEOUT", "RUNNER_BROKER_PLAN_TIMEOUT"],
]);

function runnerPlanFailureCode(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.cause) {
    if (RUNNER_PLAN_FAILURE_CODES.has(current.code) || RUNNER_PLAN_FAILURE_CODES.has(current.message)) {
      return RUNNER_PLAN_FAILURE_CODES.has(current.code) ? current.code : current.message;
    }
    const transportCode = RUNNER_PLAN_TRANSPORT_CODES.get(current.code);
    if (transportCode) return transportCode;
    if (current.name === "AbortError") return "RUNNER_BROKER_PLAN_TIMEOUT";
  }
  return "RUNNER_BROKER_PLAN_NETWORK_ERROR";
}

async function appendRunnerPlanEvidence(deps, event) {
  if (typeof deps.evidence?.append !== "function") {
    throw new Error("Runner plan Evidence recorder is unavailable");
  }
  await deps.evidence.append({
    ...event,
    endpointDigest: sha256(deps.runnerBrokerEndpoint),
  });
}

async function assertLeaderInvocation(taskBinding, invocation, deps) {
  const project = await readProjectBinding(taskBinding.projectId, deps);
  assertProjectLeaderActor(invocation?.actor?.id, project, deps);
  return project;
}

async function assertRunnerProducedRevision(taskBinding, params, deps) {
  if (!["implement", "assess"].includes(taskBinding.taskKind) || params.blocker) return;
  if (!params.changeRevisionRef || !deps.runnerJournal?.completedChangeRevision) {
    throw new Error("Task result requires a ChangeRevision proven by this Worker's Runner journal");
  }
  const ref = createChangeRevisionRef(params.changeRevisionRef);
  if (canonicalJson(ref) !== canonicalJson(params.changeRevisionRef)) {
    throw new Error("ChangeRevision schema or content digest is invalid");
  }
  if (ref.revision !== taskBinding.revisionIndex ||
      (taskBinding.taskKind === "implement" && ref.producerTaskId !== taskBinding.taskId)) {
    throw new Error("ChangeRevision does not match the current Task and revision");
  }
  const completed = await deps.runnerJournal.completedChangeRevision(ref.contentDigest);
  if (!completed || canonicalJson(completed.changeRevisionRef) !== canonicalJson(ref)) {
    throw new Error("ChangeRevision is not bound to a completed Runner invocation");
  }
  if (taskBinding.taskKind === "assess" && completed.runnerEvidence?.fixtureDigest !== ref.artifactDigest) {
    throw new Error("Assessment Runner did not materialize the submitted ChangeRevision digest");
  }
}

function createDeploymentTool(deps) {
  if (deps.professionalRole !== "operator") return undefined;
  if (!deps.deploymentBrokerEndpoint || !deps.deploymentReceiptStore || !deps.idempotencyStore || !deps.pendingOperationStore) {
    throw new Error("Operator deployment approval boundary is unavailable");
  }
  const definition = {
    name: "deploy_release",
    label: "Tiangong approved release deployment",
    description: "Request approval for, then execute, the exact accepted ChangeRevision through the closed deployment broker.",
    parameters: Type.Object({ taskId: ID }, { additionalProperties: false }),
    executionMode: "sequential",
  };
  async function submitApprovedReleaseResult(toolResult) {
    const rawOutcome = toolResult?.details?.outcome;
    if (!rawOutcome) throw new Error("Approved deployment returned no machine outcome");
    const outcome = createDeploymentOutcome(rawOutcome);
    const { taskBinding } = await resolveAssignedTask(outcome.taskId, deps);
    const project = await readProjectBinding(taskBinding.projectId, deps);
    const identity = loadWorkerIdentity(deps);
    const sourceRole = findRoleForWorker(project.roleBindings, identity.workerName);
    if (sourceRole !== "operator") throw new Error("Approved release Result has no operator role binding");
    await ensureWorkRun(taskBinding, deps, sourceRole);
    const result = createResultEnvelope({
      taskId: taskBinding.taskId,
      projectId: taskBinding.projectId,
      producer: identity.workerName,
      taskKind: taskBinding.taskKind,
      revisionIndex: taskBinding.revisionIndex,
      sourceRole,
      playbookDigest: project.playbookDigest,
      taskBindingDigest: taskBinding.contentDigest,
      completionContractDigest: taskBinding.completionContractDigest,
      sourceProfileDigest: taskBinding.sourceProfileDigest,
      sourceSkillId: taskBinding.sourceSkillId,
      skillDigest: taskBinding.sourceSkillDigest,
      claim: "Approved deployment outcome was captured and submitted by the Worker runtime.",
      artifactRefs: [outcome.changeRevisionRef.artifactDigest],
      evidenceRefs: [outcome.operationDigest],
      changeRevisionRef: outcome.changeRevisionRef,
      releaseOutcome: outcome,
      createdAt: nowISO(deps),
    });
    const submitted = await submitResult(result, deps);
    await finalizeWorkRun(taskBinding, deps, sourceRole);
    await deps.evidence?.append?.({
      type: "deployment.release.result.autosubmitted",
      taskId: result.taskId,
      projectId: result.projectId,
      resultDigest: result.contentDigest,
      outcomeDigest: outcome.contentDigest,
    });
    return submitted;
  }
  const gated = createGatedTool({
    definition,
    sideEffect: true,
    category: "external-side-effect",
    gate: new DeploymentApprovalGate({ idempotencyStore: deps.idempotencyStore }),
    evidence: deps.evidence,
    idempotencyStore: deps.idempotencyStore,
    pendingOperationStore: deps.pendingOperationStore,
    getInvocation: deps.getInvocation,
    async beforeProposal(params, { invocation }) {
      const { taskBinding } = await resolveAssignedTask(params.taskId, deps);
      if (taskBinding.taskKind !== "release") throw new Error("deploy_release requires an assigned release Task");
      if (!invocation.resumed) await assertLeaderInvocation(taskBinding, invocation, deps);
      const changeRevisionRef = await acceptedChangeRevisionForRelease(taskBinding, deps);
      const client = createDeploymentBrokerClient({ brokerEndpoint: deps.deploymentBrokerEndpoint, taskId: taskBinding.taskId, fetchImpl: deps.deploymentFetch });
      const plan = await client.plan({ changeRevisionRef });
      return { taskBinding, changeRevisionRef, plan };
    },
    summarize(_params, { preflight }) {
      return {
        toolName: "deploy_release", contractVersion: "deployment-operation-v1",
        taskId: preflight.taskBinding.taskId, projectId: preflight.taskBinding.projectId,
        revisionIndex: preflight.taskBinding.revisionIndex, targetId: preflight.plan.targetId,
        previousDigest: preflight.plan.previousDigest, rollbackDigest: preflight.plan.previousDigest,
        changeRevisionRef: preflight.changeRevisionRef, approvalPolicy: { type: "explicit_subject" },
      };
    },
    async executeOperation({ operation, actionDigest }) {
      const client = createDeploymentBrokerClient({ brokerEndpoint: deps.deploymentBrokerEndpoint, taskId: operation.taskId, fetchImpl: deps.deploymentFetch });
      const executed = await client.deploy({ actionDigest, changeRevisionRef: operation.changeRevisionRef });
      const receipt = await deps.deploymentReceiptStore.record(executed.outcome);
      return ok({ taskId: operation.taskId, outcome: receipt.outcome, replayed: executed.replayed || receipt.replayed });
    },
    replayResult(result) { return result; },
    resultProjection(result) { return result; },
    evidenceOperation(operation) { return operation; },
    completionMetadata(result) {
      return {
        deploymentOutcomeDigest: result?.details?.outcome?.contentDigest ?? null,
        deploymentDisposition: result?.details?.outcome?.disposition ?? null,
        deploymentTargetId: result?.details?.outcome?.targetId ?? null,
        deploymentCurrentDigest: result?.details?.outcome?.currentDigest ?? null,
      };
    },
  });
  return Object.freeze({
    ...gated,
    onApprovalResult: submitApprovedReleaseResult,
  });
}

function registerRunnerTool(registry, deps) {
  const role = deps.professionalRole;
  if (!new Set(["implementor", "assessor"]).has(role)) return;
  const toolName = role === "implementor" ? "run_command" : "run_test_command";
  const expectedTaskKind = role === "implementor" ? "implement" : "assess";
  registry.register({
    name: toolName,
    label: role === "implementor" ? "Tiangong isolated implementation command" : "Tiangong isolated assessment command",
    description: "Execute the immutable task-bound command plan through the disposable Runner broker. The model cannot choose or alter argv, timeout, output bounds, or working directory, and the Worker never receives the container-runtime socket.",
    parameters: Type.Object({ taskId: ID }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx, invocation) {
      const { taskBinding } = await resolveAssignedTask(params.taskId, deps);
      await assertLeaderInvocation(taskBinding, invocation, deps);
      if (taskBinding.taskKind !== expectedTaskKind) {
        throw new Error(`${toolName} is not authorized for the assigned Task kind`);
      }
      await ensureWorkRun(taskBinding, deps, role);
      if (typeof deps.runnerBrokerEndpoint !== "string" || !deps.runnerJournal) throw runnerUnavailable();
      const executor = createRunnerBrokerExecutor({
        endpoint: deps.runnerBrokerEndpoint,
        taskId: taskBinding.taskId,
        fetchImpl: deps.runnerFetch,
      });
      const runId = runnerRunIdForTask(taskBinding);
      await appendRunnerPlanEvidence(deps, {
        type: "runner.plan.requested",
        taskId: taskBinding.taskId,
        runId,
        role,
        taskBindingDigest: taskBinding.contentDigest,
      });
      let plan;
      try {
        plan = await executor.plan({ runId });
      } catch (cause) {
        await appendRunnerPlanEvidence(deps, {
          type: "runner.plan.failed",
          taskId: taskBinding.taskId,
          runId,
          role,
          taskBindingDigest: taskBinding.contentDigest,
          errorCode: runnerPlanFailureCode(cause),
        });
        const error = new Error("Validated Runner broker command plan is unavailable", { cause });
        error.code = "TIANGONG_RUNNER_PLAN_UNAVAILABLE";
        throw error;
      }
      await appendRunnerPlanEvidence(deps, {
        type: "runner.plan.received",
        taskId: taskBinding.taskId,
        runId,
        role,
        taskBindingDigest: taskBinding.contentDigest,
        planDigest: plan.contentDigest,
        commandDigest: sha256(canonicalJson(plan.command)),
        cwd: plan.cwd,
        timeoutMs: plan.timeoutMs,
        outputLimitBytes: plan.outputLimitBytes,
      });
      const expectedCwd = role === "implementor" ? "scratch/revision" : "fixture";
      if (plan.cwd !== expectedCwd) {
        const error = new Error("Runner broker command plan does not match the professional role");
        error.code = "TIANGONG_RUNNER_PLAN_INVALID";
        throw error;
      }
      const result = await runCommand({
        runId,
        command: plan.command,
        cwd: plan.cwd,
        timeoutMs: plan.timeoutMs,
        outputLimitBytes: plan.outputLimitBytes,
      }, {
        executor,
        journal: deps.runnerJournal,
        env: {
          TIANGONG_FORBIDDEN_ENV_NAMES: FORBIDDEN_ENV_KEYS.join(","),
          TIANGONG_FORBIDDEN_NETWORK_TARGETS: FORBIDDEN_NETWORK_TARGETS.join(","),
        },
      });
      if (result.outcome !== "completed") {
        const error = new Error(`Runner command outcome is uncertain (${result.reason})`);
        error.code = "TIANGONG_RUNNER_OUTCOME_UNCERTAIN";
        throw error;
      }
      return ok({
        taskId: taskBinding.taskId,
        outcome: result.outcome,
        invocationKey: result.invocationKey,
        replayed: result.replayed,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        runnerEvidence: result.runnerEvidence,
        executionPlanDigest: plan.contentDigest,
        changeRevisionRef: result.changeRevisionRef,
      });
    },
  });
}

export function createMemberToolRegistry({ deps }) {
  if (!deps?.rootDir || !PROFESSIONAL_ROLES.has(deps?.professionalRole) || !deps?.sourceProfileDigest || !deps?.sourceSkillId || !deps?.sourceSkillDigest) {
    throw new TypeError("createMemberToolRegistry requires team deps and source profile/skill binding");
  }
  const registry = new TiangongToolRegistry();
  const deploymentTool = createDeploymentTool(deps);

  registry.register({
    name: "team_resolve_task",
    label: "Tiangong team resolve assigned task",
    description:
      "Resolve the Task assigned to this Worker (sync first, then verify its immutable AgentTeams/Tiangong binding).",
    parameters: Type.Object({ taskId: ID }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx, invocation) {
      const { taskBinding } = await resolveAssignedTask(params.taskId, deps);
      const project = await assertLeaderInvocation(taskBinding, invocation, deps);
      const identity = loadWorkerIdentity(deps);
      const sourceRole = findRoleForWorker(project.roleBindings, identity.workerName);
      if (!sourceRole || sourceRole === "team_leader" || sourceRole !== deps.professionalRole) {
        throw new Error("Loaded professional RoleProfile does not match the Project role binding");
      }
      const workRun = await ensureWorkRun(taskBinding, deps, sourceRole);
      const resolved = ok({
        taskId: taskBinding.taskId,
        projectId: taskBinding.projectId,
        taskKind: taskBinding.taskKind,
        revisionIndex: taskBinding.revisionIndex,
        playbookStepId: taskBinding.playbookStepId,
        objective: taskBinding.objective,
        completionContractDigest: taskBinding.completionContractDigest,
        inputRefs: taskBinding.inputRefs,
        workRunId: workRun?.binding.runId ?? null,
        workRunPhase: workRun?.phase ?? null,
      });
      if (taskBinding.taskKind === "release" && deploymentTool) {
        return deploymentTool.execute(
          `tiangong-auto-deploy-${taskBinding.taskId}`,
          { taskId: taskBinding.taskId },
          _signal,
          _onUpdate,
          _ctx,
        );
      }
      return resolved;
    },
  });

  registerRunnerTool(registry, deps);

  registry.register({
    name: "team_submit_result",
    label: "Tiangong team submit ResultEnvelope",
    description:
      "Submit a schema-valid ResultEnvelope for the assigned Task. Producer, role, playbook, Task binding, profile, and Skill are bound by code.",
    parameters: Type.Object(
      {
        taskId: ID,
        claim: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
        blocker: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
        artifactRefs: Type.Optional(Type.Array(ID, { maxItems: 32 })),
        evidenceRefs: Type.Optional(Type.Array(ID, { maxItems: 32 })),
        changeRevisionRef: Type.Optional(CHANGE_REVISION_REF),
        releaseOutcome: Type.Optional(DEPLOYMENT_OUTCOME),
        revisionRequest: Type.Optional(Type.Object({
          summary: Type.String({ minLength: 1, maxLength: 4096 }),
        }, { additionalProperties: false })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx, invocation) {
      const identity = loadWorkerIdentity(deps);
      const { taskBinding } = await resolveAssignedTask(params.taskId, deps);
      const project = await assertLeaderInvocation(taskBinding, invocation, deps);
      const sourceRole = findRoleForWorker(project.roleBindings, identity.workerName);
      if (!sourceRole || sourceRole === "team_leader") {
        throw new Error("Assigned Worker has no professional role binding");
      }
      if (sourceRole !== deps.professionalRole) {
        throw new Error("Loaded professional RoleProfile does not match the Project role binding");
      }
      await assertRunnerProducedRevision(taskBinding, params, deps);
      if (taskBinding.taskKind === "release" && !params.blocker) {
        const outcome = createDeploymentOutcome(params.releaseOutcome);
        const completed = await deps.deploymentReceiptStore?.completedOutcome(outcome.contentDigest);
        if (!completed || canonicalJson(completed) !== canonicalJson(outcome)) {
          throw new Error("Release result requires a durable deployment receipt from this Worker");
        }
      }
      const workRun = await ensureWorkRun(taskBinding, deps, sourceRole);
      const result = createResultEnvelope({
        taskId: taskBinding.taskId,
        projectId: taskBinding.projectId,
        producer: identity.workerName,
        taskKind: taskBinding.taskKind,
        revisionIndex: taskBinding.revisionIndex,
        sourceRole,
        playbookDigest: project.playbookDigest,
        taskBindingDigest: taskBinding.contentDigest,
        completionContractDigest: taskBinding.completionContractDigest,
        sourceProfileDigest: deps.sourceProfileDigest,
        sourceSkillId: deps.sourceSkillId,
        skillDigest: deps.sourceSkillDigest,
        claim: params.claim,
        blocker: params.blocker,
        artifactRefs: params.artifactRefs,
        evidenceRefs: params.evidenceRefs,
        changeRevisionRef: params.changeRevisionRef,
        releaseOutcome: params.releaseOutcome,
        revisionRequest: params.revisionRequest,
        createdAt: nowISO(deps),
      });
      const submitted = await submitResult(result, deps);
      const finalizedWorkRun = await finalizeWorkRun(taskBinding, deps, sourceRole);
      return ok({
        taskId: submitted.result.taskId,
        producer: submitted.result.producer,
        workRunId: (finalizedWorkRun ?? workRun)?.binding.runId ?? null,
        workRunPhase: (finalizedWorkRun ?? workRun)?.phase ?? null,
        replayed: submitted.replayed,
        notified: submitted.notified,
        notificationQueued: submitted.notificationQueued,
        resultDigest: submitted.result.contentDigest,
      });
    },
  });

  const wrapped = new TiangongToolRegistry();
  for (const definition of registry.definitions()) {
    if (definition.name === "team_submit_result" && deploymentTool) wrapped.register(deploymentTool);
    wrapped.register(wrapTeamTool(definition, {
      gate: deps.gate,
      evidence: deps.evidence,
      getInvocation: deps.getInvocation,
      category: ["run_command", "run_test_command"].includes(definition.name)
        ? "isolated-execution"
        : "state-transition",
    }));
  }
  return wrapped;
}

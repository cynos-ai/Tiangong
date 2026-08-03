import { Type } from "typebox";

import { canonicalJson } from "../canonical-json.mjs";
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

const ID = Type.String({ pattern: "^[A-Za-z0-9._:-]{1,128}$" });
const DIGEST = Type.String({ pattern: "^[0-9a-f]{64}$" });
const PROFESSIONAL_ROLES = new Set(["designer", "implementor", "assessor", "operator"]);
const RUNNER_COMMAND = Type.Array(Type.String({ minLength: 1, maxLength: 8192 }), { minItems: 1, maxItems: 64 });
const RUNNER_OUTPUT_MAX = 64 * 1024;
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
function ok(details) {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

function runnerUnavailable() {
  const error = new Error("Validated Runner broker is unavailable for this Worker");
  error.code = "TIANGONG_RUNNER_UNAVAILABLE";
  return error;
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
  return createGatedTool({
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
}

function registerRunnerTool(registry, deps) {
  const role = deps.professionalRole;
  if (!new Set(["implementor", "assessor"]).has(role)) return;
  const toolName = role === "implementor" ? "run_command" : "run_test_command";
  const expectedTaskKind = role === "implementor" ? "implement" : "assess";
  registry.register({
    name: toolName,
    label: role === "implementor" ? "Tiangong isolated implementation command" : "Tiangong isolated assessment command",
    description: "Run a bounded command through the task-bound disposable Runner broker. The Worker never receives the container-runtime socket.",
    parameters: Type.Object({
      taskId: ID,
      command: RUNNER_COMMAND,
      timeoutMs: Type.Integer({ minimum: 1, maximum: 5 * 60 * 1000 }),
      outputLimitBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: RUNNER_OUTPUT_MAX })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx, invocation) {
      const { taskBinding } = await resolveAssignedTask(params.taskId, deps);
      await assertLeaderInvocation(taskBinding, invocation, deps);
      if (taskBinding.taskKind !== expectedTaskKind) {
        throw new Error(`${toolName} is not authorized for the assigned Task kind`);
      }
      if (typeof deps.runnerBrokerEndpoint !== "string" || !deps.runnerJournal) throw runnerUnavailable();
      const executor = createRunnerBrokerExecutor({
        endpoint: deps.runnerBrokerEndpoint,
        taskId: taskBinding.taskId,
        fetchImpl: deps.runnerFetch,
      });
      const result = await runCommand({
        runId: runnerRunIdForTask(taskBinding),
        command: params.command,
        cwd: role === "implementor" ? "scratch/revision" : "fixture",
        timeoutMs: params.timeoutMs,
        outputLimitBytes: params.outputLimitBytes ?? RUNNER_OUTPUT_MAX,
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

  registry.register({
    name: "team_resolve_task",
    label: "Tiangong team resolve assigned task",
    description:
      "Resolve the Task assigned to this Worker (sync first, then verify its immutable AgentTeams/Tiangong binding).",
    parameters: Type.Object({ taskId: ID }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx, invocation) {
      const { taskBinding } = await resolveAssignedTask(params.taskId, deps);
      await assertLeaderInvocation(taskBinding, invocation, deps);
      return ok({
        taskId: taskBinding.taskId,
        projectId: taskBinding.projectId,
        taskKind: taskBinding.taskKind,
        revisionIndex: taskBinding.revisionIndex,
        playbookStepId: taskBinding.playbookStepId,
        objective: taskBinding.objective,
        completionContractDigest: taskBinding.completionContractDigest,
        inputRefs: taskBinding.inputRefs,
      });
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
      return ok({
        taskId: submitted.result.taskId,
        producer: submitted.result.producer,
        replayed: submitted.replayed,
        notified: submitted.notified,
        notificationQueued: submitted.notificationQueued,
        resultDigest: submitted.result.contentDigest,
      });
    },
  });

  const wrapped = new TiangongToolRegistry();
  const deploymentTool = createDeploymentTool(deps);
  for (const definition of registry.definitions()) {
    if (definition.name === "team_submit_result" && deploymentTool) wrapped.register(deploymentTool);
    wrapped.register(wrapTeamTool(definition, {
      gate: deps.gate,
      evidence: deps.evidence,
      getInvocation: deps.getInvocation,
      category: definition.name === "team_resolve_task"
        ? "read-only"
        : (["run_command", "run_test_command"].includes(definition.name) ? "isolated-execution" : "state-transition"),
    }));
  }
  return wrapped;
}

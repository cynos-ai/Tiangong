import { Type } from "typebox";

import { findRoleForWorker } from "../playbook/transition-policy.mjs";
import { TiangongToolRegistry } from "../tools/registry.mjs";
import { createRunnerBrokerExecutor } from "../runner/broker-client.mjs";
import { runCommand, runnerRunIdForTask } from "../runner/runner-port.mjs";
import { readProjectBinding } from "../team/manifest-store.mjs";
import { assertProjectLeaderActor, loadWorkerIdentity } from "../team/team-context.mjs";
import { wrapTeamTool } from "../team/tool-wrapper.mjs";
import { resolveAssignedTask, submitResult } from "../team/team-task-port.mjs";
import { createResultEnvelope } from "./result-envelope.mjs";

const ID = Type.String({ pattern: "^[A-Za-z0-9._:-]{1,128}$" });
const DIGEST = Type.String({ pattern: "^[0-9a-f]{64}$" });
const PROFESSIONAL_ROLES = new Set(["designer", "implementor", "assessor", "operator"]);
const RUNNER_COMMAND = Type.Array(Type.String({ minLength: 1, maxLength: 8192 }), { minItems: 1, maxItems: 64 });
const RUNNER_CWD = Type.String({ pattern: "^[A-Za-z0-9._][A-Za-z0-9._/-]{0,254}$" });
const RUNNER_OUTPUT_MAX = 64 * 1024;
const CHANGE_REVISION_REF = Type.Object({
  producerTaskId: ID,
  artifactPath: Type.String({ minLength: 1, maxLength: 1024 }),
  artifactDigest: DIGEST,
  revision: Type.Integer({ minimum: 0 }),
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
      cwd: Type.Optional(RUNNER_CWD),
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
        cwd: params.cwd ?? "fixture",
        timeoutMs: params.timeoutMs,
        outputLimitBytes: params.outputLimitBytes ?? RUNNER_OUTPUT_MAX,
      }, { executor, journal: deps.runnerJournal, env: {} });
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
  for (const definition of registry.definitions()) {
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

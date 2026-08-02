import { Type } from "typebox";

import { findRoleForWorker } from "../playbook/transition-policy.mjs";
import { TiangongToolRegistry } from "../tools/registry.mjs";
import { readProjectBinding } from "../team/manifest-store.mjs";
import { loadWorkerIdentity } from "../team/team-context.mjs";
import { wrapTeamTool } from "../team/tool-wrapper.mjs";
import { resolveAssignedTask, submitResult } from "../team/team-task-port.mjs";
import { createResultEnvelope } from "./result-envelope.mjs";

const ID = Type.String({ pattern: "^[A-Za-z0-9._:-]{1,128}$" });
const DIGEST = Type.String({ pattern: "^[0-9a-f]{64}$" });
const PROFESSIONAL_ROLES = new Set(["designer", "implementor", "assessor", "operator"]);
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
    async execute(_toolCallId, params) {
      const { taskBinding } = await resolveAssignedTask(params.taskId, deps);
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
    async execute(_toolCallId, params) {
      const identity = loadWorkerIdentity(deps);
      const { taskBinding } = await resolveAssignedTask(params.taskId, deps);
      const project = await readProjectBinding(taskBinding.projectId, deps);
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
      category: definition.name === "team_resolve_task" ? "read-only" : "state-transition",
    }));
  }
  return wrapped;
}

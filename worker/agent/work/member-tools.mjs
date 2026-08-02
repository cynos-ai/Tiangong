// Professional-Worker (member) pi tool registry (architecture §6): the
// coordination surface every professional Worker shares — resolve the assigned
// Task and submit its result. A Worker only ever operates on a Task whose
// assignee is its authenticated identity; the producer is bound to that
// identity, not model input. The distinct professional work tools
// (designer read+plan-write, implementor runner, etc.) are the clean cut.

import { Type } from "typebox";

import { TiangongToolRegistry } from "../tools/registry.mjs";
import { readTaskBinding } from "../team/manifest-store.mjs";
import { loadWorkerIdentity } from "../team/team-context.mjs";
import { createTaskResult, resolveAssignedTask, submitResult } from "../team/team-task-port.mjs";

const ID = Type.String({ pattern: "^[A-Za-z0-9._:-]{1,128}$" });

function nowISO(deps) {
  const value = deps?.now?.();
  return typeof value === "string" ? value : new Date().toISOString();
}
function ok(details) {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

export function createMemberToolRegistry({ deps }) {
  if (!deps?.rootDir) {
    throw new TypeError("createMemberToolRegistry requires team deps (rootDir)");
  }
  const registry = new TiangongToolRegistry();

  registry.register({
    name: "team_resolve_task",
    label: "Tiangong team resolve assigned task",
    description:
      "Resolve the Task assigned to this Worker (sync first, then read + verify the assignee). Only the assigned Worker may call this.",
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
    label: "Tiangong team submit result",
    description:
      "Submit this Worker's result for its assigned Task. The producer is bound to the authenticated Worker identity. Re-submit of the same Task is an idempotent replay that does not re-notify the Leader.",
    parameters: Type.Object(
      {
        taskId: ID,
        summary: Type.String({ minLength: 1, maxLength: 4096 }),
        artifactRefs: Type.Optional(Type.Array(ID, { maxItems: 32 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const identity = loadWorkerIdentity(deps);
      const taskBinding = await readTaskBinding(params.taskId, deps);
      const result = createTaskResult({
        taskId: params.taskId,
        projectId: taskBinding.projectId,
        producer: identity.workerName,
        summary: params.summary,
        artifactRefs: params.artifactRefs,
        createdAt: nowISO(deps),
      });
      const submitted = await submitResult(result, deps);
      return ok({
        taskId: submitted.result.taskId,
        producer: submitted.result.producer,
        replayed: submitted.replayed,
        notified: submitted.notified,
        resultDigest: submitted.result.contentDigest,
      });
    },
  });

  return registry;
}

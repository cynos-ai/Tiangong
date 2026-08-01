import { Type } from "typebox";

import { sha256 } from "../canonical-json.mjs";
import { TiangongToolRegistry } from "../tools/registry.mjs";
import { createGatedTool } from "../tools/wrapper.mjs";

const TARGET = Type.Union([
  Type.Object({
    kind: Type.Literal("file"),
    path: Type.String({ minLength: 1, maxLength: 1024 }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal("directory_snapshot"),
    path: Type.String({ minLength: 1, maxLength: 1024 }),
    selection: Type.Object({
      includePrefixes: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 128 }),
      excludePrefixes: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 128 }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
]);

const TARGETS = Type.Array(TARGET, { minItems: 1, maxItems: 64 });

const DEFINITIONS = Object.freeze({
  start_work: Object.freeze({
    name: "start_work",
    label: "Start review work",
    description: "Create one durable review run from an objective, criteria, and bounded file/directory targets.",
    parameters: Type.Object({
      practiceId: Type.Literal("review"),
      objective: Type.String({ minLength: 1, maxLength: 4096 }),
      acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { minItems: 1, maxItems: 32 }),
      targets: TARGETS,
    }, { additionalProperties: false }),
  }),
  extend_scope: Object.freeze({
    name: "extend_scope",
    label: "Extend review scope",
    description: "Atomically append new immutable file/directory targets without changing the objective or criteria.",
    parameters: Type.Object({ targets: TARGETS }, { additionalProperties: false }),
  }),
  abandon_work: Object.freeze({
    name: "abandon_work",
    label: "Abandon review work",
    description: "End the active review run without claiming completion.",
    parameters: Type.Object({
      reasonCode: Type.Union([
        Type.Literal("superseded_by_new_request"), Type.Literal("unsupported_scope"),
        Type.Literal("cannot_complete"), Type.Literal("user_cancelled"), Type.Literal("other"),
      ]),
      summary: Type.String({ minLength: 1, maxLength: 8192 }),
    }, { additionalProperties: false }),
  }),
});

const SERVICE_METHODS = Object.freeze({
  start_work: Object.freeze({ prepare: "prepareStart", commit: "commitStart", phase: "practice.run.start" }),
  extend_scope: Object.freeze({ prepare: "prepareExtend", commit: "commitExtend", phase: "practice.scope.extend" }),
  abandon_work: Object.freeze({ prepare: "prepareAbandon", commit: "commitAbandon", phase: "practice.run.abandon" }),
});

function invocationForTool(invocation, toolCallId) {
  return {
    sessionId: invocation.sessionId,
    turnId: invocation.turnId,
    toolCallId,
    actor: invocation.actor,
    ingress: invocation.ingress,
    profileDigest: invocation.profileDigest,
  };
}

function toolResult(result) {
  const run = result.run;
  const targetRefs = run.scope.targets.map((target) => ({ targetId: target.targetId, kind: target.kind }));
  return {
    content: [{
      type: "text",
      text: `PracticeRun ${run.status}; revision ${run.revision}; scope targets ${run.scope.targets.length}; runtime target refs ${JSON.stringify(targetRefs)}.`,
    }],
    details: {
      replayed: result.replayed === true,
      stateEventId: result.stateEventId,
      stateEventHash: result.terminalHash,
      stateSequence: result.sequence,
      eventType: result.eventType,
      runId: run.runId,
      status: run.status,
      runRevision: run.revision,
      scopeRevision: run.scope.revision,
      scopeTargets: run.scope.targets.map((target) => ({
        targetId: target.targetId,
        kind: target.kind,
        snapshotIdentity: target.snapshot.identity,
      })),
      scopeDigest: run.scope.digest,
    },
  };
}

export function createReviewerStateToolRegistry({ service, gate, evidence, getInvocation }) {
  for (const [name, value] of Object.entries({ service, gate, evidence, getInvocation })) {
    if (!value) throw new TypeError(`${name} is required`);
  }
  const registry = new TiangongToolRegistry();
  for (const toolName of ["start_work", "extend_scope", "abandon_work"]) {
    const preparedByOperation = new WeakMap();
    const methods = SERVICE_METHODS[toolName];
    registry.register(createGatedTool({
      definition: DEFINITIONS[toolName],
      category: "state-transition",
      async summarize(params, { toolCallId, invocation }) {
        const prepared = await service[methods.prepare](params, invocationForTool(invocation, toolCallId));
        preparedByOperation.set(prepared.operation, prepared);
        return prepared.operation;
      },
      gate,
      evidence,
      getInvocation,
      async executeOperation({ operation, actionDigest, invocationKey, invocation }) {
        const prepared = preparedByOperation.get(operation);
        preparedByOperation.delete(operation);
        if (!prepared || sha256(operation) !== actionDigest
            || (prepared.replay?.actionDigest ?? prepared.actionDigest) !== actionDigest
            || (prepared.replay?.invocationKey ?? prepared.invocationKey) !== invocationKey) {
          throw new Error("Prepared PracticeRun transition does not match its wrapped operation");
        }
        const result = await service[methods.commit](prepared);
        invocation.observability?.checkpoint(methods.phase, {
          "tiangong.practice.id": result.run.practiceId,
          "tiangong.practice.status": result.run.status,
          "tiangong.practice.target_count": result.run.scope.targets.length,
          "tiangong.practice.revision": result.run.revision,
          "tiangong.operation.outcome": result.replayed ? "replayed" : "applied",
        });
        return toolResult(result);
      },
    }));
  }
  return registry;
}

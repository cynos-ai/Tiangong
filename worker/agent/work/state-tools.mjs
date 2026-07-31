import { Type } from "typebox";

import { sha256 } from "../canonical-json.mjs";
import { TiangongToolRegistry } from "../tools/registry.mjs";
import { createGatedTool } from "../tools/wrapper.mjs";

const FILES = Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), {
  minItems: 1,
  maxItems: 64,
});

const DEFINITIONS = Object.freeze({
  start_work: Object.freeze({
    name: "start_work",
    label: "Start review work",
    description: "Create one durable review run from an explicit objective, criteria, and file list.",
    parameters: Type.Object({
      practiceId: Type.Literal("review"),
      objective: Type.String({ minLength: 1, maxLength: 4096 }),
      acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
        minItems: 1,
        maxItems: 32,
      }),
      files: FILES,
    }, { additionalProperties: false }),
  }),
  extend_scope: Object.freeze({
    name: "extend_scope",
    label: "Extend review scope",
    description: "Append new explicit files to the active review run without changing its objective or criteria.",
    parameters: Type.Object({ files: FILES }, { additionalProperties: false }),
  }),
  abandon_work: Object.freeze({
    name: "abandon_work",
    label: "Abandon review work",
    description: "End the active review run without claiming completion.",
    parameters: Type.Object({
      reasonCode: Type.Union([
        Type.Literal("superseded_by_new_request"),
        Type.Literal("unsupported_scope"),
        Type.Literal("cannot_complete"),
        Type.Literal("user_cancelled"),
        Type.Literal("other"),
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
  const details = {
    replayed: result.replayed === true,
    stateEventId: result.stateEventId,
    stateEventHash: result.terminalHash,
    stateSequence: result.sequence,
    eventType: result.eventType,
    runId: run.runId,
    status: run.status,
    runRevision: run.revision,
    scopeRevision: run.scope.revision,
    scopeFiles: [...run.scope.files],
    scopeDigest: run.scope.digest,
  };
  return {
    content: [{
      type: "text",
      text: `PracticeRun ${run.status}; revision ${run.revision}; scope files ${run.scope.files.length}.`,
    }],
    details,
  };
}

export function createReviewerStateToolRegistry({
  service,
  gate,
  evidence,
  getInvocation,
}) {
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
      async executeOperation({ toolCallId, operation, actionDigest, invocationKey, invocation }) {
        const prepared = preparedByOperation.get(operation);
        preparedByOperation.delete(operation);
        if (!prepared || sha256(operation) !== actionDigest ||
            (prepared.replay?.actionDigest ?? prepared.actionDigest) !== actionDigest ||
            (prepared.replay?.invocationKey ?? prepared.invocationKey) !== invocationKey) {
          throw new Error("Prepared PracticeRun transition does not match its wrapped operation");
        }
        const result = await service[methods.commit](prepared);
        invocation.observability?.checkpoint(methods.phase, {
          "tiangong.practice.id": result.run.practiceId,
          "tiangong.practice.status": result.run.status,
          "tiangong.practice.scope_count": result.run.scope.files.length,
          "tiangong.practice.revision": result.run.revision,
          "tiangong.operation.outcome": result.replayed ? "replayed" : "applied",
        });
        return toolResult(result);
      },
    }));
  }
  return registry;
}

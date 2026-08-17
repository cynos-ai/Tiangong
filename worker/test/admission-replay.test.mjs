import assert from "node:assert/strict";
import test from "node:test";

import { createAdmissionHookHandlers } from "../agent/gates/admission-hooks.mjs";

const source = {
  channel: "matrix",
  actorId: "@human:example.test",
  messageId: "$event-1",
  route: "team-room",
  authenticated: true,
};

const binding = {
  workerName: "tiangong-openclaw-canary",
  runtimeLane: "openclaw-canary",
  configRevision: "config-1",
  capabilityRevision: "capability-1",
  allowedChannels: ["matrix"],
  active: true,
};

const request = {
  workerName: "tiangong-openclaw-canary",
  runtimeLane: "openclaw-canary",
  turnId: "matrix:$event-1",
  requestDigest: "request-digest-1",
  configRevision: "config-1",
  capabilityRevision: "capability-1",
};

function contextFor(phase, overrides = {}) {
  if (phase === "model") return { source, binding, request, ...overrides };
  return {
    admission: {
      phase: "model",
      source,
      workerName: request.workerName,
      runtimeLane: request.runtimeLane,
      turnId: request.turnId,
      requestDigest: request.requestDigest,
      configRevision: request.configRevision,
      capabilityRevision: request.capabilityRevision,
    },
    binding,
    toolName: "read",
    requestDigest: request.requestDigest,
    ...overrides,
  };
}

async function simulateTurn(handlers, { modelEvent = {}, toolEvent = {} } = {}) {
  const modelDecision = await handlers.beforeDispatch(modelEvent, {});
  if (modelDecision) return { modelDecision, modelCalls: 0, toolCalls: 0 };
  const toolDecision = await handlers.beforeToolCall(toolEvent, {});
  if (toolDecision) return { toolDecision, modelCalls: 1, toolCalls: 0 };
  return { modelCalls: 1, toolCalls: 1 };
}

test("allows an admitted turn through both OpenClaw stages", async () => {
  const handlers = createAdmissionHookHandlers({ resolveContext: ({ phase }) => contextFor(phase) });
  assert.deepEqual(await simulateTurn(handlers), { modelCalls: 1, toolCalls: 1 });
});

test("blocks before model work when the current binding is stale", async () => {
  const handlers = createAdmissionHookHandlers({
    resolveContext: ({ phase }) => contextFor(phase, { binding: { ...binding, active: false } }),
  });
  const first = await simulateTurn(handlers, { modelEvent: { content: "same request" } });
  const replay = await simulateTurn(handlers, { modelEvent: { content: "same request" } });
  assert.deepEqual(first, {
    modelDecision: {
      handled: true,
      text: "ADMISSION_BINDING_INACTIVE: This Worker turn is not admitted by the current Tiangong binding.",
    },
    modelCalls: 0,
    toolCalls: 0,
  });
  assert.deepEqual(replay, first);
});

test("blocks a changed or revoked tool after model admission", async () => {
  const changed = createAdmissionHookHandlers({
    resolveContext: ({ phase }) => phase === "model"
      ? contextFor(phase)
      : contextFor(phase, { requestDigest: "request-digest-2" }),
  });
  assert.deepEqual(await simulateTurn(changed), {
    toolDecision: {
      block: true,
      blockReason: "ADMISSION_REQUEST_CHANGED: This Worker turn is not admitted by the current Tiangong binding.",
    },
    modelCalls: 1,
    toolCalls: 0,
  });

  const revoked = createAdmissionHookHandlers({
    resolveContext: ({ phase }) => phase === "model"
      ? contextFor(phase)
      : contextFor(phase, { binding: { ...binding, revoked: true } }),
  });
  const decision = await simulateTurn(revoked);
  assert.equal(decision.toolDecision.block, true);
  assert.match(decision.toolDecision.blockReason, /^ADMISSION_REVOKED:/u);
});

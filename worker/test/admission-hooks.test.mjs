import assert from "node:assert/strict";
import test from "node:test";

import {
  createAdmissionHookHandlers,
  registerAdmissionHooks,
} from "../agent/gates/admission-hooks.mjs";

const binding = {
  workerName: "worker-one",
  runtimeLane: "openclaw-canary",
  configRevision: "config-1",
  capabilityRevision: "capability-1",
  allowedChannels: ["matrix"],
  active: true,
};
const source = {
  channel: "matrix",
  actorId: "@human:example.test",
  messageId: "$event-1",
  route: "team-room",
  authenticated: true,
};
const request = {
  workerName: "worker-one",
  runtimeLane: "openclaw-canary",
  turnId: "turn-1",
  requestDigest: "request-1",
  configRevision: "config-1",
  capabilityRevision: "capability-1",
};

test("blocks before-model and before-tool when the resolver cannot prove binding", async () => {
  const handlers = createAdmissionHookHandlers({ resolveContext: () => { throw new Error("missing"); } });
  assert.deepEqual(await handlers.beforeDispatch({ content: "secret" }, {}), {
    handled: true,
    text: "ADMISSION_CONTEXT_UNAVAILABLE: This Worker turn is not admitted by the current Tiangong binding.",
  });
  assert.deepEqual(await handlers.beforeToolCall({ toolName: "read" }, {}), {
    block: true,
    blockReason: "ADMISSION_CONTEXT_UNAVAILABLE: This Worker turn is not admitted by the current Tiangong binding.",
  });
});

test("passes only the exact two-stage admission result", async () => {
  const handlers = createAdmissionHookHandlers({
    resolveContext: ({ phase }) => phase === "model"
      ? { source, binding, request }
      : {
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
      },
  });
  assert.equal(await handlers.beforeDispatch({}, {}), undefined);
  assert.equal(await handlers.beforeToolCall({ toolName: "read" }, {}), undefined);
});

test("requires the OpenClaw hook API in the canary lane", () => {
  assert.deepEqual(registerAdmissionHooks({}, { resolveContext: () => {}, required: false }), {
    enabled: false,
    reason: "hook-api-unavailable",
  });
  assert.throws(
    () => registerAdmissionHooks({}, { resolveContext: () => {}, required: true }),
    /hook API is unavailable/,
  );
  const registrations = [];
  const result = registerAdmissionHooks({ on: (...args) => registrations.push(args) }, {
    resolveContext: () => {},
    required: true,
  });
  assert.deepEqual(result, { enabled: true, hooks: ["before_dispatch", "before_tool_call"] });
  assert.deepEqual(registrations.map(([name]) => name), ["before_dispatch", "before_tool_call"]);
});

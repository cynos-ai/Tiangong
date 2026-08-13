import assert from "node:assert/strict";
import test from "node:test";

import {
  AdmissionDeniedError,
  admitBeforeModel,
  admitBeforeTool,
} from "../agent/gates/admission-boundary.mjs";

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

function denied(code, fn) {
  assert.throws(fn, (error) => error instanceof AdmissionDeniedError && error.code === code);
}

test("admits an authenticated source against the current Worker binding", () => {
  const admission = admitBeforeModel({ source, binding: { ...binding }, request: { ...request } });
  assert.equal(admission.phase, "model");
  assert.equal(admission.source.actorId, source.actorId);
  assert.deepEqual(admitBeforeTool({
    admission,
    binding: { ...binding },
    toolName: "read",
    requestDigest: request.requestDigest,
  }).phase, "tool");
});

test("rejects unauthenticated, malformed, or wrong-route sources before the model", () => {
  denied("ADMISSION_SOURCE_UNAUTHENTICATED", () => admitBeforeModel({
    source: { ...source, authenticated: false }, binding, request,
  }));
  denied("ADMISSION_ACTOR_INVALID", () => admitBeforeModel({
    source: { ...source, actorId: "model-selected" }, binding, request,
  }));
  denied("ADMISSION_ROUTE_INVALID", () => admitBeforeModel({
    source: { ...source, route: "free-form-chat" }, binding, request,
  }));
});

test("rejects stale lane, config, and capability bindings before model admission", () => {
  denied("ADMISSION_BINDING_MISMATCH", () => admitBeforeModel({
    source, binding, request: { ...request, runtimeLane: "legacy-v0.2" },
  }));
  denied("ADMISSION_REVISION_STALE", () => admitBeforeModel({
    source, binding, request: { ...request, configRevision: "config-0" },
  }));
  denied("ADMISSION_BINDING_INACTIVE", () => admitBeforeModel({
    source, binding: { ...binding, active: false }, request,
  }));
});

test("rechecks revocation and exact request content before every tool", () => {
  const admission = admitBeforeModel({ source, binding, request });
  denied("ADMISSION_REVOKED", () => admitBeforeTool({
    admission, binding: { ...binding, revoked: true }, toolName: "read", requestDigest: request.requestDigest,
  }));
  denied("ADMISSION_REQUEST_CHANGED", () => admitBeforeTool({
    admission, binding, toolName: "read", requestDigest: "request-digest-2",
  }));
  denied("ADMISSION_REVISION_STALE", () => admitBeforeTool({
    admission, binding: { ...binding, capabilityRevision: "capability-2" }, toolName: "read", requestDigest: request.requestDigest,
  }));
});

test("denies a tool that is revoked or not in the current binding", () => {
  const admission = admitBeforeModel({ source, binding, request });
  denied("ADMISSION_TOOL_DENIED", () => admitBeforeTool({
    admission, binding: { ...binding, deniedTools: ["write"] }, toolName: "write", requestDigest: request.requestDigest,
  }));
  denied("ADMISSION_MODEL_REQUIRED", () => admitBeforeTool({
    binding, toolName: "read", requestDigest: request.requestDigest,
  }));
});

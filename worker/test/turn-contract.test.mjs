import assert from "node:assert/strict";
import test from "node:test";

import { createTurnRequest, createTurnResult } from "../agent/turn-contract.mjs";

function requestInput(overrides = {}) {
  return {
    attemptId: "attempt-one",
    turnId: "matrix:$event-one",
    sessionId: "session-one",
    prompt: "hello",
    workspaceDir: "/workspace",
    provider: "agentteams-gateway",
    modelId: "model-one",
    credential: "worker-token",
    actor: { id: "@peer:example.test", channel: "matrix", messageId: "$event-one" },
    ...overrides,
  };
}

const PEER_TARGET = Object.freeze({
  channel: "matrix",
  id: "@peer:example.test",
  source: "openclaw.matrix.group-only-sender",
});
const OTHER_TARGET = Object.freeze({
  channel: "matrix",
  id: "@other:example.test",
  source: "openclaw.matrix.group-only-sender",
});

test("carries a validated peer reply target from request into result", () => {
  const request = createTurnRequest(requestInput({ replyTarget: PEER_TARGET }));
  const result = createTurnResult(request, { text: "pong" });

  assert.deepEqual(request.replyTarget, PEER_TARGET);
  assert.deepEqual(result.replyTarget, PEER_TARGET);
  assert.equal(Object.isFrozen(request.replyTarget), true);
  assert.equal(Object.isFrozen(result.replyTarget), true);
  assert.equal(JSON.stringify(request).includes("worker-token"), false);
});

test("uses explicit empty peer authority when no Matrix peer context was authenticated", () => {
  const request = createTurnRequest(requestInput());
  const result = createTurnResult(request, { text: "answer" });
  assert.equal(request.replyTarget, null);
  assert.deepEqual(request.authorizedPeerTargets, []);
  assert.equal(Object.isFrozen(request.authorizedPeerTargets), true);
  assert.equal(result.replyTarget, null);
});

test("rejects malformed or unsupported reply targets", () => {
  const invalidTargets = [
    "@peer:example.test",
    { channel: "matrix", id: "peer", source: "openclaw.matrix.group-only-sender" },
    { channel: "matrix", id: "@peer:example.test", source: "model" },
    { channel: "webchat", id: "@peer:example.test", source: "openclaw.matrix.group-only-sender" },
  ];
  for (const replyTarget of invalidTargets) {
    assert.throws(() => createTurnRequest(requestInput({ replyTarget })), /reply target/iu);
  }
});

test("allows deterministic correlation to suppress but not exceed authenticated peer authority", () => {
  const request = createTurnRequest(requestInput({ replyTarget: PEER_TARGET }));
  assert.equal(createTurnResult(request, { text: "done", replyTarget: null }).replyTarget, null);
  assert.throws(
    () => createTurnResult(request, { text: "pong", replyTarget: OTHER_TARGET }),
    /not authorized/,
  );

  const outbound = createTurnRequest(requestInput({ authorizedPeerTargets: [OTHER_TARGET] }));
  assert.deepEqual(outbound.authorizedPeerTargets, [OTHER_TARGET]);
  assert.deepEqual(createTurnResult(outbound, { text: "ping", replyTarget: OTHER_TARGET }).replyTarget, OTHER_TARGET);
});

test("rejects malformed, duplicate, or unbounded authorized peer targets", () => {
  assert.throws(
    () => createTurnRequest(requestInput({ authorizedPeerTargets: [PEER_TARGET, PEER_TARGET] })),
    /must be unique/,
  );
  assert.throws(
    () => createTurnRequest(requestInput({ authorizedPeerTargets: Array.from({ length: 33 }, () => PEER_TARGET) })),
    /bounded array/,
  );
  assert.throws(
    () => createTurnRequest(requestInput({ authorizedPeerTargets: [null] })),
    /cannot contain null/,
  );
});

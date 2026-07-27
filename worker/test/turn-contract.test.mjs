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

test("carries a validated peer reply target from request into result", () => {
  const request = createTurnRequest(requestInput({ replyTarget: PEER_TARGET }));
  const result = createTurnResult(request, { text: "pong" });

  assert.deepEqual(request.replyTarget, PEER_TARGET);
  assert.deepEqual(result.replyTarget, PEER_TARGET);
  assert.equal(Object.isFrozen(request.replyTarget), true);
  assert.equal(Object.isFrozen(result.replyTarget), true);
  assert.equal(JSON.stringify(request).includes("worker-token"), false);
});

test("uses an explicit null when no reply target was authenticated", () => {
  const request = createTurnRequest(requestInput());
  const result = createTurnResult(request, { text: "answer" });
  assert.equal(request.replyTarget, null);
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

test("allows deterministic correlation to suppress but not redirect a reply target", () => {
  const request = createTurnRequest(requestInput({ replyTarget: PEER_TARGET }));
  assert.equal(createTurnResult(request, { text: "done", replyTarget: null }).replyTarget, null);
  assert.throws(
    () => createTurnResult(request, {
      text: "pong",
      replyTarget: {
        channel: "matrix",
        id: "@other:example.test",
        source: "openclaw.matrix.group-only-sender",
      },
    }),
    /cannot redirect.*replyTarget/,
  );
});

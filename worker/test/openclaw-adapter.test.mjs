import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAttemptResult,
  createTiangongPiHarness,
  toTurnRequest,
} from "../plugin/openclaw-adapter.mjs";

function attemptParams(overrides = {}) {
  return {
    abortSignal: new AbortController().signal,
    config: {
      channels: {
        matrix: {
          dm: { policy: "allowlist", allowFrom: ["@leader:example.test", "@admin:example.test"] },
          groupAllowFrom: [
            "@leader:example.test",
            "@admin:example.test",
            "@peer:example.test",
          ],
          groupPolicy: "allowlist",
        },
      },
      secrets: { matrixAccessToken: "matrix-secret" },
    },
    bootstrapPromptWarningSignature: undefined,
    bootstrapPromptWarningSignaturesSeen: [],
    currentMessageId: "$event-one",
    messageChannel: "matrix",
    model: { api: "openai-completions" },
    modelId: "model-one",
    prompt: "hello",
    provider: "agentteams-gateway",
    resolvedApiKey: "worker-token",
    runId: "attempt-one",
    senderId: "@user:example.test",
    senderIsOwner: true,
    sessionId: "session-one",
    thinkLevel: "off",
    workspaceDir: "/workspace",
    ...overrides,
  };
}

function turnResult(overrides = {}) {
  return {
    text: "answer",
    replyTarget: null,
    usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 15 },
    pendingApproval: null,
    hadPotentialSideEffects: false,
    ...overrides,
  };
}

test("claims only the AgentTeams gateway provider", async (t) => {
  const harness = createTiangongPiHarness({
    runtime: { dispose() {}, reset() {}, runTurn() {} },
  });
  t.after(() => harness.dispose());
  assert.equal(harness.id, "tiangong-pi");
  assert.equal(harness.supports({ provider: "agentteams-gateway" }).supported, true);
  assert.equal(harness.supports({ provider: "another-provider" }).supported, false);
});

test("maps OpenClaw parameters to a stable non-secret TurnRequest", () => {
  const request = toTurnRequest(attemptParams());
  assert.equal(request.turnId, "matrix:$event-one");
  assert.equal(request.actor.id, "@user:example.test");
  assert.equal(request.replyTarget, null);
  assert.equal(Object.hasOwn(request.actor, "isOwner"), false);
  assert.equal(request.credential, "worker-token");
  assert.equal(JSON.stringify(request).includes("worker-token"), false);
  assert.equal(JSON.stringify(request).includes("matrix-secret"), false);
  assert.equal(Object.keys(request).includes("credential"), false);
});

test("derives a Matrix reply target only for a group-only allowed sender", () => {
  const request = toTurnRequest(attemptParams({ senderId: "@peer:example.test" }));
  assert.deepEqual(request.replyTarget, {
    channel: "matrix",
    id: "@peer:example.test",
    source: "openclaw.matrix.group-only-sender",
  });

  for (const senderId of ["@admin:example.test", "@leader:example.test", "@unknown:example.test"]) {
    assert.equal(toTurnRequest(attemptParams({ senderId })).replyTarget, null);
  }
});

test("fails closed when Matrix peer policy facts are incomplete or malformed", () => {
  const cases = [
    { messageChannel: "webchat", senderId: "@peer:example.test" },
    { senderId: "not-an-mxid" },
    { config: {} },
    { config: { channels: { matrix: { groupPolicy: "allowlist", groupAllowFrom: ["@peer:example.test"], dm: { policy: "allowlist" } } } } },
    { config: { channels: { matrix: { groupPolicy: "open", groupAllowFrom: ["@peer:example.test"], dm: { policy: "allowlist", allowFrom: [] } } } } },
    { config: { channels: { matrix: { groupPolicy: "allowlist", groupAllowFrom: ["@peer:example.test"], dm: { policy: "open", allowFrom: [] } } } } },
  ];
  for (const overrides of cases) {
    assert.equal(toTurnRequest(attemptParams(overrides)).replyTarget, null);
  }
});

test("projects a Tiangong result into the OpenClaw attempt contract", () => {
  const result = buildAttemptResult(attemptParams(), { result: turnResult() });

  assert.equal(result.promptError, null);
  assert.deepEqual(result.assistantTexts, ["answer"]);
  assert.equal(result.lastAssistant.content[0].text, "answer");
  assert.equal(result.lastAssistant.provider, "agentteams-gateway");
  assert.equal(result.attemptUsage.total, 15);
  assert.deepEqual(result.replayMetadata, { hadPotentialSideEffects: false, replaySafe: true });
});

test("projects a validated reply target as a visible full-MXID prefix", () => {
  const targeted = turnResult({
    replyTarget: {
      channel: "matrix",
      id: "@peer:example.test",
      source: "openclaw.matrix.group-only-sender",
    },
  });
  const prefixed = buildAttemptResult(attemptParams(), { result: targeted });
  assert.deepEqual(prefixed.assistantTexts, ["@peer:example.test answer"]);
  assert.equal(prefixed.lastAssistant.content[0].text, "@peer:example.test answer");

  const existing = buildAttemptResult(attemptParams(), {
    result: { ...targeted, text: "answer for @peer:example.test" },
  });
  assert.deepEqual(existing.assistantTexts, ["answer for @peer:example.test"]);

  assert.throws(
    () => buildAttemptResult(attemptParams(), {
      result: { ...targeted, replyTarget: { ...targeted.replyTarget, id: "not-an-mxid" } },
    }),
    /reply target/,
  );
});

test("reports prompt failures without inventing assistant text", () => {
  const result = buildAttemptResult(attemptParams(), { promptError: new Error("failed") });

  assert.equal(result.promptError.message, "failed");
  assert.deepEqual(result.assistantTexts, []);
  assert.equal(result.lastAssistant.stopReason, "error");
});

test("delegates the attempt to the Tiangong runtime through the DTO boundary", async (t) => {
  let received;
  const runtime = {
    async runTurn(request) {
      received = request;
      return turnResult();
    },
    async reset() {},
    async dispose() {},
  };
  const harness = createTiangongPiHarness({ runtime });
  t.after(() => harness.dispose());
  const result = await harness.runAttempt(attemptParams({ senderId: "@peer:example.test" }));
  assert.equal(received.sessionId, "session-one");
  assert.equal(received.replyTarget.id, "@peer:example.test");
  assert.equal(result.lastAssistant.content[0].text, "answer");
});

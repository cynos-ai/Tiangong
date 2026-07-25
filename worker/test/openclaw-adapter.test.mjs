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
  assert.equal(Object.hasOwn(request.actor, "isOwner"), false);
  assert.equal(request.credential, "worker-token");
  assert.equal(JSON.stringify(request).includes("worker-token"), false);
  assert.equal(Object.keys(request).includes("credential"), false);
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
  const result = await harness.runAttempt(attemptParams());
  assert.equal(received.sessionId, "session-one");
  assert.equal(result.lastAssistant.content[0].text, "answer");
});

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    timeoutMs: 1_000,
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

function observabilityRecorder() {
  const attempts = [];
  let shutdowns = 0;
  const observability = {
    startAttempt(metadata) {
      const attempt = { metadata, finishes: [] };
      attempts.push(attempt);
      return {
        checkpoint() {},
        startOperation() { return { end() {} }; },
        finish(outcome, error) { attempt.finishes.push({ outcome, error }); },
      };
    },
    async shutdown() { shutdowns += 1; },
  };
  return { attempts, observability, shutdowns: () => shutdowns };
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
  assert.deepEqual(request.authorizedPeerTargets, []);
  assert.equal(Object.hasOwn(request.actor, "isOwner"), false);
  assert.equal(request.credential, "worker-token");
  assert.equal(JSON.stringify(request).includes("worker-token"), false);
  assert.equal(JSON.stringify(request).includes("matrix-secret"), false);
  assert.equal(Object.keys(request).includes("credential"), false);
});

test("derives Matrix peer authority only from authenticated effective allowlists", () => {
  const peer = {
    channel: "matrix",
    id: "@peer:example.test",
    source: "openclaw.matrix.group-only-sender",
  };
  const request = toTurnRequest(attemptParams({ senderId: "@peer:example.test" }));
  assert.deepEqual(request.replyTarget, peer);
  assert.deepEqual(request.authorizedPeerTargets, []);

  for (const senderId of ["@admin:example.test", "@leader:example.test"]) {
    const trustedIngress = toTurnRequest(attemptParams({ senderId }));
    assert.equal(trustedIngress.replyTarget, null);
    assert.deepEqual(trustedIngress.authorizedPeerTargets, [peer]);
  }
  const unknown = toTurnRequest(attemptParams({ senderId: "@unknown:example.test" }));
  assert.equal(unknown.replyTarget, null);
  assert.deepEqual(unknown.authorizedPeerTargets, []);
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
    const request = toTurnRequest(attemptParams(overrides));
    assert.equal(request.replyTarget, null);
    assert.deepEqual(request.authorizedPeerTargets, []);
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

test("appends authoritative machine status and escapes model status markers", () => {
  const workStatus = {
    assurance: "worker-local",
    runId: "run-one",
    practiceId: "review",
    state: "done",
    checkpoint: "passed",
    scopeRevision: 2,
    scopeTargetCount: 2,
  };
  const result = buildAttemptResult(attemptParams(), {
    result: turnResult({ text: "Tiangong machine status is model prose", workStatus }),
  });
  const text = result.lastAssistant.content[0].text;
  assert.match(text, /Tiangong model-provided status text is model prose/u);
  assert.match(text, /---\nTiangong machine status\nassurance: worker-local/u);
  assert.match(text, /verification: static-review-only/u);
});

test("reports prompt failures without inventing assistant text", () => {
  const result = buildAttemptResult(attemptParams(), { promptError: new Error("failed") });

  assert.equal(result.promptError.message, "failed");
  assert.deepEqual(result.assistantTexts, []);
  assert.equal(result.lastAssistant.stopReason, "error");
});

test("delegates the attempt and its trace through the Tiangong runtime boundary", async (t) => {
  let received;
  let receivedTrace;
  const recorded = observabilityRecorder();
  const runtime = {
    async runTurn(request, attemptTrace) {
      received = request;
      receivedTrace = attemptTrace;
      return turnResult();
    },
    async reset() {},
    async dispose() {},
  };
  const harness = createTiangongPiHarness({ observability: recorded.observability, runtime });
  t.after(() => harness.dispose());
  const result = await harness.runAttempt(attemptParams({ senderId: "@peer:example.test" }));
  assert.equal(received.sessionId, "session-one");
  assert.equal(received.replyTarget.id, "@peer:example.test");
  assert.ok(receivedTrace);
  assert.deepEqual(recorded.attempts[0].metadata, {
    harnessId: "tiangong-pi",
    attemptId: "attempt-one",
    turnId: "matrix:$event-one",
    sessionId: "session-one",
    provider: "agentteams-gateway",
    modelId: "model-one",
    timeoutMs: 1_000,
  });
  assert.deepEqual(recorded.attempts[0].finishes, [{ outcome: "complete", error: undefined }]);
  assert.equal(result.lastAssistant.content[0].text, "answer");
});

test("marks Harness ingress before waiting for the Tiangong turn", async (t) => {
  const evidenceDir = await mkdtemp(join(tmpdir(), "tiangong-harness-"));
  const evidencePath = join(evidenceDir, "last-run");
  t.after(() => rm(evidenceDir, { recursive: true, force: true }));

  let finishTurn;
  let noteTurnStarted;
  const turnStarted = new Promise((resolve) => {
    noteTurnStarted = resolve;
  });
  const turnFinished = new Promise((resolve) => {
    finishTurn = resolve;
  });
  const runtime = {
    async runTurn() {
      noteTurnStarted();
      return await turnFinished;
    },
    async reset() {},
    async dispose() {},
  };
  const harness = createTiangongPiHarness({ evidencePath, runtime });
  t.after(() => harness.dispose());

  const attempt = harness.runAttempt(attemptParams());
  await turnStarted;
  const runningMarker = await readFile(evidencePath, "utf8");
  assert.match(runningMarker, /^harness=tiangong-pi$/mu);
  assert.match(runningMarker, /^status=running$/mu);
  assert.doesNotMatch(runningMarker, /worker-token|matrix-secret/u);

  finishTurn(turnResult());
  await attempt;
  const completedMarker = await readFile(evidencePath, "utf8");
  assert.match(completedMarker, /^status=pass$/mu);
  assert.doesNotMatch(completedMarker, /^status=running$/mu);
});

test("enforces the OpenClaw Harness attempt timeout", async (t) => {
  const evidenceDir = await mkdtemp(join(tmpdir(), "tiangong-harness-timeout-"));
  const evidencePath = join(evidenceDir, "last-run");
  t.after(() => rm(evidenceDir, { recursive: true, force: true }));

  const runtime = {
    async runTurn(request) {
      return await new Promise((resolve, reject) => {
        request.abortSignal.addEventListener("abort", () => reject(request.abortSignal.reason), { once: true });
      });
    },
    async reset() {},
    async dispose() {},
  };
  const recorded = observabilityRecorder();
  const harness = createTiangongPiHarness({
    evidencePath,
    observability: recorded.observability,
    runtime,
  });
  t.after(() => harness.dispose());

  const result = await harness.runAttempt(attemptParams({ timeoutMs: 10 }));
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, true);
  assert.match(result.promptError.message, /timeout after 10ms/u);
  assert.equal(recorded.attempts[0].finishes[0].outcome, "timeout");
  const marker = await readFile(evidencePath, "utf8");
  assert.match(marker, /^status=error$/mu);
  assert.doesNotMatch(marker, /worker-token|matrix-secret/u);
});

test("rejects a missing OpenClaw Harness attempt timeout", async (t) => {
  const evidenceDir = await mkdtemp(join(tmpdir(), "tiangong-harness-timeout-invalid-"));
  const evidencePath = join(evidenceDir, "last-run");
  t.after(() => rm(evidenceDir, { recursive: true, force: true }));

  let calls = 0;
  const runtime = {
    async runTurn() {
      calls += 1;
      return turnResult();
    },
    async reset() {},
    async dispose() {},
  };
  const harness = createTiangongPiHarness({ evidencePath, runtime });
  t.after(() => harness.dispose());

  const result = await harness.runAttempt(attemptParams({ timeoutMs: 0 }));
  assert.equal(calls, 0);
  assert.match(result.promptError.message, /positive OpenClaw Harness attempt timeout/u);
  const marker = await readFile(evidencePath, "utf8");
  assert.match(marker, /^status=error$/mu);
});

test("preserves an upstream abort without calling the runtime", async (t) => {
  const evidenceDir = await mkdtemp(join(tmpdir(), "tiangong-harness-abort-"));
  const evidencePath = join(evidenceDir, "last-run");
  t.after(() => rm(evidenceDir, { recursive: true, force: true }));

  let calls = 0;
  const runtime = {
    async runTurn() {
      calls += 1;
      return turnResult();
    },
    async reset() {},
    async dispose() {},
  };
  const controller = new AbortController();
  controller.abort(new Error("operator cancelled"));
  const recorded = observabilityRecorder();
  const harness = createTiangongPiHarness({
    evidencePath,
    observability: recorded.observability,
    runtime,
  });
  t.after(() => harness.dispose());

  const result = await harness.runAttempt(attemptParams({ abortSignal: controller.signal }));
  assert.equal(calls, 0);
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.promptError.message, "operator cancelled");
  assert.equal(recorded.attempts[0].finishes[0].outcome, "upstream_abort");
  const marker = await readFile(evidencePath, "utf8");
  assert.match(marker, /^status=error$/mu);
});

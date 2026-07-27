import assert from "node:assert/strict";
import test from "node:test";

import { createPiSessionTraceObserver } from "../observability/pi-session-tracing.mjs";

function recorder() {
  const operations = [];
  const checkpoints = [];
  return {
    operations,
    checkpoints,
    observability: {
      checkpoint(phase, attributes = {}) {
        checkpoints.push({ phase, attributes });
      },
      startOperation(name, attributes = {}) {
        const operation = { name, attributes, ends: [] };
        operations.push(operation);
        return {
          end(outcome, error) {
            operation.ends.push({ outcome, error });
          },
        };
      },
    },
  };
}

function request(signal = new AbortController().signal) {
  return {
    provider: "agentteams-gateway",
    modelId: "model-one",
    abortSignal: signal,
  };
}

function assistantEvent(type, stopReason = "stop") {
  return {
    type,
    message: { role: "assistant", stopReason, content: "secret response" },
    assistantMessageEvent: { type: "text_delta", delta: "secret token" },
  };
}

test("separates pi turn, provider response, and streamed model progress", () => {
  const recorded = recorder();
  const observer = createPiSessionTraceObserver(recorded.observability, request(), { now: () => 1_000 });

  observer.handle({ type: "turn_start" });
  observer.providerRequestReady();
  observer.providerResponseReceived();
  observer.handle(assistantEvent("message_start"));
  observer.handle(assistantEvent("message_update"));
  observer.handle(assistantEvent("message_end"));
  observer.finish();

  assert.equal(recorded.operations.length, 1);
  assert.deepEqual(recorded.operations[0], {
    name: "gen_ai.chat",
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "agentteams-gateway",
      "gen_ai.request.model": "model-one",
    },
    ends: [{ outcome: "complete", error: undefined }],
  });
  assert.deepEqual(recorded.checkpoints, [
    { phase: "pi.turn.start", attributes: {} },
    { phase: "model.request.ready", attributes: {} },
    { phase: "model.response.received", attributes: {} },
    { phase: "model.response.start", attributes: {} },
    { phase: "model.response.progress", attributes: {} },
  ]);
  assert.equal(JSON.stringify(recorded).includes("secret"), false);
});

test("coalesces real stream updates into a bounded progress signal", () => {
  let observedAt = 0;
  const recorded = recorder();
  const observer = createPiSessionTraceObserver(recorded.observability, request(), {
    now: () => observedAt,
    progressIntervalMs: 60_000,
    maxProgressCheckpoints: 2,
  });

  observer.handle({ type: "turn_start" });
  observer.providerRequestReady();
  observer.handle(assistantEvent("message_start"));
  observer.handle(assistantEvent("message_update"));
  observedAt = 59_999;
  observer.handle(assistantEvent("message_update"));
  observedAt = 60_000;
  observer.handle(assistantEvent("message_update"));
  observedAt = 180_000;
  observer.handle(assistantEvent("message_update"));
  observer.handle(assistantEvent("message_end"));

  assert.equal(
    recorded.checkpoints.filter(({ phase }) => phase === "model.response.progress").length,
    2,
  );
  assert.equal(
    recorded.checkpoints.filter(({ phase }) => phase === "model.response.start").length,
    1,
  );
});

test("records bounded session retry facts without its error content", () => {
  const recorded = recorder();
  const observer = createPiSessionTraceObserver(recorded.observability, request());

  observer.handle({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "secret" });

  assert.deepEqual(recorded.checkpoints, [{
    phase: "model.retry",
    attributes: {
      "tiangong.retry.attempt": 1,
      "tiangong.retry.max_attempts": 3,
    },
  }]);
  assert.equal(JSON.stringify(recorded).includes("secret"), false);
});

test("does not call an error-only assistant message a provider response start", () => {
  const recorded = recorder();
  const observer = createPiSessionTraceObserver(recorded.observability, request());

  observer.handle({ type: "turn_start" });
  observer.providerRequestReady();
  observer.handle(assistantEvent("message_start", "error"));
  observer.handle(assistantEvent("message_end", "error"));

  assert.equal(
    recorded.checkpoints.some(({ phase }) => phase === "model.response.start"),
    false,
  );
  assert.equal(recorded.operations[0].ends[0].outcome, "error");
});

test("classifies an aborted provider operation without exporting its reason", () => {
  const controller = new AbortController();
  const recorded = recorder();
  const observer = createPiSessionTraceObserver(recorded.observability, request(controller.signal));

  observer.handle({ type: "turn_start" });
  observer.providerRequestReady();
  controller.abort(new Error("operator secret cancellation reason"));
  observer.handle(assistantEvent("message_end", "aborted"));

  assert.equal(recorded.operations[0].ends[0].outcome, "upstream_abort");
  assert.equal(recorded.operations[0].ends[0].error, undefined);
  assert.equal(JSON.stringify(recorded).includes("operator secret"), false);
});

test("closes a provider operation left active by a prompt failure", () => {
  const recorded = recorder();
  const observer = createPiSessionTraceObserver(recorded.observability, request());
  const failure = Object.assign(new Error("sensitive provider body"), { code: "MODEL_FAILED" });

  observer.handle({ type: "turn_start" });
  observer.providerRequestReady();
  observer.finish(failure);

  assert.equal(recorded.operations[0].ends[0].outcome, "error");
  assert.equal(recorded.operations[0].ends[0].error, failure);
});

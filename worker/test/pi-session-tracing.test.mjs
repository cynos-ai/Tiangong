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

test("maps each pi model turn and retry to sanitized lifecycle operations", () => {
  const recorded = recorder();
  const observer = createPiSessionTraceObserver(recorded.observability, request());

  observer.handle({ type: "turn_start" });
  observer.handle({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "secret" });
  observer.handle({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: "secret response" },
  });
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
    { phase: "model.start", attributes: {} },
    {
      phase: "model.retry",
      attributes: {
        "tiangong.retry.attempt": 1,
        "tiangong.retry.max_attempts": 3,
      },
    },
  ]);
  assert.equal(JSON.stringify(recorded).includes("secret"), false);
});

test("classifies an aborted pi model turn without exporting its reason", () => {
  const controller = new AbortController();
  const recorded = recorder();
  const observer = createPiSessionTraceObserver(recorded.observability, request(controller.signal));

  observer.handle({ type: "turn_start" });
  controller.abort(new Error("operator secret cancellation reason"));
  observer.handle({
    type: "message_end",
    message: { role: "assistant", stopReason: "aborted" },
  });

  assert.equal(recorded.operations[0].ends[0].outcome, "upstream_abort");
  assert.equal(recorded.operations[0].ends[0].error, undefined);
  assert.equal(JSON.stringify(recorded).includes("operator secret"), false);
});

test("closes a model operation left active by a prompt failure", () => {
  const recorded = recorder();
  const observer = createPiSessionTraceObserver(recorded.observability, request());
  const failure = Object.assign(new Error("sensitive provider body"), { code: "MODEL_FAILED" });

  observer.handle({ type: "turn_start" });
  observer.finish(failure);

  assert.equal(recorded.operations[0].ends[0].outcome, "error");
  assert.equal(recorded.operations[0].ends[0].error, failure);
});

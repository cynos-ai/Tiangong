import assert from "node:assert/strict";
import test from "node:test";

import { createProviderTraceBridge } from "../observability/provider-tracing.mjs";

function extensionHarness() {
  const handlers = new Map();
  return {
    handlers,
    pi: {
      on(name, handler) {
        handlers.set(name, handler);
      },
    },
  };
}

test("maps trusted provider hooks without reading payload, headers, or response content", async () => {
  const bridge = createProviderTraceBridge();
  const harness = extensionHarness();
  const calls = [];
  bridge.extension(harness.pi);
  const release = bridge.bind({
    providerRequestReady() { calls.push("request.ready"); },
    providerResponseReceived() { calls.push("response.received"); },
  });

  await harness.handlers.get("before_provider_request")({
    payload: { prompt: "secret prompt" },
  });
  await harness.handlers.get("after_provider_response")({
    status: 200,
    headers: { authorization: "secret credential" },
  });
  release();
  await harness.handlers.get("before_provider_request")({ payload: "later secret" });

  assert.deepEqual(calls, ["request.ready", "response.received"]);
  assert.equal(JSON.stringify(calls).includes("secret"), false);
});

test("allows only one active turn binding and releases idempotently", () => {
  const bridge = createProviderTraceBridge();
  const first = {};
  const release = bridge.bind(first);

  assert.throws(() => bridge.bind({}), /already bound/u);
  release();
  release();
  const releaseSecond = bridge.bind({});
  assert.doesNotThrow(releaseSecond);
});

import assert from "node:assert/strict";
import test from "node:test";
import { AdmissionDeniedError } from "../agent/gates/admission-boundary.mjs";
import { createControlAdmissionResolver } from "../agent/gates/admission-context.mjs";

const context = {
  source: { channel: "matrix", actorId: "@human:example.test", messageId: "$event", route: "team-room", authenticated: true },
  binding: { workerName: "worker-one", runtimeLane: "openclaw-canary", configRevision: "c1", capabilityRevision: "k1", active: true, allowedChannels: ["matrix"] },
  request: { workerName: "worker-one", runtimeLane: "openclaw-canary", turnId: "turn-1", requestDigest: "digest-1", configRevision: "c1", capabilityRevision: "k1" },
};

test("resolves a bounded admission context through the control API", async () => {
  let request;
  const resolve = createControlAdmissionResolver({
    url: "http://control.test/admission",
    fetchImpl: async (url, options) => {
      request = { url: url.href, options };
      return { ok: true, text: async () => JSON.stringify(context) };
    },
  });
  assert.deepEqual(await resolve({ phase: "model", event: { content: "hello" }, ctx: {} }), context);
  assert.equal(request.url, "http://control.test/admission");
  assert.equal(request.options.method, "POST");
});

test("fails closed on unavailable, malformed, oversized, and timed-out context", async () => {
  const cases = [
    [async () => ({ ok: false, text: async () => "{}" }), "ADMISSION_CONTEXT_UNAVAILABLE"],
    [async () => ({ ok: true, text: async () => "not-json" }), "ADMISSION_CONTEXT_INVALID"],
    [async () => ({ ok: true, text: async () => "x".repeat(64 * 1024 + 1) }), "ADMISSION_CONTEXT_INVALID"],
    [async (_url, { signal }) => await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("timeout"), { name: "AbortError" })))), "ADMISSION_CONTEXT_TIMEOUT"],
  ];
  for (const [fetchImpl, code] of cases) {
    const resolve = createControlAdmissionResolver({ url: "http://control.test/admission", fetchImpl, timeoutMs: 5 });
    await assert.rejects(resolve({ phase: "model" }), (error) => error instanceof AdmissionDeniedError && error.code === code);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODEX_BRIDGE_TRANSPORT,
  CODEX_NATIVE_TRANSPORT,
  CodexCapabilityDetectionError,
  detectCodexRoute,
} from "../agent/preflight/codex-capability-detection.mjs";

const BASE_URL = "http://agentteams-controller:8080/v1";
const PROVIDER = "agentteams-gateway";
const MODEL = "qwen3.7-plus";

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-codex-detection-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
}

async function writeReceipt(directory) {
  const path = join(directory, "ready.json");
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    sidecarId: "sidecar-qwen-member",
    phase: "ready",
    generation: 1,
    endpoint: "http://opencodex-sidecar:8787/v1",
    provider: PROVIDER,
    model: MODEL,
    transport: CODEX_BRIDGE_TRANSPORT,
    bridge: "opencodex",
    credentialSource: "agentteams-secret-projection",
    routeDigest: "a".repeat(64),
  }), "utf8");
  return path;
}

test("selects native Responses and records only bounded metadata", async () => {
  await withDirectory(async (directory) => {
    const recordPath = join(directory, "capability.json");
    let observed;
    const result = await detectCodexRoute({
      provider: PROVIDER,
      model: MODEL,
      baseUrl: BASE_URL,
      consumerToken: "worker-consumer-token",
      recordPath,
      fetchImpl: async (url, options) => {
        observed = { url: url.toString(), method: options.method, authorization: options.headers.authorization };
        return { status: 200, headers: { get: () => "application/json" }, text: async () => '{"id":"resp_probe","output":[]}' };
      },
    });
    assert.equal(result.transport, CODEX_NATIVE_TRANSPORT);
    assert.equal(result.endpoint, BASE_URL);
    assert.deepEqual(observed, {
      url: `${BASE_URL}/responses`,
      method: "POST",
      authorization: "Bearer worker-consumer-token",
    });
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    assert.deepEqual(record, {
      schemaVersion: 1,
      checkedAt: record.checkedAt,
      detectorVersion: "responses-probe-v1",
      provider: PROVIDER,
      model: MODEL,
      endpoint: BASE_URL,
      outcome: "supported",
      reasonCode: "responses-supported",
      status: 200,
      transport: CODEX_NATIVE_TRANSPORT,
    });
    assert.equal(JSON.stringify(record).includes("worker-consumer-token"), false);
    assert.equal(JSON.stringify(record).includes("capability probe"), false);
  });
});

test("selects OpenCodex only for a clear unsupported endpoint and uses the ready receipt", async () => {
  await withDirectory(async (directory) => {
    const recordPath = join(directory, "capability.json");
    const receiptPath = await writeReceipt(directory);
    const result = await detectCodexRoute({
      provider: PROVIDER,
      model: MODEL,
      baseUrl: BASE_URL,
      consumerToken: "worker-consumer-token",
      sidecarReceiptPath: receiptPath,
      recordPath,
      fetchImpl: async () => ({ status: 404, headers: { get: () => "application/json" }, text: async () => '{"error":"route not found"}' }),
    });
    assert.equal(result.transport, CODEX_BRIDGE_TRANSPORT);
    assert.equal(result.bridge, "opencodex");
    assert.equal(result.endpoint, "http://opencodex-sidecar:8787/v1");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(record.outcome, "unsupported");
    assert.equal(record.transport, CODEX_BRIDGE_TRANSPORT);
    assert.equal(record.sidecarId, "sidecar-qwen-member");
    assert.equal(record.sidecarGeneration, 1);
  });
});

test("reads a matching ready receipt from the deployment receipt service URL", async () => {
  await withDirectory(async (directory) => {
    const recordPath = join(directory, "capability.json");
    const receiptPath = await writeReceipt(directory);
    const receiptText = await readFile(receiptPath, "utf8");
    const calls = [];
    const result = await detectCodexRoute({
      provider: PROVIDER,
      model: MODEL,
      baseUrl: BASE_URL,
      consumerToken: "worker-consumer-token",
      sidecarReceiptUrl: "http://tiangong-opencodex-adapter:8790/v1/receipts/worker-qwen-member",
      recordPath,
      fetchImpl: async (url) => {
        calls.push(url.toString());
        if (calls.length === 1) return { status: 404, headers: { get: () => "application/json" }, text: async () => '{"error":"route not found"}' };
        return { status: 200, headers: { get: () => "application/json" }, text: async () => receiptText };
      },
    });
    assert.equal(result.transport, CODEX_BRIDGE_TRANSPORT);
    assert.deepEqual(calls, [
      `${BASE_URL}/responses`,
      "http://tiangong-opencodex-adapter:8790/v1/receipts/worker-qwen-member",
    ]);
    assert.equal(JSON.stringify(result).includes("worker-consumer-token"), false);
  });
});

test("does not silently fallback when the bridge receipt is absent", async () => {
  await withDirectory(async (directory) => {
    const recordPath = join(directory, "capability.json");
    await assert.rejects(
      detectCodexRoute({
        provider: PROVIDER,
        model: MODEL,
        baseUrl: BASE_URL,
        consumerToken: "worker-consumer-token",
        recordPath,
        fetchImpl: async () => ({ status: 405, headers: { get: () => "text/plain" }, text: async () => "method not supported" }),
      }),
      (error) => error instanceof CodexCapabilityDetectionError && error.code === "codex-compatibility-unavailable",
    );
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    assert.deepEqual({ outcome: record.outcome, transport: record.transport, reasonCode: record.reasonCode }, {
      outcome: "unavailable",
      transport: "unknown",
      reasonCode: "codex-compatibility-unavailable",
    });
  });
});

test("does not treat auth, timeout, or ambiguous 400 responses as Chat-only", async () => {
  for (const response of [
    { status: 401, text: '{"error":"unauthorized"}' },
    { status: 400, text: '{"error":"invalid input"}' },
  ]) {
    await withDirectory(async (directory) => {
      const recordPath = join(directory, "capability.json");
      await assert.rejects(
        detectCodexRoute({
          provider: PROVIDER,
          model: MODEL,
          baseUrl: BASE_URL,
          consumerToken: "worker-consumer-token",
          recordPath,
          fetchImpl: async () => ({ status: response.status, headers: { get: () => "application/json" }, text: async () => response.text }),
        }),
        (error) => error instanceof CodexCapabilityDetectionError && error.code !== "codex-compatibility-unavailable",
      );
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      assert.equal(record.outcome, "error");
      assert.equal(record.transport, "unknown");
    });
  }
});

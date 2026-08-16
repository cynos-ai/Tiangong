import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOpenCodexSidecarReceiptHandler } from "../agent/deployment/opencodex-sidecar-receipt-service.mjs";

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-opencodex-receipt-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
}

async function call(handler, url) {
  const result = { status: 0, headers: {}, body: "" };
  const response = {
    writeHead(status, headers) {
      result.status = status;
      result.headers = headers;
    },
    end(body = "") {
      result.body = body;
    },
  };
  await handler({ method: "GET", url }, response);
  return { ...result, json: result.body ? JSON.parse(result.body) : null };
}

test("receipt service exposes only a sanitized ready receipt", async () => {
  await withDirectory(async (stateDir) => {
    await writeFile(join(stateDir, "opencodex-worker-qwen.json"), JSON.stringify({
      schemaVersion: 1,
      sidecarId: "opencodex-worker-qwen",
      phase: "ready",
      generation: 2,
      endpoint: "http://opencodex-sidecar:8787/v1",
      provider: "agentteams-gateway",
      model: "qwen3.7-plus",
      credentialSource: "agentteams-secret-projection",
      secretShouldNeverAppear: "worker-consumer-token",
    }), "utf8");
    const handler = createOpenCodexSidecarReceiptHandler({ stateDir });
    const result = await call(handler, "/v1/receipts/worker-qwen");
    assert.equal(result.status, 200);
    assert.deepEqual({
      sidecarId: result.json.sidecarId,
      phase: result.json.phase,
      generation: result.json.generation,
      endpoint: result.json.endpoint,
      provider: result.json.provider,
      model: result.json.model,
      transport: result.json.transport,
      bridge: result.json.bridge,
      credentialSource: result.json.credentialSource,
    }, {
      sidecarId: "opencodex-worker-qwen",
      phase: "ready",
      generation: 2,
      endpoint: "http://opencodex-sidecar:8787/v1",
      provider: "agentteams-gateway",
      model: "qwen3.7-plus",
      transport: "responses-via-chat-bridge",
      bridge: "opencodex",
      credentialSource: "agentteams-secret-projection",
    });
    assert.equal(JSON.stringify(result.json).includes("worker-consumer-token"), false);
  });
});

test("receipt service fails closed for a missing or non-ready sidecar", async () => {
  await withDirectory(async (stateDir) => {
    const handler = createOpenCodexSidecarReceiptHandler({ stateDir });
    const missing = await call(handler, "/v1/receipts/worker-missing");
    assert.equal(missing.status, 503);
    await writeFile(join(stateDir, "opencodex-worker-draining.json"), JSON.stringify({ phase: "drained" }), "utf8");
    const drained = await call(handler, "/v1/receipts/worker-draining");
    assert.equal(drained.status, 503);
  });
});

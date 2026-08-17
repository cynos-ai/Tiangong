import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import { createRemoteCodexCapabilityCache } from "../agent/preflight/codex-capability-cache-remote.mjs";

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch { /* service is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("cache service did not become ready");
}

test("remote capability cache serializes one probe and persists sanitized metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-codex-remote-cache-"));
  const port = 18_000 + (process.pid % 1_000);
  const service = spawn(process.execPath, ["agent/preflight/codex-capability-cache-service.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, TIANGONG_CODEX_CAPABILITY_CACHE_PORT: String(port), TIANGONG_CODEX_CAPABILITY_CACHE_PATH: join(root, "codex.json") },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    await waitForHealth(port);
    const cache = createRemoteCodexCapabilityCache({ endpoint: `http://127.0.0.1:${port}` });
    let probes = 0;
    const resolve = () => cache.resolve({
      provider: "agentteams-gateway",
      model: "smoke/model",
      baseUrl: "http://gateway.test/v1",
      detectorVersion: "responses-probe-v1",
      probe: async () => {
        probes += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        return { outcome: "supported", reasonCode: "responses-supported", status: 200, transport: "native-responses" };
      },
    });
    const results = await Promise.all([resolve(), resolve()]);
    assert.equal(probes, 1);
    assert.deepEqual(results.map((value) => value.record.key), [results[0].record.key, results[0].record.key]);
    assert.deepEqual(results.map((value) => value.cacheHit).sort(), [false, true]);
    const persisted = JSON.parse(await readFile(join(root, "codex.json"), "utf8"));
    assert.equal(persisted.entries.length, 1);
    assert.equal(JSON.stringify(persisted).includes("token"), false);
    assert.equal(JSON.stringify(persisted).includes("secret"), false);
  } finally {
    if (service.exitCode === null) {
      service.kill("SIGTERM");
      await once(service, "exit");
    }
    await rm(root, { recursive: true, force: true });
  }
});

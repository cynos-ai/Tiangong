import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODEX_CAPABILITY_CACHE_SCHEMA_VERSION,
  createCodexCapabilityCache,
  codexCapabilityFingerprint,
} from "../agent/preflight/codex-capability-cache.mjs";

const BASE = {
  provider: "agentteams-gateway",
  model: "qwen3.7-plus",
  baseUrl: "http://agentteams-controller:8080/v1",
  detectorVersion: "responses-probe-v1",
};

async function withCache(run) {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-codex-cache-"));
  try {
    await run(join(directory, "codex.json"));
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
}

function nativeProbe(fingerprint) {
  return {
    outcome: "supported",
    reasonCode: "responses-supported",
    status: 200,
    transport: "native-responses",
    observed: fingerprint,
  };
}

test("reuses one shared capability result while the provider fingerprint is unchanged", async () => {
  await withCache(async (path) => {
    const cache = createCodexCapabilityCache({ path, ttlMs: 60_000 });
    let probes = 0;
    const probe = async (fingerprint) => { probes += 1; return nativeProbe(fingerprint); };
    const first = await cache.resolve({ ...BASE, probe });
    const second = await cache.resolve({ ...BASE, probe });
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.equal(probes, 1);
    assert.equal(first.record.key, second.record.key);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal(persisted.schemaVersion, CODEX_CAPABILITY_CACHE_SCHEMA_VERSION);
    assert.equal(persisted.entries.length, 1);
    assert.equal(JSON.stringify(persisted).includes("worker-consumer-token"), false);
  });
});

test("a model, provider, endpoint, or detector-version change creates a new cache key", async () => {
  await withCache(async (path) => {
    const cache = createCodexCapabilityCache({ path, ttlMs: 60_000 });
    let probes = 0;
    const probe = async (fingerprint) => { probes += 1; return nativeProbe(fingerprint); };
    const first = await cache.resolve({ ...BASE, probe });
    const changedModel = await cache.resolve({ ...BASE, model: "deepseek-v4-pro", probe });
    const changedEndpoint = await cache.resolve({ ...BASE, baseUrl: "http://agentteams-controller:8080/other", probe });
    const changedDetector = await cache.resolve({ ...BASE, detectorVersion: "responses-probe-v2", probe });
    assert.equal(probes, 4);
    assert.notEqual(first.record.key, changedModel.record.key);
    assert.notEqual(first.record.key, changedEndpoint.record.key);
    assert.notEqual(first.record.key, changedDetector.record.key);
  });
});

test("an expired shared result is refreshed once", async () => {
  await withCache(async (path) => {
    let current = Date.parse("2026-08-15T00:00:00.000Z");
    const cache = createCodexCapabilityCache({ path, now: () => current, ttlMs: 60_000 });
    let probes = 0;
    const probe = async (fingerprint) => { probes += 1; return nativeProbe(fingerprint); };
    await cache.resolve({ ...BASE, probe });
    current += 60_001;
    const refreshed = await cache.resolve({ ...BASE, probe });
    assert.equal(refreshed.cacheHit, false);
    assert.equal(probes, 2);
  });
});

test("concurrent cache misses serialize and only one caller probes", async () => {
  await withCache(async (path) => {
    const cacheA = createCodexCapabilityCache({ path, ttlMs: 60_000, pollMs: 2 });
    const cacheB = createCodexCapabilityCache({ path, ttlMs: 60_000, pollMs: 2 });
    let probes = 0;
    const probe = async (fingerprint) => {
      probes += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return nativeProbe(fingerprint);
    };
    const [first, second] = await Promise.all([
      cacheA.resolve({ ...BASE, probe }),
      cacheB.resolve({ ...BASE, probe }),
    ]);
    assert.equal(probes, 1);
    assert.equal(first.record.key, second.record.key);
    assert.equal([first.cacheHit, second.cacheHit].filter(Boolean).length, 1);
  });
});

test("does not cache an indeterminate probe failure", async () => {
  await withCache(async (path) => {
    const cache = createCodexCapabilityCache({ path, ttlMs: 60_000 });
    let probes = 0;
    const probe = async () => {
      probes += 1;
      throw new Error("provider unavailable");
    };
    await assert.rejects(cache.resolve({ ...BASE, probe }), /provider unavailable/);
    await assert.rejects(cache.resolve({ ...BASE, probe }), /provider unavailable/);
    assert.equal(probes, 2);
  });
});

test("fingerprints normalize only credential-free endpoint metadata", () => {
  const first = codexCapabilityFingerprint({ ...BASE, baseUrl: "http://agentteams-controller:8080/v1/" });
  const second = codexCapabilityFingerprint(BASE);
  assert.deepEqual(first, second);
  const namespaced = codexCapabilityFingerprint({ ...BASE, model: "codex/deepseek-v4-pro" });
  assert.equal(namespaced.fingerprint.model, "codex/deepseek-v4-pro");
});

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { sha256 } from "../agent/canonical-json.mjs";
import { DeploymentJournal } from "../agent/deployment/journal.mjs";
import {
  createDeploymentServiceHandler,
  validateDeploymentServiceConfig,
} from "../agent/deployment/service.mjs";

const PREVIOUS = "a".repeat(64);
const ARTIFACT = "b".repeat(64);

async function withService(fn) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-deployment-service-"));
  const capability = randomBytes(32).toString("base64url");
  const config = validateDeploymentServiceConfig({
    schemaVersion: 1,
    listenPort: 8790,
    targetId: "target-a",
    previousDigest: PREVIOUS,
    capabilityDigest: sha256(capability),
    faultMode: "none",
  });
  const journal = new DeploymentJournal({ filePath: join(root, "events.jsonl"), targetId: config.targetId, previousDigest: PREVIOUS });
  const server = createServer(createDeploymentServiceHandler({ config, journal }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "POST", body, token = capability, headers = {} } = {}) => fetch(`${endpoint}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try { await fn({ request, journal }); } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

async function json(response) {
  return { status: response.status, body: await response.json() };
}

test("deployment service exposes the bounded stage, activate, status, and verify contract", async () => {
  await withService(async ({ request }) => {
    const initial = await json(await request("/v1/status", { method: "GET" }));
    assert.equal(initial.status, 200);
    assert.equal(initial.body.status.currentDigest, PREVIOUS);

    const stage = { operationId: "deploy-a", artifactDigest: ARTIFACT, expectedCurrentDigest: PREVIOUS, rollbackDigest: PREVIOUS };
    assert.equal((await json(await request("/v1/stage", { body: stage }))).body.replayed, false);
    assert.equal((await json(await request("/v1/stage", { body: stage }))).body.replayed, true);
    assert.equal((await json(await request("/v1/activate", { body: { operationId: "deploy-a" } }))).status, 200);
    const verified = await json(await request("/v1/verify", { body: { operationId: "deploy-a", phase: "post_deploy", expectedDigest: ARTIFACT } }));
    assert.equal(verified.body.event.healthy, true);
    assert.equal((await json(await request("/v1/status", { method: "GET" }))).body.status.currentDigest, ARTIFACT);
  });
});

test("deployment service rejects missing capability, unknown fields, and stale preconditions without mutation", async () => {
  await withService(async ({ request }) => {
    assert.equal((await json(await request("/v1/status", { method: "GET", token: "x".repeat(32) }))).status, 403);
    const bad = await json(await request("/v1/stage", { body: {
      operationId: "deploy-a", artifactDigest: ARTIFACT, expectedCurrentDigest: "c".repeat(64), rollbackDigest: "c".repeat(64), extra: true,
    } }));
    assert.equal(bad.status, 409);
    const status = await json(await request("/v1/status", { method: "GET" }));
    assert.equal(status.body.status.currentDigest, PREVIOUS);
    assert.equal(status.body.status.sequence, 1);
  });
});

test("deployment service config is closed and capability stores only a digest", () => {
  const capabilityDigest = "d".repeat(64);
  const config = validateDeploymentServiceConfig({ schemaVersion: 1, listenPort: 8790, targetId: "t", previousDigest: PREVIOUS, capabilityDigest, faultMode: "none" });
  assert.equal(config.capabilityDigest, capabilityDigest);
  assert.equal(Object.hasOwn(config, "capability"), false);
  assert.throws(
    () => validateDeploymentServiceConfig({ ...config, capability: "not-allowed" }),
    /unknown fields/,
  );
});

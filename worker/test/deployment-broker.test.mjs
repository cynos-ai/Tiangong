import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { sha256 } from "../agent/canonical-json.mjs";
import { createDeploymentBrokerClient, deploymentBrokerEndpointForWorker } from "../agent/deployment/client.mjs";
import { createDeploymentBrokerExecutor, createDeploymentBrokerHandler, validateDeploymentBrokerConfig } from "../agent/deployment/broker-server.mjs";
import { createDeploymentServiceHandler, validateDeploymentServiceConfig } from "../agent/deployment/service.mjs";
import { DeploymentJournal } from "../agent/deployment/journal.mjs";
import { createChangeRevisionRef } from "../agent/work/change-revision-ref.mjs";

const PREVIOUS = "a".repeat(64); const ARTIFACT = "b".repeat(64); const ACTION = "c".repeat(64);
const revision = createChangeRevisionRef({ kind: "tiangong.change-revision-ref", schemaVersion: 1, producerTaskId: "implement-a", artifactPath: "revision.tar", artifactDigest: ARTIFACT, revision: 0 });

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  return { server, endpoint: `http://127.0.0.1:${server.address().port}` };
}
async function close(server) { await new Promise((resolve) => server.close(resolve)); }

async function fixture(fn, faultMode = "none") {
  const root = await mkdtemp(join(tmpdir(), "tiangong-deployment-broker-")); const capability = randomBytes(32).toString("base64url");
  const serviceConfig = validateDeploymentServiceConfig({ schemaVersion: 1, listenPort: 8790, targetId: "target-a", previousDigest: PREVIOUS, capabilityDigest: sha256(capability), faultMode });
  const journal = new DeploymentJournal({ filePath: join(root, "events.jsonl"), targetId: "target-a", previousDigest: PREVIOUS, faultMode });
  const target = await listen(createDeploymentServiceHandler({ config: serviceConfig, journal }));
  const binding = { workerName: "operator", containerName: "operator-container", workerImageId: `sha256:${"d".repeat(64)}`, role: "operator", taskId: "release-a", changeRevisionRef: revision, targetId: "target-a", previousDigest: PREVIOUS, targetEndpoint: target.endpoint, targetCapability: capability };
  const broker = await listen(createDeploymentBrokerHandler({ authenticatePeer: async () => binding, execute: createDeploymentBrokerExecutor() }));
  try { await fn({ endpoint: `${broker.endpoint}/v1/deploy`, journal }); } finally { await close(broker.server); await close(target.server); await rm(root, { recursive: true, force: true }); }
}

test("deployment broker binds revision, activates, verifies, and exactly replays", async () => {
  await fixture(async ({ endpoint, journal }) => {
    const client = createDeploymentBrokerClient({ brokerEndpoint: endpoint, taskId: "release-a" });
    assert.deepEqual(await client.plan({ changeRevisionRef: revision }), { targetId: "target-a", previousDigest: PREVIOUS, changeRevisionRef: revision });
    const first = await client.deploy({ actionDigest: ACTION, changeRevisionRef: revision });
    assert.equal(first.replayed, false); assert.equal(first.outcome.disposition, "DELIVERED"); assert.equal(first.outcome.currentDigest, ARTIFACT);
    const replay = await client.deploy({ actionDigest: ACTION, changeRevisionRef: revision });
    assert.equal(replay.replayed, true); assert.equal(replay.outcome.contentDigest, first.outcome.contentDigest);
    assert.equal((await journal.status()).currentDigest, ARTIFACT);
  });
});

test("deployment broker rolls back a failed post-verification and reports FAILED_SAFE", async () => {
  await fixture(async ({ endpoint, journal }) => {
    const result = await createDeploymentBrokerClient({ brokerEndpoint: endpoint, taskId: "release-a" }).deploy({ actionDigest: ACTION, changeRevisionRef: revision });
    assert.equal(result.outcome.disposition, "FAILED_SAFE"); assert.equal(result.outcome.rollbackPerformed, true); assert.equal(result.outcome.previousVerifyHealthy, true);
    assert.equal((await journal.status()).currentDigest, PREVIOUS);
  }, "post_verify_fail");
});

test("deployment broker reports RECOVERY_REQUIRED when rollback fails", async () => {
  await fixture(async ({ endpoint, journal }) => {
    const result = await createDeploymentBrokerClient({ brokerEndpoint: endpoint, taskId: "release-a" }).deploy({ actionDigest: ACTION, changeRevisionRef: revision });
    assert.equal(result.outcome.disposition, "RECOVERY_REQUIRED");
    assert.equal(result.outcome.postVerifyHealthy, false);
    assert.equal(result.outcome.rollbackPerformed, false);
    assert.equal(result.outcome.previousVerifyHealthy, null);
    assert.equal(result.outcome.currentDigest, ARTIFACT);
    assert.equal((await journal.status()).currentDigest, ARTIFACT);
  }, "rollback_fail");
});

test("deployment broker reports RECOVERY_REQUIRED when the previous digest cannot be verified", async () => {
  await fixture(async ({ endpoint, journal }) => {
    const result = await createDeploymentBrokerClient({ brokerEndpoint: endpoint, taskId: "release-a" }).deploy({ actionDigest: ACTION, changeRevisionRef: revision });
    assert.equal(result.outcome.disposition, "RECOVERY_REQUIRED");
    assert.equal(result.outcome.postVerifyHealthy, false);
    assert.equal(result.outcome.rollbackPerformed, true);
    assert.equal(result.outcome.previousVerifyHealthy, false);
    assert.equal(result.outcome.currentDigest, PREVIOUS);
    assert.equal((await journal.status()).currentDigest, PREVIOUS);
  }, "verify_previous_fail");
});

test("deployment broker rejects a forged revision without touching the target", async () => {
  await fixture(async ({ endpoint, journal }) => {
    const forged = createChangeRevisionRef({ kind: "tiangong.change-revision-ref", schemaVersion: 1, producerTaskId: "implement-a", artifactPath: "revision.tar", artifactDigest: "e".repeat(64), revision: 0 });
    await assert.rejects(createDeploymentBrokerClient({ brokerEndpoint: endpoint, taskId: "release-a" }).deploy({ actionDigest: ACTION, changeRevisionRef: forged }), /REQUEST_REJECTED/);
    assert.equal((await journal.status()).currentDigest, PREVIOUS);
  });
});

test("deployment broker config and fixed AgentTeams discovery are closed", () => {
  const config = validateDeploymentBrokerConfig({ schemaVersion: 1, network: "agentteams-net", listenPort: 8791, bindings: [{ workerName: "operator", containerName: "operator-c", workerImageId: `sha256:${"d".repeat(64)}`, taskId: "release-a", changeRevisionRef: revision, targetId: "target-a", previousDigest: PREVIOUS, targetEndpoint: "http://deployment-target:8790", targetCapability: "x".repeat(32) }] });
  assert.equal(config.bindings[0].role, "operator");
  assert.equal(deploymentBrokerEndpointForWorker({ role: "operator", env: { AGENTTEAMS_WORKER_NAME: "operator" } }), "http://tiangong-deployment-broker:8791/v1/deploy");
  assert.equal(deploymentBrokerEndpointForWorker({ role: "assessor", env: { AGENTTEAMS_WORKER_NAME: "assessor" } }), undefined);
  assert.throws(() => deploymentBrokerEndpointForWorker({ role: "operator", env: { AGENTTEAMS_WORKER_NAME: "operator", TIANGONG_DEPLOYMENT_BROKER_ENDPOINT: "https://external.test/v1/deploy" } }), /internal HTTP/);
});

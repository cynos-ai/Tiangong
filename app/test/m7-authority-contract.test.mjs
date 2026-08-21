import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const text = async (path) => readFile(new URL(path, root), "utf8");

async function absent(path) {
  await assert.rejects(access(new URL(path, root)), (error) => error?.code === "ENOENT");
}

test("M7 product runtime has one PostgreSQL authority and no file fallback", async () => {
  const [server, runtime, pkg, migration] = await Promise.all([
    text("app/server.mjs"), text("app/coordination/runtime-server.mjs"), text("app/package.json"), text("app/coordination/migrations/001_coordination.sql"),
  ]);
  assert.doesNotMatch(server, /TIANGONG_COORDINATION_FILE|coordinationFile|new CoordinationStore/u);
  assert.match(server, /postgres-not-configured/u);
  assert.match(runtime, /createPostgresCoordinationStore/u);
  assert.equal(JSON.parse(pkg).scripts.start, "node coordination/runtime-server.mjs");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS tiangong_coordination\.matrix_message_admission/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS tiangong_coordination\.wake/u);
});

test("M7 removes obsolete runtime implementations rather than retaining shims", async () => {
  const [dockerfile, workerPackage, wrapper, plugin] = await Promise.all([
    text("worker/Dockerfile"), text("worker/package.json"), text("worker/bin/openclaw"), text("worker/plugin/index.mjs"),
  ]);
  const forbidden = /codex-app-server|opencodex|native-runner|runner-broker|deployment-service|pending-operation|approval-command|operationDigest|EvidenceRecorder/u;
  assert.doesNotMatch(dockerfile, forbidden); assert.doesNotMatch(wrapper, forbidden); assert.doesNotMatch(plugin, forbidden);
  assert.equal("@openai/codex" in JSON.parse(workerPackage).dependencies, false);
  await Promise.all([
    absent("worker/agent/team/coordination-store.mjs"), absent("worker/agent/deployment"), absent("worker/agent/runner"),
    absent("worker/agent/pending-operation"), absent("worker/agent/evidence"), absent("worker/agent/team/native-runner-tool.mjs"),
  ]);
});

test("M7 keeps Matrix admission backlog and wake outbox as separate transactional concerns", async () => {
  const [migration, store, consumer] = await Promise.all([
    text("app/coordination/migrations/001_coordination.sql"), text("app/coordination/postgres-store.mjs"), text("app/coordination/matrix-wake-consumer.mjs"),
  ]);
  assert.match(migration, /matrix_message_admission/u); assert.match(migration, /CREATE TABLE IF NOT EXISTS tiangong_coordination\.wake/u);
  assert.match(store, /leaseMessageAdmission/u); assert.match(store, /claimWake/u); assert.match(store, /ackWake/u);
  assert.match(consumer, /PG outbox consumer/u); assert.doesNotMatch(consumer, /leaseMessageAdmission/u);
});

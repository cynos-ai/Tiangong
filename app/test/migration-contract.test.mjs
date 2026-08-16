import assert from "node:assert/strict";
import test from "node:test";

import {
  createCoordinationMigrationPlan,
  evaluateCoordinationMigrationGates,
  routeDigest,
  transitionCoordinationMigration,
} from "../coordination/migration-contract.mjs";

const defaultRoute = {
  provider: "openai-compat",
  model: "deepseek-v4-pro",
  endpoint: "https://api.deepseek.com/v1",
  transport: "native-responses",
  bridge: null,
  credentialSource: "agentteams-secret",
};
const candidateRoute = {
  provider: "openai-compat",
  model: "qwen3.7-plus",
  endpoint: "https://coding.dashscope.aliyuncs.com/v1",
  transport: "responses-via-chat-bridge",
  bridge: "opencodex",
  credentialSource: "agentteams-secret",
};

function planInput() {
  const snapshotDigest = "a".repeat(64);
  return {
    contractVersion: 1,
    migrationId: "phase-b5-qwen-coordination",
    createdAt: "2026-08-16T12:00:00.000Z",
    source: { lane: "legacy-pi", namespace: "team-shared-fs", snapshotDigest, snapshotAt: "2026-08-16T11:59:00.000Z" },
    target: { schema: "tiangong_coordination", migrationVersions: ["001_coordination", "002_task_result"], cutoverMode: "shadow-read-then-cutover" },
    defaultRoute: { ...defaultRoute },
    candidateRoute: { ...candidateRoute },
    rollback: { previousRouteDigest: routeDigest(defaultRoute), snapshotDigest, owner: "tiangong-deployment", maxRecoveryWindowMs: 86_400_000 },
    legacyLane: { name: "legacy-pi", retained: true, readOnly: true },
    requiredGates: ["providerCanary", "matrixWeb", "toolResultRetention", "restartRecovery", "rollback", "cleanup"],
  };
}

function passingObservations() {
  return {
    providerCanary: "pass",
    matrixWeb: "pass",
    toolResultRetention: "pass",
    restartRecovery: "pass",
    rollback: "pass",
    cleanup: "pass",
    defaultRouteUnchanged: true,
    targetSchemaReady: true,
    snapshotVerified: true,
  };
}

test("creates a digest-bound migration plan without credentials", () => {
  const plan = createCoordinationMigrationPlan(planInput());
  assert.equal(plan.phase, "planned");
  assert.match(plan.planDigest, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(plan).includes("token"), false);
  assert.equal(JSON.stringify(plan).includes("key"), false);
  assert.equal(plan.rollback.previousRouteDigest, routeDigest(defaultRoute));
  const tampered = { ...plan, candidateRoute: { ...plan.candidateRoute, model: "qwen3.8-max" } };
  assert.throws(() => evaluateCoordinationMigrationGates(tampered, passingObservations()), { code: "migration-plan-tampered" });
});

test("requires the retained legacy lane, exact snapshot, and rollback binding", () => {
  const input = planInput();
  input.legacyLane = { name: "legacy-pi", retained: false, readOnly: true };
  assert.throws(() => createCoordinationMigrationPlan(input), { code: "migration-legacy-lane-invalid" });

  const rebound = planInput();
  rebound.rollback = { ...rebound.rollback, previousRouteDigest: "b".repeat(64) };
  assert.throws(() => createCoordinationMigrationPlan(rebound), { code: "migration-rollback-binding-mismatch" });
});

test("rejects unsafe endpoint, unsupported bridge, and unknown fields", () => {
  const unsafe = planInput();
  unsafe.candidateRoute = { ...candidateRoute, endpoint: "https://user:pass@coding.dashscope.aliyuncs.com/v1" };
  assert.throws(() => createCoordinationMigrationPlan(unsafe), { code: "migration-endpoint-unsafe" });

  const bridge = planInput();
  bridge.candidateRoute = { ...candidateRoute, bridge: "unknown" };
  assert.throws(() => createCoordinationMigrationPlan(bridge), { code: "migration-bridge-invalid" });

  const unknown = planInput();
  unknown.candidateRoute.secret = "should-never-be-accepted";
  assert.throws(() => createCoordinationMigrationPlan(unknown), { code: "migration-field-unknown" });
});

test("fails closed until every provider, WebUI, recovery, rollback, and cleanup gate passes", () => {
  const plan = createCoordinationMigrationPlan(planInput());
  assert.throws(() => evaluateCoordinationMigrationGates(plan, { ...passingObservations(), cleanup: "PASS" }), { code: "migration-gate-result-invalid" });
  const blocked = evaluateCoordinationMigrationGates(plan, { ...passingObservations(), rollback: "unknown", defaultRouteUnchanged: false });
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.failedGates, ["rollback"]);
  assert.deepEqual(blocked.failedFacts, ["defaultRouteUnchanged"]);
  const ready = evaluateCoordinationMigrationGates(plan, passingObservations());
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.failedGates, []);
  assert.deepEqual(ready.failedFacts, []);
});

test("only a fully verified plan can cut over or complete", () => {
  const plan = createCoordinationMigrationPlan(planInput());
  assert.throws(() => transitionCoordinationMigration(plan, "cutover", {
    currentPhase: "canary",
    observations: { ...passingObservations(), providerCanary: "unknown" },
    currentRouteDigest: routeDigest(defaultRoute),
    targetSchemaReady: true,
    snapshotVerified: true,
  }), { code: "migration-cutover-not-ready" });
  const cutover = transitionCoordinationMigration(plan, "cutover", {
    currentPhase: "canary",
    observations: passingObservations(),
    currentRouteDigest: routeDigest(defaultRoute),
    targetSchemaReady: true,
    snapshotVerified: true,
  });
  assert.equal(cutover.phase, "cutover");
  assert.throws(() => transitionCoordinationMigration(plan, "completed", { currentPhase: "cutover", cutoverVerified: false }), { code: "migration-completion-not-verified" });
  assert.equal(transitionCoordinationMigration(plan, "completed", { currentPhase: "cutover", cutoverVerified: true }).phase, "completed");
});

test("rollback requires independent snapshot verification and route restoration", () => {
  const plan = createCoordinationMigrationPlan(planInput());
  assert.throws(() => transitionCoordinationMigration(plan, "rolled-back", { currentPhase: "cutover", snapshotVerified: true, previousRouteRestored: false }), { code: "migration-rollback-not-verified" });
  assert.equal(transitionCoordinationMigration(plan, "rolled-back", { currentPhase: "cutover", snapshotVerified: true, previousRouteRestored: true }).phase, "rolled-back");
});

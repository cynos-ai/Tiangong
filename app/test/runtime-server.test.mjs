import assert from "node:assert/strict";
import test from "node:test";

import { startCoordinationRuntime } from "../coordination/runtime-server.mjs";
import { createControlProfile, createMemberConfig, createTeamConfig, createTeamRouteBinding } from "../../worker/agent/team/coordination-contracts.mjs";

const NOW = "2026-08-15T03:00:00.000Z";

function fixture(prefix) {
  const profile = createControlProfile({ profileId: `profile-${prefix}`, revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: `team-${prefix}`, revision: 1, leaderMemberId: `leader-${prefix}`, memberIds: [`leader-${prefix}`], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: `route-${prefix}`, teamId: team.teamId, revision: 1, channel: "matrix", roomId: `!room-${prefix}:example.test`, createdAt: NOW });
  const leaderMember = createMemberConfig({ memberId: `leader-${prefix}`, teamId: team.teamId, workerName: `leader-${prefix}`, matrixUserId: `@leader-${prefix}:example.test`, role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const store = {
    async migrate() { return { version: "test" }; }, async health() { return { ok: true }; },
    async enqueueMessageAdmission() { throw new Error("not exercised"); }, async getWork() { return undefined; },
    async listWorks() { return []; }, async listOutbox() { return []; }, async listTasks() { return []; }, async listResults() { return []; },
    async listMessageAdmissions() { return []; }, async admissionMetrics() { return { pendingCount: 0, oldestReceivedAt: null, lastErrorCode: null }; },
  };
  return { binding: { team, route, profile, leaderMember, members: [leaderMember] }, store };
}

test("deployment coordination runtime starts with PostgreSQL store readiness and closes cleanly", async (t) => {
  const value = fixture("runtime");
  const runtime = await startCoordinationRuntime({ ...value, controlToken: "runtime-control-token", pool: { async end() {} }, port: 0 });
  t.after(() => runtime.close());
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  const ready = await fetch(`${base}/readyz`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).source, "postgres");
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("deployment runtime can expose Matrix Web login without a deployment sender token", async (t) => {
  const value = fixture("web");
  const runtime = await startCoordinationRuntime({ ...value, controlToken: "runtime-web-control-token", pool: { async end() {} }, matrixUrl: "https://matrix.example.test", secureCookies: false, port: 0 });
  t.after(() => runtime.close());
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  assert.equal(runtime.consumer, null);
  assert.deepEqual(await (await fetch(`${base}/api/chat/session`)).json(), { authenticated: false });
  assert.equal((await fetch(`${base}/api/runtime`)).status, 401);
  assert.equal((await fetch(base)).status, 200);
});

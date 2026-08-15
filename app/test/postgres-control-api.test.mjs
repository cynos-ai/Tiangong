import assert from "node:assert/strict";
import pg from "pg";
import test from "node:test";

import { createRuntimeConsoleServer } from "../server.mjs";
import { PostgresCoordinationStore } from "../coordination/postgres-store.mjs";
import { createRemoteCoordinationStore, createRemoteOpenClawLeaderAdmissionHook } from "../../worker/agent/team/coordination-control-client.mjs";
import { createLeaderOutboxHandlers, drainLeaderOutbox } from "../../worker/agent/team/leader-outbox.mjs";
import { sha256 } from "../../worker/agent/canonical-json.mjs";
import { acquirePostgresTestLock } from "./postgres-test-lock.mjs";
import {
  createControlProfile,
  createResult,
  createTaskSpec,
  createMemberConfig,
  createTeamConfig,
  createTeamRouteBinding,
} from "../../worker/agent/team/coordination-store.mjs";

const { Pool } = pg;
const connectionString = process.env.TIANGONG_TEST_POSTGRES_URL;
const disposable = process.env.TIANGONG_TEST_POSTGRES_DISPOSABLE === "1";
const skipReason = connectionString && disposable ? undefined : "set TIANGONG_TEST_POSTGRES_URL and TIANGONG_TEST_POSTGRES_DISPOSABLE=1 for disposable PostgreSQL Control API smoke";
const NOW = "2026-08-15T04:00:00.000Z";
const TOKEN = "postgres-control-api-token";

test("real PG Control API + remote Leader hook + remote outbox facade form one path", { skip: skipReason }, async (t) => {
  const release = await acquirePostgresTestLock();
  const pool = new Pool({ connectionString, max: 4 });
  const store = new PostgresCoordinationStore({ pool, now: () => NOW });
  t.after(async () => {
    await pool.query("DROP SCHEMA IF EXISTS tiangong_coordination CASCADE");
    await pool.end();
    release();
  });
  await store.migrate();
  const profile = createControlProfile({ profileId: "profile-pg-api", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-pg-api", revision: 1, leaderMemberId: "leader-pg-api", memberIds: ["leader-pg-api"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route-pg-api", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room-pg-api:example.test", createdAt: NOW });
  const leaderMember = createMemberConfig({ memberId: "leader-pg-api", teamId: team.teamId, workerName: "leader-pg-api", matrixUserId: "@leader-pg-api:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const server = createRuntimeConsoleServer({
    coordinationStore: store,
    coordinationControl: { store, bearerToken: TOKEN, team, route, profile, leaderMember, members: [leaderMember], now: () => NOW },
  }).listen(0);
  t.after(() => server.close());
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}/v1/coordination/admit`;
  const hook = createRemoteOpenClawLeaderAdmissionHook({
    endpoint,
    token: TOKEN,
    channel: { readHumanEvent: async () => ({ eventId: "$event-pg-api", roomId: route.roomId, sender: "@human-pg-api:example.test", type: "m.room.message", content: { msgtype: "m.text", body: "Run the PG path" } }) },
  });
  const admission = await hook({ roomId: route.roomId, eventId: "$event-pg-api", source: { channel: "matrix", authenticated: true, actorId: "@human-pg-api:example.test", messageId: "$event-pg-api", route: "team-room" } });
  assert.equal(admission.replayed, false);
  const task = createTaskSpec({ taskId: "task-pg-api", workId: admission.work.work.workId, assigneeMemberId: leaderMember.memberId, objective: "Read the gateway", completionContract: "one result", inputRefs: [], createdAt: NOW });
  await store.createTask({ task, team, member: leaderMember, profile, actorId: leaderMember.memberId, expectedEpoch: 0, requestId: "request-pg-api-task" });
  const result = createResult({ resultId: "result-pg-api", workId: task.workId, taskId: task.taskId, producerMemberId: leaderMember.memberId, toolResultIds: [], artifactRefs: [], claim: "gateway is readable", createdAt: NOW });
  await store.submitResult({ result, team, member: leaderMember, profile, actorId: leaderMember.memberId, expectedEpoch: 1, requestId: "request-pg-api-result" });
  const remoteStore = createRemoteCoordinationStore({ endpoint, token: TOKEN });
  assert.equal((await remoteStore.getTask(task.taskId)).status, "reported");
  assert.equal((await remoteStore.getResult(result.resultId)).contentDigest, result.contentDigest);
  const handlers = createLeaderOutboxHandlers({
    store: remoteStore,
    channel: { notifyWorkAdmitted: async () => ({ transactionId: "matrix-txn-pg-api", delivered: true }) },
    resolveWorkRoute: async () => ({ roomId: route.roomId, bindingDigest: sha256({ routeId: route.routeId }) }),
    resumeLeader: async () => ({ receiptId: "resume-receipt" }),
  });
  const drained = await drainLeaderOutbox({ store: remoteStore, consumerId: "leader-pg-api", handlers });
  assert.equal(drained.results.length, 2);
  assert.equal(drained.results.every((result) => result.status === "acked"), true);
  const runtime = await fetch(`http://127.0.0.1:${address.port}/api/runtime`);
  const facts = await runtime.json();
  assert.equal(facts.workSource, "coordination-store");
  assert.equal(facts.works.length, 1);
  assert.equal(facts.tasks.length, 1);
  assert.equal(facts.results.length, 1);
  assert.equal(facts.deliveries.every((wake) => wake.status === "acked"), true);
});

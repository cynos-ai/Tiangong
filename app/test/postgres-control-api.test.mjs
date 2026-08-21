import assert from "node:assert/strict";
import pg from "pg";
import test from "node:test";
import { createRuntimeConsoleServer } from "../server.mjs";
import { PostgresCoordinationStore } from "../coordination/postgres-store.mjs";
import { createRemoteCoordinationStore, createRemoteOpenClawLeaderAdmissionHook } from "../../worker/agent/team/coordination-control-client.mjs";
import { acquirePostgresTestLock } from "./postgres-test-lock.mjs";
import { createControlProfile, createMemberConfig, createTeamConfig, createTeamRouteBinding } from "../../worker/agent/team/coordination-contracts.mjs";

const { Pool } = pg; const connectionString = process.env.TIANGONG_TEST_POSTGRES_URL; const disposable = process.env.TIANGONG_TEST_POSTGRES_DISPOSABLE === "1"; const skipReason = connectionString && disposable ? undefined : "set disposable PostgreSQL variables"; const NOW = "2026-08-15T04:00:00.000Z"; const TOKEN = "postgres-control-api-token";

test("real PG gateway queues Matrix and remote Leader routes a requirement-pending Work", { skip: skipReason }, async (t) => {
  const release = await acquirePostgresTestLock(); const pool = new Pool({ connectionString, max: 4 }); const store = new PostgresCoordinationStore({ pool, now: () => NOW });
  t.after(async () => { await pool.query("DROP SCHEMA IF EXISTS tiangong_coordination CASCADE"); await pool.end(); release(); }); await store.migrate();
  const profile = createControlProfile({ profileId: "profile", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team", revision: 1, leaderMemberId: "leader", memberIds: ["leader"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room:example.test", createdAt: NOW });
  const leader = createMemberConfig({ memberId: "leader", teamId: team.teamId, workerName: "leader", matrixUserId: "@leader:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const server = createRuntimeConsoleServer({ coordinationStore: store, coordinationControl: { store, bearerToken: TOKEN, team, route, profile, leaderMember: leader, members: [leader], now: () => NOW } }).listen(0); t.after(() => server.close()); const endpoint = `http://127.0.0.1:${server.address().port}/v1/coordination/admit`;
  const event = { eventId: "$event", roomId: route.roomId, sender: "@human:example.test", type: "m.room.message", content: { msgtype: "m.text", body: "PG request" } };
  const hook = createRemoteOpenClawLeaderAdmissionHook({ endpoint, token: TOKEN, channel: { async readHumanEvent() { return event; } } });
  const admitted = await hook({ roomId: route.roomId, eventId: event.eventId, source: { channel: "matrix", authenticated: true, actorId: event.sender, messageId: event.eventId, route: "team-room" } }); assert.equal(admitted.admission.status, "pending");
  const remote = createRemoteCoordinationStore({ endpoint, token: TOKEN, memberId: leader.memberId }); const routed = await remote.routeMessage({ eventId: event.eventId, title: "PG Work", requestId: "route" }); assert.equal(routed.work.currentWorkSpec, null);
  const facts = await (await fetch(`http://127.0.0.1:${server.address().port}/api/runtime`)).json(); assert.equal(facts.works[0].requirementState, "requirement-pending"); assert.equal(facts.admissionMetrics.pendingCount, 0);
});

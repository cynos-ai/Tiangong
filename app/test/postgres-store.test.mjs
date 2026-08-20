import assert from "node:assert/strict";
import pg from "pg";
import test from "node:test";
import { PostgresCoordinationStore } from "../coordination/postgres-store.mjs";
import { createPostgresCoordinationStore } from "../coordination/bootstrap.mjs";
import { acquirePostgresTestLock } from "./postgres-test-lock.mjs";
import { createControlProfile, createMemberConfig, createResult, createTaskSpec, createTeamConfig, createTeamRouteBinding, createWorkSpec } from "../../worker/agent/team/coordination-store.mjs";

const { Pool } = pg; const connectionString = process.env.TIANGONG_TEST_POSTGRES_URL; const disposable = process.env.TIANGONG_TEST_POSTGRES_DISPOSABLE === "1"; const skipReason = connectionString && disposable ? undefined : "set disposable PostgreSQL variables"; const NOW = "2026-08-15T02:00:00.000Z";
function records() {
  const profile = createControlProfile({ profileId: "profile-pg", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-pg", revision: 1, leaderMemberId: "leader-pg", memberIds: ["leader-pg", "developer-pg"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route-pg", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room-pg:example.test", createdAt: NOW });
  const leader = createMemberConfig({ memberId: "leader-pg", teamId: team.teamId, workerName: "leader-pg", matrixUserId: "@leader-pg:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const developer = createMemberConfig({ memberId: "developer-pg", teamId: team.teamId, workerName: "developer-pg", matrixUserId: "@developer-pg:example.test", role: "developer", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  return { profile, team, route, leader, developer };
}
async function fixture(t, options = {}) {
  const release = await acquirePostgresTestLock(); const pool = new Pool({ connectionString, max: 4 }); const store = new PostgresCoordinationStore({ pool, now: () => NOW, ...options });
  t.after(async () => { await pool.query("DROP SCHEMA IF EXISTS tiangong_coordination CASCADE"); await pool.end(); release(); }); await store.migrate(); return { pool, store, ...records() };
}
test("Postgres bootstrap requires injected connection string", () => { assert.throws(() => createPostgresCoordinationStore({ connectionString: "" }), /DATABASE_URL is required/u); });

test("Postgres M0 persists backlog, null WorkSpec, Plan, Task/Result, and Decision-free closure", { skip: skipReason }, async (t) => {
  const value = await fixture(t); await value.store.enqueueMessageAdmission({ team: value.team, route: value.route, profile: value.profile, actorId: "@human:example.test", eventId: "$event", requestId: "admit" });
  let routed = await value.store.routeMessage({ roomId: value.route.roomId, eventId: "$event", team: value.team, route: value.route, profile: value.profile, actorId: value.leader.memberId, title: "PG Work", requestId: "route" }); const id = routed.work.work.workId; assert.equal(routed.work.currentWorkSpec, null);
  const formed = await value.store.changeWorkSpec({ workId: id, spec: createWorkSpec({ workId: id, revision: 1, goal: "Deliver", doneWhen: ["reported"], createdAt: NOW }), profile: value.profile, actorId: value.leader.memberId, expectedEpoch: 0, requestId: "spec" });
  const planned = await value.store.changeWorkPlan({ workId: id, planRef: { repositoryId: "plans", commitSha: "abc" }, reason: "published", profile: value.profile, actorId: value.leader.memberId, expectedEpoch: formed.work.epoch, requestId: "plan" });
  const task = createTaskSpec({ taskId: "task-pg", workId: id, assigneeMemberId: value.developer.memberId, objective: "Implement", createdAt: NOW }); await value.store.createTask({ task, team: value.team, member: value.developer, profile: value.profile, actorId: value.leader.memberId, expectedEpoch: planned.work.epoch, requestId: "task" });
  const result = createResult({ workId: id, taskId: task.taskId, submittedBy: value.developer.memberId, summary: "Done", createdAt: NOW }); await value.store.submitResult({ result, team: value.team, member: value.developer, profile: value.profile, actorId: value.developer.memberId, expectedEpoch: 3, requestId: "result" });
  const closed = await value.store.closeWork({ workId: id, team: value.team, profile: value.profile, actorId: value.leader.memberId, action: "complete", reason: "done", expectedEpoch: 4, requestId: "close" }); assert.equal(closed.work.status, "completed"); assert.equal(closed.work.timeline.at(-1).type, "work-completed"); assert.equal(typeof value.store.decideTask, "undefined");
  assert.equal((await value.store.getResult(task.taskId)).summary, "Done"); assert.equal((await value.store.health()).pendingAdmissionCount, 0);
});

test("Postgres admission serializes duplicate Matrix ingress and ordered routing", { skip: skipReason }, async (t) => {
  const value = await fixture(t); const calls = ["a", "b"].map((suffix) => value.store.enqueueMessageAdmission({ team: value.team, route: value.route, profile: value.profile, actorId: "@human:example.test", eventId: "$same", requestId: `admit-${suffix}` })); const results = await Promise.allSettled(calls); assert.equal(results.filter((item) => item.status === "fulfilled").length, 1); assert.equal(results.filter((item) => item.status === "rejected").length, 1);
});

test("Postgres correction atomically changes current association and preserves both timelines", { skip: skipReason }, async (t) => {
  const value = await fixture(t); await value.store.enqueueMessageAdmission({ team: value.team, route: value.route, profile: value.profile, actorId: "@human:example.test", eventId: "$old", receivedAt: NOW, requestId: "a-old" }); const source = await value.store.routeMessage({ roomId: value.route.roomId, eventId: "$old", team: value.team, route: value.route, profile: value.profile, actorId: value.leader.memberId, title: "Old", requestId: "r-old" });
  await value.store.enqueueMessageAdmission({ team: value.team, route: value.route, profile: value.profile, actorId: "@human:example.test", eventId: "$wrong", receivedAt: "2026-08-15T02:00:01Z", requestId: "a-wrong" }); const wrong = await value.store.routeMessage({ roomId: value.route.roomId, eventId: "$wrong", team: value.team, route: value.route, profile: value.profile, actorId: value.leader.memberId, targetWorkId: source.work.work.workId, expectedEpoch: 0, requestId: "r-wrong" });
  await value.store.enqueueMessageAdmission({ team: value.team, route: value.route, profile: value.profile, actorId: "@human:example.test", eventId: "$correct", receivedAt: "2026-08-15T02:00:02Z", requestId: "a-correct" }); const corrected = await value.store.correctMessageAssociation({ roomId: value.route.roomId, eventId: "$wrong", correctionEventId: "$correct", team: value.team, route: value.route, profile: value.profile, actorId: value.leader.memberId, expectedSourceEpoch: wrong.work.epoch, title: "New", requestId: "correct" });
  assert.equal((await value.store.getMessageBinding(value.route.roomId, "$wrong")).workId, corrected.targetWork.work.workId); assert.equal(corrected.sourceWork.timeline.some((entry) => entry.type === "message-association-corrected"), true);
});

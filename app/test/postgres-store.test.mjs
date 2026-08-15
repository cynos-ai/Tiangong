import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

import { PostgresCoordinationStore } from "../coordination/postgres-store.mjs";
import { createPostgresCoordinationStore } from "../coordination/bootstrap.mjs";
import { acquirePostgresTestLock } from "./postgres-test-lock.mjs";
import {
  createControlProfile,
  createTeamConfig,
  createTeamRouteBinding,
  createWorkSpec,
} from "../../worker/agent/team/coordination-store.mjs";

const { Pool } = pg;
const connectionString = process.env.TIANGONG_TEST_POSTGRES_URL;
const disposable = process.env.TIANGONG_TEST_POSTGRES_DISPOSABLE === "1";
const skipReason = connectionString && disposable ? undefined : "set TIANGONG_TEST_POSTGRES_URL and TIANGONG_TEST_POSTGRES_DISPOSABLE=1 for a disposable PostgreSQL test database";
const NOW = "2026-08-15T02:00:00.000Z";

test("Postgres deployment bootstrap requires an injected connection string", () => {
  assert.throws(() => createPostgresCoordinationStore({ connectionString: "" }), /DATABASE_URL is required/u);
});

function fixtures() {
  const profile = createControlProfile({ profileId: "profile-pg", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-pg", revision: 1, leaderMemberId: "leader-pg", memberIds: ["leader-pg"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route-pg", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room-pg:example.test", createdAt: NOW });
  return { profile, team, route };
}

function spec(workId) {
  return createWorkSpec({ workId, revision: 1, objective: "Persist one coordination Work", scope: "bounded PostgreSQL slice", completionContract: "read it back and drain its wake", createdAt: NOW });
}

test("Postgres CoordinationStore persists replay-safe Work, binding, timeline, and outbox", { skip: skipReason }, async (t) => {
  const release = await acquirePostgresTestLock();
  const pool = new Pool({ connectionString, max: 4 });
  const store = new PostgresCoordinationStore({ pool, now: () => NOW });
  t.after(async () => {
    await pool.query("DROP SCHEMA IF EXISTS tiangong_coordination CASCADE");
    await pool.end();
    release();
  });
  await store.migrate();
  const { profile, team, route } = fixtures();
  const first = await store.createWork({
    workId: "work-pg-1",
    team,
    route,
    profile,
    spec: spec("work-pg-1"),
    actorId: "@human:example.test",
    sourceEventId: "$event-pg-1",
    requestId: "request-pg-1",
    wakes: [{ kind: "leader-resume", targetMemberId: team.leaderMemberId }],
  });
  assert.equal(first.replayed, false);
  assert.equal(first.work.epoch, 0);
  assert.equal(first.work.timeline.length, 1);
  assert.equal(first.wakes[0].status, "pending");

  const replay = await store.createWork({
    workId: "work-pg-1",
    team,
    route,
    profile,
    spec: spec("work-pg-1"),
    actorId: "@human:example.test",
    sourceEventId: "$event-pg-1",
    requestId: "request-pg-1",
    wakes: [{ kind: "leader-resume", targetMemberId: team.leaderMemberId }],
  });
  assert.equal(replay.replayed, true);
  await assert.rejects(() => store.createWork({
    workId: "work-pg-1",
    team,
    route,
    profile,
    spec: spec("work-pg-1"),
    actorId: "@other:example.test",
    sourceEventId: "$event-pg-1",
    requestId: "request-pg-1",
  }), /COMMAND_REQUEST_CONFLICT/u);

  const changed = await store.changeWorkSpec({ workId: "work-pg-1", spec: createWorkSpec({ workId: "work-pg-1", revision: 2, objective: "Read it back", scope: "bounded PostgreSQL slice", completionContract: "read it back and drain its wake", createdAt: NOW }), profile, actorId: "@human:example.test", expectedEpoch: 0, requestId: "request-pg-spec-1" });
  assert.equal(changed.work.epoch, 1);
  assert.equal((await store.getWork("work-pg-1")).timeline.length, 2);

  const claimed = await store.claimWake({ wakeId: first.wakes[0].wakeId, consumerId: "leader-pg", requestId: "request-pg-claim-1" });
  assert.equal(claimed.wake.status, "claimed");
  const acked = await store.ackWake({ wakeId: first.wakes[0].wakeId, consumerId: "leader-pg", receiptId: "receipt-pg-1", requestId: "request-pg-ack-1" });
  assert.equal(acked.wake.status, "acked");
  assert.equal((await store.listOutbox({ status: "acked" })).length, 1);
  assert.equal((await store.health()).workCount, 1);
});

test("Postgres CoordinationStore lets the room/event unique key reject concurrent duplicate ingress", { skip: skipReason }, async (t) => {
  const release = await acquirePostgresTestLock();
  const pool = new Pool({ connectionString, max: 4 });
  const store = new PostgresCoordinationStore({ pool, now: () => NOW });
  t.after(async () => {
    await pool.query("DROP SCHEMA IF EXISTS tiangong_coordination CASCADE");
    await pool.end();
    release();
  });
  await store.migrate();
  const { profile, team, route } = fixtures();
  const calls = ["a", "b"].map((suffix) => store.createWork({
    workId: `work-pg-race-${suffix}`,
    team,
    route,
    profile,
    spec: spec(`work-pg-race-${suffix}`),
    actorId: "@human:example.test",
    sourceEventId: "$event-pg-race",
    requestId: `request-pg-race-${suffix}`,
  }));
  const results = await Promise.allSettled(calls);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match(results.find((result) => result.status === "rejected").reason.message, /MATRIX_MESSAGE_ALREADY_BOUND|WORK_ALREADY_EXISTS/u);
  assert.equal((await store.listWorks()).length, 1);
});

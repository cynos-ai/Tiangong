import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CoordinationStore,
  createControlProfile,
  createMemberConfig,
  createTeamConfig,
  createTeamRouteBinding,
} from "../agent/team/coordination-store.mjs";
import { admitHumanMatrixEvent } from "../agent/team/leader-admission.mjs";

const NOW = "2026-08-15T01:00:00.000Z";

function bindings() {
  const profile = createControlProfile({
    profileId: "profile-default",
    revision: 1,
    maxTimelineEntries: 64,
    maxOutboxEntries: 32,
    maxTasksPerWork: 8,
    toolResultRetentionMs: 24 * 60 * 60 * 1000,
  });
  const team = createTeamConfig({
    teamId: "team-alpha",
    revision: 1,
    leaderMemberId: "leader-1",
    memberIds: ["leader-1", "member-1"],
    controlProfileId: profile.profileId,
    createdAt: NOW,
  });
  const route = createTeamRouteBinding({
    routeId: "route-alpha",
    teamId: team.teamId,
    revision: 1,
    channel: "matrix",
    roomId: "!team:example.test",
    createdAt: NOW,
  });
  const leaderMember = createMemberConfig({
    memberId: "leader-1",
    teamId: team.teamId,
    workerName: "worker-leader-1",
    matrixUserId: "@leader:example.test",
    role: "leader",
    controlProfileId: profile.profileId,
    enabled: true,
    createdAt: NOW,
  });
  const member = createMemberConfig({
    memberId: "member-1",
    teamId: team.teamId,
    workerName: "worker-member-1",
    matrixUserId: "@member:example.test",
    role: "analyst",
    controlProfileId: profile.profileId,
    enabled: true,
    createdAt: NOW,
  });
  return { profile, team, route, leaderMember, members: [leaderMember, member] };
}

function event(body = "Please inspect the current OpenClaw runtime") {
  return {
    eventId: "$human-event-1",
    roomId: "!team:example.test",
    sender: "@alice:example.test",
    type: "m.room.message",
    content: { msgtype: "m.text", body },
  };
}

function source(overrides = {}) {
  return {
    channel: "matrix",
    authenticated: true,
    actorId: "@alice:example.test",
    messageId: "$human-event-1",
    route: "team-room",
    ...overrides,
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-leader-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new CoordinationStore({ filePath: join(root, "coordination.jsonl"), now: () => NOW }), ...bindings() };
}

async function admit(fixtureValue, overrides = {}) {
  return admitHumanMatrixEvent({
    store: fixtureValue.store,
    source: source(overrides.source),
    event: overrides.event ?? event(),
    team: fixtureValue.team,
    route: fixtureValue.route,
    profile: fixtureValue.profile,
    leaderMember: fixtureValue.leaderMember,
    members: fixtureValue.members,
    now: () => NOW,
  });
}

test("bound Human Matrix event creates one Work, one Leader session, and two durable wakes", async (t) => {
  const fixtureValue = await fixture(t);
  const first = await admit(fixtureValue);
  assert.equal(first.replayed, false);
  assert.equal(first.work.currentWorkSpec.objective, "Please inspect the current OpenClaw runtime");
  assert.match(first.work.work.leaderSessionId, /^leader-[a-f0-9]{48}$/u);
  assert.equal(first.leaderSession.sessionId, first.work.work.leaderSessionId);
  assert.equal(first.leaderSession.runtime, "openclaw-native");
  assert.deepEqual(first.wakes.map((wake) => wake.kind).sort(), ["human-reply", "leader-resume"]);
  assert.equal((await fixtureValue.store.health()).sequence, 3);
  assert.equal((await fixtureValue.store.listOutbox({ status: "pending" })).length, 2);

  const replay = await admit(fixtureValue);
  assert.equal(replay.replayed, true);
  assert.equal(replay.work.work.workId, first.work.work.workId);
  assert.equal((await fixtureValue.store.health()).workCount, 1);
  assert.equal((await fixtureValue.store.listOutbox()).length, 2);
});

test("B2 admission rejects ordinary rooms, Worker senders, control events, and changed replay content", async (t) => {
  const fixtureValue = await fixture(t);
  await assert.rejects(
    admitHumanMatrixEvent({
      store: fixtureValue.store,
      source: source(),
      event: event(),
      team: fixtureValue.team,
      route: fixtureValue.route,
      profile: fixtureValue.profile,
      leaderMember: fixtureValue.leaderMember,
      now: () => NOW,
    }),
    (error) => error.code === "HUMAN_BINDING_INVALID",
  );
  await assert.rejects(admit(fixtureValue, { source: { route: "worker-dm" } }), (error) => error.code === "HUMAN_ROUTE_NOT_BOUND");
  await assert.rejects(admit(fixtureValue, { event: { ...event(), roomId: "!other:example.test" } }), (error) => error.code === "HUMAN_ROOM_NOT_BOUND");
  await assert.rejects(admit(fixtureValue, { event: { ...event(), sender: "@leader:example.test" }, source: { actorId: "@leader:example.test" } }), (error) => error.code === "HUMAN_SENDER_IS_WORKER");
  await assert.rejects(admit(fixtureValue, { event: { ...event(), content: { msgtype: "m.text", body: "control", "com.tiangong.handoff": { work_id: "work-1" } } } }), (error) => error.code === "HUMAN_EVENT_CONTROL_CONTENT");

  await admit(fixtureValue);
  await assert.rejects(admit(fixtureValue, { event: event("The same event was rewritten") }), /COMMAND_REQUEST_CONFLICT/u);
});

test("admission survives a store restart and does not admit an unauthenticated or mismatched event", async (t) => {
  const fixtureValue = await fixture(t);
  await assert.rejects(admit(fixtureValue, { source: { authenticated: false } }), (error) => error.code === "HUMAN_SOURCE_UNAUTHENTICATED");
  await assert.rejects(admit(fixtureValue, { source: { messageId: "$other-event" } }), (error) => error.code === "HUMAN_EVENT_SOURCE_MISMATCH");
  const admitted = await admit(fixtureValue);
  const reopened = new CoordinationStore({ filePath: join(fixtureValue.root, "coordination.jsonl"), now: () => NOW });
  const replay = await admitHumanMatrixEvent({
    store: reopened,
    source: source(),
    event: event(),
    team: fixtureValue.team,
    route: fixtureValue.route,
    profile: fixtureValue.profile,
    leaderMember: fixtureValue.leaderMember,
    members: fixtureValue.members,
    now: () => NOW,
  });
  assert.equal(replay.replayed, true);
  assert.equal((await reopened.getWork(admitted.work.work.workId)).currentWorkSpec.revision, 1);
});

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
import {
  admitLeaderMatrixIngress,
  createOpenClawLeaderAdmissionHook,
} from "../agent/team/leader-ingress.mjs";

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
    memberIds: ["leader-1"],
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
  return { profile, team, route, leaderMember, members: [leaderMember] };
}

function source() {
  return {
    channel: "matrix",
    authenticated: true,
    actorId: "@alice:example.test",
    messageId: "$human-event-1",
    route: "team-room",
  };
}

function event() {
  return {
    eventId: "$human-event-1",
    roomId: "!team:example.test",
    sender: "@alice:example.test",
    type: "m.room.message",
    content: { msgtype: "m.text", body: "Start the bounded Work" },
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-leader-ingress-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    store: new CoordinationStore({ filePath: join(root, "coordination.jsonl"), now: () => NOW }),
    ...bindings(),
  };
}

test("B2 ingress reads, admits, and visibly replies without creating duplicate Work", async (t) => {
  const value = await fixture(t);
  const calls = [];
  const channel = {
    async readHumanEvent(roomId, eventId) {
      calls.push(["read", roomId, eventId]);
      return event();
    },
    async notifyWorkAdmitted(recipient, input) {
      calls.push(["reply", recipient, input]);
      return { delivered: true, eventIdDigest: "b".repeat(64) };
    },
  };
  const result = await admitLeaderMatrixIngress({
    channel,
    store: value.store,
    source: source(),
    roomId: "!team:example.test",
    eventId: "$human-event-1",
    ...value,
    now: () => NOW,
  });
  const replay = await admitLeaderMatrixIngress({
    channel,
    store: value.store,
    source: source(),
    roomId: "!team:example.test",
    eventId: "$human-event-1",
    ...value,
    now: () => NOW,
  });
  assert.equal(result.reply.delivered, true);
  assert.equal(replay.admission.replayed, true);
  assert.equal((await value.store.health()).workCount, 1);
  assert.equal((await value.store.listOutbox()).length, 2);
  assert.equal(calls.filter(([kind]) => kind === "reply").length, 2);
  assert.equal(calls[1][2].workId, result.admission.work.work.workId);
  assert.equal(calls[1][2].bindingDigest.length, 64);
});

test("B2 ingress keeps the durable Work when visible reply delivery is temporarily unavailable", async (t) => {
  const value = await fixture(t);
  const channel = {
    async readHumanEvent() { return event(); },
    async notifyWorkAdmitted() { throw new Error("temporary Matrix outage"); },
  };
  const result = await admitLeaderMatrixIngress({
    channel,
    store: value.store,
    source: source(),
    roomId: "!team:example.test",
    eventId: "$human-event-1",
    ...value,
    now: () => NOW,
  });
  assert.deepEqual(result.reply, { delivered: false, pending: true, errorCode: "MATRIX_REPLY_FAILED" });
  assert.equal((await value.store.health()).workCount, 1);
  assert.equal((await value.store.listOutbox({ status: "pending" })).filter((wake) => wake.kind === "human-reply").length, 1);
});

test("B2 OpenClaw hook binds startup dependencies and accepts only per-event ingress facts", async (t) => {
  const value = await fixture(t);
  const hook = createOpenClawLeaderAdmissionHook({
    channel: {
      async readHumanEvent() { return event(); },
      async notifyWorkAdmitted() { return { delivered: true, eventIdDigest: "c".repeat(64) }; },
    },
    store: value.store,
    team: value.team,
    route: value.route,
    profile: value.profile,
    leaderMember: value.leaderMember,
    members: value.members,
    now: () => NOW,
  });
  const result = await hook({
    source: source(),
    roomId: "!team:example.test",
    eventId: "$human-event-1",
  });
  assert.equal(result.reply.delivered, true);
  assert.throws(
    () => createOpenClawLeaderAdmissionHook({ channel: {}, store: value.store, team: value.team }),
    /current Team bindings and channel/u,
  );
});

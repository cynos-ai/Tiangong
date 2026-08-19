import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  CoordinationStore,
  createControlProfile,
  createMemberConfig,
  createTeamConfig,
  createTeamRouteBinding,
  createWorkSpec,
} from "../agent/team/coordination-store.mjs";
import { leaderResumeEventBody, parseLeaderResumeEvent, resumeLeaderMatrixEvent } from "../agent/team/leader-resume.mjs";

const NOW = "2026-08-15T03:00:00.000Z";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-leader-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = createControlProfile({ profileId: "profile-resume", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-resume", revision: 1, leaderMemberId: "leader-resume", memberIds: ["leader-resume"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route-resume", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room-resume:example.test", createdAt: NOW });
  const leaderMember = createMemberConfig({ memberId: "leader-resume", teamId: team.teamId, workerName: "leader-resume", matrixUserId: "@leader-resume:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const store = new CoordinationStore({ filePath: join(root, "coordination.jsonl"), now: () => NOW });
  const admitted = await store.createWork({
    workId: "work-resume",
    team,
    route,
    profile,
    spec: createWorkSpec({ workId: "work-resume", revision: 1, goal: "resume", scope: ["test"], doneWhen: ["evidence"], createdAt: NOW }),
    actorId: "@human-resume:example.test",
    sourceEventId: "$human-resume",
    requestId: "request-resume",
    wakes: [
      { kind: "leader-resume", targetMemberId: leaderMember.memberId },
      { kind: "human-reply", targetMemberId: "@human-resume:example.test" },
    ],
  });
  return { store, team, route, leaderMember, admitted };
}

test("Leader resume envelope is closed, bound to the durable Work, and replay-safe", async (t) => {
  const { store, team, route, leaderMember, admitted } = await fixture(t);
  const wake = admitted.wakes.find((entry) => entry.kind === "leader-resume");
  const content = leaderResumeEventBody({ wakeId: wake.wakeId, workId: wake.workId, targetMemberId: wake.targetMemberId, targetMatrixUserId: leaderMember.matrixUserId });
  const event = { eventId: "$leader-resume-event", roomId: route.roomId, sender: leaderMember.matrixUserId, type: "m.room.message", content };
  assert.deepEqual(parseLeaderResumeEvent(event).workId, wake.workId);
  const resumed = await resumeLeaderMatrixEvent({
    store,
    source: { channel: "matrix", authenticated: true, actorId: leaderMember.matrixUserId, messageId: event.eventId, route: "team-room" },
    event,
    team,
    route,
    leaderMember,
  });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.wakeStatus, "pending");
  assert.equal(resumed.leaderSessionId, admitted.work.work.leaderSessionId);
  assert.throws(() => parseLeaderResumeEvent({ ...event, content: { ...content, "com.tiangong.leader-resume": { ...content["com.tiangong.leader-resume"], work_id: "not valid" } } }), /invalid/u);
  await assert.rejects(
    resumeLeaderMatrixEvent({
      store,
      source: { channel: "matrix", authenticated: true, actorId: "@other:example.test", messageId: event.eventId, route: "team-room" },
      event,
      team,
      route,
      leaderMember,
    }),
    (error) => error.code === "LEADER_RESUME_SOURCE_MISMATCH",
  );
});

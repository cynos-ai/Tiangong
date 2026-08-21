import assert from "node:assert/strict";
import test from "node:test";

import {
  createControlProfile,
  createMemberConfig,
  createTeamConfig,
  createTeamRouteBinding,
} from "../agent/team/coordination-contracts.mjs";
import { leaderResumeEventBody, parseLeaderResumeEvent, resumeLeaderMatrixEvent } from "../agent/team/leader-resume.mjs";

const NOW = "2026-08-15T03:00:00.000Z";

function fixture() {
  const profile = createControlProfile({ profileId: "profile-resume", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-resume", revision: 1, leaderMemberId: "leader-resume", memberIds: ["leader-resume"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route-resume", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room-resume:example.test", createdAt: NOW });
  const leaderMember = createMemberConfig({ memberId: "leader-resume", teamId: team.teamId, workerName: "leader-resume", matrixUserId: "@leader-resume:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const wake = { wakeId: "a".repeat(64), kind: "leader-resume", workId: "work-resume", targetMemberId: leaderMember.memberId, status: "pending" };
  const work = { work: { workId: wake.workId, teamId: team.teamId, routeId: route.routeId, roomId: route.roomId, leaderSessionId: "leader-session" }, status: "open" };
  const store = { async getWork(id) { return id === wake.workId ? work : undefined; }, async getWake(id) { return id === wake.wakeId ? wake : undefined; } };
  return { store, team, route, leaderMember, wake, work };
}

test("Leader resume envelope is closed, bound to durable store reads, and rejects the wrong actor", async () => {
  const { store, team, route, leaderMember, wake, work } = fixture();
  const content = leaderResumeEventBody({ wakeId: wake.wakeId, workId: wake.workId, targetMemberId: wake.targetMemberId, targetMatrixUserId: leaderMember.matrixUserId });
  const event = { eventId: "$leader-resume-event", roomId: route.roomId, sender: leaderMember.matrixUserId, type: "m.room.message", content };
  assert.equal(parseLeaderResumeEvent(event).workId, wake.workId);
  const resumed = await resumeLeaderMatrixEvent({ store, source: { channel: "matrix", authenticated: true, actorId: leaderMember.matrixUserId, messageId: event.eventId, route: "team-room" }, event, team, route, leaderMember });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.wakeStatus, "pending");
  assert.equal(resumed.leaderSessionId, work.work.leaderSessionId);
  assert.throws(() => parseLeaderResumeEvent({ ...event, content: { ...content, "com.tiangong.leader-resume": { ...content["com.tiangong.leader-resume"], work_id: "not valid" } } }), /invalid/u);
  await assert.rejects(resumeLeaderMatrixEvent({ store, source: { channel: "matrix", authenticated: true, actorId: "@other:example.test", messageId: event.eventId, route: "team-room" }, event, team, route, leaderMember }), (error) => error.code === "LEADER_RESUME_SOURCE_MISMATCH");
});

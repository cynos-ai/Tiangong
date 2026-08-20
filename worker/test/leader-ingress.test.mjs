import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CoordinationStore, createControlProfile, createMemberConfig, createTeamConfig, createTeamRouteBinding } from "../agent/team/coordination-store.mjs";
import { admitLeaderMatrixIngress, createOpenClawLeaderAdmissionHook } from "../agent/team/leader-ingress.mjs";

const NOW = "2026-08-15T01:00:00.000Z";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tg-ingress-")); t.after(() => rm(root, { recursive: true, force: true }));
  const profile = createControlProfile({ profileId: "profile", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team", revision: 1, leaderMemberId: "leader", memberIds: ["leader"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room:example.test", createdAt: NOW });
  const leaderMember = createMemberConfig({ memberId: "leader", teamId: team.teamId, workerName: "leader", matrixUserId: "@leader:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, runtime: "openclaw-built-in", model: "glm-5", allowedSkills: [], createdAt: NOW });
  return { store: new CoordinationStore({ filePath: join(root, "state.json"), now: () => NOW }), profile, team, route, leaderMember, members: [leaderMember] };
}
const source = { channel: "matrix", authenticated: true, actorId: "@human:example.test", messageId: "$event", route: "team-room" };
const event = { eventId: "$event", roomId: "!room:example.test", sender: "@human:example.test", type: "m.room.message", content: { msgtype: "m.text", body: "Route me" } };

test("OpenClaw ingress re-reads one event and leaves semantic routing to Leader", async (t) => {
  const value = await fixture(t); const calls = [];
  const channel = { async readHumanEvent(roomId, eventId) { calls.push([roomId, eventId]); return event; } };
  const admitted = await admitLeaderMatrixIngress({ channel, source, roomId: event.roomId, eventId: event.eventId, ...value, now: () => NOW });
  assert.equal(admitted.admission.status, "pending"); assert.equal((await value.store.listWorks()).length, 0); assert.deepEqual(calls, [[event.roomId, event.eventId]]);
  const hook = createOpenClawLeaderAdmissionHook({ channel, ...value, now: () => NOW }); const replay = await hook({ source, roomId: event.roomId, eventId: event.eventId }); assert.equal(replay.replayed, true);
});

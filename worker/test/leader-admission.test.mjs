import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CoordinationStore, createControlProfile, createMemberConfig, createTeamConfig, createTeamRouteBinding } from "../agent/team/coordination-store.mjs";
import { admitHumanMatrixEvent } from "../agent/team/leader-admission.mjs";

const NOW = "2026-08-15T01:00:00.000Z";
function bindings() {
  const profile = createControlProfile({ profileId: "profile", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team", revision: 1, leaderMemberId: "leader", memberIds: ["leader"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!team:example.test", createdAt: NOW });
  const leaderMember = createMemberConfig({ memberId: "leader", teamId: team.teamId, workerName: "leader", matrixUserId: "@leader:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, runtime: "openclaw-built-in", model: "deepseek-chat", allowedSkills: [], createdAt: NOW });
  return { profile, team, route, leaderMember, members: [leaderMember] };
}
function source(overrides = {}) { return { channel: "matrix", authenticated: true, actorId: "@human:example.test", messageId: "$event", route: "team-room", ...overrides }; }
function event(content = { msgtype: "m.text", body: "A new request" }, overrides = {}) { return { eventId: "$event", roomId: "!team:example.test", sender: "@human:example.test", type: "m.room.message", content, ...overrides }; }
async function fixture(t) { const root = await mkdtemp(join(tmpdir(), "tg-admission-")); t.after(() => rm(root, { recursive: true, force: true })); return { store: new CoordinationStore({ filePath: join(root, "state.json"), now: () => NOW }), ...bindings() }; }

test("ordinary Human Matrix messages enter a durable backlog without creating Work or copying text", async (t) => {
  const value = await fixture(t); const first = await admitHumanMatrixEvent({ ...value, source: source(), event: event(), now: () => NOW });
  assert.equal(first.admission.status, "pending"); assert.equal(first.admission.attempts, 1); assert.equal(first.admission.leaseOwner, "leader"); assert.equal(first.binding, null); assert.equal((await value.store.listWorks()).length, 0); assert.equal(JSON.stringify(first.admission).includes("A new request"), false);
  const replay = await admitHumanMatrixEvent({ ...value, source: source(), event: event(), now: () => NOW }); assert.equal(replay.replayed, true); assert.equal((await value.store.admissionMetrics()).pendingCount, 1);
});

test("admission accepts ordinary Matrix replies but rejects Tiangong control content and invalid identity", async (t) => {
  const value = await fixture(t);
  const reply = event({ msgtype: "m.text", body: "This is another thing", "m.relates_to": { "m.in_reply_to": { event_id: "$earlier" } } });
  assert.equal((await admitHumanMatrixEvent({ ...value, source: source(), event: reply, now: () => NOW })).admission.status, "pending");
  const other = await fixture(t);
  await assert.rejects(admitHumanMatrixEvent({ ...other, source: source(), event: event({ msgtype: "m.text", body: "control", "com.tiangong.work": { work_id: "x" } }), now: () => NOW }), (error) => error.code === "HUMAN_EVENT_CONTROL_CONTENT");
  await assert.rejects(admitHumanMatrixEvent({ ...other, source: source({ authenticated: false }), event: event(), now: () => NOW }), (error) => error.code === "HUMAN_SOURCE_UNAUTHENTICATED");
  await assert.rejects(admitHumanMatrixEvent({ ...other, source: source({ actorId: "@leader:example.test" }), event: event(undefined, { sender: "@leader:example.test" }), now: () => NOW }), (error) => error.code === "HUMAN_SENDER_IS_WORKER");
});

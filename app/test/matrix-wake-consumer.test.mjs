import assert from "node:assert/strict";
import test from "node:test";

import { createControlProfile, createMemberConfig, createTeamConfig, createTeamRouteBinding } from "../../worker/agent/team/coordination-contracts.mjs";
import { createMatrixWakeConsumer } from "../coordination/matrix-wake-consumer.mjs";

const NOW = "2026-08-15T03:00:00.000Z";
const TOKEN = "matrix-deployment-token";
function response(value, status = 200) { return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(value); } }; }
function bindings() {
  const profile = createControlProfile({ profileId: "profile-consumer", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-consumer", revision: 1, leaderMemberId: "leader-consumer", memberIds: ["leader-consumer", "member-consumer"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route-consumer", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room-consumer:example.test", createdAt: NOW });
  const leaderMember = createMemberConfig({ memberId: "leader-consumer", teamId: team.teamId, workerName: "leader-consumer", matrixUserId: "@leader-consumer:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const member = createMemberConfig({ memberId: "member-consumer", teamId: team.teamId, workerName: "member-consumer", matrixUserId: "@member-consumer:example.test", role: "developer", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  return { team, route, profile, leaderMember, members: [leaderMember, member], member };
}
function queueStore(binding, kinds = ["leader-resume", "human-reply", "task-assignment", "result-notification"]) {
  const workId = "work-consumer"; const taskId = "task-consumer";
  const work = { work: { workId, teamId: binding.team.teamId, routeId: binding.route.routeId, actorId: "@human:example.test", sourceEventId: "$human" } };
  const task = { spec: { taskId, workId, assigneeMemberId: binding.member.memberId }, result: { taskId, workId } };
  const wakes = kinds.map((kind, index) => ({ wakeId: String(index + 1).repeat(64), kind, workId, ...(kind.includes("task") || kind.includes("result") ? { taskId } : {}), targetMemberId: kind === "human-reply" ? work.work.actorId : kind === "task-assignment" ? binding.member.memberId : binding.leaderMember.memberId, status: "pending" }));
  return {
    wakes,
    async getWork(id) { return id === workId ? work : undefined; }, async getTask(id) { return id === taskId ? task : undefined; },
    async listOutbox({ status } = {}) { return wakes.filter((wake) => !status || wake.status === status).map((wake) => ({ ...wake })); },
    async claimWake({ wakeId, consumerId }) { const wake = wakes.find((entry) => entry.wakeId === wakeId); if (wake.status !== "pending") throw new Error("WAKE_CLAIM_CONFLICT"); Object.assign(wake, { status: "claimed", consumerId }); return { wake: { ...wake } }; },
    async ackWake({ wakeId, consumerId, receiptId }) { const wake = wakes.find((entry) => entry.wakeId === wakeId); if (wake.status !== "claimed" || wake.consumerId !== consumerId) throw new Error("WAKE_ACK_CONFLICT"); Object.assign(wake, { status: "acked", receiptId }); return { wake: { ...wake } }; },
  };
}
function matrixFetch(binding, calls, sendUrls = []) {
  return async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/_matrix/client/v3/account/whoami")) return response({ user_id: binding.leaderMember.matrixUserId });
    if (url.includes("/joined_members")) return response({ joined: Object.fromEntries(binding.members.map((member) => [member.matrixUserId, {}])) });
    if (url.includes("/send/m.room.message/")) { sendUrls.push(url); return response({ event_id: `$sent-${sendUrls.length}` }); }
    throw new Error("unexpected matrix request");
  };
}

test("Matrix wake consumer delivers each PostgreSQL outbox kind and acknowledges it", async () => {
  const binding = bindings(); const store = queueStore(binding); const calls = []; const sendUrls = [];
  const consumer = createMatrixWakeConsumer({ store, binding, matrixUrl: "https://matrix.example.test", matrixToken: TOKEN, fetchImpl: matrixFetch(binding, calls, sendUrls), intervalMs: 1000 });
  await consumer.start(); await consumer.stop();
  const deliveries = calls.filter((call) => call.url.includes("/send/m.room.message/"));
  assert.equal(deliveries.length, 4); assert.ok(deliveries.every((call) => call.options.headers.Authorization === `Bearer ${TOKEN}`));
  const bodies = deliveries.map((call) => JSON.parse(call.options.body));
  assert.ok(bodies.some((body) => body["com.tiangong.leader-resume"])); assert.ok(bodies.some((body) => body["com.tiangong.work"])); assert.ok(bodies.some((body) => body["com.tiangong.task"])); assert.ok(bodies.some((body) => body["com.tiangong.result"]));
  assert.equal(store.wakes.every((wake) => wake.status === "acked"), true);
});

test("Matrix wake replay reuses one transaction after a crash before ack", async () => {
  const binding = bindings(); const store = queueStore(binding, ["leader-resume"]); const calls = []; const sendUrls = []; let failAck = true;
  const flakyStore = { ...store, async ackWake(input) { if (failAck) { failAck = false; throw Object.assign(new Error("simulated crash"), { code: "SIMULATED_CRASH_AFTER_SEND" }); } return store.ackWake(input); } };
  const options = { store: flakyStore, binding, matrixUrl: "https://matrix.example.test", matrixToken: TOKEN, fetchImpl: matrixFetch(binding, calls, sendUrls), intervalMs: 1000 };
  const first = createMatrixWakeConsumer(options); await first.start(); await first.stop(); assert.equal(store.wakes[0].status, "claimed");
  const restarted = createMatrixWakeConsumer(options); await restarted.start(); await restarted.stop();
  assert.equal(sendUrls.length, 2); assert.equal(new URL(sendUrls[0]).pathname, new URL(sendUrls[1]).pathname); assert.equal(store.wakes[0].status, "acked");
});

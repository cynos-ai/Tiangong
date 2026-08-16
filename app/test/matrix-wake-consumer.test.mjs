import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { CoordinationStore, createControlProfile, createMemberConfig, createResult, createTaskSpec, createTeamConfig, createTeamRouteBinding, createWorkSpec } from "../../worker/agent/team/coordination-store.mjs";
import { createMatrixWakeConsumer } from "../coordination/matrix-wake-consumer.mjs";

const NOW = "2026-08-15T03:00:00.000Z";
const TOKEN = "matrix-deployment-token";

function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(value); } };
}

test("Matrix wake consumer delivers Work, Task, and Result wakes, then acknowledges the outbox", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-matrix-consumer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = createControlProfile({ profileId: "profile-consumer", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-consumer", revision: 1, leaderMemberId: "leader-consumer", memberIds: ["leader-consumer", "member-consumer"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route-consumer", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room-consumer:example.test", createdAt: NOW });
  const leaderMember = createMemberConfig({ memberId: "leader-consumer", teamId: team.teamId, workerName: "leader-consumer", matrixUserId: "@leader-consumer:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const member = createMemberConfig({ memberId: "member-consumer", teamId: team.teamId, workerName: "member-consumer", matrixUserId: "@member-consumer:example.test", role: "implementor", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const store = new CoordinationStore({ filePath: join(root, "coordination.jsonl"), now: () => NOW });
  await store.createWork({
    workId: "work-consumer",
    team,
    route,
    profile,
    spec: createWorkSpec({ workId: "work-consumer", revision: 1, objective: "consumer", scope: "test", completionContract: "evidence", createdAt: NOW }),
    actorId: "@human-consumer:example.test",
    sourceEventId: "$human-consumer",
    requestId: "request-consumer",
    wakes: [
      { kind: "leader-resume", targetMemberId: leaderMember.memberId },
      { kind: "human-reply", targetMemberId: "@human-consumer:example.test" },
    ],
  });
  const task = createTaskSpec({ taskId: "task-consumer", workId: "work-consumer", assigneeMemberId: member.memberId, objective: "consumer task", completionContract: "one result", inputRefs: [], createdAt: NOW });
  await store.createTask({ task, team, member, profile, actorId: leaderMember.memberId, expectedEpoch: 0, requestId: "request-consumer-task", wake: { targetMemberId: member.memberId } });
  const result = createResult({ resultId: "result-consumer", workId: task.workId, taskId: task.taskId, producerMemberId: member.memberId, toolResultIds: [], artifactRefs: [], claim: "consumer result", createdAt: NOW });
  await store.submitResult({ result, team, member, profile, actorId: member.memberId, expectedEpoch: 1, requestId: "request-consumer-result" });
  await store.enqueueWake({ workId: task.workId, taskId: task.taskId, targetMemberId: leaderMember.memberId, kind: "result-notification", requestId: "request-consumer-notification" });
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/_matrix/client/v3/account/whoami")) return response({ user_id: leaderMember.matrixUserId });
    if (url.includes("/joined_members")) return response({ joined: { [leaderMember.matrixUserId]: {}, [member.matrixUserId]: {} } });
    if (url.includes("/send/m.room.message/")) return response({ event_id: "$sent-" + calls.length });
    throw new Error("unexpected matrix request");
  };
  const consumer = createMatrixWakeConsumer({ store, binding: { team, route, profile, leaderMember, members: [leaderMember, member] }, matrixUrl: "https://matrix.example.test", matrixToken: TOKEN, fetchImpl: fakeFetch, intervalMs: 1000 });
  await consumer.start();
  await consumer.stop();
  const deliveries = calls.filter((call) => call.url.includes("/send/m.room.message/"));
  assert.equal(deliveries.length, 4);
  assert.ok(deliveries.every((call) => call.options.headers.Authorization === `Bearer ${TOKEN}`));
  assert.ok(deliveries.some((call) => JSON.parse(call.options.body)["com.tiangong.leader-resume"]));
  assert.ok(deliveries.some((call) => JSON.parse(call.options.body)["com.tiangong.work"]));
  assert.ok(deliveries.some((call) => JSON.parse(call.options.body)["com.tiangong.task"]));
  assert.ok(deliveries.some((call) => JSON.parse(call.options.body)["com.tiangong.result"]));
  const taskDelivery = deliveries.find((call) => JSON.parse(call.options.body)["com.tiangong.task"]);
  const taskBody = JSON.parse(taskDelivery.options.body);
  assert.equal(taskBody.format, "org.matrix.custom.html");
  assert.match(taskBody.formatted_body, /matrix\.to\/#[^\s"]+/u);
  assert.equal((await store.listOutbox({ status: "pending" })).length, 0);
  assert.equal((await store.listOutbox({ status: "acked" })).length, 4);
});

test("Matrix outbox replay keeps one logical transaction after a crash before ack", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-matrix-consumer-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = createControlProfile({ profileId: "profile-replay", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 8, maxTasksPerWork: 4, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-replay", revision: 1, leaderMemberId: "leader-replay", memberIds: ["leader-replay"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route-replay", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room-replay:example.test", createdAt: NOW });
  const leaderMember = createMemberConfig({ memberId: "leader-replay", teamId: team.teamId, workerName: "leader-replay", matrixUserId: "@leader-replay:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const store = new CoordinationStore({ filePath: join(root, "coordination.jsonl"), now: () => NOW });
  await store.createWork({
    workId: "work-replay",
    team,
    route,
    profile,
    spec: createWorkSpec({ workId: "work-replay", revision: 1, objective: "replay", scope: "test", completionContract: "one ack", createdAt: NOW }),
    actorId: "@human-replay:example.test",
    sourceEventId: "$human-replay",
    requestId: "request-replay",
    wakes: [{ kind: "leader-resume", targetMemberId: leaderMember.memberId }],
  });
  const sendUrls = [];
  const fakeFetch = async (url) => {
    if (url.endsWith("/_matrix/client/v3/account/whoami")) return response({ user_id: leaderMember.matrixUserId });
    if (url.includes("/joined_members")) return response({ joined: { [leaderMember.matrixUserId]: {} } });
    if (url.includes("/send/m.room.message/")) {
      sendUrls.push(url);
      return response({ event_id: "$sent-replay-" + sendUrls.length });
    }
    throw new Error("unexpected matrix request");
  };
  let failAck = true;
  const flakyStore = {
    listOutbox: (...args) => store.listOutbox(...args),
    getWork: (...args) => store.getWork(...args),
    claimWake: (...args) => store.claimWake(...args),
    ackWake: async (...args) => {
      if (failAck) {
        failAck = false;
        throw Object.assign(new Error("simulated crash after Matrix send"), { code: "SIMULATED_CRASH_AFTER_SEND" });
      }
      return store.ackWake(...args);
    },
  };
  const binding = { team, route, profile, leaderMember, members: [leaderMember] };
  const first = createMatrixWakeConsumer({ store: flakyStore, binding, matrixUrl: "https://matrix.example.test", matrixToken: TOKEN, fetchImpl: fakeFetch, intervalMs: 1000 });
  await first.start();
  await first.stop();
  assert.equal((await store.listOutbox({ status: "pending" })).length, 0);
  assert.equal((await store.listOutbox({ status: "claimed" })).length, 1);
  const restarted = createMatrixWakeConsumer({ store: flakyStore, binding, matrixUrl: "https://matrix.example.test", matrixToken: TOKEN, fetchImpl: fakeFetch, intervalMs: 1000 });
  await restarted.start();
  await restarted.stop();
  assert.equal(sendUrls.length, 2);
  assert.equal(new URL(sendUrls[0]).pathname, new URL(sendUrls[1]).pathname);
  assert.equal((await store.listOutbox({ status: "pending" })).length, 0);
  assert.equal((await store.listOutbox({ status: "acked" })).length, 1);
});

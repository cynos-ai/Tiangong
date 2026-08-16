import assert from "node:assert/strict";
import test from "node:test";

import { createRemoteCoordinationStore, createRemoteOpenClawLeaderAdmissionHook } from "../agent/team/coordination-control-client.mjs";
import { leaderResumeEventBody } from "../agent/team/leader-resume.mjs";

test("remote Leader admission re-reads the Matrix event and sends only the bounded proof", async () => {
  const calls = [];
  const event = { eventId: "$event-client-1", roomId: "!room-client:example.test", sender: "@human:example.test", type: "m.room.message", content: { msgtype: "m.text", body: "hello" } };
  const hook = createRemoteOpenClawLeaderAdmissionHook({
    channel: { readHumanEvent: async (roomId, eventId) => { calls.push(["read", roomId, eventId]); return event; } },
    endpoint: "http://control.example.test/v1/coordination/admit",
    token: "client-control-token",
    fetchImpl: async (url, options) => {
      calls.push(["fetch", url, options]);
      return new Response(JSON.stringify({ replayed: false, work: { work: { workId: "work-client-1" } }, wakes: [] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await hook({
    roomId: event.roomId,
    eventId: event.eventId,
    source: { channel: "matrix", authenticated: true, actorId: event.sender, messageId: event.eventId, route: "team-room" },
  });
  assert.equal(result.work.work.workId, "work-client-1");
  assert.deepEqual(calls[0], ["read", event.roomId, event.eventId]);
  assert.equal(calls[1][2].headers.Authorization, "Bearer client-control-token");
  const body = JSON.parse(calls[1][2].body);
  assert.deepEqual(body.event, event);
  assert.equal(body.source.route, "team-room");
});

test("remote CoordinationStore facade supports a Leader outbox loop without a database handle", async () => {
  const calls = [];
  const store = createRemoteCoordinationStore({
    endpoint: "http://control.example.test/v1/coordination/admit",
    token: "client-control-token",
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      if (url.includes("/wakes?")) return new Response(JSON.stringify({ wakes: [{ wakeId: "a".repeat(64), kind: "leader-resume", targetMemberId: "leader", status: "pending", createdAt: "2026-08-15T00:00:00.000Z" }] }), { status: 200 });
      if (url.includes("/works/")) return new Response(JSON.stringify({ work: { work: { workId: "work-1" }, routeId: "route-1" } }), { status: 200 });
      return new Response(JSON.stringify({ wake: { status: url.endsWith("/claim") ? "claimed" : "acked" } }), { status: 200 });
    },
  });
  assert.equal((await store.listOutbox({ status: "pending" })).length, 1);
  assert.equal((await store.getWork("work-1")).work.workId, "work-1");
  assert.equal((await store.claimWake({ wakeId: "a".repeat(64), consumerId: "leader", requestId: "claim-1" })).wake.status, "claimed");
  assert.equal((await store.ackWake({ wakeId: "a".repeat(64), consumerId: "leader", receiptId: "receipt-1", requestId: "ack-1" })).wake.status, "acked");
  assert.equal(calls.every(([, options]) => options.headers.Authorization === "Bearer client-control-token"), true);
});

test("remote CoordinationStore routes bound Task/Result writes through the deployment gateway", async () => {
  const calls = [];
  const store = createRemoteCoordinationStore({
    endpoint: "http://control.example.test/v1/coordination/admit",
    token: "client-control-token",
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      if (url.endsWith("/tasks")) return new Response(JSON.stringify({ replayed: false, task: { spec: { taskId: "task-remote" } }, wake: { kind: "task-assignment" } }), { status: 200 });
      return new Response(JSON.stringify({ replayed: false, result: { resultId: "result-remote" }, wake: { kind: "result-notification" } }), { status: 200 });
    },
  });
  const task = await store.createTask({ task: { taskId: "task-remote" }, actorId: "leader-remote", expectedEpoch: 0, requestId: "task-remote-request" });
  const result = await store.submitResult({ result: { resultId: "result-remote" }, actorId: "member-remote", expectedEpoch: 1, requestId: "result-remote-request" });
  assert.equal(task.wake.kind, "task-assignment");
  assert.equal(result.wake.kind, "result-notification");
  assert.equal(calls[0][0], "http://control.example.test/v1/coordination/tasks");
  assert.equal(JSON.parse(calls[0][1].body).actorId, "leader-remote");
  assert.equal(calls[1][0], "http://control.example.test/v1/coordination/results");
  assert.equal(JSON.parse(calls[1][1].body).actorId, "member-remote");
});

test("remote Leader admission routes a machine resume envelope to the resume endpoint", async () => {
  const calls = [];
  const event = {
    eventId: "$event-client-resume",
    roomId: "!room-client:example.test",
    sender: "@leader:example.test",
    type: "m.room.message",
    content: leaderResumeEventBody({ wakeId: "a".repeat(64), workId: "work-client-resume", targetMemberId: "leader", targetMatrixUserId: "@leader:example.test" }),
  };
  const hook = createRemoteOpenClawLeaderAdmissionHook({
    channel: { readHumanEvent: async () => event },
    endpoint: "http://control.example.test/v1/coordination/admit",
    token: "client-control-token",
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return new Response(JSON.stringify({ resumed: true, workId: event.content["com.tiangong.leader-resume"].work_id }), { status: 200 });
    },
  });
  const result = await hook({
    roomId: event.roomId,
    eventId: event.eventId,
    source: { channel: "matrix", authenticated: true, actorId: event.sender, messageId: event.eventId, route: "team-room" },
  });
  assert.equal(result.resumed, true);
  assert.equal(calls[0][0], "http://control.example.test/v1/coordination/resume");
});

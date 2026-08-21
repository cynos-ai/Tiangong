import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteCoordinationStore, createRemoteOpenClawLeaderAdmissionHook } from "../agent/team/coordination-control-client.mjs";
import { leaderResumeEventBody } from "../agent/team/leader-resume.mjs";

const endpoint = "http://control.example.test/v1/coordination/admit";
const token = "client-control-token";

test("remote admission re-reads Matrix and sends the ordinary event proof", async () => {
  const calls = []; const event = { eventId: "$event", roomId: "!room:example.test", sender: "@human:example.test", type: "m.room.message", content: { msgtype: "m.text", body: "hello" } };
  const hook = createRemoteOpenClawLeaderAdmissionHook({ endpoint, token, channel: { async readHumanEvent() { return event; } }, fetchImpl: async (url, options) => { calls.push([url, options]); return new Response(JSON.stringify({ replayed: false, admission: { eventId: event.eventId, status: "pending" }, binding: null }), { status: 200 }); } });
  const result = await hook({ roomId: event.roomId, eventId: event.eventId, source: { channel: "matrix", authenticated: true, actorId: event.sender, messageId: event.eventId, route: "team-room" } });
  assert.equal(result.admission.status, "pending"); assert.equal(JSON.parse(calls[0][1].body).event.content.body, "hello");
});

test("remote facade exposes routing, Work, Task, Result, cancellation, and closure without Decision", async () => {
  const calls = [];
  const store = createRemoteCoordinationStore({ endpoint, token, memberId: "leader", fetchImpl: async (url, options) => {
    calls.push([url, options]);
    if (url.includes("/admissions?")) return new Response(JSON.stringify({ admissions: [], metrics: { pendingCount: 0 } }), { status: 200 });
    if (url.endsWith("/admissions/route")) return new Response(JSON.stringify({ binding: { workId: "work-1" }, work: { work: { workId: "work-1" } } }), { status: 200 });
    if (url.endsWith("/tasks") && options.method === "POST") return new Response(JSON.stringify({ task: { status: "assigned" } }), { status: 200 });
    if (url.endsWith("/results")) return new Response(JSON.stringify({ result: { taskId: "task-1" } }), { status: 200 });
    if (url.endsWith("/cancel")) return new Response(JSON.stringify({ task: { status: "cancelled" } }), { status: 200 });
    if (url.endsWith("/close")) return new Response(JSON.stringify({ action: "complete", work: { status: "completed" } }), { status: 200 });
    if (url.endsWith("/works/work-1")) return new Response(JSON.stringify({ work: { work: { workId: "work-1" } } }), { status: 200 });
    return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
  } });
  assert.equal((await store.listMessageAdmissions({ status: "pending" })).metrics.pendingCount, 0);
  assert.equal((await store.routeMessage({ eventId: "$event", title: "Work", requestId: "r" })).binding.workId, "work-1");
  assert.equal((await store.getWork("work-1")).work.workId, "work-1");
  assert.equal((await store.createTask({ task: { taskId: "task-1" }, expectedEpoch: 0, requestId: "t" })).task.status, "assigned");
  assert.equal((await store.submitResult({ result: { taskId: "task-1" }, expectedEpoch: 1, requestId: "s" })).result.taskId, "task-1");
  assert.equal((await store.cancelTask({ workId: "work-1", taskId: "task-2", reason: "stop", expectedEpoch: 1, requestId: "x" })).task.status, "cancelled");
  assert.equal((await store.closeWork({ workId: "work-1", action: "complete", reason: "done", expectedEpoch: 2, requestId: "c" })).work.status, "completed");
  assert.equal(calls.every(([, options]) => options.headers.Authorization === `Bearer ${token}`), true);
  assert.equal(typeof store.decideTask, "undefined");
});

test("machine resume envelope still routes to resume endpoint", async () => {
  const event = { eventId: "$resume", roomId: "!room:example.test", sender: "@leader:example.test", type: "m.room.message", content: leaderResumeEventBody({ wakeId: "a".repeat(64), workId: "work-1", targetMemberId: "leader", targetMatrixUserId: "@leader:example.test" }) };
  let url;
  const hook = createRemoteOpenClawLeaderAdmissionHook({ endpoint, token, channel: { async readHumanEvent() { return event; } }, fetchImpl: async (value) => { url = value; return new Response(JSON.stringify({ resumed: true }), { status: 200 }); } });
  assert.equal((await hook({ roomId: event.roomId, eventId: event.eventId, source: { channel: "matrix", authenticated: true, actorId: event.sender, messageId: event.eventId, route: "team-room" } })).resumed, true);
  assert.equal(url, "http://control.example.test/v1/coordination/resume");
});

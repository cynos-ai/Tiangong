import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeConsoleServer } from "../server.mjs";
import { CoordinationStore, createControlProfile, createMemberConfig, createResult, createTaskSpec, createTeamConfig, createTeamRouteBinding, createWorkSpec } from "../../worker/agent/team/coordination-store.mjs";

const NOW = "2026-08-15T03:00:00.000Z"; const TOKEN = "control-token-for-test";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tg-api-")); t.after(() => rm(root, { recursive: true, force: true }));
  const profile = createControlProfile({ profileId: "profile", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team", revision: 1, leaderMemberId: "leader", memberIds: ["leader", "developer"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room:example.test", createdAt: NOW });
  const leader = createMemberConfig({ memberId: "leader", teamId: team.teamId, workerName: "leader", matrixUserId: "@leader:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, runtime: "openclaw-built-in", model: "deepseek-chat", allowedSkills: [], createdAt: NOW });
  const developer = createMemberConfig({ memberId: "developer", teamId: team.teamId, workerName: "developer", matrixUserId: "@developer:example.test", role: "developer", controlProfileId: profile.profileId, enabled: true, runtime: "codex-app-server", model: "deepseek-v4-flash", allowedSkills: [], createdAt: NOW });
  const store = new CoordinationStore({ filePath: join(root, "state.json"), now: () => NOW });
  const server = createRuntimeConsoleServer({ coordinationStore: store, coordinationControl: { store, bearerToken: TOKEN, team, route, profile, leaderMember: leader, members: [leader, developer], now: () => NOW } }).listen(0); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  const post = async (path, body) => { const response = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }); return { response, body: await response.json() }; };
  return { profile, team, route, leader, developer, store, base, headers, post };
}
function ingress(route, eventId = "$event") { return { source: { channel: "matrix", authenticated: true, actorId: "@human:example.test", messageId: eventId, route: "team-room" }, event: { eventId, roomId: route.roomId, sender: "@human:example.test", type: "m.room.message", content: { msgtype: "m.text", body: "A request" } } }; }

test("Control API queues ordinary Matrix, lets Leader route, and exposes requirement-pending Work", async (t) => {
  const value = await fixture(t); const admitted = await value.post("/v1/coordination/admit", ingress(value.route)); assert.equal(admitted.response.status, 200); assert.equal(admitted.body.admission.status, "pending"); assert.equal((await value.store.listWorks()).length, 0);
  const list = await fetch(`${value.base}/v1/coordination/admissions?status=pending`, { headers: value.headers }); const listed = await list.json(); assert.equal(listed.metrics.pendingCount, 1);
  const routed = await value.post("/v1/coordination/admissions/route", { eventId: "$event", title: "Readable Work", actorId: value.leader.memberId, requestId: "route-1" }); assert.equal(routed.response.status, 200); assert.equal(routed.body.work.currentWorkSpec, null);
  const replay = await value.post("/v1/coordination/admit", ingress(value.route)); assert.equal(replay.body.binding.workId, routed.body.work.work.workId);
  const unauthorized = await fetch(`${value.base}/v1/coordination/admissions`, {}); assert.equal(unauthorized.status, 401);
});

test("Control API completes reported Tasks without Decision and rejects late writes", async (t) => {
  const value = await fixture(t); await value.post("/v1/coordination/admit", ingress(value.route)); const routed = (await value.post("/v1/coordination/admissions/route", { eventId: "$event", title: "Work", actorId: value.leader.memberId, requestId: "route" })).body; const id = routed.work.work.workId;
  const spec = createWorkSpec({ workId: id, revision: 1, goal: "Deliver", doneWhen: ["result reported"], createdAt: NOW }); const formed = (await value.post(`/v1/coordination/works/${id}/spec`, { spec, actorId: value.leader.memberId, expectedEpoch: 0, requestId: "spec" })).body;
  const task = createTaskSpec({ taskId: "task", workId: id, assigneeMemberId: value.developer.memberId, objective: "Implement", createdAt: NOW }); const assigned = await value.post("/v1/coordination/tasks", { task, actorId: value.leader.memberId, expectedEpoch: formed.work.epoch, requestId: "task" }); assert.equal(assigned.body.task.status, "assigned");
  const result = createResult({ workId: id, taskId: task.taskId, submittedBy: value.developer.memberId, summary: "Done", createdAt: NOW }); const submitted = await value.post("/v1/coordination/results", { result, actorId: value.developer.memberId, expectedEpoch: 2, requestId: "result" }); assert.equal(submitted.body.result.taskId, task.taskId);
  const closed = await value.post(`/v1/coordination/works/${id}/close`, { action: "complete", reason: "done", actorId: value.leader.memberId, expectedEpoch: 3, requestId: "close" }); assert.equal(closed.body.work.status, "completed");
  const late = await value.post(`/v1/coordination/works/${id}/title`, { title: "Late", actorId: value.leader.memberId, expectedEpoch: 4, requestId: "late" }); assert.equal(late.response.status, 409); assert.equal(typeof value.store.decideTask, "undefined");
  const oldEndpoint = await value.post("/v1/coordination/decisions", {}); assert.equal(oldEndpoint.response.status, 405);
});

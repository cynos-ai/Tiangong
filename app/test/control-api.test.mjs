import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createRuntimeConsoleServer } from "../server.mjs";
import {
  CoordinationStore,
  createControlProfile,
  createResult,
  createTaskSpec,
  createMemberConfig,
  createTeamConfig,
  createTeamRouteBinding,
} from "../../worker/agent/team/coordination-store.mjs";
import { leaderResumeEventBody } from "../../worker/agent/team/leader-resume.mjs";

const NOW = "2026-08-15T03:00:00.000Z";
const TOKEN = "control-token-for-test";

test("Coordination Control API keeps Team bindings server-side and replays one Matrix ingress", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-control-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = createControlProfile({ profileId: "profile-api", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-api", revision: 1, leaderMemberId: "leader-api", memberIds: ["leader-api"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route-api", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room-api:example.test", createdAt: NOW });
  const leaderMember = createMemberConfig({ memberId: "leader-api", teamId: team.teamId, workerName: "leader-api", matrixUserId: "@leader-api:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const store = new CoordinationStore({ filePath: join(root, "coordination.jsonl"), now: () => NOW });
  const server = createRuntimeConsoleServer({
    coordinationControl: { store, bearerToken: TOKEN, team, route, profile, leaderMember, members: [leaderMember], now: () => NOW },
  }).listen(0);
  t.after(() => server.close());
  const address = server.address();
  const request = {
    source: { channel: "matrix", authenticated: true, actorId: "@human-api:example.test", messageId: "$event-api-1", route: "team-room" },
    event: { eventId: "$event-api-1", roomId: route.roomId, sender: "@human-api:example.test", type: "m.room.message", content: { msgtype: "m.text", body: "Open the API slice" } },
  };
  const first = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/admit`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(request) });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.replayed, false);
  assert.equal(firstBody.work.work.teamId, team.teamId);
  assert.equal(firstBody.wakes.length, 2);
  const listedWork = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/works/${encodeURIComponent(firstBody.work.work.workId)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(listedWork.status, 200);
  assert.equal((await listedWork.json()).work.work.workId, firstBody.work.work.workId);
  const listedWakes = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/wakes?status=pending`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(listedWakes.status, 200);
  assert.equal((await listedWakes.json()).wakes.length, 2);
  const replay = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/admit`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(request) });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  const wakeId = firstBody.wakes[0].wakeId;
  const claim = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/wakes/claim`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ wakeId, consumerId: "leader-api", requestId: "claim-api-1" }) });
  assert.equal(claim.status, 200);
  assert.equal((await claim.json()).wake.status, "claimed");
  const ack = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/wakes/ack`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ wakeId, consumerId: "leader-api", receiptId: "receipt-api-1", requestId: "ack-api-1" }) });
  assert.equal(ack.status, 200);
  assert.equal((await ack.json()).wake.status, "acked");
  const unauthorized = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/admit`, { method: "POST", body: JSON.stringify(request) });
  assert.equal(unauthorized.status, 401);
  assert.equal(JSON.stringify(firstBody).includes(TOKEN), false);
});

test("Coordination Control API validates a deployment-authored Leader resume event without creating Work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-control-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = createControlProfile({ profileId: "profile-resume-api", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-resume-api", revision: 1, leaderMemberId: "leader-resume-api", memberIds: ["leader-resume-api"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route-resume-api", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room-resume-api:example.test", createdAt: NOW });
  const leaderMember = createMemberConfig({ memberId: "leader-resume-api", teamId: team.teamId, workerName: "leader-resume-api", matrixUserId: "@leader-resume-api:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const store = new CoordinationStore({ filePath: join(root, "coordination.jsonl"), now: () => NOW });
  const server = createRuntimeConsoleServer({ coordinationControl: { store, bearerToken: TOKEN, team, route, profile, leaderMember, members: [leaderMember], now: () => NOW } }).listen(0);
  t.after(() => server.close());
  const address = server.address();
  const admission = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/admit`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ source: { channel: "matrix", authenticated: true, actorId: "@human-resume-api:example.test", messageId: "$human-resume-api", route: "team-room" }, event: { eventId: "$human-resume-api", roomId: route.roomId, sender: "@human-resume-api:example.test", type: "m.room.message", content: { msgtype: "m.text", body: "resume" } } }) });
  const admitted = await admission.json();
  const wake = admitted.wakes.find((entry) => entry.kind === "leader-resume");
  const event = { eventId: "$leader-resume-api", roomId: route.roomId, sender: leaderMember.matrixUserId, type: "m.room.message", content: leaderResumeEventBody({ wakeId: wake.wakeId, workId: wake.workId, targetMemberId: leaderMember.memberId, targetMatrixUserId: leaderMember.matrixUserId }) };
  const resumed = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/resume`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ source: { channel: "matrix", authenticated: true, actorId: leaderMember.matrixUserId, messageId: event.eventId, route: "team-room" }, event }) });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).resumed, true);
  assert.equal((await store.listWorks()).length, 1);
});

test("Coordination Control API keeps Task/Result writes bound to the current Team and emits durable wakes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-control-task-result-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = createControlProfile({ profileId: "profile-task-result-api", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-task-result-api", revision: 1, leaderMemberId: "leader-task-result-api", memberIds: ["leader-task-result-api", "member-task-result-api"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route-task-result-api", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room-task-result-api:example.test", createdAt: NOW });
  const leaderMember = createMemberConfig({ memberId: "leader-task-result-api", teamId: team.teamId, workerName: "leader-task-result-api", matrixUserId: "@leader-task-result-api:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const member = createMemberConfig({ memberId: "member-task-result-api", teamId: team.teamId, workerName: "member-task-result-api", matrixUserId: "@member-task-result-api:example.test", role: "implementor", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const store = new CoordinationStore({ filePath: join(root, "coordination.jsonl"), now: () => NOW });
  const server = createRuntimeConsoleServer({ coordinationControl: { store, bearerToken: TOKEN, team, route, profile, leaderMember, members: [leaderMember, member], now: () => NOW } }).listen(0);
  t.after(() => server.close());
  const address = server.address();
  const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  const admission = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/admit`, { method: "POST", headers, body: JSON.stringify({ source: { channel: "matrix", authenticated: true, actorId: "@human-task-result-api:example.test", messageId: "$human-task-result-api", route: "team-room" }, event: { eventId: "$human-task-result-api", roomId: route.roomId, sender: "@human-task-result-api:example.test", type: "m.room.message", content: { msgtype: "m.text", body: "Build the bounded task" } } }) });
  const admitted = await admission.json();
  const task = createTaskSpec({ taskId: "task-task-result-api", workId: admitted.work.work.workId, assigneeMemberId: member.memberId, objective: "Run one bounded implementation", completionContract: "submit one Result", inputRefs: [], createdAt: NOW });
  const taskResponse = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/tasks`, { method: "POST", headers, body: JSON.stringify({ task, actorId: leaderMember.memberId, expectedEpoch: 0, requestId: "task-create-api" }) });
  assert.equal(taskResponse.status, 200);
  const createdTask = await taskResponse.json();
  assert.equal(createdTask.task.spec.assigneeMemberId, member.memberId);
  assert.equal(createdTask.wake.kind, "task-assignment");
  assert.equal(createdTask.wake.status, "pending");
  const result = createResult({ resultId: "result-task-result-api", workId: task.workId, taskId: task.taskId, producerMemberId: member.memberId, toolResultIds: [], artifactRefs: [], claim: "implementation complete", createdAt: NOW });
  const resultResponse = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/results`, { method: "POST", headers, body: JSON.stringify({ result, actorId: member.memberId, expectedEpoch: 1, requestId: "result-submit-api" }) });
  assert.equal(resultResponse.status, 200);
  const submitted = await resultResponse.json();
  assert.equal(submitted.result.resultId, result.resultId);
  assert.equal(submitted.wake.kind, "result-notification");
  assert.equal(submitted.wake.targetMemberId, leaderMember.memberId);
  const decisionResponse = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/decisions`, { method: "POST", headers, body: JSON.stringify({ taskId: task.taskId, decision: "accept", resultDigest: result.contentDigest, reason: "the bounded Result is current", actorId: leaderMember.memberId, expectedEpoch: 2, requestId: "decision-api-1" }) });
  assert.equal(decisionResponse.status, 200);
  const decisionBody = await decisionResponse.json();
  assert.equal(decisionBody.decision.decision, "accept");
  assert.equal(decisionBody.task.status, "accepted");
  const decisionRead = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/decisions/${decisionBody.decision.decisionId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(decisionRead.status, 200);
  assert.equal((await decisionRead.json()).decision.taskId, task.taskId);
  const closeResponse = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/works/${encodeURIComponent(task.workId)}/close`, { method: "POST", headers, body: JSON.stringify({ decision: "complete", reason: "all accepted", actorId: leaderMember.memberId, expectedEpoch: 3, requestId: "close-api-1" }) });
  assert.equal(closeResponse.status, 200);
  assert.equal((await closeResponse.json()).work.status, "closed");
  const wrongDecisionActor = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/decisions`, { method: "POST", headers, body: JSON.stringify({ taskId: task.taskId, decision: "blocked", reason: "wrong actor", actorId: member.memberId, expectedEpoch: 3, requestId: "decision-wrong-actor" }) });
  assert.equal(wrongDecisionActor.status, 422);
  assert.equal((await wrongDecisionActor.json()).error, "TASK_DECISION_ACTOR_NOT_LEADER");
  const taskRead = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/tasks/${task.taskId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal((await taskRead.json()).task.result.resultId, result.resultId);
  const wrongTaskActor = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/tasks`, { method: "POST", headers, body: JSON.stringify({ task: createTaskSpec({ taskId: "task-wrong-actor", workId: task.workId, assigneeMemberId: member.memberId, objective: task.objective, completionContract: task.completionContract, inputRefs: [], createdAt: NOW }), actorId: member.memberId, expectedEpoch: 1, requestId: "task-wrong-actor" }) });
  assert.equal(wrongTaskActor.status, 422);
  assert.equal((await wrongTaskActor.json()).error, "TASK_ACTOR_NOT_LEADER");
  const wrongResultActor = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/results`, { method: "POST", headers, body: JSON.stringify({ result, actorId: leaderMember.memberId, expectedEpoch: 1, requestId: "result-wrong-actor" }) });
  assert.equal(wrongResultActor.status, 422);
  assert.equal((await wrongResultActor.json()).error, "RESULT_ACTOR_MISMATCH");
  const replay = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/results`, { method: "POST", headers, body: JSON.stringify({ result, actorId: member.memberId, expectedEpoch: 1, requestId: "result-submit-api" }) });
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.wakeReplayed, true);
  const pending = await store.listOutbox({ status: "pending" });
  assert.equal(pending.filter((wake) => wake.kind === "task-assignment").length, 1);
  assert.equal(pending.filter((wake) => wake.kind === "result-notification").length, 1);
});

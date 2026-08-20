import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CoordinationStore, createContentRef, createControlProfile, createMemberConfig, createResult,
  createTaskSpec, createTeamConfig, createTeamRouteBinding, createWorkSpec,
} from "../agent/team/coordination-store.mjs";

const NOW = "2026-08-15T00:00:00.000Z";
function records() {
  const profile = createControlProfile({ profileId: "profile", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team", revision: 1, leaderMemberId: "leader", memberIds: ["leader", "developer"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room:example.test", createdAt: NOW });
  const leader = createMemberConfig({ memberId: "leader", teamId: team.teamId, workerName: "leader", matrixUserId: "@leader:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, runtime: "openclaw-built-in", model: "glm-5", allowedSkills: [], createdAt: NOW });
  const developer = createMemberConfig({ memberId: "developer", teamId: team.teamId, workerName: "developer", matrixUserId: "@developer:example.test", role: "developer", controlProfileId: profile.profileId, enabled: true, runtime: "openclaw-built-in", model: "glm-5", allowedSkills: [], createdAt: NOW });
  return { profile, team, route, leader, developer };
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-m0-store-")); t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new CoordinationStore({ filePath: join(root, "state.json"), now: () => NOW, ...options }), ...records() };
}
async function newWork(value, eventId = "$event-1", title = "New request") {
  await value.store.enqueueMessageAdmission({ team: value.team, route: value.route, profile: value.profile, actorId: "@human:example.test", eventId, requestId: `admit-${eventId}` });
  return value.store.routeMessage({ roomId: value.route.roomId, eventId, team: value.team, route: value.route, profile: value.profile, actorId: value.leader.memberId, title, requestId: `route-${eventId}` });
}
async function formSpec(value, work, requestId = "spec-1") {
  return value.store.changeWorkSpec({ workId: work.work.workId, spec: createWorkSpec({ workId: work.work.workId, revision: 1, goal: "Deliver the requested change", scope: ["repository"], constraints: ["local commit only"], doneWhen: ["tests pass"], unresolvedAssumptions: [], createdAt: NOW }), profile: value.profile, actorId: value.leader.memberId, expectedEpoch: work.epoch, requestId });
}

test("M0 Work supports title, null WorkSpec, immutable Plan ContentRef, and restart recovery", async (t) => {
  const value = await fixture(t); const routed = await newWork(value); const id = routed.work.work.workId;
  assert.equal(routed.work.currentWorkSpec, null); assert.equal(routed.work.status, "open"); assert.equal(routed.work.work.title, "New request");
  await assert.rejects(value.store.createTask({ task: createTaskSpec({ taskId: "too-early", workId: id, assigneeMemberId: value.developer.memberId, objective: "Do work", createdAt: NOW }), team: value.team, member: value.developer, profile: value.profile, actorId: value.leader.memberId, expectedEpoch: 0, requestId: "too-early" }), /TASK_WORK_CONFLICT/u);
  const formed = await formSpec(value, routed.work);
  const renamed = await value.store.changeWorkTitle({ workId: id, title: "Readable title", profile: value.profile, actorId: value.leader.memberId, expectedEpoch: formed.work.epoch, requestId: "title-1" });
  const planRef = createContentRef({ repositoryId: "plans", commitSha: "abc123" });
  const planned = await value.store.changeWorkPlan({ workId: id, planRef, reason: "Architect candidate challenged", profile: value.profile, actorId: value.leader.memberId, expectedEpoch: renamed.work.epoch, requestId: "plan-1" });
  assert.deepEqual(planned.work.currentPlanRef, planRef); assert.equal(planned.work.work.title, "Readable title");
  const reopened = new CoordinationStore({ filePath: join(value.root, "state.json"), now: () => NOW });
  assert.equal((await reopened.getWork(id)).currentWorkSpec.goal, "Deliver the requested change");
});

test("M0 Task projects assigned/reported and complete-work needs no CoordinationDecision", async (t) => {
  const value = await fixture(t); const routed = await newWork(value); let work = (await formSpec(value, routed.work)).work;
  const task = createTaskSpec({ taskId: "task-1", workId: work.work.workId, assigneeMemberId: value.developer.memberId, objective: "Implement", inputs: [], constraints: ["no push"], createdAt: NOW });
  const assigned = await value.store.createTask({ task, team: value.team, member: value.developer, profile: value.profile, actorId: value.leader.memberId, expectedEpoch: work.epoch, requestId: "task-1" });
  assert.equal(assigned.task.status, "assigned"); assert.match(assigned.task.sessionRef, /^member-[a-f0-9]{48}$/u);
  const reopenedForSession = new CoordinationStore({ filePath: join(value.root, "state.json"), now: () => NOW });
  assert.equal((await reopenedForSession.getTask(task.taskId)).sessionRef, assigned.task.sessionRef);
  assert.notEqual(assigned.task.sessionRef, work.work.leaderSessionId); work = await value.store.getWork(work.work.workId);
  await assert.rejects(value.store.closeWork({ workId: work.work.workId, team: value.team, profile: value.profile, actorId: value.leader.memberId, action: "complete", reason: "too early", expectedEpoch: work.epoch, requestId: "close-early" }), /WORK_CLOSE_GUARD_FAILED/u);
  const result = createResult({ workId: work.work.workId, taskId: task.taskId, submittedBy: value.developer.memberId, summary: "Implemented and tested", deliverableRefs: [], toolResultRefs: [], createdAt: NOW });
  await value.store.submitResult({ result, team: value.team, member: value.developer, profile: value.profile, actorId: value.developer.memberId, expectedEpoch: work.epoch, requestId: "result-1" });
  assert.equal((await value.store.getTask(task.taskId)).status, "reported"); work = await value.store.getWork(work.work.workId);
  const closed = await value.store.closeWork({ workId: work.work.workId, team: value.team, profile: value.profile, actorId: value.leader.memberId, action: "complete", reason: "doneWhen satisfied", expectedEpoch: work.epoch, requestId: "close-1" });
  assert.equal(closed.work.status, "completed"); assert.equal(closed.work.timeline.at(-1).type, "work-completed"); assert.equal(typeof value.store.decideTask, "undefined");
  await assert.rejects(value.store.changeWorkPlan({ workId: work.work.workId, planRef: { repositoryId: "plans", commitSha: "late" }, reason: "late", profile: value.profile, actorId: value.leader.memberId, expectedEpoch: closed.work.epoch, requestId: "late-plan" }), /WORK_EPOCH_OR_CHANGE_CONFLICT/u);
});

test("M0 cancellation and CloseGuard fail closed on active or unresolved machine state", async (t) => {
  const value = await fixture(t, {
    cancellationGuard: { async stopAndInspect() { return { stopped: false, writerReleased: false, unresolvedOperations: [] }; } },
    closeGuard: { async inspect() { return { activeExecutions: ["task-1"], unresolvedOperations: [], pendingApprovals: [], unreadableContentRefs: [] }; } },
  });
  const routed = await newWork(value); let work = (await formSpec(value, routed.work)).work;
  const task = createTaskSpec({ taskId: "task-1", workId: work.work.workId, assigneeMemberId: value.developer.memberId, objective: "Implement", createdAt: NOW });
  await value.store.createTask({ task, team: value.team, member: value.developer, profile: value.profile, actorId: value.leader.memberId, expectedEpoch: work.epoch, requestId: "task-1" }); work = await value.store.getWork(work.work.workId);
  await assert.rejects(value.store.cancelTask({ workId: work.work.workId, taskId: task.taskId, team: value.team, profile: value.profile, actorId: value.leader.memberId, reason: "stop", expectedEpoch: work.epoch, requestId: "cancel-1" }), /TASK_CANCEL_GUARD_FAILED/u);
  const clean = await fixture(t); const pending = await newWork(clean, "$stop-event");
  const stopped = await clean.store.closeWork({ workId: pending.work.work.workId, team: clean.team, profile: clean.profile, actorId: clean.leader.memberId, action: "stop", reason: "requirement withdrawn", expectedEpoch: 0, requestId: "stop-null" });
  assert.equal(stopped.work.status, "stopped");
});

test("M0 CloseGuard rejects active execution, unresolved Operation, pending Approval, and unreadable delivery", async (t) => {
  for (const [field, marker] of [["activeExecutions", "task-active"], ["unresolvedOperations", "operation-1"], ["pendingApprovals", "operation-2"], ["unreadableContentRefs", "ref-1"]]) {
    const value = await fixture(t, { closeGuard: { async inspect() { return { activeExecutions: [], unresolvedOperations: [], pendingApprovals: [], unreadableContentRefs: [], [field]: [marker] }; } } });
    const routed = await newWork(value, `$guard-${field}`); const formed = await formSpec(value, routed.work, `spec-${field}`);
    await assert.rejects(value.store.closeWork({ workId: formed.work.work.workId, team: value.team, profile: value.profile, actorId: value.leader.memberId, action: "complete", reason: "must fail closed", expectedEpoch: formed.work.epoch, requestId: `close-${field}` }), /WORK_CLOSE_GUARD_FAILED/u);
  }
});

test("M0 room routing is ordered, idempotent, and UI-independent", async (t) => {
  const value = await fixture(t);
  await value.store.enqueueMessageAdmission({ team: value.team, route: value.route, profile: value.profile, actorId: "@human:example.test", eventId: "$event-a", receivedAt: "2026-08-15T00:00:00.000Z", requestId: "admit-a" });
  await value.store.enqueueMessageAdmission({ team: value.team, route: value.route, profile: value.profile, actorId: "@human:example.test", eventId: "$event-b", receivedAt: "2026-08-15T00:00:01.000Z", requestId: "admit-b" });
  await assert.rejects(value.store.routeMessage({ roomId: value.route.roomId, eventId: "$event-b", team: value.team, route: value.route, profile: value.profile, actorId: value.leader.memberId, title: "B", requestId: "route-b" }), /MESSAGE_ROUTE_ORDER_CONFLICT/u);
  const first = await value.store.routeMessage({ roomId: value.route.roomId, eventId: "$event-a", team: value.team, route: value.route, profile: value.profile, actorId: value.leader.memberId, title: "A", requestId: "route-a" });
  const second = await value.store.routeMessage({ roomId: value.route.roomId, eventId: "$event-b", team: value.team, route: value.route, profile: value.profile, actorId: value.leader.memberId, targetWorkId: first.work.work.workId, expectedEpoch: first.work.epoch, requestId: "route-b" });
  assert.equal(second.binding.workId, first.work.work.workId); assert.equal((await value.store.admissionMetrics()).pendingCount, 0);
  const replay = await value.store.routeMessage({ roomId: value.route.roomId, eventId: "$event-b", team: value.team, route: value.route, profile: value.profile, actorId: value.leader.memberId, targetWorkId: first.work.work.workId, expectedEpoch: first.work.epoch, requestId: "route-b" });
  assert.equal(replay.replayed, true);
});

test("M0 mistaken association correction preserves history and current replay target", async (t) => {
  const value = await fixture(t); const source = await newWork(value, "$old", "Old Work");
  await value.store.enqueueMessageAdmission({ team: value.team, route: value.route, profile: value.profile, actorId: "@human:example.test", eventId: "$wrong", receivedAt: "2026-08-15T00:00:01.000Z", requestId: "admit-wrong" });
  const attached = await value.store.routeMessage({ roomId: value.route.roomId, eventId: "$wrong", team: value.team, route: value.route, profile: value.profile, actorId: value.leader.memberId, targetWorkId: source.work.work.workId, expectedEpoch: source.work.epoch, requestId: "route-wrong" });
  await value.store.enqueueMessageAdmission({ team: value.team, route: value.route, profile: value.profile, actorId: "@human:example.test", eventId: "$correction", receivedAt: "2026-08-15T00:00:02.000Z", requestId: "admit-correction" });
  const corrected = await value.store.correctMessageAssociation({ roomId: value.route.roomId, eventId: "$wrong", correctionEventId: "$correction", team: value.team, route: value.route, profile: value.profile, actorId: value.leader.memberId, expectedSourceEpoch: attached.work.epoch, title: "Separate Work", requestId: "correct-1" });
  assert.notEqual(corrected.targetWork.work.workId, source.work.work.workId); assert.equal((await value.store.getMessageBinding(value.route.roomId, "$wrong")).workId, corrected.targetWork.work.workId);
  assert.equal(corrected.sourceWork.timeline.some((entry) => entry.type === "message-association-corrected"), true);
  const replay = await value.store.routeMessage({ roomId: value.route.roomId, eventId: "$wrong", team: value.team, route: value.route, profile: value.profile, actorId: value.leader.memberId, targetWorkId: source.work.work.workId, expectedEpoch: corrected.sourceWork.epoch, requestId: "another-route" });
  assert.equal(replay.binding.workId, corrected.targetWork.work.workId);
});

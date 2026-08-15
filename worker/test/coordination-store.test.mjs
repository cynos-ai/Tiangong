import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../agent/canonical-json.mjs";
import { ToolResultStore } from "../agent/gates/tool-result-store.mjs";
import {
  CoordinationStore,
  createControlProfile,
  createMemberConfig,
  createResult,
  createTaskSpec,
  createTeamConfig,
  createTeamRouteBinding,
  createWorkSpec,
} from "../agent/team/coordination-store.mjs";

const NOW = "2026-08-15T00:00:00.000Z";

function profile() {
  return createControlProfile({
    profileId: "profile-default",
    revision: 1,
    maxTimelineEntries: 64,
    maxOutboxEntries: 32,
    maxTasksPerWork: 8,
    toolResultRetentionMs: 24 * 60 * 60 * 1000,
  });
}

function team() {
  return createTeamConfig({
    teamId: "team-alpha",
    revision: 1,
    leaderMemberId: "leader-1",
    memberIds: ["leader-1", "member-1"],
    controlProfileId: "profile-default",
    createdAt: NOW,
  });
}

function route() {
  return createTeamRouteBinding({
    routeId: "route-alpha",
    teamId: "team-alpha",
    revision: 1,
    channel: "matrix",
    roomId: "!room:example.test",
    createdAt: NOW,
  });
}

function member() {
  return createMemberConfig({
    memberId: "member-1",
    teamId: "team-alpha",
    workerName: "worker-member-1",
    matrixUserId: "@member:example.test",
    role: "analyst",
    controlProfileId: "profile-default",
    enabled: true,
    createdAt: NOW,
  });
}

function initialSpec(workId = "work-1") {
  return createWorkSpec({
    workId,
    revision: 1,
    objective: "Understand the repository",
    scope: "Read-only project inspection",
    completionContract: "Return a bounded report with direct references",
    createdAt: NOW,
  });
}

function specInput(overrides = {}) {
  return {
    workId: "work-1",
    revision: 1,
    objective: "Understand the repository",
    scope: "Read-only project inspection",
    completionContract: "Return a bounded report with direct references",
    createdAt: NOW,
    ...overrides,
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-coordination-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "coordination.jsonl");
  const store = new CoordinationStore({ filePath, now: () => NOW });
  return { root, filePath, store, controlProfile: profile(), team: team(), route: route(), member: member() };
}

async function admitted(fixtureValue, requestId = "work-request-1") {
  return fixtureValue.store.createWork({
    workId: "work-1",
    team: fixtureValue.team,
    route: fixtureValue.route,
    profile: fixtureValue.controlProfile,
    spec: initialSpec(),
    actorId: "@human:example.test",
    sourceEventId: "$human-event-1",
    requestId,
  });
}

function taskSpec(overrides = {}) {
  return createTaskSpec({
    taskId: "task-1",
    workId: "work-1",
    assigneeMemberId: "member-1",
    objective: "Inspect the current runtime",
    completionContract: "Submit one bounded Result",
    inputRefs: [],
    createdAt: NOW,
    ...overrides,
  });
}

function toolResult(overrides = {}) {
  const callKey = sha256({ actorId: "worker-member-1", taskId: "task-1", toolCallId: "call-1" });
  return {
    version: 1,
    toolResultId: sha256({ source: "openclaw.tool_result_persist", callKey }),
    callKey,
    workId: "work-1",
    taskId: "task-1",
    actorId: "worker-member-1",
    runtimeProfile: "openclaw-built-in",
    tool: "read",
    requestSummary: { toolName: "read", toolCallId: "call-1" },
    resultSummary: { outcome: "success", textLength: 2, hasData: false },
    outputRef: null,
    startedAt: NOW,
    completedAt: "2026-08-15T00:00:01.000Z",
    ...overrides,
  };
}

test("B1 domain records are typed, digest-bound, and reject extra fields", () => {
  const value = profile();
  assert.equal(value.kind, "tiangong.control-profile");
  assert.equal(value.contentDigest, sha256({
    kind: value.kind,
    schemaVersion: value.schemaVersion,
    profileId: value.profileId,
    revision: value.revision,
    maxTimelineEntries: value.maxTimelineEntries,
    maxOutboxEntries: value.maxOutboxEntries,
    maxTasksPerWork: value.maxTasksPerWork,
    toolResultRetentionMs: value.toolResultRetentionMs,
  }));
  assert.throws(() => createTeamConfig({
    teamId: "team-alpha",
    revision: 1,
    leaderMemberId: "leader-1",
    memberIds: ["member-1"],
    controlProfileId: "profile-default",
    createdAt: NOW,
  }), /leaderMemberId/u);
  assert.throws(() => createWorkSpec({ ...initialSpec(), unexpected: true }), /unknown fields/u);
});

test("WorkSpec changes use epoch and requestId replay, and survive a reopened store", async (t) => {
  const fixtureValue = await fixture(t);
  const first = await admitted(fixtureValue);
  assert.equal(first.replayed, false);
  assert.equal(first.work.epoch, 0);
  assert.equal(first.work.timeline.length, 1);

  const changed = await fixtureValue.store.changeWorkSpec({
    workId: "work-1",
    spec: createWorkSpec(specInput({ revision: 2, objective: "Understand the OpenClaw boundary" })),
    profile: fixtureValue.controlProfile,
    actorId: "@human:example.test",
    expectedEpoch: 0,
    requestId: "spec-request-1",
  });
  assert.equal(changed.replayed, false);
  assert.equal(changed.work.epoch, 1);
  assert.equal(changed.work.currentWorkSpec.revision, 2);

  const replay = await fixtureValue.store.changeWorkSpec({
    workId: "work-1",
    spec: createWorkSpec(specInput({ revision: 2, objective: "Understand the OpenClaw boundary" })),
    profile: fixtureValue.controlProfile,
    actorId: "@human:example.test",
    expectedEpoch: 0,
    requestId: "spec-request-1",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.work.epoch, 1);
  await assert.rejects(fixtureValue.store.changeWorkSpec({
    workId: "work-1",
    spec: createWorkSpec(specInput({ revision: 2, objective: "Conflicting request" })),
    profile: fixtureValue.controlProfile,
    actorId: "@human:example.test",
    expectedEpoch: 1,
    requestId: "spec-request-1",
  }), /COMMAND_REQUEST_CONFLICT/u);

  const reopened = new CoordinationStore({ filePath: fixtureValue.filePath, now: () => NOW });
  const state = await reopened.getWork("work-1");
  assert.equal(state.epoch, 1);
  assert.equal(state.timeline.length, 2);
  assert.equal((await reopened.health()).sequence, 2);
});

test("Task, durable wake, ToolResult citation, and one-result ownership form one B1 path", async (t) => {
  const fixtureValue = await fixture(t);
  await admitted(fixtureValue);
  const created = await fixtureValue.store.createTask({
    task: taskSpec(),
    team: fixtureValue.team,
    member: fixtureValue.member,
    profile: fixtureValue.controlProfile,
    actorId: "worker-member-1",
    expectedEpoch: 0,
    requestId: "task-request-1",
    wake: { targetMemberId: "member-1", kind: "task-assignment" },
  });
  assert.equal(created.task.status, "assigned");
  assert.equal(created.wake.status, "pending");
  assert.equal((await fixtureValue.store.getWork("work-1")).epoch, 1);

  const claimed = await fixtureValue.store.claimWake({
    wakeId: created.wake.wakeId,
    consumerId: "member-1",
    requestId: "wake-claim-1",
  });
  assert.equal(claimed.wake.status, "claimed");
  const acked = await fixtureValue.store.ackWake({
    wakeId: created.wake.wakeId,
    consumerId: "member-1",
    receiptId: "matrix-event-1",
    requestId: "wake-ack-1",
  });
  assert.equal(acked.wake.status, "acked");

  const toolStore = new ToolResultStore({ filePath: join(fixtureValue.root, "tool-results.json") });
  const observed = toolResult();
  await toolStore.append(observed);
  const result = createResult({
    resultId: "result-1",
    workId: "work-1",
    taskId: "task-1",
    producerMemberId: "member-1",
    toolResultIds: [observed.toolResultId],
    artifactRefs: [],
    claim: "The runtime boundary is present",
    createdAt: "2026-08-15T00:00:02.000Z",
  });
  const submitted = await fixtureValue.store.submitResult({
    result,
    team: fixtureValue.team,
    member: fixtureValue.member,
    profile: fixtureValue.controlProfile,
    actorId: "worker-member-1",
    expectedEpoch: 1,
    requestId: "result-request-1",
    toolResultStore: toolStore,
  });
  assert.equal(submitted.replayed, false);
  assert.equal((await fixtureValue.store.getTask("task-1")).status, "reported");
  assert.equal((await fixtureValue.store.getWork("work-1")).epoch, 2);
  assert.equal((await toolStore.list()).retentionMarks.length, 1);

  const replay = await fixtureValue.store.submitResult({
    result,
    team: fixtureValue.team,
    member: fixtureValue.member,
    profile: fixtureValue.controlProfile,
    actorId: "worker-member-1",
    expectedEpoch: 1,
    requestId: "result-request-1",
    toolResultStore: toolStore,
  });
  assert.equal(replay.replayed, true);
  await assert.rejects(fixtureValue.store.cancelTask({
    workId: "work-1",
    taskId: "task-1",
    profile: fixtureValue.controlProfile,
    actorId: "leader-1",
    reason: "too late",
    expectedEpoch: 2,
    requestId: "cancel-after-result",
  }), /TASK_CANCEL_CONFLICT/u);
});

test("cancellation wins the Result race and journal tampering fails closed", async (t) => {
  const fixtureValue = await fixture(t);
  await admitted(fixtureValue);
  await fixtureValue.store.createTask({
    task: taskSpec(),
    team: fixtureValue.team,
    member: fixtureValue.member,
    profile: fixtureValue.controlProfile,
    actorId: "worker-member-1",
    expectedEpoch: 0,
    requestId: "task-request-1",
  });
  const cancelled = await fixtureValue.store.cancelTask({
    workId: "work-1",
    taskId: "task-1",
    profile: fixtureValue.controlProfile,
    actorId: "leader-1",
    reason: "scope withdrawn",
    expectedEpoch: 1,
    requestId: "cancel-request-1",
  });
  assert.equal(cancelled.task.status, "cancelled");
  const result = createResult({
    resultId: "result-1",
    workId: "work-1",
    taskId: "task-1",
    producerMemberId: "member-1",
    claim: "late",
    createdAt: "2026-08-15T00:00:02.000Z",
  });
  await assert.rejects(fixtureValue.store.submitResult({
    result,
    team: fixtureValue.team,
    member: fixtureValue.member,
    profile: fixtureValue.controlProfile,
    actorId: "worker-member-1",
    expectedEpoch: 2,
    requestId: "result-request-late",
  }), /RESULT_TASK_CONFLICT/u);

  const journal = await readFile(fixtureValue.filePath, "utf8");
  const tampered = journal.replace("scope withdrawn", "scope changed");
  await rm(fixtureValue.filePath);
  await import("node:fs/promises").then(({ writeFile }) => writeFile(fixtureValue.filePath, tampered));
  await assert.rejects(new CoordinationStore({ filePath: fixtureValue.filePath, now: () => NOW }).health(), /Invalid coordination journal/u);
});

import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createRuntimeConsoleServer } from "../server.mjs";
import {
  CoordinationStore,
  createControlProfile,
  createMemberConfig,
  createResult,
  createTaskSpec,
  createTeamConfig,
  createTeamRouteBinding,
  createWorkSpec,
} from "../../worker/agent/team/coordination-store.mjs";

test("runtime console exposes health and honest unknown state by default", async (t) => {
  const server = createRuntimeConsoleServer().listen(0);
  t.after(() => server.close());
  const address = server.address();
  const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  const runtime = await fetch(`http://127.0.0.1:${address.port}/api/runtime`);
  assert.equal(runtime.status, 200);
  assert.deepEqual(await runtime.json(), {
    status: "unknown",
    source: "runtime-facts-not-configured",
    lane: null,
    worker: null,
    toolResults: [],
    toolResultsSource: "tool-result-capture-not-configured",
    works: [],
    workSource: "coordination-store-not-configured",
    deliveries: [],
    deliverySource: "coordination-store-not-configured",
    tasks: [],
    taskSource: "coordination-store-not-configured",
    results: [],
    resultSource: "coordination-store-not-configured",
  });
  const ready = await fetch(`http://127.0.0.1:${address.port}/readyz`);
  assert.equal(ready.status, 503);
});

test("runtime console projects bounded ToolResult metadata without raw payloads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-console-capture-"));
  const captureFile = join(directory, "openclaw.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(captureFile, JSON.stringify({
    version: 1,
    results: [{
    toolResultId: "a".repeat(64),
    callKey: "b".repeat(64),
    workId: "work-1",
    taskId: "task-1",
    actorId: "agent-1",
    runtimeProfile: "openclaw-built-in",
    tool: "read",
    requestSummary: { toolName: "read", toolCallId: "call-1" },
    resultSummary: { outcome: "success", textLength: 5, hasData: false },
    outputRef: { repositoryId: "repo-1", commitSha: "abc123" },
    startedAt: "2026-08-13T00:00:00.000Z",
    completedAt: "2026-08-13T00:00:00.000Z",
    raw: "must-not-leak",
    }],
    retentionMarks: [],
  }), { mode: 0o600 });
  const server = createRuntimeConsoleServer({ captureFile }).listen(0);
  t.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/runtime`);
  assert.equal(response.status, 200);
  const facts = await response.json();
  assert.equal(facts.status, "unknown");
  assert.equal(facts.toolResultsSource, "tool-result-capture-file");
  assert.deepEqual(facts.toolResults, [{
    version: 1,
    toolResultId: "a".repeat(64),
    callKey: "b".repeat(64),
    workId: "work-1",
    taskId: "task-1",
    actorId: "agent-1",
    runtimeProfile: "openclaw-built-in",
    tool: "read",
    requestSummary: { toolName: "read", toolCallId: "call-1" },
    resultSummary: { outcome: "success", textLength: 5, hasData: false },
    outputRef: { repositoryId: "repo-1", commitSha: "abc123" },
    startedAt: "2026-08-13T00:00:00.000Z",
    completedAt: "2026-08-13T00:00:00.000Z",
  }]);
  assert.equal(JSON.stringify(facts).includes("must-not-leak"), false);
});

test("runtime console projects CoordinationStore Work cards, timeline, and durable wake state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-console-coordination-"));
  const coordinationFile = join(directory, "coordination.jsonl");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = "2026-08-15T01:00:00.000Z";
  const profile = createControlProfile({ profileId: "profile-1", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-1", revision: 1, leaderMemberId: "leader-1", memberIds: ["leader-1"], controlProfileId: profile.profileId, createdAt: now });
  const route = createTeamRouteBinding({ routeId: "route-1", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!team:example.test", createdAt: now });
  const leader = createMemberConfig({ memberId: "leader-1", teamId: team.teamId, workerName: "leader", matrixUserId: "@leader:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: now });
  const store = new CoordinationStore({ filePath: coordinationFile, now: () => now });
  await store.createWork({
    workId: "work-1",
    team,
    route,
    profile,
    spec: createWorkSpec({ workId: "work-1", revision: 1, objective: "Inspect runtime", scope: "bounded", completionContract: "visible reply", createdAt: now }),
    actorId: "@alice:example.test",
    sourceEventId: "$human-event-1",
    leaderSessionId: "leader-session-1",
    requestId: "request-1",
    wakes: [{ kind: "leader-resume", targetMemberId: leader.memberId }, { kind: "human-reply", targetMemberId: "@alice:example.test" }],
  });
  const task = createTaskSpec({ taskId: "task-console-1", workId: "work-1", assigneeMemberId: leader.memberId, objective: "Inspect the bounded runtime", completionContract: "return one claim", inputRefs: [], createdAt: now });
  await store.createTask({ task, team, member: leader, profile, actorId: leader.memberId, expectedEpoch: 0, requestId: "request-console-task" });
  await store.submitResult({
    result: createResult({ resultId: "result-console-1", workId: task.workId, taskId: task.taskId, producerMemberId: leader.memberId, toolResultIds: [], artifactRefs: [], claim: "runtime is observable", createdAt: now }),
    team,
    member: leader,
    profile,
    actorId: leader.memberId,
    expectedEpoch: 1,
    requestId: "request-console-result",
  });
  const server = createRuntimeConsoleServer({ coordinationFile }).listen(0);
  t.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/runtime`);
  const facts = await response.json();
  assert.equal(facts.workSource, "coordination-store");
  assert.equal(facts.works.length, 1);
  assert.deepEqual(facts.works[0].currentWorkSpec, { revision: 1, objective: "Inspect runtime", scope: "bounded", completionContract: "visible reply" });
  assert.equal(facts.works[0].timeline.length, 3);
  assert.equal(facts.deliveries.length, 2);
  assert.deepEqual(facts.deliveries.map((wake) => wake.kind).sort(), ["human-reply", "leader-resume"]);
  assert.equal(facts.tasks.length, 1);
  assert.equal(facts.tasks[0].status, "reported");
  assert.equal(facts.tasks[0].result.resultId, "result-console-1");
  assert.equal(facts.results.length, 1);
  assert.equal(facts.results[0].claim, "runtime is observable");
  assert.equal(JSON.stringify(facts).includes("profile-1"), false);
});

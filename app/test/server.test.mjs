import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeConsoleServer } from "../server.mjs";
import { CoordinationStore, createControlProfile, createMemberConfig, createTaskSpec, createTeamConfig, createTeamRouteBinding, createWorkSpec } from "../../worker/agent/team/coordination-store.mjs";

async function get(server, path = "/api/runtime") { const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`); return { response, body: path.includes("events") ? null : await response.json() }; }

test("runtime console exposes honest unknown state and message-admission fields", async (t) => {
  const server = createRuntimeConsoleServer().listen(0); t.after(() => server.close()); const { body } = await get(server);
  assert.equal(body.status, "unknown"); assert.deepEqual(body.works, []); assert.deepEqual(body.pendingAdmissions, []); assert.deepEqual(body.admissionMetrics, { pendingCount: 0, oldestReceivedAt: null, lastErrorCode: null }); assert.equal("decisions" in body, false);
  assert.equal((await get(server, "/readyz")).response.status, 503);
});

test("runtime console streams bounded facts over SSE", async (t) => {
  const server = createRuntimeConsoleServer({ sseIntervalMs: 100 }).listen(0); t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/runtime/events`); const reader = response.body.getReader(); const first = await reader.read(); const text = new TextDecoder().decode(first.value); assert.match(text, /"pendingAdmissions":\[\]/u); await reader.cancel();
});

test("runtime console projects bounded ToolResult metadata without raw payload", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tg-console-tool-")); t.after(() => rm(root, { recursive: true, force: true })); const capture = join(root, "capture.json");
  await writeFile(capture, JSON.stringify({ version: 1, results: [{ toolResultId: "a".repeat(64), callKey: "b".repeat(64), workId: "work", taskId: "task", actorId: "agent", runtimeProfile: "openclaw-built-in", tool: "read", requestSummary: { toolName: "read" }, resultSummary: { outcome: "success" }, outputRef: null, startedAt: "2026-08-15T00:00:00Z", completedAt: "2026-08-15T00:00:01Z", raw: "secret" }], retentionMarks: [] }), { mode: 0o600 });
  const server = createRuntimeConsoleServer({ captureFile: capture }).listen(0); t.after(() => server.close()); const { body } = await get(server); assert.equal(body.toolResults.length, 1); assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("runtime console keeps workSpec null visible as requirement-pending and shows backlog metrics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tg-console-work-")); t.after(() => rm(root, { recursive: true, force: true })); const now = "2026-08-15T00:00:00.000Z";
  const profile = createControlProfile({ profileId: "profile", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team", revision: 1, leaderMemberId: "leader", memberIds: ["leader"], controlProfileId: profile.profileId, createdAt: now });
  const route = createTeamRouteBinding({ routeId: "route", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room:example.test", createdAt: now });
  const leader = createMemberConfig({ memberId: "leader", teamId: team.teamId, workerName: "leader", matrixUserId: "@leader:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: now });
  const store = new CoordinationStore({ filePath: join(root, "state.json"), now: () => now });
  await store.createWork({ workId: "work-null", team, route, profile, spec: null, title: "Requirement", actorId: "@human:example.test", sourceEventId: "$routed", requestId: "create" });
  await store.enqueueMessageAdmission({ team, route, profile, actorId: "@human:example.test", eventId: "$pending", requestId: "pending" });
  const server = createRuntimeConsoleServer({ coordinationStore: store }).listen(0); t.after(() => server.close()); const { body } = await get(server);
  assert.equal(body.works.length, 1); assert.equal(body.works[0].currentWorkSpec, null); assert.equal(body.works[0].requirementState, "requirement-pending"); assert.equal(body.admissionMetrics.pendingCount, 1); assert.equal(body.pendingAdmissions[0].eventId, "$pending");
});

test("runtime console projects configured Agents, independent Task sessions, and actually used Skills", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tg-console-agents-")); t.after(() => rm(root, { recursive: true, force: true })); const now = "2026-08-19T00:00:00.000Z";
  const profile = createControlProfile({ profileId: "profile-agents", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-agents", revision: 1, leaderMemberId: "leader-agents", memberIds: ["leader-agents", "developer-agents"], controlProfileId: profile.profileId, createdAt: now });
  const route = createTeamRouteBinding({ routeId: "route-agents", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!agents:example.test", createdAt: now });
  const leader = createMemberConfig({ memberId: "leader-agents", teamId: team.teamId, workerName: "leader-agents", matrixUserId: "@leader:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, allowedSkills: ["work-coordination"], createdAt: now });
  const developer = createMemberConfig({ memberId: "developer-agents", teamId: team.teamId, workerName: "developer-agents", matrixUserId: "@developer:example.test", role: "developer", controlProfileId: profile.profileId, enabled: true, allowedSkills: ["test-driven-development"], createdAt: now });
  const store = new CoordinationStore({ filePath: join(root, "state.json"), now: () => now });
  const spec = createWorkSpec({ workId: "work-agents", revision: 1, goal: "Implement", doneWhen: ["Result exists"], createdAt: now });
  let work = (await store.createWork({ workId: spec.workId, team, route, profile, spec, title: "Agents", actorId: "@human:example.test", sourceEventId: "$agents", requestId: "create-agents" })).work;
  const task = createTaskSpec({ taskId: "task-agents", workId: spec.workId, assigneeMemberId: developer.memberId, objective: "Implement", createdAt: now });
  await store.createTask({ task, team, member: developer, profile, actorId: leader.memberId, expectedEpoch: work.epoch, requestId: "task-agents" });
  const capture = join(root, "capture.json");
  await writeFile(capture, JSON.stringify({ version: 1, results: [{ toolResultId: "c".repeat(64), callKey: "d".repeat(64), workId: spec.workId, taskId: task.taskId, actorId: developer.memberId, runtimeProfile: "codex-app-server", tool: "tiangong_use_skill", requestSummary: { toolName: "tiangong_use_skill" }, resultSummary: { outcome: "success", skillId: "test-driven-development", skillVersion: "1.0.0", skillContentDigest: "e".repeat(64) }, outputRef: null, startedAt: now, completedAt: now }], retentionMarks: [] }), { mode: 0o600 });
  const server = createRuntimeConsoleServer({ coordinationStore: store, captureFile: capture, memberConfigs: [leader, developer] }).listen(0); t.after(() => server.close()); const { body } = await get(server);
  assert.equal(body.tasks[0].sessionRef.startsWith("member-"), true);
  assert.equal(body.agents.length, 2); const projected = body.agents.find((agent) => agent.memberId === developer.memberId);
  assert.equal(projected.status, "active"); assert.equal(projected.activeTasks[0].sessionRef, body.tasks[0].sessionRef); assert.equal(projected.usedSkills[0].skillId, "test-driven-development");
});

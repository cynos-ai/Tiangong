import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRuntimeConsoleServer } from "../server.mjs";
import { createControlProfile, createMemberConfig, createTeamConfig } from "../../worker/agent/team/coordination-contracts.mjs";

async function get(server, path = "/api/runtime") { const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`); return { response, body: path.includes("events") ? null : await response.json() }; }
function storeProjection({ works = [], tasks = [], results = [], admissions = [], metrics = { pendingCount: 0, oldestReceivedAt: null, lastErrorCode: null } } = {}) {
  return { async listWorks() { return works; }, async listOutbox() { return []; }, async listTasks() { return tasks; }, async listResults() { return results; }, async listMessageAdmissions() { return admissions; }, async admissionMetrics() { return metrics; }, async health() { return { ok: true }; } };
}

test("runtime console exposes honest unknown state and message-admission fields", async (t) => {
  const server = createRuntimeConsoleServer().listen(0); t.after(() => server.close()); const { body } = await get(server);
  assert.equal(body.status, "unknown"); assert.deepEqual(body.works, []); assert.deepEqual(body.pendingAdmissions, []); assert.deepEqual(body.admissionMetrics, { pendingCount: 0, oldestReceivedAt: null, lastErrorCode: null }); assert.equal("decisions" in body, false);
  assert.equal(body.workSource, "postgres-not-configured"); assert.equal((await get(server, "/readyz")).response.status, 503);
});

test("chat-first workbench ships self-contained assets and strict browser headers", async (t) => {
  const server = createRuntimeConsoleServer().listen(0); t.after(() => server.close()); const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base); const html = await response.text();
  assert.equal(response.status, 200); assert.match(response.headers.get("content-security-policy"), /script-src 'self'/u); assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/u);
  assert.match(html, /Tiangong 工作台/u); assert.match(html, /MATRIX ROOM/u); assert.match(html, /WORK FACTS/u); assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/u); assert.doesNotMatch(html, /<style/u);
  const script = await fetch(`${base}/app.js`); const css = await fetch(`${base}/styles.css`);
  assert.match(script.headers.get("content-type"), /text\/javascript/u); assert.match(css.headers.get("content-type"), /text\/css/u); assert.doesNotMatch(await script.text(), /(?:localStorage|sessionStorage|innerHTML|\.style\.)/u);
});

test("runtime console streams bounded facts over SSE", async (t) => {
  const server = createRuntimeConsoleServer({ sseIntervalMs: 100 }).listen(0); t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/runtime/events`); const reader = response.body.getReader(); const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /"pendingAdmissions":\[\]/u); await reader.cancel();
});

test("runtime console projects bounded ToolResult metadata without raw payload", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tg-console-tool-")); t.after(() => rm(root, { recursive: true, force: true })); const capture = join(root, "capture.json");
  await writeFile(capture, JSON.stringify({ version: 1, results: [{ toolResultId: "a".repeat(64), callKey: "b".repeat(64), workId: "work", taskId: "task", actorId: "agent", runtimeProfile: "openclaw-built-in", tool: "read", requestSummary: { toolName: "read" }, resultSummary: { outcome: "success" }, outputRef: null, startedAt: "2026-08-15T00:00:00Z", completedAt: "2026-08-15T00:00:01Z", raw: "secret" }], retentionMarks: [] }), { mode: 0o600 });
  const server = createRuntimeConsoleServer({ captureFile: capture }).listen(0); t.after(() => server.close()); const { body } = await get(server); assert.equal(body.toolResults.length, 1); assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("runtime console projects null WorkSpec and PostgreSQL admission metrics", async (t) => {
  const now = "2026-08-15T00:00:00.000Z";
  const work = { work: { workId: "work-null", teamId: "team", routeId: "route", roomId: "!room:example.test", title: "Requirement", actorId: "@human:example.test", sourceEventId: "$routed", leaderSessionId: "leader-session" }, epoch: 0, status: "open", currentWorkSpec: null, currentPlanRef: null, timeline: [{ sequence: 1, type: "work-created", at: now, actorId: "leader", requestId: "create", epoch: 0, payload: { source: { roomId: "!room:example.test", eventId: "$routed", actorId: "@human:example.test" } } }] };
  const store = storeProjection({ works: [work], admissions: [{ eventId: "$pending", roomId: "!room:example.test", receivedAt: now, attempts: 0, lastErrorCode: null }], metrics: { pendingCount: 1, oldestReceivedAt: now, lastErrorCode: null } });
  const server = createRuntimeConsoleServer({ coordinationStore: store }).listen(0); t.after(() => server.close()); const { body } = await get(server);
  assert.equal(body.works[0].currentWorkSpec, null); assert.equal(body.works[0].requirementState, "requirement-pending"); assert.equal(body.works[0].timeline[0].payload.source.eventId, "$routed"); assert.equal(body.admissionMetrics.pendingCount, 1); assert.equal(body.pendingAdmissions[0].eventId, "$pending");
});

test("runtime console projects configured Agents, Task sessions, Plan facts, and used Skills", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tg-console-agents-")); t.after(() => rm(root, { recursive: true, force: true })); const now = "2026-08-19T00:00:00.000Z";
  const profile = createControlProfile({ profileId: "profile-agents", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-agents", revision: 1, leaderMemberId: "leader-agents", memberIds: ["leader-agents", "developer-agents"], controlProfileId: profile.profileId, createdAt: now });
  const leader = createMemberConfig({ memberId: "leader-agents", teamId: team.teamId, workerName: "leader-agents", matrixUserId: "@leader:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, allowedSkills: ["work-coordination"], createdAt: now });
  const developer = createMemberConfig({ memberId: "developer-agents", teamId: team.teamId, workerName: "developer-agents", matrixUserId: "@developer:example.test", role: "developer", controlProfileId: profile.profileId, enabled: true, allowedSkills: ["test-driven-development"], createdAt: now });
  const plan1 = { adapter: "workspace", ref: "plans/agents-v1.md" }; const plan2 = { adapter: "workspace", ref: "plans/agents-v2.md" };
  const work = { work: { workId: "work-agents", teamId: team.teamId, routeId: "route-agents", roomId: "!agents:example.test", title: "Agents", actorId: "@human:example.test", sourceEventId: "$agents", leaderSessionId: "leader-session" }, epoch: 3, status: "open", currentWorkSpec: { revision: 1, goal: "Implement", scope: [], constraints: [], doneWhen: ["Result exists"], unresolvedAssumptions: [] }, currentPlanRef: plan2, timeline: [plan1, plan2].map((planRef, index) => ({ sequence: index + 1, type: "work-plan-changed", at: now, actorId: leader.memberId, requestId: `plan-${index}`, epoch: index + 1, payload: { planRef } })) };
  const task = { spec: { taskId: "task-agents", workId: "work-agents", assigneeMemberId: developer.memberId, objective: "Implement", constraints: [], inputs: [], createdAt: now }, sessionRef: "member-session", status: "assigned", result: null, cancellation: null };
  const capture = join(root, "capture.json"); await writeFile(capture, JSON.stringify({ version: 1, results: [{ toolResultId: "c".repeat(64), callKey: "d".repeat(64), workId: "work-agents", taskId: "task-agents", actorId: developer.memberId, runtimeProfile: "openclaw-built-in", tool: "tiangong_use_skill", requestSummary: { toolName: "tiangong_use_skill" }, resultSummary: { outcome: "success", skillId: "test-driven-development", skillVersion: "1.0.0", skillContentDigest: "e".repeat(64) }, outputRef: null, startedAt: now, completedAt: now }], retentionMarks: [] }), { mode: 0o600 });
  const server = createRuntimeConsoleServer({ coordinationStore: storeProjection({ works: [work], tasks: [task] }), captureFile: capture, memberConfigs: [leader, developer] }).listen(0); t.after(() => server.close()); const { body } = await get(server);
  assert.equal(body.tasks[0].sessionRef, "member-session"); assert.deepEqual(body.works[0].currentPlanRef, plan2); assert.deepEqual(body.works[0].timeline.map((entry) => entry.payload.planRef.ref), [plan1.ref, plan2.ref]);
  const projected = body.agents.find((agent) => agent.memberId === developer.memberId); assert.equal(projected.status, "active"); assert.equal(projected.usedSkills[0].skillId, "test-driven-development");
});

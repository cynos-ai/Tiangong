import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRuntimeConsoleServer, parseAgentLoopConsoleUrl } from "../server.mjs";
import { createControlProfile, createMemberConfig, createTeamConfig } from "../../worker/agent/team/coordination-contracts.mjs";

async function get(server, path = "/api/runtime") { const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`); return { response, body: path.includes("events") ? null : await response.json() }; }
function storeProjection({ works = [], tasks = [], results = [], admissions = [], metrics = { pendingCount: 0, oldestReceivedAt: null, lastErrorCode: null } } = {}) {
  return {
    async getWork(workId) { return works.find((entry) => entry.work?.workId === workId); },
    async enqueueMessageAdmission() { throw new Error("not used by projection test"); },
    async listWorks() { return works; }, async listOutbox() { return []; }, async listTasks() { return tasks; }, async listResults() { return results; }, async listMessageAdmissions() { return admissions; }, async admissionMetrics() { return metrics; }, async health() { return { ok: true }; },
  };
}

test("AgentLoop console links accept only the documented fixed HTTPS route", () => {
  const base = "https://agentloop4service.console.aliyun.com/agentloop/region/cn-hangzhou/agentspace/demo-space/app/llm_agent/app-list";
  assert.equal(parseAgentLoopConsoleUrl(base), base);
  assert.equal(parseAgentLoopConsoleUrl(""), null);
  for (const invalid of ["not-a-url", "http://agentloop4service.console.aliyun.com/agentloop/region/cn-hangzhou/agentspace/demo/app/llm_agent/app-list", "https://evil.example/agentloop/region/cn-hangzhou/agentspace/demo/app/llm_agent/app-list", `${base}?token=secret`]) {
    assert.throws(() => parseAgentLoopConsoleUrl(invalid), /AgentLoop console URL/u);
  }
});

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
  const script = await fetch(`${base}/app.js`); const css = await fetch(`${base}/styles.css`); const scriptText = await script.text(); const cssText = await css.text();
  assert.match(script.headers.get("content-type"), /text\/javascript/u); assert.match(css.headers.get("content-type"), /text\/css/u); assert.doesNotMatch(scriptText, /(?:localStorage|sessionStorage|innerHTML|\.style\.)/u);
  assert.match(html, /AgentLoop 诊断轨迹/u); assert.match(html, /可能被采样、延迟、重复或丢失/u); assert.match(html, /按需加载轨迹/u); assert.match(scriptText, /\/api\/diagnostics\/works\//u); assert.match(scriptText, /load-diagnostics/u); assert.match(cssText, /diagnostics-summary/u);
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

test("AgentLoop diagnostics endpoint revalidates Web identity and PostgreSQL Work scope", async (t) => {
  const createdAt = "2026-08-21T00:00:00.000Z";
  const work = { work: { workId: "work-diagnostics", teamId: "team-diagnostics", routeId: "route-diagnostics", roomId: "!diagnostics:example.test", createdAt }, status: "open", timeline: [{ at: createdAt }] };
  const store = storeProjection({ works: [work] });
  let authorized = 0; let observedRequest;
  const matrixWebGateway = { async handle() { return false; }, async authorizeRead() { authorized += 1; return { session: { userId: "@human:example.test" } }; }, async close() {} };
  const diagnosticsClient = { async query(value) { observedRequest = value; return { version: 1, availability: "unknown", complete: true, truncated: false, workId: value.workId, spans: [], summary: {}, rawContentEmitted: false, queriedAt: "2026-08-21T01:00:00.000Z", cacheState: "miss", authoritative: false }; } };
  const coordinationControl = { store, bearerToken: "control-token-123456", team: { teamId: "team-diagnostics" }, route: { routeId: "route-diagnostics", roomId: "!diagnostics:example.test" }, profile: {}, leaderMember: {}, members: [] };
  const server = createRuntimeConsoleServer({ coordinationStore: store, coordinationControl, matrixWebGateway, diagnosticsClient, now: () => Date.parse("2026-08-21T01:00:00.000Z") }).listen(0); t.after(() => server.close());
  const result = await get(server, "/api/diagnostics/works/work-diagnostics/trace");
  assert.equal(result.response.status, 200); assert.equal(authorized, 1); assert.deepEqual(observedRequest, { workId: "work-diagnostics", fromEpoch: 1787270340, toEpoch: 1787274001 }); assert.equal(result.body.authoritative, false); assert.equal(result.body.windowLimited, false);

  const injection = await get(server, "/api/diagnostics/works/work-diagnostics/trace?project=other");
  assert.equal(injection.response.status, 422); assert.equal(injection.body.error, "DIAGNOSTICS_REQUEST_INVALID");
});

test("AgentLoop diagnostics endpoint denies revoked and cross-Room requests before querying the adapter", async (t) => {
  const work = { work: { workId: "work-other", teamId: "team", routeId: "route", roomId: "!other:example.test", createdAt: "2026-08-21T00:00:00Z" }, status: "open", timeline: [] };
  const store = storeProjection({ works: [work] }); let queries = 0;
  const diagnosticsClient = { async query() { queries += 1; return {}; } };
  const control = { store, bearerToken: "control-token-123456", team: { teamId: "team" }, route: { routeId: "route", roomId: "!bound:example.test" }, profile: {}, leaderMember: {}, members: [] };
  const revoked = { async handle() { return false; }, async authorizeRead() { throw Object.assign(new Error("revoked"), { code: "MATRIX_SESSION_REVOKED", status: 401 }); }, async close() {} };
  const revokedServer = createRuntimeConsoleServer({ coordinationStore: store, coordinationControl: control, matrixWebGateway: revoked, diagnosticsClient }).listen(0); t.after(() => revokedServer.close());
  assert.equal((await get(revokedServer, "/api/diagnostics/works/work-other/trace")).response.status, 401); assert.equal(queries, 0);

  const allowed = { async handle() { return false; }, async authorizeRead() {}, async close() {} };
  const scopedServer = createRuntimeConsoleServer({ coordinationStore: store, coordinationControl: control, matrixWebGateway: allowed, diagnosticsClient }).listen(0); t.after(() => scopedServer.close());
  const scoped = await get(scopedServer, "/api/diagnostics/works/work-other/trace"); assert.equal(scoped.response.status, 404); assert.equal(scoped.body.error, "DIAGNOSTIC_WORK_NOT_FOUND"); assert.equal(queries, 0);
});

test("a blocked diagnostics query does not enter the runtime projection or SSE path", async (t) => {
  const createdAt = "2026-08-21T00:00:00Z";
  const work = { work: { workId: "work-slow", teamId: "team", routeId: "route", roomId: "!bound:example.test", createdAt }, status: "open", timeline: [{ at: createdAt }] };
  const store = storeProjection({ works: [work] });
  let release; let entered;
  const queryEntered = new Promise((accept) => { entered = accept; });
  const blocked = new Promise((accept) => { release = accept; });
  const diagnosticsClient = { async query(value) { entered(); await blocked; return { workId: value.workId }; } };
  const gateway = { async handle() { return false; }, async authorizeRead() {}, async close() {} };
  const control = { store, bearerToken: "control-token-123456", team: { teamId: "team" }, route: { routeId: "route", roomId: "!bound:example.test" }, profile: {}, leaderMember: {}, members: [] };
  const server = createRuntimeConsoleServer({ coordinationStore: store, coordinationControl: control, matrixWebGateway: gateway, diagnosticsClient }).listen(0); t.after(() => server.close());
  const pending = get(server, "/api/diagnostics/works/work-slow/trace"); await queryEntered;
  try {
    const runtime = await Promise.race([get(server, "/api/runtime"), new Promise((_, reject) => setTimeout(() => reject(new Error("runtime projection waited for diagnostics")), 500))]);
    assert.equal(runtime.response.status, 200);
  } finally { release(); }
  assert.equal((await pending).response.status, 200);
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
  const agentLoopConsoleUrl = "https://agentloop4service.console.aliyun.com/agentloop/region/cn-hangzhou/agentspace/demo-space/app/llm_agent/app-list";
  const server = createRuntimeConsoleServer({ coordinationStore: storeProjection({ works: [work], tasks: [task] }), captureFile: capture, memberConfigs: [leader, developer], agentLoopConsoleUrl }).listen(0); t.after(() => server.close()); const { body } = await get(server);
  assert.equal(body.tasks[0].sessionRef, "member-session"); assert.deepEqual(body.works[0].currentPlanRef, plan2); assert.deepEqual(body.works[0].timeline.map((entry) => entry.payload.planRef.ref), [plan1.ref, plan2.ref]);
  assert.match(body.works[0].trajectoryUrl, /attributes\.tiangong\.work\.id/iu); assert.match(body.tasks[0].trajectoryUrl, /attributes\.tiangong\.task\.id/iu); assert.equal(body.works[0].trajectoryUrl.includes("secret"), false);
  const projected = body.agents.find((agent) => agent.memberId === developer.memberId); assert.equal(projected.status, "active"); assert.equal(projected.usedSkills[0].skillId, "test-driven-development");
});

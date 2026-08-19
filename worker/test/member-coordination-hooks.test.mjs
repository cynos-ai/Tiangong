import assert from "node:assert/strict";
import test from "node:test";

import { createTaskSpec } from "../agent/team/coordination-store.mjs";
import { createMemberCoordinationHooks, registerMemberCoordinationHooks } from "../agent/team/member-coordination-hooks.mjs";

const ENDPOINT = "http://coordination-runtime:8780/v1/coordination/admit";
const TOKEN = "member-control-token";
const MEMBER_ID = "member-hooks";
const taskSpec = createTaskSpec({
  taskId: "task-hooks",
  workId: "work-hooks",
  assigneeMemberId: MEMBER_ID,
  objective: "Run the bounded native task",
  inputs: [],
  constraints: ["Submit one Result"],
  createdAt: "2026-08-16T00:00:00.000Z",
});

function fakeFetch(calls) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith(`/tasks/${taskSpec.taskId}`)) return new Response(JSON.stringify({ task: { spec: taskSpec, sessionRef: "member-logical-session-hooks", status: "assigned" } }), { status: 200 });
    if (String(url).endsWith(`/works/${taskSpec.workId}`)) return new Response(JSON.stringify({ work: { work: { workId: taskSpec.workId, teamId: "team-hooks" }, epoch: 1 } }), { status: 200 });
    if (String(url).endsWith("/results")) return new Response(JSON.stringify({ replayed: false, result: { taskId: taskSpec.taskId }, wake: { kind: "result-notification" } }), { status: 200 });
    return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
  };
}

test("member OpenClaw hooks fetch the immutable TaskSpec and submit one bounded Result", async () => {
  const calls = [];
  const hooks = createMemberCoordinationHooks({ endpoint: ENDPOINT, token: TOKEN, memberId: MEMBER_ID, fetchImpl: fakeFetch(calls), now: () => "2026-08-16T00:01:00.000Z" });
  assert.equal(await hooks.beforePromptBuild({ prompt: "@member Tiangong Task assigned: work=work-hooks task=task-hooks." }, { sessionKey: "member-session-hooks" }).then((value) => /Authoritative Tiangong TaskSpec/u.test(value.prependContext)), true);
  const submission = await hooks.agentEnd({ success: true, messages: [{ role: "assistant", content: [{ type: "text", text: "bounded implementation report" }] }] }, { sessionKey: "member-session-hooks" });
  assert.equal(submission.replayed, false);
  const resultRequest = calls.find((call) => call.url.endsWith("/results"));
  assert.ok(resultRequest);
  assert.equal(resultRequest.init.headers.Authorization, `Bearer ${TOKEN}`);
  const body = JSON.parse(resultRequest.init.body);
  assert.equal(body.actorId, MEMBER_ID);
  assert.equal(body.result.workId, taskSpec.workId);
  assert.equal(body.result.taskId, taskSpec.taskId);
  assert.equal(body.result.summary, "bounded implementation report");
  assert.equal(body.result.submittedBy, MEMBER_ID);
  assert.equal(JSON.stringify(body).includes(TOKEN), false);
});

test("member OpenClaw hooks enforce one active OpenClaw session owner per Task", async () => {
  const hooks = createMemberCoordinationHooks({ endpoint: ENDPOINT, token: TOKEN, memberId: MEMBER_ID, fetchImpl: fakeFetch([]) });
  const prompt = { prompt: "Tiangong Task assigned: work=work-hooks task=task-hooks." };
  await hooks.beforePromptBuild(prompt, { sessionKey: "member-session-owner" });
  await assert.rejects(() => hooks.beforePromptBuild(prompt, { sessionKey: "member-session-racer" }), /TASK_SESSION_ALREADY_ACTIVE/u);
});

test("member OpenClaw hooks reject an assignment for another Worker", async () => {
  const hooks = createMemberCoordinationHooks({ endpoint: ENDPOINT, token: TOKEN, memberId: MEMBER_ID, fetchImpl: async () => new Response(JSON.stringify({ task: { spec: { ...taskSpec, assigneeMemberId: "other-member" }, sessionRef: "member-logical-session-wrong", status: "assigned" } }), { status: 200 }) });
  await assert.rejects(
    () => hooks.beforePromptBuild({ prompt: "Tiangong Task assigned: work=work-hooks task=task-hooks." }, { sessionKey: "member-session-wrong" }),
    /not bound to this Worker/u,
  );
});

test("member hook submits a bounded Result from the native Runner after-tool event", async () => {
  const calls = [];
  const hooks = createMemberCoordinationHooks({ endpoint: ENDPOINT, token: TOKEN, memberId: MEMBER_ID, fetchImpl: fakeFetch(calls), now: () => "2026-08-16T00:02:00.000Z" });
  await hooks.afterToolCall({
    toolName: "tiangong_run_command",
    result: {
      details: {
        taskId: taskSpec.taskId,
        workId: taskSpec.workId,
        replayed: false,
        changeRevisionRef: { contentDigest: "a".repeat(64) },
      },
    },
  }, { sessionKey: "member-session-native-runner" });
  const resultRequest = calls.find((call) => call.url.endsWith("/results"));
  assert.ok(resultRequest);
  const body = JSON.parse(resultRequest.init.body);
  assert.deepEqual(body.result.deliverableRefs, [{ adapter: "runner-change-revision@1", ref: "a".repeat(64) }]);
  assert.match(body.result.summary, /ChangeRevision/u);
});

test("member hook registration uses OpenClaw's native lifecycle hooks", () => {
  const registrations = [];
  const result = registerMemberCoordinationHooks({ on: (...args) => registrations.push(args) }, { endpoint: ENDPOINT, token: TOKEN, memberId: MEMBER_ID, fetchImpl: fakeFetch([]) });
  assert.deepEqual(result, { enabled: true, hooks: ["before_prompt_build", "after_tool_call", "agent_end"] });
  assert.deepEqual(registrations.map(([name]) => name), ["before_prompt_build", "after_tool_call", "agent_end"]);
});

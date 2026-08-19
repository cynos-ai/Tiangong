import { createResult } from "./coordination-store.mjs";
import { createRemoteCoordinationStore } from "./coordination-control-client.mjs";

const ID = /^[A-Za-z0-9@!#$%&*+./:=?_-]{1,160}$/u;
const MAX_REPORT_BYTES = 8 * 1024;
const TASK_ASSIGNMENT = /Tiangong Task assigned:\s*work=([^\s.]+)\s+task=([^\s.]+)/u;
const DIGEST = /^[0-9a-f]{64}$/u;

function required(value, name, pattern = ID) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new TypeError(`${name} is missing or invalid`);
  }
  return value;
}

function bounded(value, limit = MAX_REPORT_BYTES) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function hookKey(ctx = {}) {
  return required(ctx.sessionKey ?? ctx.sessionId ?? ctx.runId, "OpenClaw member session key", /^[^\s]{1,512}$/u);
}

function assignmentFromPrompt(prompt) {
  if (typeof prompt !== "string") return null;
  const match = prompt.match(TASK_ASSIGNMENT);
  if (!match) return null;
  return { workId: required(match[1], "assigned workId"), taskId: required(match[2], "assigned taskId") };
}

function reportFromMessages(event) {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const assistant = messages.filter((message) => message?.role === "assistant").at(-1);
  const content = Array.isArray(assistant?.content)
    ? assistant.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
    : typeof assistant?.content === "string" ? assistant.content : "";
  return bounded(content.replace(/[\r\n]+/gu, " ").trim());
}

function nativeRunnerDetails(event = {}) {
  const result = event?.result;
  const details = result?.details ?? result?.result?.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  if (typeof details.taskId !== "string" || typeof details.workId !== "string") return null;
  const changeRevisionRef = details.changeRevisionRef;
  if (changeRevisionRef !== null && changeRevisionRef !== undefined &&
      (typeof changeRevisionRef !== "object" || !DIGEST.test(changeRevisionRef.contentDigest ?? ""))) return null;
  return Object.freeze({
    taskId: details.taskId,
    workId: details.workId,
    replayed: details.replayed === true,
    changeRevisionDigest: changeRevisionRef?.contentDigest ?? null,
  });
}

/**
 * Hooks for a non-Leader OpenClaw Worker. OpenClaw remains the model/session
 * owner; this module only fetches the immutable TaskSpec before a native turn
 * and writes one bounded Result after that turn. It never receives PG or Team
 * bindings and never starts a second model loop.
 */
export function createMemberCoordinationHooks({ endpoint, token, memberId, fetchImpl = globalThis.fetch, now = () => new Date().toISOString() } = {}) {
  const actorId = required(memberId, "memberId");
  const store = createRemoteCoordinationStore({ endpoint, token, fetchImpl, memberId: actorId });
  const assignments = new Map();
  const activeTaskSessions = new Map();
  const nativeResults = new Set();
  return Object.freeze({
    async beforePromptBuild(event = {}, ctx = {}) {
      const assignment = assignmentFromPrompt(event.prompt);
      if (!assignment) return undefined;
      const key = hookKey(ctx);
      const task = await store.getTask(assignment.taskId);
      if (!task?.spec || task.status !== "assigned" || typeof task.sessionRef !== "string" || task.spec.taskId !== assignment.taskId || task.spec.workId !== assignment.workId || task.spec.assigneeMemberId !== actorId) {
        throw new Error("OpenClaw member Task assignment is not bound to this Worker");
      }
      const activeKey = activeTaskSessions.get(task.spec.taskId);
      if (activeKey && activeKey !== key) throw new Error("TASK_SESSION_ALREADY_ACTIVE");
      activeTaskSessions.set(task.spec.taskId, key);
      assignments.set(key, Object.freeze({ task, workId: assignment.workId, taskId: assignment.taskId, sessionRef: task.sessionRef }));
      const objective = bounded(task.spec.objective, 4096);
      const constraints = Array.isArray(task.spec.constraints) ? bounded(task.spec.constraints.join("; "), 4096) : "";
      return { prependContext: `Authoritative Tiangong TaskSpec (read-only): task=${task.spec.taskId} work=${task.spec.workId} logicalSession=${task.sessionRef} objective=${objective}${constraints ? ` constraints=${constraints}` : ""}` };
    },
    async agentEnd(event = {}, ctx = {}) {
      const key = hookKey(ctx);
      const assignment = assignments.get(key);
      if (!assignment) return undefined;
      assignments.delete(key);
      activeTaskSessions.delete(assignment.taskId);
      if (nativeResults.has(assignment.taskId)) return undefined;
      const work = await store.getWork(assignment.workId);
      if (!work?.work || work.work.workId !== assignment.workId) {
        throw new Error("OpenClaw member Task Work binding is unavailable");
      }
      const report = reportFromMessages(event);
      const result = createResult({
        workId: assignment.workId,
        taskId: assignment.taskId,
        submittedBy: actorId,
        toolResultRefs: [],
        deliverableRefs: [],
        summary: event.success === false
          ? `Blocked: ${bounded(event.error || "Native OpenClaw member session failed", 4096)}`
          : bounded(report, 4096) || "Native OpenClaw member session completed without a bounded assistant report",
        createdAt: now(),
      });
      return store.submitResult({
        result,
        expectedEpoch: work.epoch,
        requestId: `result-submit-${assignment.taskId}`,
      });
    },
    async afterToolCall(event = {}, ctx = {}) {
      if (event.toolName !== "tiangong_run_command") return undefined;
      const details = nativeRunnerDetails(event);
      if (!details) throw new Error("Native Runner ToolResult details are unavailable");
      const task = await store.getTask(details.taskId);
      if (!task?.spec || task.spec.taskId !== details.taskId || task.spec.workId !== details.workId || task.spec.assigneeMemberId !== actorId) {
        throw new Error("Native Runner ToolResult is not bound to this Worker Task");
      }
      if (task.result) {
        nativeResults.add(details.taskId);
        return undefined;
      }
      const work = await store.getWork(details.workId);
      if (!work?.work || work.work.workId !== details.workId) throw new Error("Native Runner ToolResult Work binding is unavailable");
      const deliverableRefs = details.changeRevisionDigest ? [{ adapter: "runner-change-revision@1", ref: details.changeRevisionDigest }] : [];
      const result = createResult({
        workId: details.workId,
        taskId: details.taskId,
        submittedBy: actorId,
        toolResultRefs: [],
        deliverableRefs,
        summary: bounded(`Native Runner completed the assigned Codex tool call${details.replayed ? " by journal replay" : ""}${details.changeRevisionDigest ? `; ChangeRevision ${details.changeRevisionDigest}` : ""}.`, 4096),
        createdAt: now(),
      });
      const submitted = await store.submitResult({ result, expectedEpoch: work.epoch, requestId: `result-submit-${details.taskId}` });
      nativeResults.add(details.taskId);
      return submitted;
    },
  });
}

export function registerMemberCoordinationHooks(api, options = {}) {
  if (typeof api?.on !== "function") throw new Error("OpenClaw member coordination hook API is unavailable");
  const hooks = createMemberCoordinationHooks(options);
  api.on("before_prompt_build", hooks.beforePromptBuild, { priority: 100 });
  api.on("after_tool_call", hooks.afterToolCall, { priority: 100 });
  api.on("agent_end", hooks.agentEnd, { priority: 100 });
  return { enabled: true, hooks: ["before_prompt_build", "after_tool_call", "agent_end"] };
}

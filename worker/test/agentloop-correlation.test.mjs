import assert from "node:assert/strict";
import test from "node:test";

import processor from "../observability/agentloop-span-processor.mjs";
import {
  correlationAttributes,
  correlationForContext,
  registerAgentLoopCorrelation,
  resetAgentLoopCorrelationForTest,
} from "../observability/correlation.mjs";
import { enrichToolResultCorrelation, registerTiangongControlSpanHooks } from "../observability/hooks.mjs";

test.beforeEach(() => resetAgentLoopCorrelationForTest());

test("AgentLoop correlation carries only bounded product identifiers", () => {
  registerAgentLoopCorrelation({ runId: "run-1", sessionKey: "session-1" }, {
    workId: "work-1",
    taskId: "task-1",
    memberId: "developer-1",
    sessionRef: "member-session-1",
    turnId: "turn-1",
    skillId: "scenario-testing",
    prompt: "must-not-appear",
  });
  const correlation = correlationForContext({ runId: "run-1" });
  assert.deepEqual(correlation, {
    workId: "work-1",
    taskId: "task-1",
    memberId: "developer-1",
    sessionRef: "member-session-1",
    turnId: "turn-1",
    skillId: "scenario-testing",
  });
  assert.deepEqual(correlationAttributes(correlation), {
    "tiangong.work.id": "work-1",
    "tiangong.task.id": "task-1",
    "tiangong.member.id": "developer-1",
    "tiangong.session.ref": "member-session-1",
    "tiangong.turn.id": "turn-1",
    "tiangong.skill.id": "scenario-testing",
  });
});

test("custom AgentLoop span processor enriches a matching span without content", () => {
  registerAgentLoopCorrelation({ runId: "run-2" }, { workId: "work-2", memberId: "tester-1" });
  const written = {};
  processor.onEnding({
    attributes: { "openclaw.run.id": "run-2", "gen_ai.input.messages": "private prompt" },
    setAttribute(key, value) { written[key] = value; },
  });
  assert.deepEqual(written, { "tiangong.work.id": "work-2", "tiangong.member.id": "tester-1" });
  assert.equal(JSON.stringify(written).includes("private prompt"), false);
});

test("Tiangong control spans end persisted and missing ToolResult operations deterministically", () => {
  const handlers = new Map();
  const ended = [];
  const attributes = [];
  const api = { on(name, handler) { handlers.set(name, handler); } };
  const observability = {
    enabled: true,
    startAttempt() {
      return {
        correlate() {},
        startOperation() {
          return {
            setAttributes(value) { attributes.push(value); },
            end(outcome, error) { ended.push({ outcome, error }); },
          };
        },
        finish() {},
      };
    },
  };
  const control = registerTiangongControlSpanHooks(api, { observability, env: { TIANGONG_MEMBER_ID: "developer-1", TIANGONG_MEMBER_MODEL: "glm-5" } });
  const first = { runId: "run-persisted", sessionKey: "session-persisted" };
  handlers.get("before_prompt_build")({}, first);
  handlers.get("before_tool_call")({ toolName: "read", toolCallId: "call-persisted" }, first);
  control.observeToolResult({ toolResultId: "b".repeat(64), resultSummary: { outcome: "success" } }, first, { toolCallId: "call-persisted" });
  handlers.get("agent_end")({ success: true }, first);
  assert.deepEqual(ended[0], { outcome: "complete", error: undefined });
  assert.deepEqual(attributes[0], { "tiangong.tool_result.id": "b".repeat(64) });

  const second = { runId: "run-missing", sessionKey: "session-missing" };
  handlers.get("before_prompt_build")({}, second);
  handlers.get("before_tool_call")({ toolName: "read", toolCallId: "call-missing" }, second);
  handlers.get("agent_end")({ success: false }, second);
  assert.deepEqual(ended[1], { outcome: "error", error: { code: "TOOL_RESULT_NOT_PERSISTED" } });
});

test("ToolResult correlation joins the current Task and tool call", () => {
  registerAgentLoopCorrelation({ runId: "run-3" }, { workId: "work-3", taskId: "task-3", memberId: "reviewer-1" });
  registerAgentLoopCorrelation({ runId: "run-3", toolCallId: "call-3" }, { toolCallId: "call-3", skillId: "independent-code-review" });
  const record = enrichToolResultCorrelation({ toolResultId: "a".repeat(64), resultSummary: { outcome: "success" } }, { runId: "run-3" }, { toolCallId: "call-3" });
  assert.equal(record.workId, "work-3");
  assert.equal(record.taskId, "task-3");
  assert.equal(correlationForContext({ runId: "run-3" }, "call-3").toolResultId, "a".repeat(64));
});

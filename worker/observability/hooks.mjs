import {
  correlationAttributes,
  correlationForContext,
  registerAgentLoopCorrelation,
} from "./correlation.mjs";

function firstId(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0 && value.length <= 256);
}

function resultDetails(result) {
  if (!result || typeof result !== "object") return {};
  const details = result.details && typeof result.details === "object" ? result.details : result;
  return {
    workId: firstId(
      details.workId,
      details.work?.workId,
      details.work?.work?.workId,
      details.targetWork?.workId,
      details.targetWork?.work?.workId,
      details.binding?.workId,
      details.task?.spec?.workId,
      details.result?.workId,
    ),
    taskId: firstId(details.taskId, details.task?.taskId, details.task?.spec?.taskId, details.result?.taskId),
    skillId: firstId(details.skillId, details.skillUse?.skillId),
  };
}

export function registerAgentLoopCorrelationHooks(api, { env = process.env } = {}) {
  if (typeof api?.on !== "function") throw new Error("AgentLoop correlation requires OpenClaw hooks");
  const memberId = firstId(env.TIANGONG_MEMBER_ID, env.AGENTTEAMS_WORKER_NAME);

  api.on("before_prompt_build", (event = {}, ctx = {}) => {
    registerAgentLoopCorrelation(ctx, {
      memberId,
      turnId: firstId(event.eventId, event.messageId, event.currentMessageId, ctx.eventId, ctx.messageId, ctx.runId),
    });
  }, { priority: 300 });

  api.on("before_tool_call", (event = {}, ctx = {}) => {
    const params = event.params && typeof event.params === "object" ? event.params : {};
    registerAgentLoopCorrelation(ctx, {
      memberId,
      workId: firstId(params.workId, params.targetWorkId),
      taskId: firstId(params.taskId),
      skillId: event.toolName === "tiangong_use_skill" ? firstId(params.skillId) : undefined,
      toolCallId: firstId(event.toolCallId, ctx.toolCallId),
    });
  }, { priority: 300 });

  api.on("after_tool_call", (event = {}, ctx = {}) => {
    registerAgentLoopCorrelation(ctx, {
      memberId,
      ...resultDetails(event.result),
      toolCallId: firstId(event.toolCallId, ctx.toolCallId),
    });
  }, { priority: 300 });

  return { enabled: true, hooks: ["before_prompt_build", "before_tool_call", "after_tool_call"] };
}

function hookKey(ctx = {}) {
  return firstId(ctx.runId, ctx.sessionKey, ctx.sessionId);
}

export function registerTiangongControlSpanHooks(api, { observability, env = process.env } = {}) {
  if (typeof api?.on !== "function" || !observability || typeof observability.startAttempt !== "function") {
    throw new Error("Tiangong control span hooks require OpenClaw hooks and observability");
  }
  const attempts = new Map();
  const tools = new Map();
  const memberId = firstId(env.TIANGONG_MEMBER_ID, env.AGENTTEAMS_WORKER_NAME) ?? "unknown-member";
  const modelId = firstId(env.TIANGONG_MEMBER_MODEL, env.AGENTTEAMS_MODEL) ?? "unknown-model";

  api.on("before_prompt_build", (_event = {}, ctx = {}) => {
    if (!observability.enabled) return;
    const key = hookKey(ctx);
    if (!key || attempts.has(key)) return;
    const correlation = correlationForContext(ctx);
    attempts.set(key, observability.startAttempt({
      controlId: "tiangong-control",
      attemptId: firstId(ctx.runId, key),
      turnId: firstId(correlation.turnId, ctx.runId, key),
      sessionId: firstId(ctx.sessionId, ctx.sessionKey, key),
      provider: "agentteams-gateway",
      modelId,
      timeoutMs: 30 * 60 * 1000,
      memberId,
      ...correlation,
    }));
  }, { priority: -200 });

  api.on("before_tool_call", (event = {}, ctx = {}) => {
    if (!observability.enabled) return;
    const key = hookKey(ctx);
    const attempt = key ? attempts.get(key) : undefined;
    if (!attempt) return;
    const correlation = correlationForContext(ctx, event.toolCallId);
    attempt.correlate(Object.fromEntries(Object.entries({
      "tiangong.work.id": correlation.workId,
      "tiangong.task.id": correlation.taskId,
      "tiangong.member.id": correlation.memberId ?? memberId,
      "tiangong.session.ref": correlation.sessionRef,
      "tiangong.turn.id": correlation.turnId,
      "tiangong.skill.id": correlation.skillId,
    }).filter(([, value]) => value)));
    const operation = attempt.startOperation("execute_tool", {
      "tiangong.tool.name": firstId(event.toolName) ?? "unknown-tool",
      ...Object.fromEntries(Object.entries({
        "tiangong.work.id": correlation.workId,
        "tiangong.task.id": correlation.taskId,
        "tiangong.member.id": correlation.memberId ?? memberId,
        "tiangong.session.ref": correlation.sessionRef,
        "tiangong.turn.id": correlation.turnId,
        "tiangong.skill.id": correlation.skillId,
      }).filter(([, value]) => value)),
    });
    const toolCallId = firstId(event.toolCallId, ctx.toolCallId);
    if (toolCallId) tools.set(toolCallId, { operation, attemptKey: key });
  }, { priority: -200 });

  api.on("agent_end", (event = {}, ctx = {}) => {
    const key = hookKey(ctx);
    const attempt = key ? attempts.get(key) : undefined;
    if (!attempt) return;
    attempts.delete(key);
    for (const [toolCallId, pending] of tools) {
      if (pending.attemptKey !== key) continue;
      tools.delete(toolCallId);
      pending.operation.end("error", { code: "TOOL_RESULT_NOT_PERSISTED" });
    }
    attempt.correlate(Object.fromEntries(Object.entries(correlationAttributes(correlationForContext(ctx))).filter(([, value]) => value)));
    attempt.finish(event.success === false ? "error" : "complete", event.success === false ? { code: "AGENT_TURN_FAILED" } : undefined);
  }, { priority: -200 });

  return {
    observeToolResult(record, ctx = {}, event = {}) {
      const pending = tools.get(event.toolCallId);
      if (!pending) return;
      tools.delete(event.toolCallId);
      pending.operation.setAttributes({ "tiangong.tool_result.id": record.toolResultId });
      const outcome = record.resultSummary?.outcome === "success" ? "complete" : record.resultSummary?.outcome === "timeout" ? "timeout" : "error";
      pending.operation.end(outcome, outcome === "complete" ? undefined : { code: "TOOL_EXECUTION_FAILED" });
    },
  };
}

export function enrichToolResultCorrelation(record, ctx = {}, event = {}) {
  const observed = correlationForContext(ctx, event.toolCallId);
  const value = {
    ...record,
    ...(record.workId || !observed.workId ? {} : { workId: observed.workId }),
    ...(record.taskId || !observed.taskId ? {} : { taskId: observed.taskId }),
  };
  registerAgentLoopCorrelation(ctx, {
    ...observed,
    workId: value.workId,
    taskId: value.taskId,
    toolResultId: value.toolResultId,
    toolCallId: firstId(event.toolCallId, ctx.toolCallId),
  });
  return Object.freeze(value);
}

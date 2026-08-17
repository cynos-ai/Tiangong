import { join } from "node:path";

import { sha256 } from "../canonical-json.mjs";
import { ToolResultStore } from "./tool-result-store.mjs";

const WORKER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;

function bounded(value, limit = 512) {
  return typeof value === "string" ? value.slice(0, limit) : null;
}

function contentShape(content) {
  if (!Array.isArray(content)) return [];
  return content.slice(0, 32).map((part) => ({
    type: bounded(part?.type, 64),
    textLength: typeof part?.text === "string" ? part.text.length : undefined,
    hasData: typeof part?.data === "string",
  }));
}

export function summarizeToolResult(event = {}) {
  const message = event.message && typeof event.message === "object" ? event.message : {};
  return {
    version: 1,
    source: "openclaw.tool_result_persist",
    toolName: bounded(event.toolName),
    toolCallId: bounded(event.toolCallId),
    role: bounded(message.role, 64),
    isSynthetic: event.isSynthetic === true,
    content: contentShape(message.content),
  };
}

export function defaultToolResultCapturePath(env = process.env) {
  const explicit = typeof env.TIANGONG_TOOL_RESULT_CAPTURE_FILE === "string"
    ? env.TIANGONG_TOOL_RESULT_CAPTURE_FILE.trim()
    : "";
  if (explicit) return explicit;
  const stateRoot = typeof env.TIANGONG_STATE_DIR === "string" && env.TIANGONG_STATE_DIR.trim() !== ""
    ? env.TIANGONG_STATE_DIR.trim()
    : typeof env.AGENTTEAMS_WORKER_NAME === "string" && WORKER_NAME_PATTERN.test(env.AGENTTEAMS_WORKER_NAME)
      ? `/root/agentteams-fs/agents/${env.AGENTTEAMS_WORKER_NAME}/.tiangong/runtime`
      : "";
  if (!stateRoot) throw new Error("ToolResult capture requires a Worker state root");
  return join(stateRoot, "tool-results", "openclaw.json");
}

export function createToolResultCaptureHook({ filePath, now = () => new Date() } = {}) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("ToolResult capture filePath is required");
  }
  if (typeof now !== "function") throw new TypeError("ToolResult capture clock is required");
  const store = new ToolResultStore({ filePath });
  return async (event, ctx = {}) => {
    const timestamp = now().toISOString();
    const summary = summarizeToolResult(event);
    if (!summary.toolCallId) throw new Error("TOOL_RESULT_CAPTURE_GAP");
    const actorId = bounded(ctx.actorId ?? ctx.senderId ?? ctx.agentId, 128);
    if (!actorId) throw new Error("TOOL_RESULT_CAPTURE_GAP");
    const sessionKey = bounded(ctx.sessionKey, 128);
    if (!sessionKey) throw new Error("TOOL_RESULT_CAPTURE_GAP");
    const callKey = sha256({ actorId, sessionKey, toolCallId: summary.toolCallId });
    const toolResultId = sha256({ source: summary.source, callKey });
    const textLength = summary.content.reduce((total, part) => total + (part.textLength ?? 0), 0);
    const outcome = event.outcome === "timeout" || event.status === "timeout"
      ? "timeout"
      : event.outcome === "cancel" || event.status === "cancelled"
        ? "cancel"
        : summary.isSynthetic
          ? "denied"
          : event.outcome === "error" || event.status === "error"
            ? "error"
            : "success";
    const startedAt = bounded(event.startedAt, 64) ?? timestamp;
    const record = {
      toolResultId,
      callKey,
      ...(bounded(ctx.workId, 256) ? { workId: bounded(ctx.workId, 256) } : {}),
      ...(bounded(ctx.taskId, 256) ? { taskId: bounded(ctx.taskId, 256) } : {}),
      actorId,
      runtimeProfile: bounded(ctx.runtimeProfile, 128) ?? "openclaw-built-in",
      tool: summary.toolName ?? "unknown",
      requestSummary: {
        toolName: summary.toolName ?? "unknown",
        toolCallId: summary.toolCallId,
      },
      resultSummary: {
        outcome,
        contentPartCount: summary.content.length,
        textLength,
        hasData: summary.content.some((part) => part.hasData === true),
        isSynthetic: summary.isSynthetic,
      },
      outputRef: event.outputRef ?? null,
      startedAt,
      completedAt: timestamp,
    };
    await store.append(record);
    return undefined;
  };
}

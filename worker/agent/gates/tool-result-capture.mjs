import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import { sha256 } from "../canonical-json.mjs";

const MAX_RECORD_BYTES = 4096;
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
  return join(stateRoot, "tool-results", "openclaw.jsonl");
}

export function createToolResultCaptureHook({ filePath, now = () => new Date() } = {}) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("ToolResult capture filePath is required");
  }
  if (typeof now !== "function") throw new TypeError("ToolResult capture clock is required");
  return (event, ctx = {}) => {
    const timestamp = now().toISOString();
    const summary = summarizeToolResult(event);
    const record = {
      ...summary,
      captureId: sha256({
        source: summary.source,
        toolCallId: summary.toolCallId,
        agentId: bounded(ctx.agentId, 128),
        sessionKey: bounded(ctx.sessionKey, 128),
        timestamp,
      }),
      agentId: bounded(ctx.agentId, 128),
      sessionKey: bounded(ctx.sessionKey, 128),
      timestamp,
    };
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
      throw new Error("ToolResult capture record exceeds the bounded limit");
    }
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const fd = openSync(filePath, "a", 0o600);
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    return undefined;
  };
}

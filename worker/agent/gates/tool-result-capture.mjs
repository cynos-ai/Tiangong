import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const MAX_RECORD_BYTES = 4096;

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
    toolName: bounded(event.toolName),
    toolCallId: bounded(event.toolCallId),
    role: bounded(message.role, 64),
    isSynthetic: event.isSynthetic === true,
    content: contentShape(message.content),
  };
}

export function createToolResultCaptureHook({ filePath, now = () => new Date() } = {}) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("ToolResult capture filePath is required");
  }
  if (typeof now !== "function") throw new TypeError("ToolResult capture clock is required");
  return (event) => {
    const record = { ...summarizeToolResult(event), timestamp: now().toISOString() };
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
      throw new Error("ToolResult capture record exceeds the bounded limit");
    }
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const fd = openSync(filePath, "a", 0o600);
    try { writeSync(fd, line); } finally { closeSync(fd); }
    return undefined;
  };
}

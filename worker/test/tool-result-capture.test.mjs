import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createToolResultCaptureHook, defaultToolResultCapturePath, summarizeToolResult } from "../agent/gates/tool-result-capture.mjs";

test("captures only bounded ToolResult metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-tool-result-"));
  const filePath = join(directory, "tool-results.jsonl");
  const hook = createToolResultCaptureHook({ filePath, now: () => new Date("2026-08-13T00:00:00.000Z") });
  hook({ toolName: "read", toolCallId: "call-1", message: { role: "toolResult", content: [{ type: "text", text: "secret must not be written" }] } }, { agentId: "agent-1", sessionKey: "session-1" });
  const record = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(record, {
    version: 1,
    source: "openclaw.tool_result_persist",
    toolName: "read",
    toolCallId: "call-1",
    role: "toolResult",
    isSynthetic: false,
    content: [{ type: "text", textLength: 26, hasData: false }],
    captureId: record.captureId,
    agentId: "agent-1",
    sessionKey: "session-1",
    timestamp: "2026-08-13T00:00:00.000Z",
  });
  assert.equal(JSON.stringify(record).includes("secret"), false);
});

test("derives the default capture path only from an explicit or Worker-owned state root", () => {
  assert.equal(defaultToolResultCapturePath({ TIANGONG_TOOL_RESULT_CAPTURE_FILE: "C:\\tmp\\capture.jsonl" }), "C:\\tmp\\capture.jsonl");
  const workerPath = defaultToolResultCapturePath({ AGENTTEAMS_WORKER_NAME: "worker-one" });
  assert.equal(workerPath, process.platform === "win32"
    ? "\\root\\agentteams-fs\\agents\\worker-one\\.tiangong\\runtime\\tool-results\\openclaw.jsonl"
    : "/root/agentteams-fs/agents/worker-one/.tiangong/runtime/tool-results/openclaw.jsonl");
  assert.throws(() => defaultToolResultCapturePath({}), /Worker state root/u);
});

test("normalizes malformed messages without claiming content", () => {
  assert.deepEqual(summarizeToolResult({ toolName: "x", message: null }), {
    version: 1,
    source: "openclaw.tool_result_persist",
    toolName: "x",
    toolCallId: null,
    role: null,
    isSynthetic: false,
    content: [],
  });
});

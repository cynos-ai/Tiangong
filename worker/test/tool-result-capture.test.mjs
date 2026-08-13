import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createToolResultCaptureHook, summarizeToolResult } from "../agent/gates/tool-result-capture.mjs";

test("captures only bounded ToolResult metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-tool-result-"));
  const filePath = join(directory, "tool-results.jsonl");
  const hook = createToolResultCaptureHook({ filePath, now: () => new Date("2026-08-13T00:00:00.000Z") });
  hook({ toolName: "read", toolCallId: "call-1", message: { role: "toolResult", content: [{ type: "text", text: "secret must not be written" }] } });
  const record = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(record, {
    version: 1,
    toolName: "read",
    toolCallId: "call-1",
    role: "toolResult",
    isSynthetic: false,
    content: [{ type: "text", textLength: 26, hasData: false }],
    timestamp: "2026-08-13T00:00:00.000Z",
  });
  assert.equal(JSON.stringify(record).includes("secret"), false);
});

test("normalizes malformed messages without claiming content", () => {
  assert.deepEqual(summarizeToolResult({ toolName: "x", message: null }), {
    version: 1,
    toolName: "x",
    toolCallId: null,
    role: null,
    isSynthetic: false,
    content: [],
  });
});

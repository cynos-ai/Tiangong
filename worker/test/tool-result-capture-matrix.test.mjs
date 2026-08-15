import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createToolResultCaptureHook } from "../agent/gates/tool-result-capture.mjs";
import { ToolResultStore } from "../agent/gates/tool-result-store.mjs";

test("captures success, error, denied, and replay observations without raw payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-tool-result-matrix-"));
  const filePath = join(directory, "tool-results.json");
  const hook = createToolResultCaptureHook({
    filePath,
    now: (() => {
      let sequence = 0;
      return () => new Date(`2026-08-13T00:00:0${sequence++}.000Z`);
    })(),
  });
  const cases = [
    { label: "success", event: { toolName: "read", toolCallId: "call-success", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } } },
    { label: "error", event: { toolName: "read", toolCallId: "call-error", message: { role: "toolResult", content: [{ type: "text", text: "stable error" }] } } },
    { label: "denied", event: { toolName: "write", toolCallId: "call-denied", isSynthetic: true, message: { role: "toolResult", content: [{ type: "text", text: "ADMISSION_TOOL_DENIED" }] } } },
    { label: "replay", event: { toolName: "read", toolCallId: "call-success", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } } },
  ];

  for (const { event } of cases) await hook(event, { agentId: "agent-1", sessionKey: "session-1" });
  const records = (await new ToolResultStore({ filePath }).list()).results;
  assert.equal(records.length, 3);
  assert.equal(new Set(records.map((record) => record.toolResultId)).size, records.length);
  assert.ok(records.every((record) => record.runtimeProfile === "openclaw-built-in"));
  assert.ok(records.every((record) => record.actorId === "agent-1"));
  assert.deepEqual(records.map((record) => record.requestSummary.toolCallId), [
    "call-success", "call-error", "call-denied",
  ]);
  assert.equal(records[2].resultSummary.outcome, "denied");
  assert.equal(records[0].resultSummary.textLength, 2);
  assert.equal(records[1].resultSummary.textLength, 12);
  assert.equal(records[2].resultSummary.textLength, "ADMISSION_TOOL_DENIED".length);
  assert.equal(JSON.stringify(records).includes("credential"), false);
  assert.equal(JSON.stringify(records).includes("stable error"), false);
  assert.equal(JSON.stringify(records).includes("ADMISSION_TOOL_DENIED"), false);
});

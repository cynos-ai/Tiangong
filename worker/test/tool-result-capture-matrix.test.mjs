import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createToolResultCaptureHook } from "../agent/gates/tool-result-capture.mjs";

test("captures success, error, denied, and replay observations without raw payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-tool-result-matrix-"));
  const filePath = join(directory, "tool-results.jsonl");
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

  for (const { event } of cases) hook(event);
  const records = (await readFile(filePath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(records.length, cases.length);
  assert.deepEqual(records.map((record) => record.toolCallId), [
    "call-success", "call-error", "call-denied", "call-success",
  ]);
  assert.equal(records[2].isSynthetic, true);
  assert.equal(records[0].content[0].textLength, 2);
  assert.equal(records[1].content[0].textLength, 12);
  assert.equal(records[2].content[0].textLength, "ADMISSION_TOOL_DENIED".length);
  assert.equal(JSON.stringify(records).includes("credential"), false);
  assert.equal(JSON.stringify(records).includes("stable error"), false);
  assert.equal(JSON.stringify(records).includes("ADMISSION_TOOL_DENIED"), false);
});

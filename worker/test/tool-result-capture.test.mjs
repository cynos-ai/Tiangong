import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createToolResultCaptureHook, defaultToolResultCapturePath, summarizeToolResult } from "../agent/gates/tool-result-capture.mjs";
import { ToolResultStore } from "../agent/gates/tool-result-store.mjs";

test("captures only bounded ToolResult metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-tool-result-"));
  const filePath = join(directory, "tool-results.json");
  const hook = createToolResultCaptureHook({ filePath, now: () => new Date("2026-08-13T00:00:00.000Z") });
  await hook({ toolName: "read", toolCallId: "call-1", message: { role: "toolResult", content: [{ type: "text", text: "secret must not be written" }] } }, { agentId: "agent-1", sessionKey: "session-1" });
  const record = (await new ToolResultStore({ filePath }).list()).results[0];
  assert.equal(record.tool, "read");
  assert.equal(record.actorId, "agent-1");
  assert.equal(record.resultSummary.textLength, 26);
  assert.equal(record.resultSummary.outcome, "success");
  assert.match(record.toolResultId, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(record).includes("secret"), false);
});

test("derives the default capture path only from an explicit or Worker-owned state root", () => {
  assert.equal(defaultToolResultCapturePath({ TIANGONG_TOOL_RESULT_CAPTURE_FILE: "C:\\tmp\\capture.jsonl" }), "C:\\tmp\\capture.jsonl");
  const workerPath = defaultToolResultCapturePath({ AGENTTEAMS_WORKER_NAME: "worker-one" });
  assert.equal(workerPath, process.platform === "win32"
    ? "\\root\\agentteams-fs\\agents\\worker-one\\.tiangong\\runtime\\tool-results\\openclaw.json"
    : "/root/agentteams-fs/agents/worker-one/.tiangong/runtime/tool-results/openclaw.json");
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

test("fails closed when capture storage or ownership metadata is unavailable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-tool-result-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missingOwner = createToolResultCaptureHook({ filePath: join(directory, "missing-owner.json") });
  await assert.rejects(
    missingOwner({ toolName: "read", toolCallId: "call-missing-owner", message: { role: "toolResult", content: [] } }, { sessionKey: "session-1" }),
    /TOOL_RESULT_CAPTURE_GAP/u,
  );

  const storagePath = join(directory, "storage-directory");
  await mkdir(storagePath);
  const storageFailure = createToolResultCaptureHook({ filePath: storagePath });
  await assert.rejects(
    storageFailure({ toolName: "read", toolCallId: "call-storage-failure", message: { role: "toolResult", content: [] } }, { agentId: "agent-1", sessionKey: "session-1" }),
    /ToolResult store state file is invalid/u,
  );
});

test("validates and retains only structured ContentRef shapes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-tool-result-ref-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "tool-results.json");
  const hook = createToolResultCaptureHook({ filePath });
  await hook({
    toolName: "read",
    toolCallId: "call-ref",
    outputRef: { repositoryId: "repo-1", commitSha: "abc123" },
    message: { role: "toolResult", content: [] },
  }, { agentId: "agent-1", sessionKey: "session-1", workId: "work-1" });
  const record = (await new ToolResultStore({ filePath }).list()).results[0];
  assert.deepEqual(record.outputRef, { repositoryId: "repo-1", commitSha: "abc123" });
  await assert.rejects(
    hook({ toolName: "read", toolCallId: "call-bad-ref", outputRef: { path: "/tmp/raw" }, message: { role: "toolResult", content: [] } }, { agentId: "agent-1", sessionKey: "session-1", workId: "work-1" }),
    /outputRef has an unsupported shape/u,
  );
});

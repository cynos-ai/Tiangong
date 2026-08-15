import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createRuntimeConsoleServer } from "../server.mjs";

test("runtime console exposes health and honest unknown state by default", async (t) => {
  const server = createRuntimeConsoleServer().listen(0);
  t.after(() => server.close());
  const address = server.address();
  const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  const runtime = await fetch(`http://127.0.0.1:${address.port}/api/runtime`);
  assert.equal(runtime.status, 200);
  assert.deepEqual(await runtime.json(), { status: "unknown", source: "runtime-facts-not-configured", lane: null, worker: null, toolResults: [], toolResultsSource: "tool-result-capture-not-configured" });
  const ready = await fetch(`http://127.0.0.1:${address.port}/readyz`);
  assert.equal(ready.status, 503);
});

test("runtime console projects bounded ToolResult metadata without raw payloads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-console-capture-"));
  const captureFile = join(directory, "openclaw.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(captureFile, JSON.stringify({
    version: 1,
    results: [{
    toolResultId: "a".repeat(64),
    callKey: "b".repeat(64),
    workId: "work-1",
    taskId: "task-1",
    actorId: "agent-1",
    runtimeProfile: "openclaw-built-in",
    tool: "read",
    requestSummary: { toolName: "read", toolCallId: "call-1" },
    resultSummary: { outcome: "success", textLength: 5, hasData: false },
    outputRef: { repositoryId: "repo-1", commitSha: "abc123" },
    startedAt: "2026-08-13T00:00:00.000Z",
    completedAt: "2026-08-13T00:00:00.000Z",
    raw: "must-not-leak",
    }],
    retentionMarks: [],
  }), { mode: 0o600 });
  const server = createRuntimeConsoleServer({ captureFile }).listen(0);
  t.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/runtime`);
  assert.equal(response.status, 200);
  const facts = await response.json();
  assert.equal(facts.status, "unknown");
  assert.equal(facts.toolResultsSource, "tool-result-capture-file");
  assert.deepEqual(facts.toolResults, [{
    version: 1,
    toolResultId: "a".repeat(64),
    callKey: "b".repeat(64),
    workId: "work-1",
    taskId: "task-1",
    actorId: "agent-1",
    runtimeProfile: "openclaw-built-in",
    tool: "read",
    requestSummary: { toolName: "read", toolCallId: "call-1" },
    resultSummary: { outcome: "success", textLength: 5, hasData: false },
    outputRef: { repositoryId: "repo-1", commitSha: "abc123" },
    startedAt: "2026-08-13T00:00:00.000Z",
    completedAt: "2026-08-13T00:00:00.000Z",
  }]);
  assert.equal(JSON.stringify(facts).includes("must-not-leak"), false);
});

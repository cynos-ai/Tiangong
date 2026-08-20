import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../agent/canonical-json.mjs";
import { ToolResultStore } from "../agent/gates/tool-result-store.mjs";

function result(overrides = {}) {
  const callKey = sha256({ actorId: "member-1", sessionKey: "session-1", toolCallId: "call-1" });
  return {
    toolResultId: sha256({ source: "openclaw.tool_result_persist", callKey }),
    callKey,
    workId: "work-1",
    taskId: "task-1",
    actorId: "member-1",
    runtimeProfile: "openclaw-built-in",
    tool: "read",
    requestSummary: { toolName: "read", toolCallId: "call-1" },
    resultSummary: { outcome: "success", textLength: 2, hasData: false },
    outputRef: null,
    startedAt: "2026-08-15T00:00:00.000Z",
    completedAt: "2026-08-15T00:00:01.000Z",
    ...overrides,
  };
}

test("ToolResult store survives restart, deduplicates, and records retention", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-tool-result-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "execution-records.json");
  const store = new ToolResultStore({ filePath });
  const first = await store.append(result());
  const replay = await store.append(result());
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  const mark = await store.markRetention(first.result.toolResultId, { workId: "work-1", until: "2026-12-01T00:00:00.000Z" });
  assert.equal(mark.replayed, false);

  const reopened = new ToolResultStore({ filePath });
  const state = await reopened.list();
  assert.equal(state.results.length, 1);
  assert.equal(state.retentionMarks.length, 1);
  assert.deepEqual(await reopened.get(first.result.toolResultId), first.result);
  assert.equal((await readFile(filePath, "utf8")).includes("secret"), false);
});

test("ToolResult store rejects changed duplicate calls and missing ownership", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-tool-result-conflict-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ToolResultStore({ filePath: join(directory, "execution-records.json") });
  await store.append(result());
  await assert.rejects(store.append(result({ resultSummary: { outcome: "error", textLength: 5, hasData: false } })), /TOOL_RESULT_CONFLICT/u);
  await assert.rejects(store.markRetention(result().toolResultId, { workId: "work-2", until: "2026-12-01T00:00:00.000Z" }), /TOOL_RESULT_OWNER_MISMATCH/u);
});

test("synchronous ToolResult append shares replay and lock semantics", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-tool-result-sync-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "execution-records.json"); const store = new ToolResultStore({ filePath });
  assert.equal(store.appendSync(result()).replayed, false);
  assert.equal(store.appendSync(result()).replayed, true);
  await mkdir(`${filePath}.lock`);
  assert.throws(() => store.appendSync(result()), /TOOL_RESULT_STORE_BUSY/u);
  const stale = new Date("2000-01-01T00:00:00.000Z");
  await utimes(`${filePath}.lock`, stale, stale);
  assert.equal(store.appendSync(result()).replayed, true);
});

test("synchronous ToolResult append rejects linked state files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-tool-result-links-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "execution-records.json"); const store = new ToolResultStore({ filePath });
  store.appendSync(result());
  await link(filePath, join(directory, "hard-link.json"));
  assert.throws(() => store.appendSync(result()), /state file is invalid/u);
  const symbolicPath = join(directory, "symbolic-link.json"); await symlink(filePath, symbolicPath);
  assert.throws(() => new ToolResultStore({ filePath: symbolicPath }).appendSync(result()), /state file is invalid/u);
});

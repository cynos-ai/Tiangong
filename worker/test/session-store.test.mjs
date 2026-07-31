import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { sha256 } from "../agent/canonical-json.mjs";
import { statePathsForSession } from "../agent/persistence/state-paths.mjs";
import {
  assertSessionCapacity,
  PersistentSessionStore,
} from "../agent/session-store.mjs";

test("session capacity rejects new model turns before unbounded growth", () => {
  assert.deepEqual(assertSessionCapacity([], "hello", { maxEntries: 2, maxBytes: 100 }), {
    entries: 0,
    bytes: 7,
  });
  assert.throws(
    () => assertSessionCapacity([{}, {}], "hello", { maxEntries: 2, maxBytes: 100 }),
    /entry capacity reached/u,
  );
  assert.throws(
    () => assertSessionCapacity([], "too large", { maxEntries: 2, maxBytes: 5 }),
    /byte capacity reached/u,
  );
});

test("pi session transcript reopens and reset preserves an adjacent transcript", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-session-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDir = join(root, "workspace");
  const stateDirectory = join(root, "state");
  await mkdir(workspaceDir);

  let store = new PersistentSessionStore({ stateDirectory });
  const first = await store.open({ sessionId: "matrix-session", workspaceDir });
  first.manager.appendCustomEntry("tiangong-test", { persisted: true });
  first.manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "persisted" }],
    api: "openai-completions",
    provider: "agentteams-gateway",
    model: "model-one",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sessionFile = first.manager.getSessionFile();
  const adjacent = await store.open({ sessionId: "adjacent-session", workspaceDir });
  adjacent.manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "adjacent" }],
    api: "openai-completions",
    provider: "agentteams-gateway",
    model: "model-one",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const adjacentFile = adjacent.manager.getSessionFile();

  store = new PersistentSessionStore({ stateDirectory });
  const reopened = await store.open({ sessionId: "matrix-session", workspaceDir });
  assert.equal(reopened.manager.getSessionFile(), sessionFile);
  assert.deepEqual(
    reopened.manager.getEntries().find((entry) => entry.type === "custom")?.data,
    { persisted: true },
  );

  await store.reset("matrix-session");
  await assert.rejects(access(sessionFile), { code: "ENOENT" });
  await access(adjacentFile);
  const reset = await store.open({ sessionId: "matrix-session", workspaceDir });
  assert.equal(reset.manager.getEntries().length, 0);
});

test("transcript reset and session-root deletion cannot remove business state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-session-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDir = join(root, "workspace");
  const stateDirectory = join(root, "state");
  await mkdir(workspaceDir);
  const store = new PersistentSessionStore({ stateDirectory });
  const opened = await store.open({ sessionId: "matrix-session", workspaceDir });
  const expectedPaths = statePathsForSession({ stateDirectory, sessionId: "matrix-session" });
  assert.deepEqual(opened.paths, expectedPaths);

  const businessFiles = [
    join(expectedPaths.practiceRunDirectory, "events.jsonl"),
    expectedPaths.evidenceFilePath,
    expectedPaths.idempotencyFilePath,
    join(expectedPaths.pendingOperationDirectory, "pending-sentinel"),
    join(expectedPaths.rollbackDirectory, "rollback-sentinel"),
  ];
  for (const [index, filePath] of businessFiles.entries()) {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(filePath, `business-state-${index}\n`, { mode: 0o600 });
  }

  async function fingerprints() {
    return Promise.all(businessFiles.map(async (filePath) => {
      const entry = await lstat(filePath);
      return {
        filePath,
        identity: `${entry.dev}:${entry.ino}`,
        mode: entry.mode & 0o777,
        digest: sha256(await readFile(filePath)),
      };
    }));
  }

  const before = await fingerprints();
  await store.reset("matrix-session");
  assert.deepEqual(await fingerprints(), before);
  const reset = await store.open({ sessionId: "matrix-session", workspaceDir });
  assert.equal(reset.manager.getEntries().length, 0);

  await rm(expectedPaths.sessionDirectory, { recursive: true, force: true });
  assert.deepEqual(await fingerprints(), before);
  const rebuilt = await store.open({ sessionId: "matrix-session", workspaceDir });
  assert.equal(rebuilt.manager.getEntries().length, 0);
});

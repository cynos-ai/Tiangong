import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("concurrent opens reserve one durable pi session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-session-open-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDir = join(root, "workspace");
  const stateDirectory = join(root, "state");
  await mkdir(workspaceDir);

  const stores = [
    new PersistentSessionStore({ stateDirectory }),
    new PersistentSessionStore({ stateDirectory }),
  ];
  const opened = await Promise.all(stores.map((store) => store.open({
    sessionId: "matrix-session",
    workspaceDir,
  })));
  assert.equal(opened[0].manager.getSessionFile(), opened[1].manager.getSessionFile());
  const sameStore = await stores[0].open({ sessionId: "matrix-session", workspaceDir });
  assert.equal(sameStore.manager, opened[0].manager);
  const sessionFiles = (await readdir(dirname(opened[0].manager.getSessionFile())))
    .filter((name) => name.endsWith(".jsonl"));
  assert.equal(sessionFiles.length, 1);

  opened[0].manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "persisted" }],
    api: "openai-completions",
    provider: "agentteams-gateway",
    model: "model-one",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const reopened = await new PersistentSessionStore({ stateDirectory }).open({
    sessionId: "matrix-session",
    workspaceDir,
  });
  assert.equal(reopened.manager.getEntries().length, 1);
});

test("invalid transcript files fail closed instead of creating a replacement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-session-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDir = join(root, "workspace");
  const stateDirectory = join(root, "state");
  await mkdir(workspaceDir);
  const paths = statePathsForSession({ stateDirectory, sessionId: "matrix-session" });
  await mkdir(paths.piDirectory, { recursive: true, mode: 0o700 });

  const invalidFile = join(paths.piDirectory, "invalid.jsonl");
  await writeFile(invalidFile, "{not-json}\n", { mode: 0o600 });
  await assert.rejects(
    new PersistentSessionStore({ stateDirectory }).open({ sessionId: "matrix-session", workspaceDir }),
    /invalid JSONL/u,
  );
  await rm(invalidFile);

  const targetFile = join(root, "outside.jsonl");
  await writeFile(targetFile, "outside\n", { mode: 0o600 });
  await symlink(targetFile, join(paths.piDirectory, "linked.jsonl"));
  await assert.rejects(
    new PersistentSessionStore({ stateDirectory }).open({ sessionId: "matrix-session", workspaceDir }),
    /regular files/u,
  );
});

test("a persisted transcript cannot change its workspace binding", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-session-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDir = join(root, "workspace");
  const otherWorkspaceDir = join(root, "other-workspace");
  const stateDirectory = join(root, "state");
  await mkdir(workspaceDir);
  await mkdir(otherWorkspaceDir);
  const store = new PersistentSessionStore({ stateDirectory });
  await store.open({ sessionId: "matrix-session", workspaceDir });
  await assert.rejects(
    store.open({ sessionId: "matrix-session", workspaceDir: otherWorkspaceDir }),
    /workspace does not match/u,
  );
});

test("reset and open serialize without leaving a stale transcript manager", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-session-reset-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDir = join(root, "workspace");
  const stateDirectory = join(root, "state");
  await mkdir(workspaceDir);
  const store = new PersistentSessionStore({ stateDirectory });
  await store.open({ sessionId: "matrix-session", workspaceDir });

  await Promise.all([
    store.reset("matrix-session"),
    store.open({ sessionId: "matrix-session", workspaceDir }),
  ]);
  const reopened = await store.open({ sessionId: "matrix-session", workspaceDir });
  assert.equal(reopened.manager.getEntries().length, 0);
  const sessionFiles = (await readdir(dirname(reopened.manager.getSessionFile())))
    .filter((name) => name.endsWith(".jsonl"));
  assert.equal(sessionFiles.length, 1);
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
    join(expectedPaths.workRunDirectory, "run.binding.json"),
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

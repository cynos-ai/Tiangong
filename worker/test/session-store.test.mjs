import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PersistentSessionStore } from "../agent/session-store.mjs";

test("pi session transcript reopens from the Tiangong state directory", async (t) => {
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

  store = new PersistentSessionStore({ stateDirectory });
  const reopened = await store.open({ sessionId: "matrix-session", workspaceDir });
  assert.equal(reopened.manager.getSessionFile(), sessionFile);
  assert.deepEqual(
    reopened.manager.getEntries().find((entry) => entry.type === "custom")?.data,
    { persisted: true },
  );

  await store.reset("matrix-session");
  await assert.rejects(access(sessionFile), { code: "ENOENT" });
  const reset = await store.open({ sessionId: "matrix-session", workspaceDir });
  assert.equal(reset.manager.getEntries().length, 0);
});

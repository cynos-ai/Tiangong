import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { createAgentTeamsPendingStorage } from "../agent/pending-operation/agentteams-storage.mjs";

test("AgentTeams pending storage scopes remote erasure to the Worker workspace", async () => {
  const calls = [];
  const workspaceDir = "/root/hiclaw-fs/agents/worker-one";
  const operationDirectory = join(
    workspaceDir,
    ".tiangong/runtime/sessions/session-one/pending-operations/operation-one",
  );
  const storage = createAgentTeamsPendingStorage({
    workspaceDir,
    workerName: "worker-one",
    runCommand: async (script, args) => calls.push({ script, args }),
  });

  await storage.publishErasure({ operationDirectory });
  await storage.purge({ operationDirectory });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, [
    "worker-one",
    ".tiangong/runtime/sessions/session-one/pending-operations/operation-one",
    operationDirectory,
  ]);
  assert.equal(calls[0].script.includes("ensure_mc_credentials >/dev/null 2>&1 || true"), true);
  assert.equal(calls[0].script.includes("mc cp"), true);
  assert.equal(calls[1].script.includes("mc rm --recursive --force"), true);
  assert.equal(JSON.stringify(calls).includes("write content"), false);

  await assert.rejects(
    storage.publishErasure({ operationDirectory: "/root/hiclaw-fs/agents/other/operation" }),
    /escapes the Worker workspace/u,
  );
});

test("AgentTeams pending storage is unavailable without a validated Worker identity", () => {
  assert.equal(createAgentTeamsPendingStorage({ workspaceDir: "/workspace", workerName: "" }), undefined);
  assert.throws(
    () => createAgentTeamsPendingStorage({ workspaceDir: "/workspace", workerName: "../escape" }),
    /Invalid AgentTeams Worker identity/u,
  );
});

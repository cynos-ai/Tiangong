import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../agent/canonical-json.mjs";
import { createAgentTeamsPendingStorage } from "../agent/pending-operation/agentteams-storage.mjs";
import { statePathsForSession } from "../agent/persistence/state-paths.mjs";

test("AgentTeams pending storage scopes remote erasure to the Worker workspace", async () => {
  const calls = [];
  const workspaceDir = "/root/agentteams-fs/agents/worker-one";
  const stateDirectory = join(workspaceDir, ".tiangong", "runtime");
  const sessionId = "session-one";
  const operationKey = sha256("operation-one");
  const paths = statePathsForSession({ stateDirectory, sessionId });
  const operationDirectory = join(paths.pendingOperationDirectory, operationKey);
  const remotePath = `.tiangong/runtime/pending-operations/${paths.sessionHash}/${operationKey}`;
  const storage = createAgentTeamsPendingStorage({
    workspaceDir,
    workerName: "worker-one",
    runCommand: async (script, args) => calls.push({ script, args }),
  });

  await storage.publishErasure({ operationDirectory });
  await storage.purge({ operationDirectory });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["worker-one", remotePath, operationDirectory]);
  assert.equal(calls[0].script.includes("ensure_mc_credentials >/dev/null 2>&1 || true"), true);
  assert.equal(calls[0].script.includes("mc cp"), true);
  assert.equal(calls[1].script.includes("mc rm --recursive --force"), true);
  assert.equal(JSON.stringify(calls).includes("write content"), false);

  await assert.rejects(
    storage.publishErasure({ operationDirectory: "/root/agentteams-fs/agents/other/operation" }),
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

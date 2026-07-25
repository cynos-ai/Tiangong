import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { idempotencyKey, operationDigest, operationRequestDigest } from "../agent/canonical-json.mjs";
import { EvidenceRecorder } from "../agent/evidence/recorder.mjs";
import { IdempotencyStore } from "../agent/idempotency/store.mjs";
import { PendingOperationStore } from "../agent/pending-operation/store.mjs";
import { summarizeWrite } from "../agent/tools/operations.mjs";

const CLI_PATH = fileURLToPath(new URL("../agent/retention/cli.mjs", import.meta.url));

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function checkpoint(workspaceDir, suffix, content) {
  const params = { path: `output-${suffix}.txt`, content };
  const operation = await summarizeWrite(workspaceDir, params);
  const digest = operationDigest(operation);
  const value = {
    sessionId: "session-one",
    turnId: `turn-${suffix}`,
    toolCallId: `call-${suffix}`,
    toolName: "write",
    actorId: "@requester:example.test",
    requestDigest: operationRequestDigest(operation),
    operationDigest: digest,
    operation,
    approvalId: `approval-${digest.slice(0, 24)}`,
    requestedBy: "@requester:example.test",
  };
  value.idempotencyKey = idempotencyKey({
    sessionId: value.sessionId,
    turnId: value.turnId,
    toolCallId: value.toolCallId,
    operationDigest: digest,
  });
  return { value, params };
}

test("explicit retention compacts only terminal records beyond the 90-day replay window", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-retention-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDir = join(root, "workspace");
  const stateDirectory = join(workspaceDir, ".tiangong", "runtime");
  const sessionDirectory = join(stateDirectory, "sessions", "session-one");
  await mkdir(workspaceDir);

  const idempotencyStore = new IdempotencyStore({ filePath: join(sessionDirectory, "idempotency.jsonl") });
  const pendingOperationStore = new PendingOperationStore({
    directory: join(sessionDirectory, "pending-operations"),
  });
  const expired = await checkpoint(workspaceDir, "expired", "expired raw content\n");
  await pendingOperationStore.put(expired.value, expired.params);
  await idempotencyStore.putPending(expired.value.idempotencyKey, expired.value);
  await idempotencyStore.approve(expired.value.idempotencyKey, {
    operationDigest: expired.value.operationDigest,
    approvedBy: expired.value.requestedBy,
  });
  await idempotencyStore.beginExecution(expired.value.idempotencyKey, expired.value);
  await idempotencyStore.complete(expired.value.idempotencyKey, {
    operationDigest: expired.value.operationDigest,
    replayResult: { content: [], details: { replayed: true } },
    completedAt: "2020-01-01T00:00:00.000Z",
  });
  await pendingOperationStore.remove(expired.value.idempotencyKey);

  const active = await checkpoint(workspaceDir, "active", "active raw content\n");
  await pendingOperationStore.put(active.value, active.params);
  await idempotencyStore.putPending(active.value.idempotencyKey, active.value);

  const env = {
    TIANGONG_WORKSPACE_DIR: workspaceDir,
    TIANGONG_STATE_DIR: stateDirectory,
    AGENTTEAMS_WORKER_NAME: "",
  };
  const report = await runCli(["report"], env);
  assert.equal(report.code, 0, report.stderr);
  assert.equal(JSON.parse(report.stdout).eligible, 1);

  const compact = await runCli([
    "compact",
    "--actor",
    "local-operator",
    "--confirm",
    "expire-90-day-replay-window",
  ], env);
  assert.equal(compact.code, 0, compact.stderr);
  assert.equal(compact.stdout.includes(expired.params.content), false);
  assert.equal(JSON.parse(compact.stdout).compacted, 1);
  assert.equal(await idempotencyStore.get(expired.value.idempotencyKey), undefined);
  assert.equal((await idempotencyStore.get(active.value.idempotencyKey)).status, "pending");
  await assert.rejects(
    pendingOperationStore.load(expired.value.idempotencyKey, expired.value),
    { code: "ENOENT" },
  );
  assert.deepEqual((await new EvidenceRecorder({
    filePath: join(sessionDirectory, "evidence", "events.jsonl"),
  }).readAll()).map((entry) => entry.type), ["retention.idempotency.expired"]);
});

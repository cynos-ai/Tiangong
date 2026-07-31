import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { idempotencyKey, operationDigest, operationRequestDigest } from "../agent/canonical-json.mjs";
import { EvidenceRecorder } from "../agent/evidence/recorder.mjs";
import { IdempotencyStore } from "../agent/idempotency/store.mjs";
import { PendingOperationStore } from "../agent/pending-operation/store.mjs";
import { statePathsForSession } from "../agent/persistence/state-paths.mjs";
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

test("explicit retention uses only independent roots and compacts expired terminal records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-retention-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDir = join(root, "workspace");
  const stateDirectory = join(workspaceDir, ".tiangong", "runtime");
  const paths = statePathsForSession({ stateDirectory, sessionId: "session-one" });
  await mkdir(workspaceDir);
  const artifactSentinel = join(paths.capturedArtifactDirectory, "retention-must-ignore");
  await mkdir(paths.capturedArtifactDirectory, { recursive: true });
  await writeFile(artifactSentinel, "artifact root is independently retained\n");

  const idempotencyStore = new IdempotencyStore({ filePath: paths.idempotencyFilePath });
  const pendingOperationStore = new PendingOperationStore({
    directory: paths.pendingOperationDirectory,
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

  const legacyStore = new IdempotencyStore({
    filePath: join(paths.sessionDirectory, "idempotency.jsonl"),
  });
  const legacy = await checkpoint(workspaceDir, "legacy", "legacy raw content\n");
  await legacyStore.putPending(legacy.value.idempotencyKey, legacy.value);
  await legacyStore.approve(legacy.value.idempotencyKey, {
    operationDigest: legacy.value.operationDigest,
    approvedBy: legacy.value.requestedBy,
  });
  await legacyStore.beginExecution(legacy.value.idempotencyKey, legacy.value);
  await legacyStore.complete(legacy.value.idempotencyKey, {
    operationDigest: legacy.value.operationDigest,
    replayResult: { content: [], details: { replayed: true } },
    completedAt: "2020-01-01T00:00:00.000Z",
  });

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
  assert.equal((await legacyStore.get(legacy.value.idempotencyKey)).status, "completed");
  assert.equal(await readFile(artifactSentinel, "utf8"), "artifact root is independently retained\n");
  await assert.rejects(
    pendingOperationStore.load(expired.value.idempotencyKey, expired.value),
    { code: "ENOENT" },
  );
  assert.deepEqual((await new EvidenceRecorder({
    filePath: paths.evidenceFilePath,
  }).readAll()).map((entry) => entry.type), ["retention.idempotency.expired"]);
});

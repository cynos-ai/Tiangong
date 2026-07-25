import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  idempotencyKey,
  operationDigest,
  operationRequestDigest,
} from "../agent/canonical-json.mjs";
import { EvidenceRecorder } from "../agent/evidence/recorder.mjs";
import { IdempotencyStore } from "../agent/idempotency/store.mjs";
import { PendingOperationStore } from "../agent/pending-operation/store.mjs";
import { summarizeWrite } from "../agent/tools/operations.mjs";

const CLI_PATH = fileURLToPath(new URL("../agent/reconciliation/cli.mjs", import.meta.url));

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

test("operator CLI resolves a stale not-applied write without exposing its content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-reconcile-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDir = join(root, "workspace");
  const stateDirectory = join(workspaceDir, ".tiangong", "runtime");
  const sessionDirectory = join(stateDirectory, "sessions", "session-one");
  await mkdir(workspaceDir);

  const params = { path: "output.txt", content: "must not appear in CLI output\n" };
  const operation = await summarizeWrite(workspaceDir, params);
  const digest = operationDigest(operation);
  const checkpoint = {
    sessionId: "session-one",
    turnId: "turn-one",
    toolCallId: "call-one",
    toolName: "write",
    actorId: "@requester:example.test",
    requestDigest: operationRequestDigest(operation),
    operationDigest: digest,
    operation,
    approvalId: `approval-${digest.slice(0, 24)}`,
    requestedBy: "@requester:example.test",
  };
  checkpoint.idempotencyKey = idempotencyKey({
    sessionId: checkpoint.sessionId,
    turnId: checkpoint.turnId,
    toolCallId: checkpoint.toolCallId,
    operationDigest: digest,
  });

  const idempotencyStore = new IdempotencyStore({
    filePath: join(sessionDirectory, "idempotency.jsonl"),
  });
  const pendingOperationStore = new PendingOperationStore({
    directory: join(sessionDirectory, "pending-operations"),
  });
  await pendingOperationStore.put(checkpoint, params);
  await idempotencyStore.putPending(checkpoint.idempotencyKey, checkpoint);
  await idempotencyStore.approve(checkpoint.idempotencyKey, {
    operationDigest: digest,
    approvedBy: checkpoint.requestedBy,
  });
  await idempotencyStore.beginExecution(checkpoint.idempotencyKey, checkpoint);
  const residentEvidence = new EvidenceRecorder({
    filePath: join(sessionDirectory, "evidence", "events.jsonl"),
  });
  await residentEvidence.append({ type: "runtime.before_reconciliation" });

  const result = await runCli([
    "resolve",
    checkpoint.approvalId,
    "--actor",
    "local-operator",
    "--reason-code",
    "TEST_STALE_EXECUTION",
    "--minimum-age-seconds",
    "0",
  ], {
    TIANGONG_WORKSPACE_DIR: workspaceDir,
    TIANGONG_STATE_DIR: stateDirectory,
    AGENTTEAMS_WORKER_NAME: "",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(params.content), false);
  assert.deepEqual(JSON.parse(result.stdout), {
    idempotencyKey: checkpoint.idempotencyKey,
    resolution: "not_applied",
    status: "approved",
  });
  assert.equal((await idempotencyStore.get(checkpoint.idempotencyKey)).status, "approved");
  await residentEvidence.append({ type: "runtime.after_reconciliation" });
  const evidence = await residentEvidence.readAll();
  assert.deepEqual(evidence.map((entry) => entry.type), [
    "runtime.before_reconciliation",
    "operation.reconciliation.decided",
    "operation.reconciliation.state_updated",
    "runtime.after_reconciliation",
  ]);
  assert.deepEqual(evidence.map((entry) => entry.sequence), [1, 2, 3, 4]);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  idempotencyKey,
  operationDigest,
  operationRequestDigest,
} from "../agent/canonical-json.mjs";
import { EvidenceRecorder } from "../agent/evidence/recorder.mjs";
import { PolicyGate } from "../agent/gates/policy-gate.mjs";
import { IdempotencyStore } from "../agent/idempotency/store.mjs";
import { PendingOperationStore } from "../agent/pending-operation/store.mjs";
import { statePathsForSession } from "../agent/persistence/state-paths.mjs";
import { WriteReconciler } from "../agent/reconciliation/write-reconciler.mjs";
import { createConstrainedWrite } from "../agent/tools/constrained-write.mjs";
import { summarizeWrite } from "../agent/tools/operations.mjs";

async function fixture(t, { previousContent } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-reconcile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDir = join(root, "workspace");
  const stateDirectory = join(root, "state");
  const paths = statePathsForSession({ stateDirectory, sessionId: "session-one" });
  const rollbackDir = paths.rollbackDirectory;
  await mkdir(workspaceDir);
  const targetPath = join(workspaceDir, "output.txt");
  if (previousContent !== undefined) await writeFile(targetPath, previousContent);

  const params = { path: "output.txt", content: "approved content\n" };
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

  const idempotencyStore = new IdempotencyStore({ filePath: paths.idempotencyFilePath });
  const pendingOperationStore = new PendingOperationStore({
    directory: paths.pendingOperationDirectory,
  });
  const evidence = new EvidenceRecorder({ filePath: paths.evidenceFilePath });
  await pendingOperationStore.put(checkpoint, params);
  await idempotencyStore.putPending(checkpoint.idempotencyKey, checkpoint);
  await idempotencyStore.approve(checkpoint.idempotencyKey, {
    operationDigest: digest,
    approvedBy: checkpoint.requestedBy,
  });
  await idempotencyStore.beginExecution(checkpoint.idempotencyKey, checkpoint);
  const executing = await idempotencyStore.get(checkpoint.idempotencyKey);

  function reconciler(ageMilliseconds = 600_000) {
    return new WriteReconciler({
      workspaceDir,
      rollbackDir,
      idempotencyStore,
      pendingOperationStore,
      evidence,
      clock: () => new Date(Date.parse(executing.startedAt) + ageMilliseconds),
    });
  }

  return {
    workspaceDir,
    rollbackDir,
    targetPath,
    params,
    checkpoint,
    idempotencyStore,
    pendingOperationStore,
    evidence,
    executing,
    reconciler,
  };
}

const DECISION = {
  reconciledBy: "local-operator",
  reasonCode: "STALE_WORKER_EXECUTION",
};

test("stale execution with unchanged precondition becomes approved for explicit replay", async (t) => {
  const context = await fixture(t);
  const inspection = await context.reconciler().inspect(context.checkpoint.idempotencyKey);
  assert.equal(inspection.resolution, "not_applied");
  assert.equal(inspection.snapshotState, "absent");

  const result = await context.reconciler().resolve(context.checkpoint.idempotencyKey, DECISION);
  assert.equal(result.entry.status, "approved");
  const gate = new PolicyGate({ idempotencyStore: context.idempotencyStore });
  assert.equal((await gate.evaluate({
    operation: context.checkpoint.operation,
    operationDigest: context.checkpoint.operationDigest,
    idempotencyKey: context.checkpoint.idempotencyKey,
    actorId: context.checkpoint.requestedBy,
  })).kind, "allow");
  assert.deepEqual((await context.evidence.readAll()).map((entry) => entry.type), [
    "operation.reconciliation.decided",
    "operation.reconciliation.state_updated",
  ]);
});

test("stale execution with desired content present becomes completed without re-execution", async (t) => {
  const context = await fixture(t, { previousContent: "previous content\n" });
  const constrained = createConstrainedWrite({
    workspaceDir: context.workspaceDir,
    rollbackDir: context.rollbackDir,
  });
  await constrained.lifecycle.prepare({
    idempotencyKey: context.checkpoint.idempotencyKey,
    operation: context.checkpoint.operation,
  });
  await writeFile(context.targetPath, context.params.content);

  const result = await context.reconciler().resolve(context.checkpoint.idempotencyKey, DECISION);
  assert.equal(result.inspection.resolution, "applied");
  assert.equal(result.inspection.snapshotState, "valid");
  assert.equal(result.entry.status, "completed");
  assert.equal(result.entry.replayResult.details.reconciled, true);
  await assert.rejects(
    context.pendingOperationStore.load(context.checkpoint.idempotencyKey, result.entry),
    /payload has been erased/u,
  );
  await assert.rejects(
    readFile(join(context.rollbackDir, context.checkpoint.idempotencyKey, "metadata.json")),
    { code: "ENOENT" },
  );
  const replay = await context.idempotencyStore.beginExecution(
    context.checkpoint.idempotencyKey,
    context.checkpoint,
  );
  assert.equal(replay.execute, false);
  assert.equal(replay.entry.status, "completed");
  assert.equal(await readFile(context.targetPath, "utf8"), context.params.content);
});

test("unexpected target state records conflict and remains fail-closed", async (t) => {
  const context = await fixture(t);
  await writeFile(context.targetPath, "unexpected content\n");

  const result = await context.reconciler().resolve(context.checkpoint.idempotencyKey, DECISION);
  assert.equal(result.inspection.resolution, "conflict");
  assert.equal(result.entry.status, "executing");
  assert.equal(result.entry.reconciliations.at(-1).resolution, "conflict");
  const gate = new PolicyGate({ idempotencyStore: context.idempotencyStore });
  const decision = await gate.evaluate({
    operation: context.checkpoint.operation,
    operationDigest: context.checkpoint.operationDigest,
    idempotencyKey: context.checkpoint.idempotencyKey,
    actorId: context.checkpoint.requestedBy,
  });
  assert.equal(decision.kind, "deny");
  assert.equal(decision.reasonCode, "EXECUTION_UNCERTAIN");
});

test("recent executing operations cannot be reconciled", async (t) => {
  const context = await fixture(t);
  await assert.rejects(
    context.reconciler(1_000).resolve(context.checkpoint.idempotencyKey, DECISION),
    /not stale enough/u,
  );
  assert.equal((await context.idempotencyStore.get(context.checkpoint.idempotencyKey)).status, "executing");
  assert.deepEqual(await context.evidence.readAll(), []);
});

test("invalid operator attribution is rejected before Evidence or state mutation", async (t) => {
  const context = await fixture(t);
  await assert.rejects(
    context.reconciler().resolve(context.checkpoint.idempotencyKey, {
      reconciledBy: "operator\nspoofed",
      reasonCode: "STALE_WORKER_EXECUTION",
    }),
    /bounded operator identifier/u,
  );
  assert.equal((await context.idempotencyStore.get(context.checkpoint.idempotencyKey)).status, "executing");
  assert.deepEqual(await context.evidence.readAll(), []);
});

test("known failed operation with restored precondition can return to approved", async (t) => {
  const context = await fixture(t, { previousContent: "previous content\n" });
  await context.idempotencyStore.fail(context.checkpoint.idempotencyKey, {
    operationDigest: context.checkpoint.operationDigest,
    errorCode: "TOOL_EXECUTION_FAILED",
  });

  const result = await context.reconciler().resolve(context.checkpoint.idempotencyKey, {
    ...DECISION,
    minimumAgeMilliseconds: 0,
  });
  assert.equal(result.inspection.status, "failed");
  assert.equal(result.inspection.resolution, "not_applied");
  assert.equal(result.entry.status, "approved");
  assert.equal(result.entry.reconciliations.at(-1).fromErrorCode, "TOOL_EXECUTION_FAILED");
});

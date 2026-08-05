import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  idempotencyKey,
  operationDigest,
  operationRequestDigest,
  sha256,
} from "../agent/canonical-json.mjs";
import { PendingOperationStore } from "../agent/pending-operation/store.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-pending-operation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory: join(root, "pending-operations") };
}

function pendingWrite(content = "approved content\n") {
  const operation = {
    policyVersion: "workspace-tools-v1",
    workspaceScope: "a".repeat(64),
    toolName: "write",
    target: "output.txt",
    input: {
      contentDigest: sha256(content),
      contentBytes: Buffer.byteLength(content),
    },
    precondition: { existed: false, previousDigest: null, previousBytes: 0 },
  };
  const digest = operationDigest(operation);
  const checkpoint = {
    sessionId: "session-one",
    turnId: "turn-one",
    toolCallId: "call-one",
    toolName: "write",
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
  return { checkpoint, params: { path: "./output.txt", content } };
}

function pendingRelease() {
  const operation = {
    toolName: "deploy_release",
    contractVersion: "deployment-operation-v1",
    taskId: "professional-release-0",
    projectId: "professional-release",
    revisionIndex: 0,
    targetId: "deployment-target",
    previousDigest: "a".repeat(64),
    rollbackDigest: "a".repeat(64),
    changeRevisionRef: {
      kind: "tiangong.change-revision",
      schemaVersion: 1,
      projectId: "professional-release",
      taskId: "professional-implement-0",
      producerTaskId: "professional-implement-0",
      revision: 0,
      artifactDigest: "b".repeat(64),
      contentDigest: "c".repeat(64),
    },
    approvalPolicy: { type: "explicit_subject" },
  };
  const digest = operationDigest(operation);
  const checkpoint = {
    sessionId: "operator-room-session",
    turnId: "turn-release",
    toolCallId: "call-release",
    toolName: "deploy_release",
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
  return { checkpoint, params: { taskId: operation.taskId } };
}

function mode(path) {
  return stat(path).then((entry) => entry.mode & 0o777);
}

test("pending write envelope and protected payload survive store restart", async (t) => {
  const paths = await fixture(t);
  const pending = pendingWrite("sensitive write content α\n");
  let store = new PendingOperationStore({
    directory: paths.directory,
    clock: () => new Date("2026-07-25T10:00:00.000Z"),
  });

  const envelope = await store.put(pending.checkpoint, pending.params);
  const operationDirectory = join(paths.directory, pending.checkpoint.idempotencyKey);
  const envelopePath = join(operationDirectory, "envelope.json");
  const payloadPath = join(operationDirectory, "write-content");
  const envelopeText = await readFile(envelopePath, "utf8");

  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.createdAt, "2026-07-25T10:00:00.000Z");
  assert.equal(envelopeText.includes(pending.params.content), false);
  assert.equal(await mode(operationDirectory), 0o700);
  assert.equal(await mode(envelopePath), 0o600);
  assert.equal(await mode(payloadPath), 0o600);

  store = new PendingOperationStore({ directory: paths.directory });
  const recovered = await store.load(pending.checkpoint.idempotencyKey, pending.checkpoint);
  assert.deepEqual(recovered.arguments, {
    path: "output.txt",
    content: pending.params.content,
  });

  const duplicate = await store.put(pending.checkpoint, pending.params);
  assert.equal(duplicate.createdAt, envelope.createdAt);

  await store.remove(pending.checkpoint.idempotencyKey);
  await assert.rejects(
    store.load(pending.checkpoint.idempotencyKey, pending.checkpoint),
    /payload has been erased/u,
  );
  assert.equal(await readFile(payloadPath, "utf8"), "");
  assert.equal(JSON.parse(await readFile(join(operationDirectory, "terminal.json"), "utf8")).state, "payload-erased");
  await store.remove(pending.checkpoint.idempotencyKey);
  assert.equal(await readFile(payloadPath, "utf8"), "");
});

test("pending deployment arguments survive restart without using the protected write payload path", async (t) => {
  const paths = await fixture(t);
  const pending = pendingRelease();
  const store = new PendingOperationStore({ directory: paths.directory });
  const envelope = await store.put(pending.checkpoint, pending.params);
  const operationDirectory = join(paths.directory, pending.checkpoint.idempotencyKey);
  const argumentsPath = join(operationDirectory, "arguments.json");
  assert.equal(envelope.payload.kind, "structured-arguments-v1");
  assert.equal(await readFile(argumentsPath, "utf8"), JSON.stringify(pending.params));
  assert.equal(await mode(argumentsPath), 0o600);
  assert.deepEqual((await store.load(pending.checkpoint.idempotencyKey, pending.checkpoint)).arguments, pending.params);

  await writeFile(argumentsPath, JSON.stringify({ taskId: "other-task" }));
  await assert.rejects(
    store.load(pending.checkpoint.idempotencyKey, pending.checkpoint),
    /payload integrity check failed/u,
  );
  await writeFile(argumentsPath, JSON.stringify(pending.params));
  await store.remove(pending.checkpoint.idempotencyKey);
  assert.equal(await readFile(argumentsPath, "utf8"), "");
  assert.equal(JSON.parse(await readFile(join(operationDirectory, "terminal.json"), "utf8")).state, "payload-erased");
});

test("pending write payload tampering is rejected", async (t) => {
  const paths = await fixture(t);
  const pending = pendingWrite();
  const store = new PendingOperationStore({ directory: paths.directory });
  await store.put(pending.checkpoint, pending.params);
  await writeFile(
    join(paths.directory, pending.checkpoint.idempotencyKey, "write-content"),
    "tampered content\n",
  );

  await assert.rejects(
    store.load(pending.checkpoint.idempotencyKey, pending.checkpoint),
    /payload integrity check failed/u,
  );

  const payloadPath = join(paths.directory, pending.checkpoint.idempotencyKey, "write-content");
  await writeFile(payloadPath, pending.params.content);
  await chmod(payloadPath, 0o644);
  const repaired = await store.load(pending.checkpoint.idempotencyKey, pending.checkpoint);
  assert.equal(repaired.permissionsRepaired, true);
  assert.equal(await mode(payloadPath), 0o600);
});

test("pending operation identity and payload must match the approved operation", async (t) => {
  const paths = await fixture(t);
  const pending = pendingWrite();
  const store = new PendingOperationStore({ directory: paths.directory });

  await assert.rejects(
    store.put(pending.checkpoint, { ...pending.params, content: "different" }),
    /does not match the approved operation/u,
  );
  await assert.rejects(
    store.put({ ...pending.checkpoint, operationDigest: "0".repeat(64) }, pending.params),
    /operation digest mismatch/u,
  );
  await store.put(pending.checkpoint, pending.params);
  await assert.rejects(
    store.load(pending.checkpoint.idempotencyKey, {
      ...pending.checkpoint,
      requestedBy: "@other:example.test",
    }),
    /requestedBy mismatch/u,
  );
  await assert.rejects(
    store.load("../escape", pending.checkpoint),
    /lowercase SHA-256 digest/u,
  );
});

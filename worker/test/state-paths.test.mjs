import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import { sha256 } from "../agent/canonical-json.mjs";
import {
  statePathsForSession,
  statePathsForSessionHash,
  stateRootPaths,
  workerStatePaths,
  WORKER_SCOPE_SESSION_HASH,
} from "../agent/persistence/state-paths.mjs";

test("state path resolver keeps transcript, WorkRun, and side-effect roots separate", () => {
  const stateDirectory = resolve("fixture-state-root");
  const sessionId = "matrix-session";
  const sessionHash = sha256(sessionId);
  const roots = stateRootPaths(stateDirectory);
  const paths = statePathsForSession({ stateDirectory, sessionId });

  assert.equal(Object.isFrozen(roots), true);
  assert.deepEqual(roots, {
    stateDirectory,
    sessionsRoot: join(stateDirectory, "sessions"),
    workRunsRoot: join(stateDirectory, "work-runs"),
    evidenceRoot: join(stateDirectory, "evidence"),
    idempotencyRoot: join(stateDirectory, "idempotency"),
    runnerJournalsRoot: join(stateDirectory, "runner-journals"),
    deploymentReceiptsRoot: join(stateDirectory, "deployment-receipts"),
    pendingOperationsRoot: join(stateDirectory, "pending-operations"),
    rollbacksRoot: join(stateDirectory, "rollbacks"),
  });
  assert.equal(Object.isFrozen(paths), true);
  assert.equal(paths.sessionHash, sessionHash);
  assert.equal(paths.sessionDirectory, join(stateDirectory, "sessions", sessionHash));
  assert.equal(paths.workRunDirectory, join(stateDirectory, "work-runs", sessionHash));
  assert.equal(paths.evidenceFilePath, join(stateDirectory, "evidence", sessionHash, "events.jsonl"));
  assert.equal(paths.idempotencyFilePath, join(stateDirectory, "idempotency", sessionHash, "idempotency.jsonl"));
  assert.equal(paths.runnerJournalFilePath, join(stateDirectory, "runner-journals", sessionHash, "runner.jsonl"));
  assert.equal(paths.deploymentReceiptFilePath, join(stateDirectory, "deployment-receipts", sessionHash, "deployments.jsonl"));
  assert.equal(paths.pendingOperationDirectory, join(stateDirectory, "pending-operations", sessionHash));
  assert.equal(paths.rollbackDirectory, join(stateDirectory, "rollbacks", sessionHash));
  assert.deepEqual(statePathsForSessionHash({ stateDirectory, sessionHash }), paths);
});

test("worker-scoped approval paths are stable and separate from Matrix sessions", () => {
  const stateDirectory = resolve("fixture-state-root");
  const worker = workerStatePaths(stateDirectory);
  const session = statePathsForSession({ stateDirectory, sessionId: "matrix-session" });
  assert.equal(worker.sessionHash, WORKER_SCOPE_SESSION_HASH);
  assert.equal(worker.idempotencyFilePath, join(stateDirectory, "idempotency", WORKER_SCOPE_SESSION_HASH, "idempotency.jsonl"));
  assert.equal(worker.pendingOperationDirectory, join(stateDirectory, "pending-operations", WORKER_SCOPE_SESSION_HASH));
  assert.notEqual(worker.idempotencyFilePath, session.idempotencyFilePath);
});

test("state path resolver rejects untrusted or ambiguous identities", () => {
  assert.throws(() => stateRootPaths(""), /stateDirectory is required/u);
  assert.throws(() => statePathsForSession({ stateDirectory: "/state", sessionId: "" }), /sessionId is required/u);
  for (const sessionHash of ["session-one", "../escape", "A".repeat(64), "a".repeat(63)]) {
    assert.throws(
      () => statePathsForSessionHash({ stateDirectory: "/state", sessionHash }),
      /lowercase SHA-256 digest/u,
    );
  }
});

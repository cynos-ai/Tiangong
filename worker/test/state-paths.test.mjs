import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import { sha256 } from "../agent/canonical-json.mjs";
import {
  statePathsForSession,
  statePathsForSessionHash,
  stateRootPaths,
} from "../agent/persistence/state-paths.mjs";

test("state path resolver produces physically separate per-session roots", () => {
  const stateDirectory = resolve("fixture-state-root");
  const sessionId = "matrix-session";
  const sessionHash = sha256(sessionId);
  const roots = stateRootPaths(stateDirectory);
  const paths = statePathsForSession({ stateDirectory, sessionId });

  assert.equal(Object.isFrozen(roots), true);
  assert.deepEqual(roots, {
    stateDirectory,
    sessionsRoot: join(stateDirectory, "sessions"),
    practiceRunsRoot: join(stateDirectory, "practice-runs"),
    evidenceRoot: join(stateDirectory, "evidence"),
    idempotencyRoot: join(stateDirectory, "idempotency"),
    pendingOperationsRoot: join(stateDirectory, "pending-operations"),
    rollbacksRoot: join(stateDirectory, "rollbacks"),
  });
  assert.equal(Object.isFrozen(paths), true);
  assert.equal(paths.sessionHash, sessionHash);
  assert.equal(paths.sessionDirectory, join(stateDirectory, "sessions", sessionHash));
  assert.equal(paths.piDirectory, join(stateDirectory, "sessions", sessionHash, "pi"));
  assert.equal(paths.practiceRunDirectory, join(stateDirectory, "practice-runs", sessionHash));
  assert.equal(
    paths.practiceRunJournalPath,
    join(stateDirectory, "practice-runs", sessionHash, "events.jsonl"),
  );
  assert.equal(
    paths.practiceRunSnapshotPath,
    join(stateDirectory, "practice-runs", sessionHash, "snapshot.json"),
  );
  assert.equal(
    paths.practiceRunProtectedDirectory,
    join(stateDirectory, "practice-runs", sessionHash, "protected"),
  );
  assert.equal(paths.evidenceFilePath, join(stateDirectory, "evidence", sessionHash, "events.jsonl"));
  assert.equal(
    paths.idempotencyFilePath,
    join(stateDirectory, "idempotency", sessionHash, "idempotency.jsonl"),
  );
  assert.equal(
    paths.pendingOperationDirectory,
    join(stateDirectory, "pending-operations", sessionHash),
  );
  assert.equal(paths.rollbackDirectory, join(stateDirectory, "rollbacks", sessionHash));
  assert.deepEqual(
    statePathsForSessionHash({ stateDirectory, sessionHash }),
    paths,
  );
});

test("state path resolver rejects untrusted or ambiguous identities", () => {
  assert.throws(() => stateRootPaths(""), /stateDirectory is required/u);
  assert.throws(
    () => statePathsForSession({ stateDirectory: "/state", sessionId: "" }),
    /sessionId is required/u,
  );
  for (const sessionHash of ["session-one", "../escape", "A".repeat(64), "a".repeat(63)]) {
    assert.throws(
      () => statePathsForSessionHash({ stateDirectory: "/state", sessionHash }),
      /lowercase SHA-256 digest/u,
    );
  }
});

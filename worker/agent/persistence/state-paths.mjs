import { join, resolve } from "node:path";

import { sha256 } from "../canonical-json.mjs";

const SESSION_HASH_PATTERN = /^[a-f0-9]{64}$/u;

function requiredString(value, name) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} is required`);
  return value;
}

export function stateRootPaths(stateDirectory) {
  const root = resolve(requiredString(stateDirectory, "stateDirectory"));
  return Object.freeze({
    stateDirectory: root,
    sessionsRoot: join(root, "sessions"),
    practiceRunsRoot: join(root, "practice-runs"),
    evidenceRoot: join(root, "evidence"),
    capturedArtifactsRoot: join(root, "captured-artifacts"),
    idempotencyRoot: join(root, "idempotency"),
    pendingOperationsRoot: join(root, "pending-operations"),
    rollbacksRoot: join(root, "rollbacks"),
  });
}

export function statePathsForSessionHash({ stateDirectory, sessionHash }) {
  if (typeof sessionHash !== "string" || !SESSION_HASH_PATTERN.test(sessionHash)) {
    throw new TypeError("sessionHash must be a lowercase SHA-256 digest");
  }
  const roots = stateRootPaths(stateDirectory);
  const sessionDirectory = join(roots.sessionsRoot, sessionHash);
  const practiceRunDirectory = join(roots.practiceRunsRoot, sessionHash);
  const evidenceDirectory = join(roots.evidenceRoot, sessionHash);
  const capturedArtifactDirectory = join(roots.capturedArtifactsRoot, sessionHash);
  const idempotencyDirectory = join(roots.idempotencyRoot, sessionHash);
  return Object.freeze({
    ...roots,
    sessionHash,
    sessionDirectory,
    piDirectory: join(sessionDirectory, "pi"),
    practiceRunDirectory,
    practiceRunJournalPath: join(practiceRunDirectory, "events.jsonl"),
    practiceRunSnapshotPath: join(practiceRunDirectory, "snapshot.json"),
    practiceRunProtectedDirectory: join(practiceRunDirectory, "protected"),
    evidenceDirectory,
    evidenceFilePath: join(evidenceDirectory, "events.jsonl"),
    capturedArtifactDirectory,
    capturedArtifactObjectsDirectory: join(capturedArtifactDirectory, "objects"),
    capturedArtifactTemporaryDirectory: join(capturedArtifactDirectory, "tmp"),
    capturedArtifactLockPath: join(capturedArtifactDirectory, "store-lock-target"),
    idempotencyDirectory,
    idempotencyFilePath: join(idempotencyDirectory, "idempotency.jsonl"),
    pendingOperationDirectory: join(roots.pendingOperationsRoot, sessionHash),
    rollbackDirectory: join(roots.rollbacksRoot, sessionHash),
  });
}

export function statePathsForSession({ stateDirectory, sessionId }) {
  return statePathsForSessionHash({
    stateDirectory,
    sessionHash: sha256(requiredString(sessionId, "sessionId")),
  });
}

import { join, resolve } from "node:path";

import { sha256 } from "../canonical-json.mjs";

const SESSION_HASH_PATTERN = /^[a-f0-9]{64}$/u;
export const WORKER_SCOPE_SESSION_HASH = sha256("tiangong.worker.scope.v1");

function requiredString(value, name) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} is required`);
  return value;
}

export function stateRootPaths(stateDirectory) {
  const root = resolve(requiredString(stateDirectory, "stateDirectory"));
  return Object.freeze({
    stateDirectory: root,
    sessionsRoot: join(root, "sessions"),
    workRunsRoot: join(root, "work-runs"),
    evidenceRoot: join(root, "evidence"),
    idempotencyRoot: join(root, "idempotency"),
    runnerJournalsRoot: join(root, "runner-journals"),
    deploymentReceiptsRoot: join(root, "deployment-receipts"),
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
  const workRunDirectory = join(roots.workRunsRoot, sessionHash);
  const evidenceDirectory = join(roots.evidenceRoot, sessionHash);
  const idempotencyDirectory = join(roots.idempotencyRoot, sessionHash);
  return Object.freeze({
    ...roots,
    sessionHash,
    sessionDirectory,
    piDirectory: join(sessionDirectory, "pi"),
    workRunDirectory,
    evidenceDirectory,
    evidenceFilePath: join(evidenceDirectory, "events.jsonl"),
    idempotencyDirectory,
    idempotencyFilePath: join(idempotencyDirectory, "idempotency.jsonl"),
    runnerJournalFilePath: join(roots.runnerJournalsRoot, sessionHash, "runner.jsonl"),
    deploymentReceiptFilePath: join(roots.deploymentReceiptsRoot, sessionHash, "deployments.jsonl"),
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

// Approval, idempotency, pending-operation, and deployment-receipt state is
// Worker-scoped rather than Matrix-session-scoped. A requester approval can
// arrive in a different authenticated Matrix room/session than the Worker
// turn that created the pending operation; using this fixed, non-input-shaped
// hash keeps that durable boundary shared without trusting a session supplied
// by the requester.
export function workerStatePaths(stateDirectory) {
  return statePathsForSessionHash({
    stateDirectory,
    sessionHash: WORKER_SCOPE_SESSION_HASH,
  });
}

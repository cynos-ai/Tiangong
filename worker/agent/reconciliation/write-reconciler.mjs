import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { sha256 } from "../canonical-json.mjs";
import { resolveWorkspacePath } from "../tools/operations.mjs";

const OPERATOR_ID_PATTERN = /^[A-Za-z0-9@._:+-]{1,128}$/u;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;

function sameFileState(observation, expected) {
  if (observation.existed !== expected?.existed) return false;
  if (!observation.existed) return true;
  return observation.digest === expected.previousDigest && observation.bytes === expected.previousBytes;
}

async function observeTarget(path) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) throw new Error("Reconciliation target is not a regular file");
    const content = await readFile(path);
    return { existed: true, digest: sha256(content), bytes: content.byteLength };
  } catch (error) {
    if (error?.code === "ENOENT") return { existed: false, digest: null, bytes: 0 };
    throw error;
  }
}

async function observeSnapshot(directory, precondition) {
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || (entry.mode & 0o077) !== 0) return "invalid";
  } catch (error) {
    if (error?.code === "ENOENT") return "absent";
    throw error;
  }

  let metadata;
  try {
    const metadataPath = join(directory, "metadata.json");
    const metadataEntry = await lstat(metadataPath);
    if (!metadataEntry.isFile() || (metadataEntry.mode & 0o077) !== 0) return "invalid";
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return "invalid";
    throw error;
  }
  if (typeof metadata?.existed !== "boolean" || metadata.existed !== precondition?.existed) {
    return "invalid";
  }

  const previousPath = join(directory, "previous-content");
  if (!metadata.existed) {
    try {
      await lstat(previousPath);
      return "invalid";
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return "valid";
    }
  }

  try {
    const previousEntry = await lstat(previousPath);
    if (!previousEntry.isFile() || (previousEntry.mode & 0o077) !== 0) return "invalid";
    const previous = await readFile(previousPath);
    return sha256(previous) === precondition.previousDigest &&
      previous.byteLength === precondition.previousBytes
      ? "valid"
      : "invalid";
  } catch (error) {
    if (error?.code === "ENOENT") return "invalid";
    throw error;
  }
}

function reconciliationResolution(entry, target, snapshotState) {
  if (snapshotState === "invalid") return "conflict";
  const intended = entry.operation.input;
  if (target.existed && target.digest === intended.contentDigest && target.bytes === intended.contentBytes) {
    return "applied";
  }
  if (sameFileState(target, entry.operation.precondition)) return "not_applied";
  return "conflict";
}

function replayResult(target) {
  return {
    content: [{
      type: "text",
      text: `Write outcome reconciled for ${target}; the approved content is present.`,
    }],
    details: { replayed: true, reconciled: true },
  };
}

export class WriteReconciler {
  #workspaceDir;
  #rollbackDir;
  #idempotencyStore;
  #pendingOperationStore;
  #evidence;
  #clock;

  constructor({
    workspaceDir,
    rollbackDir,
    idempotencyStore,
    pendingOperationStore,
    evidence,
    clock = () => new Date(),
  }) {
    if (!workspaceDir || !rollbackDir || !idempotencyStore || !pendingOperationStore || !evidence) {
      throw new TypeError("WriteReconciler requires workspace, stores, rollback directory, and Evidence");
    }
    this.#workspaceDir = workspaceDir;
    this.#rollbackDir = rollbackDir;
    this.#idempotencyStore = idempotencyStore;
    this.#pendingOperationStore = pendingOperationStore;
    this.#evidence = evidence;
    this.#clock = clock;
  }

  async inspect(key) {
    const entry = await this.#idempotencyStore.get(key);
    if (!entry) throw new Error("Operation not found");
    if (!["executing", "failed"].includes(entry.status)) {
      throw new Error("Operation is not eligible for reconciliation");
    }
    if (entry.toolName !== "write" || entry.operation?.toolName !== "write") {
      throw new Error("Only constrained writes can be reconciled");
    }

    await this.#pendingOperationStore.load(key, entry);
    const target = await resolveWorkspacePath(this.#workspaceDir, entry.operation.target);
    if (target.workspaceScope !== entry.operation.workspaceScope) {
      throw new Error("Reconciliation workspace scope mismatch");
    }
    const targetObservation = await observeTarget(target.absolutePath);
    const snapshotState = await observeSnapshot(join(this.#rollbackDir, key), entry.operation.precondition);
    const now = this.#clock();
    if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("Reconciliation clock is invalid");
    const startedAt = Date.parse(entry.startedAt ?? entry.failedAt ?? "");
    const ageMilliseconds = Number.isFinite(startedAt) ? Math.max(0, now.valueOf() - startedAt) : null;

    return {
      idempotencyKey: key,
      status: entry.status,
      operationDigest: entry.operationDigest,
      approvalId: entry.approvalId,
      target: entry.operation.target,
      intendedDigest: entry.operation.input.contentDigest,
      targetObservation,
      snapshotState,
      resolution: reconciliationResolution(entry, targetObservation, snapshotState),
      ageMilliseconds,
    };
  }

  async resolve(key, {
    reconciledBy,
    reasonCode,
    minimumAgeMilliseconds = 300_000,
  }) {
    if (typeof reconciledBy !== "string" || !OPERATOR_ID_PATTERN.test(reconciledBy)) {
      throw new TypeError("reconciledBy must be a bounded operator identifier");
    }
    if (typeof reasonCode !== "string" || !REASON_CODE_PATTERN.test(reasonCode)) {
      throw new TypeError("reasonCode must be a stable uppercase identifier");
    }
    if (!Number.isSafeInteger(minimumAgeMilliseconds) || minimumAgeMilliseconds < 0) {
      throw new TypeError("minimumAgeMilliseconds must be a non-negative integer");
    }
    const inspection = await this.inspect(key);
    if (inspection.status === "executing" &&
        (inspection.ageMilliseconds === null || inspection.ageMilliseconds < minimumAgeMilliseconds)) {
      throw new Error("Executing operation is not stale enough for reconciliation");
    }
    const observation = {
      targetExisted: inspection.targetObservation.existed,
      targetDigest: inspection.targetObservation.digest,
      targetBytes: inspection.targetObservation.bytes,
      snapshotState: inspection.snapshotState,
    };
    await this.#evidence.append({
      type: "operation.reconciliation.decided",
      idempotencyKey: key,
      operationDigest: inspection.operationDigest,
      approvalId: inspection.approvalId,
      actorId: reconciledBy,
      reasonCode,
      fromStatus: inspection.status,
      resolution: inspection.resolution,
      observation,
    });
    if (inspection.resolution !== "conflict") {
      await rm(join(this.#rollbackDir, key), { recursive: true, force: true });
    }
    const updated = await this.#idempotencyStore.reconcile(key, {
      operationDigest: inspection.operationDigest,
      resolution: inspection.resolution,
      reconciledBy,
      reasonCode,
      observation,
      replayResult: inspection.resolution === "applied" ? replayResult(inspection.target) : undefined,
    });
    await this.#evidence.append({
      type: "operation.reconciliation.state_updated",
      idempotencyKey: key,
      operationDigest: inspection.operationDigest,
      approvalId: inspection.approvalId,
      actorId: reconciledBy,
      resolution: inspection.resolution,
      status: updated.status,
    });
    return { inspection, entry: updated };
  }
}

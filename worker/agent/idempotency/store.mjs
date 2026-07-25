import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson } from "../canonical-json.mjs";
import { withFileLock } from "../persistence/file-lock.mjs";

const EMPTY_STATE = Object.freeze({ version: 1, entries: {} });
const RECONCILIATION_RESOLUTIONS = new Set(["applied", "not_applied", "conflict"]);
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;

function requiredString(value, name) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} is required`);
  return value;
}

function normalizeReconciliationObservation(observation) {
  if (typeof observation?.targetExisted !== "boolean" ||
      !Number.isSafeInteger(observation.targetBytes) || observation.targetBytes < 0 ||
      !["absent", "valid", "invalid"].includes(observation.snapshotState)) {
    throw new TypeError("Invalid reconciliation observation");
  }
  const targetDigest = observation.targetDigest;
  if (observation.targetExisted !== (typeof targetDigest === "string" && targetDigest !== "")) {
    throw new TypeError("Reconciliation target digest does not match existence");
  }
  return {
    targetExisted: observation.targetExisted,
    targetDigest: targetDigest ?? null,
    targetBytes: observation.targetBytes,
    snapshotState: observation.snapshotState,
  };
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class IdempotencyStore {
  #filePath;
  #state;
  #queue = Promise.resolve();

  constructor({ filePath }) {
    if (!filePath) throw new TypeError("filePath is required");
    this.#filePath = filePath;
  }

  async #reload() {
    try {
      const parsed = JSON.parse(await readFile(this.#filePath, "utf8"));
      if (parsed?.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
        throw new Error("Unsupported idempotency state");
      }
      this.#state = parsed;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#state = structuredClone(EMPTY_STATE);
    }
  }

  async #persist() {
    const directory = dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${canonicalJson(this.#state)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.#filePath);
      await syncDirectory(directory);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async #mutate(callback) {
    const operation = this.#queue.then(() => withFileLock(this.#filePath, async () => {
      await this.#reload();
      const result = callback(this.#state.entries);
      await this.#persist();
      return result;
    }));
    this.#queue = operation.catch(() => {});
    return operation;
  }

  async get(key) {
    await this.#queue;
    await this.#reload();
    return this.#state.entries[key] ? structuredClone(this.#state.entries[key]) : undefined;
  }

  async findInvocation({ sessionId, turnId, toolCallId }) {
    await this.#queue;
    await this.#reload();
    const matches = Object.entries(this.#state.entries).filter(([, entry]) =>
      entry.sessionId === sessionId && entry.turnId === turnId && entry.toolCallId === toolCallId);
    if (matches.length > 1) throw new Error("Multiple idempotency records exist for one tool invocation");
    if (matches.length === 0) return undefined;
    const [key, entry] = matches[0];
    return { key, entry: structuredClone(entry) };
  }

  async findApproval(approvalId) {
    await this.#queue;
    await this.#reload();
    const matches = Object.entries(this.#state.entries).filter(([, entry]) =>
      entry.approvalId === approvalId);
    if (matches.length > 1) throw new Error("Approval identifier is not unique");
    if (matches.length === 0) return undefined;
    const [key, entry] = matches[0];
    return { key, entry: structuredClone(entry) };
  }

  async putPending(key, value) {
    return this.#mutate((entries) => {
      const existing = entries[key];
      if (existing && existing.operationDigest !== value.operationDigest) {
        throw new Error("Idempotency key collision");
      }
      if (!existing) entries[key] = { ...value, status: "pending" };
      return structuredClone(entries[key]);
    });
  }

  async approve(key, { operationDigest, approvedBy, approvedAt = new Date().toISOString() }) {
    if (typeof approvedBy !== "string" || approvedBy === "") throw new TypeError("approvedBy is required");
    return this.#mutate((entries) => {
      const entry = entries[key];
      if (!entry) throw new Error("Pending operation not found");
      if (entry.operationDigest !== operationDigest) throw new Error("Approval operation digest mismatch");
      if (["approved", "executing", "completed"].includes(entry.status)) {
        if (entry.approval?.approvedBy !== approvedBy) throw new Error("Approval subject mismatch");
        return structuredClone(entry);
      }
      if (entry.status !== "pending") throw new Error("Operation cannot be approved");
      entry.status = "approved";
      entry.approval = { approvedBy, approvedAt };
      return structuredClone(entry);
    });
  }

  async reject(key, { operationDigest, rejectedBy, reasonCode, rejectedAt = new Date().toISOString() }) {
    if (typeof rejectedBy !== "string" || rejectedBy === "") throw new TypeError("rejectedBy is required");
    return this.#mutate((entries) => {
      const entry = entries[key];
      if (!entry) throw new Error("Pending operation not found");
      if (entry.operationDigest !== operationDigest) throw new Error("Rejection operation digest mismatch");
      if (entry.status === "rejected") {
        if (entry.rejection?.rejectedBy !== rejectedBy) throw new Error("Rejection subject mismatch");
        return structuredClone(entry);
      }
      if (entry.status !== "pending") throw new Error("Operation cannot be rejected");
      entry.status = "rejected";
      entry.rejection = { rejectedBy, rejectedAt, reasonCode: reasonCode ?? null };
      return structuredClone(entry);
    });
  }

  async beginExecution(key, value) {
    return this.#mutate((entries) => {
      const existing = entries[key];
      if (existing?.status === "completed") return { execute: false, entry: structuredClone(existing) };
      if (existing?.status === "executing") return { execute: false, uncertain: true, entry: structuredClone(existing) };
      if (existing && existing.operationDigest !== value.operationDigest) throw new Error("Operation digest mismatch");
      entries[key] = {
        ...(existing ?? {}),
        ...value,
        status: "executing",
        startedAt: new Date().toISOString(),
      };
      return { execute: true, entry: structuredClone(entries[key]) };
    });
  }

  async complete(key, { operationDigest, replayResult, completedAt = new Date().toISOString() }) {
    return this.#mutate((entries) => {
      const entry = entries[key];
      if (!entry || entry.status !== "executing") throw new Error("Operation is not executing");
      if (entry.operationDigest !== operationDigest) throw new Error("Operation digest mismatch");
      entry.status = "completed";
      entry.completedAt = completedAt;
      entry.replayResult = replayResult;
      return structuredClone(entry);
    });
  }

  async fail(key, { operationDigest, errorCode, failedAt = new Date().toISOString() }) {
    return this.#mutate((entries) => {
      const entry = entries[key];
      if (!entry || entry.operationDigest !== operationDigest) throw new Error("Operation not found");
      entry.status = "failed";
      entry.failedAt = failedAt;
      entry.errorCode = errorCode;
      return structuredClone(entry);
    });
  }

  async reconcile(key, {
    operationDigest,
    resolution,
    reconciledBy,
    reasonCode,
    observation,
    replayResult,
    reconciledAt = new Date().toISOString(),
  }) {
    requiredString(operationDigest, "operationDigest");
    requiredString(reconciledBy, "reconciledBy");
    if (!RECONCILIATION_RESOLUTIONS.has(resolution)) throw new TypeError("Invalid reconciliation resolution");
    if (typeof reasonCode !== "string" || !REASON_CODE_PATTERN.test(reasonCode)) {
      throw new TypeError("reasonCode must be a stable uppercase identifier");
    }
    const normalizedObservation = normalizeReconciliationObservation(observation);
    if (resolution === "applied" && (!replayResult || typeof replayResult !== "object")) {
      throw new TypeError("Applied reconciliation requires a replay result");
    }

    return this.#mutate((entries) => {
      const entry = entries[key];
      if (!entry || entry.operationDigest !== operationDigest) throw new Error("Operation not found");
      if (!["executing", "failed"].includes(entry.status)) {
        throw new Error("Operation is not eligible for reconciliation");
      }
      if (resolution === "not_applied" && !entry.approval?.approvedBy) {
        throw new Error("A not-applied operation has no approval to restore");
      }

      const record = {
        fromStatus: entry.status,
        fromStartedAt: entry.startedAt ?? null,
        fromFailedAt: entry.failedAt ?? null,
        fromErrorCode: entry.errorCode ?? null,
        resolution,
        reconciledBy,
        reasonCode,
        reconciledAt,
        observation: normalizedObservation,
      };
      entry.reconciliations = [...(entry.reconciliations ?? []), record];

      if (resolution === "applied") {
        entry.status = "completed";
        entry.completedAt = reconciledAt;
        entry.replayResult = structuredClone(replayResult);
      } else if (resolution === "not_applied") {
        entry.status = "approved";
        delete entry.completedAt;
        delete entry.replayResult;
      }
      if (resolution !== "conflict") {
        delete entry.startedAt;
        delete entry.failedAt;
        delete entry.errorCode;
      }
      return structuredClone(entry);
    });
  }
}

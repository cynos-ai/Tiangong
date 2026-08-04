import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { withFileLock } from "../persistence/file-lock.mjs";

const JOURNAL_VERSION = 2;
const GENESIS_HASH = "0".repeat(64);
const KEY_PATTERN = /^[a-f0-9]{64}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const RECONCILIATION_RESOLUTIONS = new Set(["applied", "not_applied", "conflict"]);
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;

function requiredString(value, name) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} is required`);
  return value;
}

function terminalTimestamp(entry) {
  if (entry.status === "completed") return entry.completedAt;
  if (entry.status === "rejected") return entry.rejection?.rejectedAt;
  return undefined;
}

function parseCutoff(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError("before must be an ISO timestamp");
  return timestamp;
}

function invocationIndexKey({ sessionId, turnId, toolCallId }) {
  return sha256({
    sessionId: requiredString(sessionId, "sessionId"),
    turnId: requiredString(turnId, "turnId"),
    toolCallId: requiredString(toolCallId, "toolCallId"),
  });
}

function validateKey(key) {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    throw new TypeError("idempotency key must be a lowercase SHA-256 digest");
  }
  return key;
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

function journalRecord(sequence, previousHash, key, entry) {
  const unsigned = { version: JOURNAL_VERSION, sequence, previousHash, key, entry };
  return { ...unsigned, hash: sha256(unsigned) };
}

function entriesEqual(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

export class IdempotencyStore {
  #filePath;
  #state = { entries: {} };
  #invocations = new Map();
  #approvals = new Map();
  #sequence = 0;
  #previousHash = GENESIS_HASH;
  #offset = 0;
  #identity;
  #mtimeMs;
  #initialized = false;
  #queue = Promise.resolve();

  constructor({ filePath }) {
    if (!filePath) throw new TypeError("filePath is required");
    this.#filePath = filePath;
  }

  #reset() {
    this.#state = { entries: {} };
    this.#invocations.clear();
    this.#approvals.clear();
    this.#sequence = 0;
    this.#previousHash = GENESIS_HASH;
    this.#offset = 0;
    this.#identity = undefined;
    this.#mtimeMs = undefined;
  }

  #removeIndexes(key, entry) {
    if (!entry) return;
    const invocation = invocationIndexKey(entry);
    if (this.#invocations.get(invocation) === key) this.#invocations.delete(invocation);
    if (entry.approvalId && this.#approvals.get(entry.approvalId) === key) {
      this.#approvals.delete(entry.approvalId);
    }
  }

  #assertIndexAvailability(key, entry) {
    const invocation = invocationIndexKey(entry);
    const invocationOwner = this.#invocations.get(invocation);
    if (invocationOwner && invocationOwner !== key) {
      throw new Error("Multiple idempotency records exist for one tool invocation");
    }
    if (entry.approvalId) {
      const approvalOwner = this.#approvals.get(entry.approvalId);
      if (approvalOwner && approvalOwner !== key) throw new Error("Approval identifier is not unique");
    }
  }

  #applyRecord(record) {
    const { hash, ...unsigned } = record ?? {};
    if (record?.version !== JOURNAL_VERSION || record.sequence !== this.#sequence + 1 ||
        record.previousHash !== this.#previousHash || hash !== sha256(unsigned)) {
      throw new Error(`Invalid idempotency journal at sequence ${this.#sequence + 1}`);
    }
    const key = validateKey(record.key);
    if (!record.entry || typeof record.entry !== "object" || Array.isArray(record.entry) ||
        record.entry.idempotencyKey !== key) {
      throw new Error("Invalid idempotency journal entry");
    }
    this.#assertIndexAvailability(key, record.entry);
    this.#removeIndexes(key, this.#state.entries[key]);
    this.#state.entries[key] = structuredClone(record.entry);
    this.#invocations.set(invocationIndexKey(record.entry), key);
    if (record.entry.approvalId) this.#approvals.set(record.entry.approvalId, key);
    this.#sequence = record.sequence;
    this.#previousHash = record.hash;
  }

  async #readRange(start, length) {
    if (length === 0) return "";
    const handle = await open(this.#filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
        if (bytesRead === 0) throw new Error("Idempotency journal changed during read");
        offset += bytesRead;
      }
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  }

  async #reload() {
    let metadata;
    try {
      metadata = await stat(this.#filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (this.#initialized && this.#offset > 0) throw new Error("Idempotency journal disappeared");
      this.#reset();
      this.#initialized = true;
      return;
    }
    if (!metadata.isFile()) throw new Error("Idempotency journal is not a regular file");
    if ((metadata.mode & 0o077) !== 0) {
      await chmod(this.#filePath, 0o600);
      metadata = await stat(this.#filePath);
      if ((metadata.mode & 0o077) !== 0) throw new Error("Idempotency journal permissions cannot be restricted");
    }
    const identity = `${metadata.dev}:${metadata.ino}`;
    let start = this.#offset;
    if (identity !== this.#identity || metadata.size < this.#offset ||
        (metadata.size === this.#offset && metadata.mtimeMs !== this.#mtimeMs)) {
      this.#reset();
      start = 0;
    } else if (metadata.size === this.#offset) {
      this.#initialized = true;
      return;
    }

    const text = await this.#readRange(start, metadata.size - start);
    if (text !== "" && !text.endsWith("\n")) throw new Error("Idempotency journal has a partial record");
    for (const line of text.split("\n")) {
      if (line !== "") this.#applyRecord(JSON.parse(line));
    }
    this.#offset = metadata.size;
    this.#identity = identity;
    this.#mtimeMs = metadata.mtimeMs;
    this.#initialized = true;
  }

  async #append(key, entry) {
    if (entry.idempotencyKey !== key) throw new Error("Idempotency journal key mismatch");
    this.#assertIndexAvailability(key, entry);
    const creating = this.#identity === undefined;
    const record = journalRecord(this.#sequence + 1, this.#previousHash, key, entry);
    const line = `${canonicalJson(record)}\n`;
    await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const handle = await open(this.#filePath, "a", 0o600);
    let metadata;
    try {
      await handle.writeFile(line);
      await handle.sync();
      metadata = await handle.stat();
    } finally {
      await handle.close();
    }
    if (creating) await syncDirectory(dirname(this.#filePath));
    this.#applyRecord(record);
    this.#offset = metadata.size;
    this.#identity = `${metadata.dev}:${metadata.ino}`;
    this.#mtimeMs = metadata.mtimeMs;
  }

  async #compact() {
    const directory = dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    let sequence = 0;
    let previousHash = GENESIS_HASH;
    try {
      for (const key of Object.keys(this.#state.entries).sort()) {
        const record = journalRecord(sequence + 1, previousHash, key, this.#state.entries[key]);
        await handle.writeFile(`${canonicalJson(record)}\n`);
        sequence = record.sequence;
        previousHash = record.hash;
      }
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
    this.#reset();
    await this.#reload();
  }

  async #mutate(key, callback) {
    const operationKey = validateKey(key);
    const operation = this.#queue.then(() => withFileLock(this.#filePath, async () => {
      await this.#reload();
      const previous = this.#state.entries[operationKey] && structuredClone(this.#state.entries[operationKey]);
      let result;
      try {
        result = callback(this.#state.entries);
      } catch (error) {
        this.#reset();
        throw error;
      }
      if (entriesEqual(previous, this.#state.entries[operationKey])) return result;
      const updated = this.#state.entries[operationKey] && structuredClone(this.#state.entries[operationKey]);
      if (previous === undefined) delete this.#state.entries[operationKey];
      else this.#state.entries[operationKey] = previous;
      try {
        if (updated === undefined) {
          delete this.#state.entries[operationKey];
          this.#removeIndexes(operationKey, previous);
          await this.#compact();
        } else {
          await this.#append(operationKey, updated);
        }
      } catch (error) {
        this.#reset();
        throw error;
      }
      return result;
    }));
    this.#queue = operation.catch(() => {});
    return operation;
  }

  async #read(callback) {
    await this.#queue;
    return withFileLock(this.#filePath, async () => {
      await this.#reload();
      return callback();
    });
  }

  async get(key) {
    const operationKey = validateKey(key);
    return this.#read(() => this.#state.entries[operationKey]
      ? structuredClone(this.#state.entries[operationKey])
      : undefined);
  }

  async findInvocation(invocation) {
    const indexKey = invocationIndexKey(invocation);
    return this.#read(() => {
      const key = this.#invocations.get(indexKey);
      return key ? { key, entry: structuredClone(this.#state.entries[key]) } : undefined;
    });
  }

  async findApproval(approvalId) {
    const identifier = requiredString(approvalId, "approvalId");
    return this.#read(() => {
      const key = this.#approvals.get(identifier);
      return key ? { key, entry: structuredClone(this.#state.entries[key]) } : undefined;
    });
  }

  async findByOperationDigest(operationDigest) {
    if (typeof operationDigest !== "string" || !DIGEST_PATTERN.test(operationDigest)) {
      throw new TypeError("operationDigest must be a lowercase SHA-256 digest");
    }
    return this.#read(() => {
      const matches = Object.entries(this.#state.entries)
        .filter(([, entry]) => entry.operationDigest === operationDigest);
      if (matches.length > 1) throw new Error("Multiple idempotency records exist for one operation digest");
      if (matches.length === 0) return undefined;
      const [key, entry] = matches[0];
      return { key, entry: structuredClone(entry) };
    });
  }

  async listTerminalBefore(before) {
    const cutoff = parseCutoff(before);
    return this.#read(() => Object.entries(this.#state.entries)
      .filter(([, entry]) => {
        const terminalAt = terminalTimestamp(entry);
        const terminalMilliseconds = Date.parse(terminalAt ?? "");
        return Number.isFinite(terminalMilliseconds) && terminalMilliseconds <= cutoff;
      })
      .map(([key, entry]) => ({ key, entry: structuredClone(entry), terminalAt: terminalTimestamp(entry) })));
  }

  async removeTerminalsBefore(keys, before) {
    if (!Array.isArray(keys) || new Set(keys).size !== keys.length) {
      throw new TypeError("keys must be a unique array");
    }
    const operationKeys = keys.map(validateKey);
    const cutoff = parseCutoff(before);
    const operation = this.#queue.then(() => withFileLock(this.#filePath, async () => {
      await this.#reload();
      const summaries = operationKeys.map((key) => {
        const entry = this.#state.entries[key];
        const terminalAt = entry && terminalTimestamp(entry);
        const terminalMilliseconds = Date.parse(terminalAt ?? "");
        if (!terminalAt || !Number.isFinite(terminalMilliseconds) || terminalMilliseconds > cutoff) {
          throw new Error("Operation is not an expired terminal record");
        }
        return {
          key,
          status: entry.status,
          operationDigest: entry.operationDigest,
          approvalId: entry.approvalId,
          terminalAt,
        };
      });
      if (summaries.length === 0) return summaries;
      for (const { key } of summaries) {
        const previous = this.#state.entries[key];
        delete this.#state.entries[key];
        this.#removeIndexes(key, previous);
      }
      try {
        await this.#compact();
      } catch (error) {
        this.#reset();
        throw error;
      }
      return summaries;
    }));
    this.#queue = operation.catch(() => {});
    return operation;
  }

  async removeTerminalBefore(key, before) {
    return (await this.removeTerminalsBefore([key], before))[0];
  }

  async putPending(key, value) {
    return this.#mutate(key, (entries) => {
      const existing = entries[key];
      if (existing && existing.operationDigest !== value.operationDigest) throw new Error("Idempotency key collision");
      if (!existing) entries[key] = { ...value, status: "pending" };
      return structuredClone(entries[key]);
    });
  }

  async approve(key, { operationDigest, approvedBy, approvedAt = new Date().toISOString() }) {
    if (typeof approvedBy !== "string" || approvedBy === "") throw new TypeError("approvedBy is required");
    return this.#mutate(key, (entries) => {
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
    return this.#mutate(key, (entries) => {
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
    return this.#mutate(key, (entries) => {
      const existing = entries[key];
      if (existing?.status === "completed") return { execute: false, entry: structuredClone(existing) };
      if (existing?.status === "executing") return { execute: false, uncertain: true, entry: structuredClone(existing) };
      if (existing && existing.operationDigest !== value.operationDigest) throw new Error("Operation digest mismatch");
      entries[key] = existing?.status === "approved"
        ? { ...existing, status: "executing", startedAt: new Date().toISOString() }
        : { ...(existing ?? {}), ...value, status: "executing", startedAt: new Date().toISOString() };
      return { execute: true, entry: structuredClone(entries[key]) };
    });
  }

  async complete(key, { operationDigest, replayResult, completedAt = new Date().toISOString() }) {
    return this.#mutate(key, (entries) => {
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
    return this.#mutate(key, (entries) => {
      const entry = entries[key];
      if (!entry || entry.operationDigest !== operationDigest) throw new Error("Operation not found");
      entry.status = "failed";
      entry.failedAt = failedAt;
      entry.errorCode = errorCode;
      return structuredClone(entry);
    });
  }

  async reconcile(key, { operationDigest, resolution, reconciledBy, reasonCode, observation, replayResult, reconciledAt = new Date().toISOString() }) {
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

    return this.#mutate(key, (entries) => {
      const entry = entries[key];
      if (!entry || entry.operationDigest !== operationDigest) throw new Error("Operation not found");
      if (!["executing", "failed"].includes(entry.status)) throw new Error("Operation is not eligible for reconciliation");
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

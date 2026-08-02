import { chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { withFileLock } from "../persistence/file-lock.mjs";

const VERSION = 1;
const GENESIS_HASH = "0".repeat(64);
const DIGEST = /^[0-9a-f]{64}$/u;
const STATUSES = new Set(["executing", "completed", "outcome_uncertain"]);
const REASON = /^[A-Z][A-Z0-9_]{0,63}$/u;

function assertDigest(value, name) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertTimestamp(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO timestamp`);
  }
  return value;
}

function validateEntry(key, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      entry.invocationKey !== key || !STATUSES.has(entry.status)) {
    throw new Error("Invalid runner journal entry");
  }
  assertDigest(entry.requestDigest, "requestDigest");
  assertTimestamp(entry.startedAt, "startedAt");
  if (entry.status === "completed") {
    assertTimestamp(entry.completedAt, "completedAt");
    if (!entry.result || typeof entry.result !== "object" || entry.result.outcome !== "completed" ||
        entry.result.invocationKey !== key) {
      throw new Error("Invalid completed runner journal result");
    }
  } else if (entry.completedAt !== undefined || entry.result !== undefined) {
    throw new Error("Non-completed runner journal entry contains a result");
  }
  if (entry.status === "outcome_uncertain") {
    if (typeof entry.reason !== "string" || !REASON.test(entry.reason)) {
      throw new Error("Invalid runner journal uncertainty reason");
    }
    assertTimestamp(entry.uncertainAt, "uncertainAt");
  } else if (entry.reason !== undefined || entry.uncertainAt !== undefined) {
    throw new Error("Certain runner journal entry contains uncertainty fields");
  }
  return entry;
}

function validateRecord(record, sequence, previousHash) {
  const { hash, ...unsigned } = record ?? {};
  if (record?.version !== VERSION || record.sequence !== sequence ||
      record.previousHash !== previousHash || hash !== sha256(unsigned)) {
    throw new Error(`Invalid runner journal at sequence ${sequence}`);
  }
  const key = assertDigest(record.key, "runner invocation key");
  validateEntry(key, record.entry);
  return key;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class RunnerJournal {
  #filePath;
  #clock;

  constructor({ filePath, clock = () => new Date() }) {
    if (typeof filePath !== "string" || filePath === "") throw new TypeError("filePath is required");
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    this.#filePath = filePath;
    this.#clock = clock;
  }

  #now() {
    const value = this.#clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("Runner journal clock returned an invalid Date");
    }
    return value.toISOString();
  }

  async #load() {
    let metadata;
    try {
      metadata = await stat(this.#filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return { entries: new Map(), sequence: 0, previousHash: GENESIS_HASH };
      throw error;
    }
    if (!metadata.isFile()) throw new Error("Runner journal is not a regular file");
    if ((metadata.mode & 0o077) !== 0) {
      await chmod(this.#filePath, 0o600);
      metadata = await stat(this.#filePath);
      if ((metadata.mode & 0o077) !== 0) throw new Error("Runner journal permissions cannot be restricted");
    }
    const text = await readFile(this.#filePath, "utf8");
    if (text !== "" && !text.endsWith("\n")) throw new Error("Runner journal has a partial record");
    const entries = new Map();
    let sequence = 0;
    let previousHash = GENESIS_HASH;
    for (const line of text.split("\n")) {
      if (line === "") continue;
      const record = JSON.parse(line);
      const key = validateRecord(record, sequence + 1, previousHash);
      entries.set(key, structuredClone(record.entry));
      sequence = record.sequence;
      previousHash = record.hash;
    }
    return { entries, sequence, previousHash };
  }

  async #append(state, key, entry) {
    validateEntry(key, entry);
    const unsigned = {
      version: VERSION,
      sequence: state.sequence + 1,
      previousHash: state.previousHash,
      key,
      entry,
    };
    const record = { ...unsigned, hash: sha256(unsigned) };
    const directory = dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const creating = state.sequence === 0;
    const handle = await open(this.#filePath, "a", 0o600);
    try {
      await handle.writeFile(`${canonicalJson(record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (creating) await syncDirectory(directory);
    state.entries.set(key, structuredClone(entry));
    state.sequence = record.sequence;
    state.previousHash = record.hash;
    return structuredClone(entry);
  }

  async #locked(callback) {
    return withFileLock(this.#filePath, async () => callback(await this.#load()));
  }

  async begin(key, requestDigest) {
    const invocationKey = assertDigest(key, "runner invocation key");
    const digest = assertDigest(requestDigest, "requestDigest");
    return this.#locked(async (state) => {
      const existing = state.entries.get(invocationKey);
      if (existing) {
        if (existing.requestDigest !== digest) throw new Error("Runner invocation request digest conflict");
        return { execute: false, entry: structuredClone(existing) };
      }
      const entry = {
        invocationKey,
        requestDigest: digest,
        status: "executing",
        startedAt: this.#now(),
      };
      await this.#append(state, invocationKey, entry);
      return { execute: true, entry: structuredClone(entry) };
    });
  }

  async complete(key, requestDigest, result) {
    const invocationKey = assertDigest(key, "runner invocation key");
    const digest = assertDigest(requestDigest, "requestDigest");
    return this.#locked(async (state) => {
      const existing = state.entries.get(invocationKey);
      if (!existing || existing.requestDigest !== digest) throw new Error("Executing runner invocation not found");
      if (existing.status === "completed") {
        if (canonicalJson(existing.result) !== canonicalJson(result)) {
          throw new Error("Completed runner invocation result conflict");
        }
        return structuredClone(existing);
      }
      if (existing.status !== "executing") throw new Error("Runner invocation is outcome uncertain");
      const entry = {
        ...existing,
        status: "completed",
        completedAt: this.#now(),
        result: structuredClone(result),
      };
      delete entry.reason;
      delete entry.uncertainAt;
      return this.#append(state, invocationKey, entry);
    });
  }

  async recordUncertain(key, requestDigest, reason) {
    const invocationKey = assertDigest(key, "runner invocation key");
    const digest = assertDigest(requestDigest, "requestDigest");
    if (typeof reason !== "string" || !REASON.test(reason)) {
      throw new TypeError("Runner uncertainty reason must be a stable uppercase identifier");
    }
    return this.#locked(async (state) => {
      const existing = state.entries.get(invocationKey);
      if (!existing || existing.requestDigest !== digest) throw new Error("Executing runner invocation not found");
      if (existing.status === "outcome_uncertain") {
        if (existing.reason !== reason) throw new Error("Runner uncertainty reason conflict");
        return structuredClone(existing);
      }
      if (existing.status !== "executing") throw new Error("Completed runner invocation cannot become uncertain");
      return this.#append(state, invocationKey, {
        ...existing,
        status: "outcome_uncertain",
        reason,
        uncertainAt: this.#now(),
      });
    });
  }

  async lookup(key) {
    const invocationKey = assertDigest(key, "runner invocation key");
    return this.#locked((state) => {
      const entry = state.entries.get(invocationKey);
      return entry ? structuredClone(entry) : undefined;
    });
  }
}

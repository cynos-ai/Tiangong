import { mkdir, open, rename, rm } from "node:fs/promises";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { withFileLock } from "../persistence/file-lock.mjs";

const VERSION = 1;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_RESULTS = 256;
const MAX_RETENTION_MARKS = 256;
const DIGEST = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9._:@$-]{1,256}$/u;
const OUTCOMES = new Set(["success", "error", "denied", "timeout", "cancel"]);

function bounded(value, name, limit = 512) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > limit) {
    throw new TypeError(`${name} is missing or exceeds the bounded limit`);
  }
  return value;
}

function optionalBounded(value, name, limit = 512) {
  if (value === undefined || value === null) return undefined;
  return bounded(value, name, limit);
}

function timestamp(value, name) {
  const normalized = bounded(value, name, 64);
  if (!Number.isFinite(Date.parse(normalized))) throw new TypeError(`${name} must be an ISO timestamp`);
  return normalized;
}

function digest(value, name) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new TypeError(`${name} must be a SHA-256 digest`);
  return value;
}

function exactId(value, name) {
  const normalized = bounded(value, name);
  if (!ID.test(normalized)) throw new TypeError(`${name} has an invalid identifier`);
  return normalized;
}

function summary(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)) throw new TypeError(`${name} contains an invalid field`);
    if (typeof entry === "string") result[key] = bounded(entry, `${name}.${key}`, 256);
    else if (typeof entry === "number" && Number.isSafeInteger(entry)) result[key] = entry;
    else if (typeof entry === "boolean") result[key] = entry;
    else if (entry === null) result[key] = null;
    else throw new TypeError(`${name}.${key} is not a bounded scalar`);
  }
  if (Buffer.byteLength(canonicalJson(result)) > 2048) throw new TypeError(`${name} is too large`);
  return result;
}

function contentRef(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("outputRef must be an object");
  const keys = Object.keys(value).sort().join("\n");
  if (keys === "commitSha\nrepositoryId") {
    return Object.freeze({
      repositoryId: exactId(value.repositoryId, "outputRef.repositoryId"),
      commitSha: bounded(value.commitSha, "outputRef.commitSha", 128),
    });
  }
  if (keys === "adapter\nref") {
    return Object.freeze({
      adapter: bounded(value.adapter, "outputRef.adapter", 128),
      ref: bounded(value.ref, "outputRef.ref", 256),
    });
  }
  throw new TypeError("outputRef has an unsupported shape");
}

export function normalizeToolResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("ToolResult must be an object");
  const normalized = {
    version: VERSION,
    toolResultId: digest(value.toolResultId, "toolResultId"),
    callKey: digest(value.callKey, "callKey"),
    ...(value.workId === undefined ? {} : { workId: exactId(value.workId, "workId") }),
    ...(value.taskId === undefined ? {} : { taskId: exactId(value.taskId, "taskId") }),
    actorId: exactId(value.actorId, "actorId"),
    runtimeProfile: exactId(value.runtimeProfile, "runtimeProfile"),
    tool: exactId(value.tool, "tool"),
    requestSummary: summary(value.requestSummary, "requestSummary"),
    resultSummary: summary(value.resultSummary, "resultSummary"),
    outputRef: contentRef(value.outputRef),
    startedAt: timestamp(value.startedAt, "startedAt"),
    completedAt: timestamp(value.completedAt, "completedAt"),
  };
  if (Date.parse(normalized.completedAt) < Date.parse(normalized.startedAt)) {
    throw new TypeError("completedAt must not precede startedAt");
  }
  if (!OUTCOMES.has(normalized.resultSummary.outcome)) throw new TypeError("resultSummary.outcome is invalid");
  return Object.freeze(normalized);
}

function emptyState() {
  return { version: VERSION, results: [], retentionMarks: [] };
}

function immutableResult(value) {
  const { startedAt: _startedAt, completedAt: _completedAt, ...rest } = value;
  return rest;
}

function assertPath(filePath) {
  if (typeof filePath !== "string" || !isAbsolute(filePath)) throw new TypeError("ToolResult store filePath must be absolute");
  return filePath;
}

function normalizeState(state) {
  if (!state || state.version !== VERSION || !Array.isArray(state.results) || !Array.isArray(state.retentionMarks) ||
      state.results.length > MAX_RESULTS || state.retentionMarks.length > MAX_RETENTION_MARKS) {
    throw new Error("ToolResult store state is invalid");
  }
  return {
    version: VERSION,
    results: state.results.map(normalizeToolResult),
    retentionMarks: state.retentionMarks.map((mark) => ({
      toolResultId: digest(mark.toolResultId, "retentionMark.toolResultId"),
      workId: exactId(mark.workId, "retentionMark.workId"),
      until: timestamp(mark.until, "retentionMark.until"),
    })),
  };
}

function repairablePermissions(metadata) {
  return process.platform !== "win32" && (metadata.mode & 0o077) !== 0 && metadata.nlink === 1 && metadata.uid === process.getuid?.();
}

function assertStateMetadata(metadata) {
  if (!metadata.isFile() || metadata.size > MAX_STATE_BYTES || metadata.nlink !== 1) throw new Error("ToolResult store state file is invalid");
}

async function readState(filePath) {
  let handle;
  try { handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    if (error?.code === "ELOOP") throw new Error("ToolResult store state file is invalid");
    throw error;
  }
  try {
    let metadata = await handle.stat(); assertStateMetadata(metadata);
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      if (!repairablePermissions(metadata)) throw new Error("ToolResult store permissions are too broad");
      await handle.chmod(0o600); metadata = await handle.stat(); assertStateMetadata(metadata);
      if ((metadata.mode & 0o077) !== 0) throw new Error("ToolResult store permissions are too broad");
    }
    let state;
    try { state = JSON.parse(await handle.readFile("utf8")); } catch { throw new Error("ToolResult store state is not valid JSON"); }
    assertStateMetadata(await handle.stat());
    return normalizeState(state);
  } finally { await handle.close(); }
}

function readStateSync(filePath) {
  let descriptor;
  try { descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    if (error?.code === "ELOOP") throw new Error("ToolResult store state file is invalid");
    throw error;
  }
  try {
    let metadata = fstatSync(descriptor); assertStateMetadata(metadata);
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      if (!repairablePermissions(metadata)) throw new Error("ToolResult store permissions are too broad");
      fchmodSync(descriptor, 0o600); metadata = fstatSync(descriptor); assertStateMetadata(metadata);
      if ((metadata.mode & 0o077) !== 0) throw new Error("ToolResult store permissions are too broad");
    }
    let state;
    try { state = JSON.parse(readFileSync(descriptor, "utf8")); } catch { throw new Error("ToolResult store state is not valid JSON"); }
    assertStateMetadata(fstatSync(descriptor));
    return normalizeState(state);
  } finally { closeSync(descriptor); }
}

async function writeState(filePath, state) {
  const line = `${canonicalJson(state)}\n`;
  if (Buffer.byteLength(line) > MAX_STATE_BYTES) throw new Error("ToolResult store state exceeds the bounded limit");
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${sha256({ line, nonce: `${Date.now()}:${Math.random()}` })}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(line); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, filePath); } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
}

function writeStateSync(filePath, state) {
  const line = `${canonicalJson(state)}\n`;
  if (Buffer.byteLength(line) > MAX_STATE_BYTES) throw new Error("ToolResult store state exceeds the bounded limit");
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${sha256({ line, nonce: `${Date.now()}:${Math.random()}` })}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try { writeFileSync(descriptor, line); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  try { renameSync(temporary, filePath); } catch (error) { rmSync(temporary, { force: true }); throw error; }
}

function withFileLockSync(filePath, callback) {
  const lockPath = `${filePath}.lock`;
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  for (;;) {
    try { mkdirSync(lockPath, { mode: 0o700 }); break; } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lock = statSync(lockPath);
      if (Date.now() - lock.mtimeMs < 30_000) throw new Error("TOOL_RESULT_STORE_BUSY");
      const stalePath = `${lockPath}.stale-${crypto.randomUUID()}`;
      try { renameSync(lockPath, stalePath); } catch (caught) { if (caught?.code === "ENOENT") continue; throw caught; }
      rmSync(stalePath, { recursive: true, force: true });
    }
  }
  try { return callback(); } finally { rmSync(lockPath, { recursive: true, force: true }); }
}

export class ToolResultStore {
  #filePath;
  #maxResults;

  constructor({ filePath, maxResults = MAX_RESULTS } = {}) {
    this.#filePath = assertPath(filePath);
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) throw new TypeError("maxResults is outside the bounded range");
    this.#maxResults = maxResults;
  }

  async append(value) {
    const result = normalizeToolResult(value);
    return withFileLock(this.#filePath, async () => this.#appendToState(result, await readState(this.#filePath), writeState));
  }

  appendSync(value) {
    const result = normalizeToolResult(value);
    return withFileLockSync(this.#filePath, () => this.#appendToState(result, readStateSync(this.#filePath), (filePath, state) => writeStateSync(filePath, state)));
  }

  #appendToState(result, state, writer) {
    const existing = state.results.find((entry) => entry.toolResultId === result.toolResultId);
    if (existing) {
      if (canonicalJson(immutableResult(existing)) !== canonicalJson(immutableResult(result))) throw new Error("TOOL_RESULT_CONFLICT");
      return { replayed: true, result: existing };
    }
    const callExisting = state.results.find((entry) => entry.callKey === result.callKey);
    if (callExisting) throw new Error("TOOL_RESULT_CALL_CONFLICT");
    const next = { ...state, results: [...state.results, result].slice(-this.#maxResults) };
    const written = writer(this.#filePath, next);
    return written && typeof written.then === "function" ? written.then(() => ({ replayed: false, result })) : { replayed: false, result };
  }

  async get(toolResultId) {
    const id = digest(toolResultId, "toolResultId");
    const state = await withFileLock(this.#filePath, () => readState(this.#filePath));
    return state.results.find((entry) => entry.toolResultId === id);
  }

  async markRetention(toolResultId, { workId, until } = {}) {
    const id = digest(toolResultId, "toolResultId");
    const owner = exactId(workId, "workId");
    const expiry = timestamp(until, "until");
    return withFileLock(this.#filePath, async () => {
      const state = await readState(this.#filePath);
      const result = state.results.find((entry) => entry.toolResultId === id);
      if (!result) throw new Error("TOOL_RESULT_NOT_FOUND");
      if (result.workId !== owner) throw new Error("TOOL_RESULT_OWNER_MISMATCH");
      const existing = state.retentionMarks.find((mark) => mark.toolResultId === id && mark.workId === owner);
      if (existing) {
        if (existing.until !== expiry) throw new Error("TOOL_RESULT_RETENTION_CONFLICT");
        return { replayed: true, mark: existing };
      }
      const mark = { toolResultId: id, workId: owner, until: expiry };
      await writeState(this.#filePath, {
        ...state,
        retentionMarks: [...state.retentionMarks, mark].slice(-MAX_RETENTION_MARKS),
      });
      return { replayed: false, mark };
    });
  }

  async list() {
    const state = await withFileLock(this.#filePath, () => readState(this.#filePath));
    return structuredClone(state);
  }
}

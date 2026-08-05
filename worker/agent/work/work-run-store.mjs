// WorkRunStore: role-neutral persistence for WorkRuns (architecture §8).
//
// Each run is an immutable binding plus an append-only, hash-chained phase
// journal. open is idempotent (re-opening the same runId returns the existing
// run); transition is guarded by the phase machine (work-run.mjs) and never
// overwrites history. The filesystem is injected so the contract is
// deterministic and testable without touching real storage.

import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { withFileLock } from "../persistence/file-lock.mjs";
import {
  GENESIS_HASH,
  WORK_RUN_ID_PATTERN,
  canTransition,
  createPhaseEvent,
  createWorkRun,
  isTerminalPhase,
  replayWorkRun,
} from "./work-run.mjs";

function now(deps) {
  const value = deps?.now?.();
  return typeof value === "string" ? value : new Date().toISOString();
}

function assertRunId(value, name = "runId") {
  if (typeof value !== "string" || !WORK_RUN_ID_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a bounded WorkRun identifier`);
  }
  return value;
}

export class WorkRunStore {
  constructor({ directory, fs, now: nowFn, lock } = {}) {
    if (typeof directory !== "string" || directory === "") {
      throw new TypeError("WorkRunStore requires a directory");
    }
    this.#directory = directory;
    const customFs = fs !== undefined && fs !== null;
    this.#fs = fs ?? {
      chmod,
      lstat,
      mkdir,
      readFile,
      readdir,
      writeFile,
      appendFile: (file, data) => writeFile(file, data, { flag: "a", mode: 0o600 }),
    };
    this.#lock = lock ?? (customFs ? async (_filePath, callback) => callback() : withFileLock);
    if (typeof this.#lock !== "function") throw new TypeError("WorkRunStore lock must be a function");
    this.#now = nowFn;
  }

  #directory;
  #fs;
  #lock;
  #now;

  async #ensureDir() {
    await this.#fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });
    if (typeof this.#fs.lstat !== "function") return;
    const stat = await this.#fs.lstat(this.#directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("WorkRun directory must be a real directory");
    if ((stat.mode & 0o077) !== 0 && typeof this.#fs.chmod === "function") {
      await this.#fs.chmod(this.#directory, 0o700);
    }
  }

  async #assertFile(filePath, label) {
    if (typeof this.#fs.lstat !== "function") return;
    let stat;
    try {
      stat = await this.#fs.lstat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file`);
    if ((stat.mode & 0o077) !== 0 && typeof this.#fs.chmod === "function") {
      await this.#fs.chmod(filePath, 0o600);
    }
  }

  #bindingPath(runId) {
    return path.join(this.#directory, `${assertRunId(runId)}.binding.json`);
  }

  #eventsPath(runId) {
    return path.join(this.#directory, `${assertRunId(runId)}.events.jsonl`);
  }

  #withRunLock(runId, callback) {
    return this.#lock(this.#eventsPath(runId), callback);
  }

  async #readBinding(runId) {
    const filePath = this.#bindingPath(runId);
    await this.#assertFile(filePath, "WorkRun binding");
    const raw = await this.#fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  }

  async #readEvents(runId) {
    try {
      const filePath = this.#eventsPath(runId);
      await this.#assertFile(filePath, "WorkRun journal");
      const raw = await this.#fs.readFile(filePath, "utf8");
      return raw
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async open(input) {
    const binding = createWorkRun(input);
    await this.#ensureDir();
    return this.#withRunLock(binding.runId, async () => {
      try {
        await this.#fs.writeFile(this.#bindingPath(binding.runId), `${JSON.stringify(binding)}\n`, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const existing = await this.#readBinding(binding.runId);
        if (existing.contentDigest !== binding.contentDigest) {
          throw new Error(
            `WorkRun ${binding.runId} already exists with a different binding`,
          );
        }
      }
      return this.#readUnlocked(binding.runId);
    });
  }

  async transition(runId, toPhase, { reason } = {}) {
    assertRunId(runId);
    return this.#withRunLock(runId, async () => {
      const state = await this.#readUnlocked(runId);
      if (state.terminal) throw new Error(`WorkRun ${runId} is terminal (${state.phase})`);
      if (!canTransition(state.phase, toPhase)) {
        throw new Error(`Illegal phase transition for ${runId}: ${state.phase} -> ${toPhase}`);
      }
      const previousHash = state.events.length
        ? state.events[state.events.length - 1].contentDigest
        : state.binding.contentDigest;
      const event = createPhaseEvent({
        runId,
        sequence: state.events.length + 1,
        fromPhase: state.phase,
        toPhase,
        previousHash,
        at: now(this),
        reason,
      });
      await this.#fs.appendFile(this.#eventsPath(runId), `${JSON.stringify(event)}\n`, { mode: 0o600 });
      return this.#readUnlocked(runId);
    });
  }

  async #readUnlocked(runId) {
    const binding = await this.#readBinding(runId);
    const events = await this.#readEvents(runId);
    return replayWorkRun(binding, events);
  }

  async read(runId) {
    assertRunId(runId);
    return this.#withRunLock(runId, () => this.#readUnlocked(runId));
  }

  async latestForTask(taskId) {
    assertRunId(taskId, "taskId");
    await this.#ensureDir();
    let entries;
    try {
      entries = await this.#fs.readdir(this.#directory);
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
    const bindings = entries.filter((name) => typeof name === "string" && name.endsWith(".binding.json"));
    let latest;
    for (const name of bindings) {
      const runId = assertRunId(name.slice(0, -".binding.json".length), "WorkRun file name");
      const state = await this.#withRunLock(runId, async () => {
        const filePath = path.join(this.#directory, name);
        await this.#assertFile(filePath, "WorkRun binding");
        const raw = await this.#fs.readFile(filePath, "utf8");
        const binding = JSON.parse(raw);
        if (binding.runId !== runId) throw new Error("WorkRun binding file name does not match runId");
        if (binding.taskId !== taskId) return undefined;
        return this.#readUnlocked(runId);
      });
      if (!state) continue;
      if (state.binding.taskId !== taskId) throw new Error("WorkRun binding changed while reading");
      if (!latest || state.binding.createdAt > latest.binding.createdAt) latest = state;
    }
    return latest;
  }

  // exposed for completeness / diagnostics
  static get genesisHash() {
    return GENESIS_HASH;
  }
}

export { isTerminalPhase };

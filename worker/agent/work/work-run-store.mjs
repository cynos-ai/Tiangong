// WorkRunStore: role-neutral persistence for WorkRuns (architecture §8).
//
// Each run is an immutable binding plus an append-only, hash-chained phase
// journal. open is idempotent (re-opening the same runId returns the existing
// run); transition is guarded by the phase machine (work-run.mjs) and never
// overwrites history. The filesystem is injected so the contract is
// deterministic and testable without touching real storage.

import { chmod, lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
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
  constructor({ directory, fs, now: nowFn, lock, ownerId, authorizeRecovery } = {}) {
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
      unlink,
      writeFile,
      appendFile: (file, data) => writeFile(file, data, { flag: "a", mode: 0o600 }),
    };
    this.#lock = lock ?? (customFs ? async (_filePath, callback) => callback() : withFileLock);
    if (typeof this.#lock !== "function") throw new TypeError("WorkRunStore lock must be a function");
    this.#now = nowFn;
    this.#ownerId = ownerId ?? `owner-${crypto.randomUUID()}`;
    if (typeof this.#ownerId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(this.#ownerId)) {
      throw new TypeError("WorkRunStore ownerId must be a bounded identifier");
    }
    this.#authorizeRecovery = authorizeRecovery;
  }

  #directory;
  #fs;
  #lock;
  #now;
  #ownerId;
  #authorizeRecovery;

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

  #ownerPath(runId) {
    return path.join(this.#directory, `${assertRunId(runId)}.owner.json`);
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

  async #readOwner(runId) {
    const filePath = this.#ownerPath(runId);
    try {
      await this.#assertFile(filePath, "WorkRun owner lease");
      const value = JSON.parse(await this.#fs.readFile(filePath, "utf8"));
      if (!value || value.schemaVersion !== 1 || value.runId !== runId ||
          typeof value.ownerId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.ownerId)) {
        throw new Error("WorkRun owner lease is invalid");
      }
      return value;
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #removeOwner(runId) {
    if (typeof this.#fs.unlink !== "function") throw new Error("WorkRun owner lease cleanup is unavailable");
    try {
      await this.#fs.unlink(this.#ownerPath(runId));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async #appendTransitionUnlocked(state, toPhase, reason) {
    if (state.terminal) throw new Error(`WorkRun ${state.binding.runId} is terminal (${state.phase})`);
    if (!canTransition(state.phase, toPhase)) {
      throw new Error(`Illegal phase transition for ${state.binding.runId}: ${state.phase} -> ${toPhase}`);
    }
    const previousHash = state.events.length
      ? state.events[state.events.length - 1].contentDigest
      : state.binding.contentDigest;
    const event = createPhaseEvent({
      runId: state.binding.runId,
      sequence: state.events.length + 1,
      fromPhase: state.phase,
      toPhase,
      previousHash,
      at: now(this),
      reason,
    });
    await this.#fs.appendFile(this.#eventsPath(state.binding.runId), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    return this.#readUnlocked(state.binding.runId);
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
      return this.#appendTransitionUnlocked(state, toPhase, reason);
    });
  }

  /**
   * Claim the one active execution owner for a non-terminal WorkRun. The
   * lease file survives a Worker crash; a new process therefore cannot
   * blindly replay a started run until a recovery controller reconciles it.
   */
  async claim(runId) {
    assertRunId(runId);
    await this.#ensureDir();
    return this.#withRunLock(runId, async () => {
      const state = await this.#readUnlocked(runId);
      if (state.terminal) {
        await this.#removeOwner(runId);
        return state;
      }
      const existing = await this.#readOwner(runId);
      if (existing) {
        if (existing.ownerId !== this.#ownerId) {
          const error = new Error(`WorkRun ${runId} is owned by another execution process`);
          error.code = "TIANGONG_WORK_RUN_OWNER_CONFLICT";
          throw error;
        }
        return state;
      }
      if (["executing", "waiting_approval", "verifying"].includes(state.phase)) {
        const error = new Error(`WorkRun ${runId} has a started phase without an execution owner`);
        error.code = "TIANGONG_WORK_RUN_RECOVERY_REQUIRED";
        throw error;
      }
      await this.#fs.writeFile(this.#ownerPath(runId), `${JSON.stringify({ schemaVersion: 1, runId, ownerId: this.#ownerId })}\n`, { flag: "wx", mode: 0o600 });
      return state;
    });
  }

  /** Release a lease only when this store still owns it. */
  async release(runId) {
    assertRunId(runId);
    return this.#withRunLock(runId, async () => {
      const existing = await this.#readOwner(runId);
      if (!existing) return this.#readUnlocked(runId);
      if (existing.ownerId !== this.#ownerId) {
        const error = new Error(`WorkRun ${runId} is owned by another execution process`);
        error.code = "TIANGONG_WORK_RUN_OWNER_CONFLICT";
        throw error;
      }
      await this.#removeOwner(runId);
      return this.#readUnlocked(runId);
    });
  }

  /**
   * Privileged recovery entry point. It is intentionally absent from the
   * model tool registry. A deployment/recovery controller must authorize the
   * action; resume appends a blocked/recovery pair before reclaiming the lease.
   */
  async reconcile(runId, { action = "resume", reason = "worker-restart-reconciled" } = {}) {
    assertRunId(runId);
    if (action !== "resume" && action !== "abandon") {
      throw new TypeError("WorkRun recovery action must be resume or abandon");
    }
    if (typeof this.#authorizeRecovery !== "function") {
      const error = new Error("WorkRun recovery requires a privileged controller");
      error.code = "TIANGONG_WORK_RUN_RECOVERY_UNAUTHORIZED";
      throw error;
    }
    await this.#authorizeRecovery({ runId, action });
    return this.#withRunLock(runId, async () => {
      let state = await this.#readUnlocked(runId);
      if (state.terminal) return state;
      await this.#removeOwner(runId);
      if (action === "abandon") {
        state = await this.#appendTransitionUnlocked(state, "abandoned", reason);
        return state;
      }
      if (state.phase !== "blocked") state = await this.#appendTransitionUnlocked(state, "blocked", reason);
      state = await this.#appendTransitionUnlocked(state, "executing", "recovery-resume");
      await this.#fs.writeFile(this.#ownerPath(runId), `${JSON.stringify({ schemaVersion: 1, runId, ownerId: this.#ownerId })}\n`, { flag: "wx", mode: 0o600 });
      return state;
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

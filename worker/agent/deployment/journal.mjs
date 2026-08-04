import { chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { withFileLock } from "../persistence/file-lock.mjs";

const VERSION = 1;
const GENESIS_HASH = "0".repeat(64);
const DIGEST = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FAULT_MODES = new Set(["none", "post_verify_fail", "rollback_fail", "verify_previous_fail"]);
const VERIFY_PHASES = new Set(["post_deploy", "previous"]);
const MAX_EVENTS = 1024;

function demand(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} has an invalid format`);
  return value;
}

function normalizeConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Deployment config is required");
  const config = {
    targetId: demand(input.targetId, ID, "targetId"),
    previousDigest: demand(input.previousDigest, DIGEST, "previousDigest"),
    faultMode: FAULT_MODES.has(input.faultMode) ? input.faultMode : (() => { throw new Error("faultMode is invalid"); })(),
  };
  return Object.freeze(config);
}

function eventRecord(sequence, previousHash, event) {
  const unsigned = { version: VERSION, sequence, previousHash, event };
  return Object.freeze({ ...unsigned, hash: sha256(unsigned) });
}

function initialState(config) {
  return {
    config,
    initialized: false,
    currentDigest: config.previousDigest,
    staged: new Map(),
    activated: new Map(),
    verified: new Map(),
    rolledBack: new Map(),
    sequence: 0,
    previousHash: GENESIS_HASH,
  };
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function applyRecord(state, record) {
  const { hash, ...unsigned } = record ?? {};
  if (record?.version !== VERSION || record.sequence !== state.sequence + 1 ||
      record.previousHash !== state.previousHash || hash !== sha256(unsigned) ||
      !record.event || typeof record.event !== "object" || Array.isArray(record.event)) {
    throw new Error(`Invalid deployment journal at sequence ${state.sequence + 1}`);
  }
  const event = record.event;
  if (event.type === "deployment.initialized") {
    if (state.initialized || record.sequence !== 1 || event.targetId !== state.config.targetId ||
        event.previousDigest !== state.config.previousDigest || event.faultMode !== state.config.faultMode) {
      throw new Error("Deployment journal configuration is inconsistent");
    }
    state.initialized = true;
  } else {
    if (!state.initialized) throw new Error("Deployment journal is missing its configuration record");
    demand(event.operationId, ID, "operationId");
  }
  if (event.type === "deployment.initialized") {
    // Configuration is the durable genesis fact; it has no operation identity.
  } else if (event.type === "deployment.staged") {
    demand(event.artifactDigest, DIGEST, "artifactDigest");
    demand(event.expectedCurrentDigest, DIGEST, "expectedCurrentDigest");
    demand(event.rollbackDigest, DIGEST, "rollbackDigest");
    if (state.staged.has(event.operationId)) throw new Error("Deployment journal contains duplicate stage events");
    state.staged.set(event.operationId, event);
  } else if (event.type === "deployment.activated") {
    const stage = state.staged.get(event.operationId);
    if (!stage || state.activated.has(event.operationId) || event.artifactDigest !== stage.artifactDigest ||
        event.previousDigest !== stage.expectedCurrentDigest || state.currentDigest !== event.previousDigest) {
      throw new Error("Deployment journal activation is inconsistent");
    }
    state.currentDigest = event.artifactDigest;
    state.activated.set(event.operationId, event);
  } else if (event.type === "deployment.verified") {
    const activation = state.activated.get(event.operationId);
    const key = `${event.operationId}:${event.phase}`;
    const stage = state.staged.get(event.operationId);
    const phaseReady = event.phase === "post_deploy"
      ? activation && !state.rolledBack.has(event.operationId) && event.expectedDigest === stage?.artifactDigest
      : event.phase === "previous" && state.rolledBack.has(event.operationId) && event.expectedDigest === stage?.rollbackDigest;
    if (!VERIFY_PHASES.has(event.phase) || !phaseReady || state.verified.has(key) ||
        event.currentDigest !== state.currentDigest || typeof event.healthy !== "boolean") {
      throw new Error("Deployment journal verification is inconsistent");
    }
    state.verified.set(key, event);
  } else if (event.type === "deployment.rolled_back") {
    const stage = state.staged.get(event.operationId);
    const activation = state.activated.get(event.operationId);
    if (!stage || !activation || state.rolledBack.has(event.operationId) ||
        event.fromDigest !== state.currentDigest || event.toDigest !== stage.rollbackDigest) {
      throw new Error("Deployment journal rollback is inconsistent");
    }
    state.currentDigest = event.toDigest;
    state.rolledBack.set(event.operationId, event);
  } else {
    throw new Error("Deployment journal event type is invalid");
  }
  state.sequence = record.sequence;
  state.previousHash = record.hash;
}

async function load(filePath, config) {
  const state = initialState(config);
  let text;
  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Deployment journal is not a regular file");
    if ((metadata.mode & 0o077) !== 0) {
      await chmod(filePath, 0o600);
      const restricted = await stat(filePath);
      if ((restricted.mode & 0o077) !== 0) throw new Error("Deployment journal permissions cannot be restricted");
    }
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return state;
    throw error;
  }
  if (text !== "" && !text.endsWith("\n")) throw new Error("Deployment journal has a partial record");
  const lines = text.split("\n").filter(Boolean);
  if (lines.length > MAX_EVENTS) throw new Error("Deployment journal event capacity exceeded");
  for (const line of lines) applyRecord(state, JSON.parse(line));
  return state;
}

async function append(filePath, state, event) {
  if (state.sequence >= MAX_EVENTS) throw new Error("Deployment journal event capacity exceeded");
  const creating = state.sequence === 0;
  const record = eventRecord(state.sequence + 1, state.previousHash, event);
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await open(filePath, "a", 0o600);
  try {
    await handle.writeFile(`${canonicalJson(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (creating) {
    const directory = await open(dirname(filePath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  applyRecord(state, record);
  return record;
}

async function ensureInitialized(filePath, state) {
  if (state.initialized) return;
  await append(filePath, state, Object.freeze({
    type: "deployment.initialized",
    targetId: state.config.targetId,
    previousDigest: state.config.previousDigest,
    faultMode: state.config.faultMode,
  }));
}

export class DeploymentJournal {
  #filePath;
  #config;

  constructor({ filePath, targetId, previousDigest, faultMode = "none" }) {
    if (typeof filePath !== "string" || filePath === "") throw new TypeError("filePath is required");
    this.#filePath = filePath;
    this.#config = normalizeConfig({ targetId, previousDigest, faultMode });
  }

  async #read(callback) {
    return withFileLock(this.#filePath, async () => callback(await load(this.#filePath, this.#config)));
  }

  async #mutate(callback) {
    return withFileLock(this.#filePath, async () => callback(await load(this.#filePath, this.#config)));
  }

  async status() {
    return this.#mutate(async (state) => {
      await ensureInitialized(this.#filePath, state);
      return Object.freeze({
        targetId: this.#config.targetId,
        currentDigest: state.currentDigest,
        previousDigest: this.#config.previousDigest,
        faultMode: this.#config.faultMode,
        sequence: state.sequence,
        terminalHash: state.previousHash,
      });
    });
  }

  async stage({ operationId, artifactDigest, expectedCurrentDigest, rollbackDigest }) {
    const proposed = Object.freeze({
      type: "deployment.staged",
      operationId: demand(operationId, ID, "operationId"),
      artifactDigest: demand(artifactDigest, DIGEST, "artifactDigest"),
      expectedCurrentDigest: demand(expectedCurrentDigest, DIGEST, "expectedCurrentDigest"),
      rollbackDigest: demand(rollbackDigest, DIGEST, "rollbackDigest"),
    });
    return this.#mutate(async (state) => {
      await ensureInitialized(this.#filePath, state);
      const existing = state.staged.get(proposed.operationId);
      if (existing) {
        if (!same(existing, proposed)) throw new Error("Deployment stage conflicts with an immutable operation");
        return { event: structuredClone(existing), replayed: true };
      }
      if (state.currentDigest !== proposed.expectedCurrentDigest || proposed.rollbackDigest !== proposed.expectedCurrentDigest) {
        throw new Error("Deployment stage precondition does not match the current target");
      }
      await append(this.#filePath, state, proposed);
      return { event: structuredClone(proposed), replayed: false };
    });
  }

  async activate({ operationId }) {
    demand(operationId, ID, "operationId");
    return this.#mutate(async (state) => {
      await ensureInitialized(this.#filePath, state);
      const existing = state.activated.get(operationId);
      if (existing) return { event: structuredClone(existing), replayed: true };
      const stage = state.staged.get(operationId);
      if (!stage) throw new Error("Deployment has not been staged");
      if (state.currentDigest !== stage.expectedCurrentDigest) throw new Error("Deployment activation precondition changed");
      const event = Object.freeze({
        type: "deployment.activated",
        operationId,
        artifactDigest: stage.artifactDigest,
        previousDigest: state.currentDigest,
      });
      await append(this.#filePath, state, event);
      return { event: structuredClone(event), replayed: false };
    });
  }

  async verify({ operationId, expectedDigest, phase = "post_deploy" }) {
    demand(operationId, ID, "operationId");
    demand(expectedDigest, DIGEST, "expectedDigest");
    if (!VERIFY_PHASES.has(phase)) throw new Error("Deployment verification phase is invalid");
    return this.#mutate(async (state) => {
      await ensureInitialized(this.#filePath, state);
      const key = `${operationId}:${phase}`;
      const existing = state.verified.get(key);
      if (existing) {
        if (existing.expectedDigest !== expectedDigest) throw new Error("Deployment verification conflicts with an immutable operation");
        return { event: structuredClone(existing), replayed: true };
      }
      const stage = state.staged.get(operationId);
      if (!stage || !state.activated.has(operationId)) throw new Error("Deployment has not been activated");
      if ((phase === "post_deploy" && state.rolledBack.has(operationId)) ||
          (phase === "previous" && !state.rolledBack.has(operationId))) {
        throw new Error("Deployment verification phase is not ready");
      }
      const requiredDigest = phase === "post_deploy" ? stage.artifactDigest : stage.rollbackDigest;
      if (expectedDigest !== requiredDigest) throw new Error("Deployment verification digest does not match the operation");
      const injectedFailure = (phase === "post_deploy" &&
        ["post_verify_fail", "rollback_fail", "verify_previous_fail"].includes(this.#config.faultMode)) ||
        (phase === "previous" && this.#config.faultMode === "verify_previous_fail");
      const healthy = state.currentDigest === expectedDigest && !injectedFailure;
      const event = Object.freeze({
        type: "deployment.verified",
        operationId,
        phase,
        expectedDigest,
        currentDigest: state.currentDigest,
        healthy,
      });
      await append(this.#filePath, state, event);
      return { event: structuredClone(event), replayed: false };
    });
  }

  async rollback({ operationId }) {
    demand(operationId, ID, "operationId");
    return this.#mutate(async (state) => {
      await ensureInitialized(this.#filePath, state);
      const existing = state.rolledBack.get(operationId);
      if (existing) return { event: structuredClone(existing), replayed: true };
      const stage = state.staged.get(operationId);
      if (!stage || !state.activated.has(operationId)) throw new Error("Deployment is not eligible for rollback");
      if (this.#config.faultMode === "rollback_fail") throw new Error("Injected rollback failure");
      if (state.currentDigest !== stage.artifactDigest) throw new Error("Rollback precondition changed");
      const event = Object.freeze({
        type: "deployment.rolled_back",
        operationId,
        fromDigest: state.currentDigest,
        toDigest: stage.rollbackDigest,
      });
      await append(this.#filePath, state, event);
      return { event: structuredClone(event), replayed: false };
    });
  }
}

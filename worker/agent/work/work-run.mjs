// WorkRun: a Worker-local recovery fact for one Task (architecture §8).
//
// Role-neutral: every role stores a WorkRun the same way; the store never
// branches on role. The immutable binding (run/task/role/skill, objective,
// scope, completion contract, refs) is fixed at open; only the phase evolves
// through a guarded, hash-chained event journal. It is independent of any
// role-specific state model.

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { TEAM_ROLES } from "../team/manifest.mjs";

export const WORK_RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;
const ROLE_SET = new Set(TEAM_ROLES);
export const GENESIS_HASH = "0".repeat(64);

export const PHASES = Object.freeze([
  "planned",
  "executing",
  "waiting_approval",
  "verifying",
  "finalized",
  "blocked",
  "conflict",
  "abandoned",
]);
const ALLOWED_TRANSITIONS = Object.freeze({
  planned: Object.freeze(["executing", "blocked", "conflict", "abandoned"]),
  executing: Object.freeze(["waiting_approval", "verifying", "blocked", "conflict", "abandoned"]),
  waiting_approval: Object.freeze(["verifying", "blocked", "conflict", "abandoned"]),
  verifying: Object.freeze(["finalized", "blocked", "conflict", "abandoned"]),
  finalized: Object.freeze([]),
  blocked: Object.freeze(["executing", "abandoned"]),
  conflict: Object.freeze(["abandoned"]),
  abandoned: Object.freeze([]),
});
const TERMINAL_PHASES = new Set(["finalized", "abandoned"]);

function demandString(value, name) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} must be a non-empty string`);
  return value;
}
function demandPattern(value, name, pattern) {
  demandString(value, name);
  if (!pattern.test(value)) throw new Error(`${name} has an invalid format: ${value}`);
  return value;
}
function frozenStringArray(input, name) {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input)) throw new TypeError(`${name} must be an array`);
  const items = input.map((item) => demandPattern(item, `${name} entry`, ID_PATTERN));
  if (new Set(items).size !== items.length) throw new Error(`${name} contains duplicates`);
  return Object.freeze(items);
}
function freezeWithDigest(record) {
  const base = Object.freeze({ ...record });
  return Object.freeze({ ...base, contentDigest: sha256(canonicalJson(base)) });
}

export function isTerminalPhase(phase) {
  return TERMINAL_PHASES.has(phase);
}

export function canTransition(fromPhase, toPhase) {
  return ALLOWED_TRANSITIONS[fromPhase]?.includes(toPhase) ?? false;
}

export function createWorkRun(input) {
  if (input === null || typeof input !== "object") {
    throw new TypeError("work run input must be an object");
  }
  if (!ROLE_SET.has(input.role)) throw new Error(`Unsupported role: ${input.role}`);
  const record = {
    kind: "tiangong.work-run",
    schemaVersion: 1,
    runId: demandPattern(input.runId, "runId", WORK_RUN_ID_PATTERN),
    taskId: demandPattern(input.taskId, "taskId", WORK_RUN_ID_PATTERN),
    role: input.role,
    skillId: demandPattern(input.skillId, "skillId", WORK_RUN_ID_PATTERN),
    objective: demandString(input.objective, "objective"),
    scope: demandString(input.scope, "scope"),
    completionContractDigest: demandPattern(input.completionContractDigest, "completionContractDigest", DIGEST_PATTERN),
    inputRefs: frozenStringArray(input.inputRefs, "inputRefs"),
    phase: "planned",
    createdAt: demandPattern(input.createdAt, "createdAt", ISO_PATTERN),
  };
  record.skillDigest = demandPattern(input.skillDigest, "skillDigest", DIGEST_PATTERN);
  return freezeWithDigest(record);
}

export function createPhaseEvent(input) {
  if (input === null || typeof input !== "object") {
    throw new TypeError("phase event input must be an object");
  }
  if (!Number.isInteger(input.sequence) || input.sequence < 1) {
    throw new TypeError("sequence must be a positive integer");
  }
  if (!canTransition(input.fromPhase, input.toPhase)) {
    throw new Error(`Illegal phase transition: ${input.fromPhase} -> ${input.toPhase}`);
  }
  const record = {
    kind: "tiangong.work-run-phase",
    schemaVersion: 1,
    runId: demandPattern(input.runId, "runId", WORK_RUN_ID_PATTERN),
    sequence: input.sequence,
    fromPhase: input.fromPhase,
    toPhase: input.toPhase,
    previousHash: demandPattern(input.previousHash, "previousHash", DIGEST_PATTERN),
    at: demandPattern(input.at, "at", ISO_PATTERN),
  };
  if (input.reason !== undefined && input.reason !== null) {
    record.reason = demandString(input.reason, "reason");
  }
  return freezeWithDigest(record);
}

// Replay an event journal onto the binding to compute the current phase and
// verify the hash chain (tamper evidence).
export function replayWorkRun(binding, events) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new TypeError("binding must be an object");
  }
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  const { contentDigest, ...bindingWithoutDigest } = binding;
  const verifiedBinding = createWorkRun(bindingWithoutDigest);
  if (canonicalJson(verifiedBinding) !== canonicalJson(binding)) {
    throw new Error("WorkRun binding digest is invalid");
  }
  let phase = binding.phase;
  let previousHash = binding.contentDigest;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.runId !== binding.runId) throw new Error("Event runId does not match the work run");
    if (event.sequence !== i + 1) {
      throw new Error(`Phase event sequence gap: expected ${i + 1}, got ${event.sequence}`);
    }
    if (event.fromPhase !== phase) {
      throw new Error(`Phase event ${event.sequence} expects from ${event.fromPhase} but run is at ${phase}`);
    }
    const { contentDigest, ...rest } = event;
    let verifiedEvent;
    try {
      verifiedEvent = createPhaseEvent(rest);
    } catch {
      throw new Error(`Phase event ${event.sequence} digest is invalid`);
    }
    if (canonicalJson(verifiedEvent) !== canonicalJson(event)) {
      throw new Error(`Phase event ${event.sequence} digest is invalid`);
    }
    if (event.previousHash !== previousHash) {
      throw new Error(`Phase event ${event.sequence} breaks the hash chain`);
    }
    phase = event.toPhase;
    previousHash = contentDigest;
  }
  return { binding, phase, events: Object.freeze([...events]), terminal: isTerminalPhase(phase) };
}

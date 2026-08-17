import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { withFileLock } from "../persistence/file-lock.mjs";

// Phase B coordination slice.  This is deliberately a small, file-backed
// CoordinationStore seam: the journal is durable and rebuildable, while the
// current Work/Task projections are derived on every open.  AgentTeams owns
// the shared storage transport; this module owns only Tiangong's typed facts.

const JOURNAL_VERSION = 1;
const GENESIS_HASH = "0".repeat(64);
const DIGEST = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9@!#$%&*+./:=?_-]{1,160}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_TIMELINE_ENTRIES = 4096;
const MAX_OUTBOX_ENTRIES = 1024;
const MAX_TASKS_PER_WORK = 256;
const MAX_INPUT_REFS = 32;
const MAX_TOOL_RESULTS = 64;
const MAX_ARTIFACT_REFS = 64;

function bounded(value, name, limit = 4096) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > limit || /[\u0000\r\n]/u.test(value)) {
    throw new TypeError(`${name} is missing or exceeds the bounded limit`);
  }
  return value;
}

function identifier(value, name) {
  const normalized = bounded(value, name, 160);
  if (!ID.test(normalized)) throw new TypeError(`${name} has an invalid identifier`);
  return normalized;
}

function digest(value, name) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new TypeError(`${name} must be a SHA-256 digest`);
  return value;
}

function timestamp(value, name) {
  const normalized = bounded(value, name, 64);
  if (!ISO.test(normalized) || !Number.isFinite(Date.parse(normalized))) throw new TypeError(`${name} must be an ISO timestamp`);
  return normalized;
}

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${name} must be a positive bounded integer`);
  return value;
}

function nonNegativeInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new TypeError(`${name} must be a non-negative bounded integer`);
  return value;
}

function uniqueStrings(input, name, maximum, validator = identifier) {
  if (!Array.isArray(input) || input.length > maximum) throw new TypeError(`${name} must be a bounded array`);
  const values = input.map((value) => validator(value, `${name} entry`));
  if (new Set(values).size !== values.length) throw new Error(`${name} contains duplicates`);
  return Object.freeze(values);
}

function freezeWithDigest(record) {
  const base = Object.freeze({ ...record });
  return Object.freeze({ ...base, contentDigest: sha256(canonicalJson(base)) });
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function assertExactKeys(value, allowed, name) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw new Error(`${name} contains unknown fields: ${unexpected.join(",")}`);
}

function assertDigestRecord(value, recreate, name) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return same(recreate(value), value);
  } catch {
    return false;
  }
}

export function createControlProfile(input) {
  assertObject(input, "control profile input");
  assertExactKeys(input, new Set(["profileId", "revision", "maxTimelineEntries", "maxOutboxEntries", "maxTasksPerWork", "toolResultRetentionMs"]), "ControlProfile");
  return freezeWithDigest({
    kind: "tiangong.control-profile",
    schemaVersion: 1,
    profileId: identifier(input.profileId, "profileId"),
    revision: positiveInteger(input.revision, "revision"),
    maxTimelineEntries: positiveInteger(input.maxTimelineEntries, "maxTimelineEntries", MAX_TIMELINE_ENTRIES),
    maxOutboxEntries: positiveInteger(input.maxOutboxEntries, "maxOutboxEntries", MAX_OUTBOX_ENTRIES),
    maxTasksPerWork: positiveInteger(input.maxTasksPerWork, "maxTasksPerWork", MAX_TASKS_PER_WORK),
    toolResultRetentionMs: positiveInteger(input.toolResultRetentionMs, "toolResultRetentionMs", 365 * 24 * 60 * 60 * 1000),
  });
}

export function isControlProfile(value) {
  return assertDigestRecord(value, (entry) => createControlProfile({
    profileId: entry.profileId,
    revision: entry.revision,
    maxTimelineEntries: entry.maxTimelineEntries,
    maxOutboxEntries: entry.maxOutboxEntries,
    maxTasksPerWork: entry.maxTasksPerWork,
    toolResultRetentionMs: entry.toolResultRetentionMs,
  }), "ControlProfile");
}

export function createTeamConfig(input) {
  assertObject(input, "TeamConfig input");
  assertExactKeys(input, new Set(["teamId", "revision", "leaderMemberId", "memberIds", "controlProfileId", "createdAt"]), "TeamConfig");
  const memberIds = uniqueStrings(input.memberIds, "memberIds", 64);
  const leaderMemberId = identifier(input.leaderMemberId, "leaderMemberId");
  if (!memberIds.includes(leaderMemberId)) throw new Error("leaderMemberId must be present in memberIds");
  return freezeWithDigest({
    kind: "tiangong.team-config",
    schemaVersion: 1,
    teamId: identifier(input.teamId, "teamId"),
    revision: positiveInteger(input.revision, "revision"),
    leaderMemberId,
    memberIds,
    controlProfileId: identifier(input.controlProfileId, "controlProfileId"),
    createdAt: timestamp(input.createdAt, "createdAt"),
  });
}

export function isTeamConfig(value) {
  return assertDigestRecord(value, (entry) => createTeamConfig({
    teamId: entry.teamId,
    revision: entry.revision,
    leaderMemberId: entry.leaderMemberId,
    memberIds: entry.memberIds,
    controlProfileId: entry.controlProfileId,
    createdAt: entry.createdAt,
  }), "TeamConfig");
}

export function createTeamRouteBinding(input) {
  assertObject(input, "TeamRouteBinding input");
  assertExactKeys(input, new Set(["routeId", "teamId", "revision", "channel", "roomId", "createdAt"]), "TeamRouteBinding");
  if (input.channel !== "matrix") throw new Error("TeamRouteBinding channel must be matrix");
  return freezeWithDigest({
    kind: "tiangong.team-route-binding",
    schemaVersion: 1,
    routeId: identifier(input.routeId, "routeId"),
    teamId: identifier(input.teamId, "teamId"),
    revision: positiveInteger(input.revision, "revision"),
    channel: "matrix",
    roomId: bounded(input.roomId, "roomId", 256),
    createdAt: timestamp(input.createdAt, "createdAt"),
  });
}

export function isTeamRouteBinding(value) {
  return assertDigestRecord(value, (entry) => createTeamRouteBinding({
    routeId: entry.routeId,
    teamId: entry.teamId,
    revision: entry.revision,
    channel: entry.channel,
    roomId: entry.roomId,
    createdAt: entry.createdAt,
  }), "TeamRouteBinding");
}

export function createMemberConfig(input) {
  assertObject(input, "MemberConfig input");
  assertExactKeys(input, new Set(["memberId", "teamId", "workerName", "matrixUserId", "role", "controlProfileId", "enabled", "createdAt"]), "MemberConfig");
  return freezeWithDigest({
    kind: "tiangong.member-config",
    schemaVersion: 1,
    memberId: identifier(input.memberId, "memberId"),
    teamId: identifier(input.teamId, "teamId"),
    workerName: identifier(input.workerName, "workerName"),
    matrixUserId: bounded(input.matrixUserId, "matrixUserId", 256),
    role: bounded(input.role, "role", 128),
    controlProfileId: identifier(input.controlProfileId, "controlProfileId"),
    enabled: input.enabled === true,
    createdAt: timestamp(input.createdAt, "createdAt"),
  });
}

export function isMemberConfig(value) {
  return assertDigestRecord(value, (entry) => createMemberConfig({
    memberId: entry.memberId,
    teamId: entry.teamId,
    workerName: entry.workerName,
    matrixUserId: entry.matrixUserId,
    role: entry.role,
    controlProfileId: entry.controlProfileId,
    enabled: entry.enabled,
    createdAt: entry.createdAt,
  }), "MemberConfig");
}

export function createWorkSpec(input) {
  assertObject(input, "WorkSpec input");
  assertExactKeys(input, new Set(["workId", "revision", "objective", "scope", "completionContract", "createdAt"]), "WorkSpec");
  return freezeWithDigest({
    kind: "tiangong.work-spec",
    schemaVersion: 1,
    workId: identifier(input.workId, "workId"),
    revision: positiveInteger(input.revision, "revision"),
    objective: bounded(input.objective, "objective", 4096),
    scope: bounded(input.scope, "scope", 4096),
    completionContract: bounded(input.completionContract, "completionContract", 4096),
    createdAt: timestamp(input.createdAt, "createdAt"),
  });
}

export function isWorkSpec(value) {
  return assertDigestRecord(value, (entry) => createWorkSpec({
    workId: entry.workId,
    revision: entry.revision,
    objective: entry.objective,
    scope: entry.scope,
    completionContract: entry.completionContract,
    createdAt: entry.createdAt,
  }), "WorkSpec");
}

export function createTaskSpec(input) {
  assertObject(input, "TaskSpec input");
  assertExactKeys(input, new Set(["taskId", "workId", "assigneeMemberId", "objective", "completionContract", "inputRefs", "createdAt"]), "TaskSpec");
  return freezeWithDigest({
    kind: "tiangong.task-spec",
    schemaVersion: 1,
    taskId: identifier(input.taskId, "taskId"),
    workId: identifier(input.workId, "workId"),
    assigneeMemberId: identifier(input.assigneeMemberId, "assigneeMemberId"),
    objective: bounded(input.objective, "objective", 4096),
    completionContract: bounded(input.completionContract, "completionContract", 4096),
    inputRefs: uniqueStrings(input.inputRefs ?? [], "inputRefs", MAX_INPUT_REFS, (value, name) => digest(value, name)),
    createdAt: timestamp(input.createdAt, "createdAt"),
  });
}

export function isTaskSpec(value) {
  return assertDigestRecord(value, (entry) => createTaskSpec({
    taskId: entry.taskId,
    workId: entry.workId,
    assigneeMemberId: entry.assigneeMemberId,
    objective: entry.objective,
    completionContract: entry.completionContract,
    inputRefs: entry.inputRefs,
    createdAt: entry.createdAt,
  }), "TaskSpec");
}

export function createResult(input) {
  assertObject(input, "Result input");
  assertExactKeys(input, new Set(["resultId", "workId", "taskId", "producerMemberId", "toolResultIds", "artifactRefs", "claim", "blocker", "createdAt"]), "Result");
  const hasClaim = typeof input.claim === "string" && input.claim.length > 0;
  const hasBlocker = typeof input.blocker === "string" && input.blocker.length > 0;
  if (hasClaim === hasBlocker) throw new Error("Result must contain exactly one claim or blocker");
  const record = {
    kind: "tiangong.result",
    schemaVersion: 1,
    resultId: identifier(input.resultId, "resultId"),
    workId: identifier(input.workId, "workId"),
    taskId: identifier(input.taskId, "taskId"),
    producerMemberId: identifier(input.producerMemberId, "producerMemberId"),
    toolResultIds: uniqueStrings(input.toolResultIds ?? [], "toolResultIds", MAX_TOOL_RESULTS, (value, name) => digest(value, name)),
    artifactRefs: uniqueStrings(input.artifactRefs ?? [], "artifactRefs", MAX_ARTIFACT_REFS),
    createdAt: timestamp(input.createdAt, "createdAt"),
  };
  if (hasClaim) record.claim = bounded(input.claim, "claim", 8192);
  if (hasBlocker) record.blocker = bounded(input.blocker, "blocker", 4096);
  return freezeWithDigest(record);
}

export function isResult(value) {
  return assertDigestRecord(value, (entry) => createResult({
    resultId: entry.resultId,
    workId: entry.workId,
    taskId: entry.taskId,
    producerMemberId: entry.producerMemberId,
    toolResultIds: entry.toolResultIds,
    artifactRefs: entry.artifactRefs,
    claim: entry.claim,
    blocker: entry.blocker,
    createdAt: entry.createdAt,
  }), "Result");
}

function workRecord(input) {
  return freezeWithDigest({
    kind: "tiangong.work",
    schemaVersion: 1,
    workId: identifier(input.workId, "workId"),
    teamId: identifier(input.teamId, "teamId"),
    routeId: identifier(input.routeId, "routeId"),
    actorId: bounded(input.actorId, "actorId", 256),
    sourceEventId: bounded(input.sourceEventId, "sourceEventId", 256),
    controlProfileId: identifier(input.controlProfileId, "controlProfileId"),
    leaderSessionId: identifier(input.leaderSessionId, "leaderSessionId"),
    createdAt: timestamp(input.createdAt, "createdAt"),
  });
}

function isWorkRecord(value) {
  try {
    return same(workRecord({
      workId: value.workId,
      teamId: value.teamId,
      routeId: value.routeId,
      actorId: value.actorId,
      sourceEventId: value.sourceEventId,
      controlProfileId: value.controlProfileId,
      leaderSessionId: value.leaderSessionId,
      createdAt: value.createdAt,
    }), value);
  } catch {
    return false;
  }
}

function emptyState() {
  return { sequence: 0, previousHash: GENESIS_HASH, works: {}, tasks: {}, results: {}, wakes: {}, commands: {} };
}

function commandKey(scope, requestId) {
  return `${scope}\u0000${requestId}`;
}

function assertRequest(requestId, name = "requestId") {
  return identifier(requestId, name);
}

function command(scope, requestId, value) {
  return { scope, requestId: assertRequest(requestId), commandDigest: sha256({ scope, value }) };
}

function checkCommand(state, request, expected) {
  const existing = state.commands[commandKey(request.scope, request.requestId)];
  if (!existing) return false;
  if (existing !== request.commandDigest) throw new Error("COMMAND_REQUEST_CONFLICT");
  if (!expected()) throw new Error("COMMAND_REPLAY_STATE_MISSING");
  return true;
}

function profileFor(input) {
  if (!isControlProfile(input)) throw new Error("A schema-valid current ControlProfile is required");
  return input;
}

function verifyProfile(work, profile) {
  if (work.controlProfileId !== profile.profileId) throw new Error("CONTROL_PROFILE_MISMATCH");
}

function clone(value) {
  return structuredClone(value);
}

function snapshotWork(entry) {
  return clone({
    work: entry.work,
    epoch: entry.epoch,
    status: entry.status,
    currentWorkSpec: entry.currentWorkSpec,
    timeline: entry.timeline,
  });
}

function snapshotTask(entry) {
  return clone(entry);
}

function snapshotWake(entry) {
  return clone(entry);
}

function validatePath(filePath) {
  if (typeof filePath !== "string" || !isAbsolute(filePath)) throw new TypeError("CoordinationStore filePath must be absolute");
  return filePath;
}

async function appendRecords(filePath, records) {
  if (records.length === 0) return;
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await open(filePath, "a", 0o600);
  try {
    await handle.writeFile(records.map((record) => `${canonicalJson(record)}\n`).join(""));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function eventRecord(state, event, sequence, previousHash) {
  const unsigned = {
    version: JOURNAL_VERSION,
    sequence,
    previousHash,
    type: event.type,
    at: timestamp(event.at, "event.at"),
    ...(event.command ? { command: event.command } : {}),
    payload: event.payload,
  };
  return { ...unsigned, hash: sha256(unsigned) };
}

function appendTimeline(entry, record, payload, epoch) {
  const actorId = payload.actorId ?? entry.work.actorId;
  entry.timeline.push({
    sequence: record.sequence,
    eventHash: record.hash,
    type: record.type,
    at: record.at,
    actorId,
    requestId: record.command?.requestId ?? null,
    epoch,
    payload: clone(payload),
  });
  if (entry.timeline.length > entry.profile.maxTimelineEntries) throw new Error("WORK_TIMELINE_LIMIT_EXCEEDED");
}

function applyRecord(state, record) {
  const { hash, ...unsigned } = record ?? {};
  if (record?.version !== JOURNAL_VERSION || record.sequence !== state.sequence + 1 ||
      record.previousHash !== state.previousHash || hash !== sha256(unsigned)) {
    throw new Error(`Invalid coordination journal at sequence ${state.sequence + 1}`);
  }
  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) throw new Error("Invalid coordination event payload");
  if (record.command) {
    const c = record.command;
    if (typeof c.scope !== "string" || typeof c.requestId !== "string" || !DIGEST.test(c.commandDigest)) throw new Error("Invalid coordination command identity");
    const key = commandKey(c.scope, c.requestId);
    const previous = state.commands[key];
    if (previous && previous !== c.commandDigest) throw new Error("Conflicting coordination command identity");
    state.commands[key] = c.commandDigest;
  }
  const payload = record.payload;
  if (record.type === "work-created") {
    if (state.works[payload.work?.workId]) throw new Error("WORK_ALREADY_EXISTS");
    if (!isWorkRecord(payload.work) || !isControlProfile(payload.profile) || !isTeamConfig(payload.team) || !isTeamRouteBinding(payload.route) || !isWorkSpec(payload.spec)) {
      throw new Error("Invalid work-created binding");
    }
    if (payload.route.teamId !== payload.team.teamId || payload.work.teamId !== payload.team.teamId ||
        payload.work.routeId !== payload.route.routeId || payload.work.controlProfileId !== payload.profile.profileId ||
        payload.spec.workId !== payload.work.workId) throw new Error("Work binding mismatch");
    const entry = {
      work: payload.work,
      team: payload.team,
      route: payload.route,
      profile: payload.profile,
      currentWorkSpec: payload.spec,
      epoch: 0,
      status: "open",
      timeline: [],
    };
    state.works[payload.work.workId] = entry;
    appendTimeline(entry, record, payload, 0);
  } else if (record.type === "work-spec-changed") {
    const entry = state.works[payload.workId];
    if (!entry || entry.status !== "open" || !isWorkSpec(payload.spec)) throw new Error("Invalid work-spec-changed event");
    if (payload.spec.workId !== payload.workId || payload.expectedEpoch !== entry.epoch || payload.spec.revision !== entry.currentWorkSpec.revision + 1) {
      throw new Error("WORK_EPOCH_OR_SPEC_CONFLICT");
    }
    entry.epoch += 1;
    entry.currentWorkSpec = payload.spec;
    appendTimeline(entry, record, payload, entry.epoch);
  } else if (record.type === "task-created") {
    const entry = state.works[payload.task?.workId];
    if (!entry || entry.status !== "open" || !isTaskSpec(payload.task)) throw new Error("Invalid task-created event");
    if (state.tasks[payload.task.taskId]) throw new Error("TASK_ALREADY_EXISTS");
    if (payload.task.workId !== entry.work.workId || payload.expectedEpoch !== entry.epoch || entry.timeline.length >= entry.profile.maxTimelineEntries ||
        Object.values(state.tasks).filter((task) => task.spec.workId === entry.work.workId).length >= entry.profile.maxTasksPerWork) {
      throw new Error("TASK_WORK_CONFLICT");
    }
    entry.epoch += 1;
    state.tasks[payload.task.taskId] = { spec: payload.task, status: "assigned", result: null, cancellation: null };
    appendTimeline(entry, record, payload, entry.epoch);
  } else if (record.type === "task-cancelled") {
    const entry = state.works[payload.workId];
    const task = state.tasks[payload.taskId];
    if (!entry || !task || task.spec.workId !== payload.workId || entry.status !== "open" || payload.expectedEpoch !== entry.epoch || task.result || task.status === "cancelled") {
      throw new Error("TASK_CANCEL_CONFLICT");
    }
    entry.epoch += 1;
    task.status = "cancelled";
    task.cancellation = { actorId: payload.actorId, reason: payload.reason, at: record.at };
    appendTimeline(entry, record, payload, entry.epoch);
  } else if (record.type === "result-submitted") {
    const entry = state.works[payload.result?.workId];
    const task = state.tasks[payload.result?.taskId];
    if (!entry || !task || !isResult(payload.result) || task.spec.workId !== payload.result.workId ||
        entry.status !== "open" || payload.expectedEpoch !== entry.epoch || task.result || task.status === "cancelled") {
      throw new Error("RESULT_TASK_CONFLICT");
    }
    entry.epoch += 1;
    task.status = "reported";
    task.result = payload.result;
    state.results[payload.result.resultId] = payload.result;
    appendTimeline(entry, record, payload, entry.epoch);
  } else if (record.type === "wake-enqueued") {
    const wake = payload.wake;
    if (!wake || typeof wake !== "object" || state.wakes[wake.wakeId] || !ID.test(wake.wakeId) || !ID.test(wake.targetMemberId) ||
        !["task-assignment", "leader-resume", "result-notification", "human-reply"].includes(wake.kind) || wake.status !== "pending") {
      throw new Error("Invalid wake-enqueued event");
    }
    if (Object.keys(state.wakes).length >= MAX_OUTBOX_ENTRIES) throw new Error("OUTBOX_LIMIT_EXCEEDED");
    state.wakes[wake.wakeId] = wake;
  } else if (record.type === "wake-claimed") {
    const wake = state.wakes[payload.wakeId];
    if (!wake || !ID.test(payload.consumerId) || (wake.status !== "pending" && !(wake.status === "claimed" && wake.consumerId === payload.consumerId))) {
      throw new Error("WAKE_CLAIM_CONFLICT");
    }
    if (wake.status === "pending") {
      wake.status = "claimed";
      wake.consumerId = payload.consumerId;
      wake.claimedAt = record.at;
    }
  } else if (record.type === "wake-acked") {
    const wake = state.wakes[payload.wakeId];
    if (!wake || wake.status !== "claimed" || wake.consumerId !== payload.consumerId || !bounded(payload.receiptId, "receiptId", 256)) {
      throw new Error("WAKE_ACK_CONFLICT");
    }
    wake.status = "acked";
    wake.receiptId = payload.receiptId;
    wake.ackedAt = record.at;
  } else {
    throw new Error(`Unknown coordination event type: ${record.type}`);
  }
  state.sequence = record.sequence;
  state.previousHash = record.hash;
}

export class CoordinationStore {
  #filePath;
  #maxJournalBytes;
  #now;
  #state = emptyState();
  #queue = Promise.resolve();
  #initialized = false;

  constructor({ filePath, now = () => new Date().toISOString(), maxJournalBytes = MAX_JOURNAL_BYTES } = {}) {
    this.#filePath = validatePath(filePath);
    if (typeof now !== "function") throw new TypeError("CoordinationStore now must be a function");
    if (!Number.isSafeInteger(maxJournalBytes) || maxJournalBytes < 1024 || maxJournalBytes > MAX_JOURNAL_BYTES) throw new TypeError("maxJournalBytes is outside the bounded range");
    this.#maxJournalBytes = maxJournalBytes;
    this.#now = now;
  }

  async #reload() {
    let metadata;
    try {
      metadata = await lstat(this.#filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.#state = emptyState();
      this.#initialized = true;
      return;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > this.#maxJournalBytes) throw new Error("Coordination journal file is invalid");
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      await chmod(this.#filePath, 0o600);
      metadata = await lstat(this.#filePath);
      if ((metadata.mode & 0o077) !== 0) throw new Error("Coordination journal permissions cannot be restricted");
    }
    const state = emptyState();
    const text = await readFile(this.#filePath, "utf8");
    if (text !== "" && !text.endsWith("\n")) throw new Error("Coordination journal has a partial record");
    for (const line of text.split("\n")) {
      if (line === "") continue;
      let record;
      try { record = JSON.parse(line); } catch { throw new Error("Coordination journal contains invalid JSON"); }
      applyRecord(state, record);
    }
    this.#state = state;
    this.#initialized = true;
  }

  async #mutate(builder) {
    const operation = this.#queue.then(() => withFileLock(this.#filePath, async () => {
      await this.#reload();
      const transaction = await builder(this.#state);
      if (!transaction || !Array.isArray(transaction.events) || transaction.events.length === 0) return transaction?.result;
      const preview = clone(this.#state);
      const records = [];
      let sequence = preview.sequence;
      let previousHash = preview.previousHash;
      for (const event of transaction.events) {
        const record = eventRecord(preview, event, sequence + 1, previousHash);
        applyRecord(preview, record);
        records.push(record);
        sequence = record.sequence;
        previousHash = record.hash;
      }
      await appendRecords(this.#filePath, records);
      this.#state = preview;
      return transaction.result;
    }));
    this.#queue = operation.catch(() => {});
    return operation;
  }

  async #read(callback) {
    await this.#queue;
    return withFileLock(this.#filePath, async () => {
      await this.#reload();
      return callback(this.#state);
    });
  }

  async createWork({ workId, team, route, profile, spec, actorId, sourceEventId, requestId, leaderSessionId, wakes = [] } = {}) {
    const currentProfile = profileFor(profile);
    if (!isTeamConfig(team) || !isTeamRouteBinding(route) || !isWorkSpec(spec)) throw new Error("Work admission requires valid TeamConfig, route binding, and WorkSpec");
    if (team.controlProfileId !== currentProfile.profileId || route.teamId !== team.teamId || spec.workId !== workId) throw new Error("WORK_ADMISSION_BINDING_MISMATCH");
    const sessionId = leaderSessionId ?? `leader-${sha256({ workId, teamId: team.teamId, routeId: route.routeId }).slice(0, 48)}`;
    const work = workRecord({ workId, teamId: team.teamId, routeId: route.routeId, actorId, sourceEventId, controlProfileId: currentProfile.profileId, leaderSessionId: sessionId, createdAt: spec.createdAt });
    if (!Array.isArray(wakes) || wakes.length > 2) throw new TypeError("Work wakes must contain at most two entries");
    const wakeRecords = wakes.map((wake) => {
      const kind = wake?.kind;
      if (!["leader-resume", "human-reply"].includes(kind)) throw new Error("Unsupported Work wake kind");
      return {
        wakeId: sha256({ kind, workId, targetMemberId: wake.targetMemberId, requestId }),
        kind,
        workId: identifier(workId, "workId"),
        targetMemberId: identifier(wake.targetMemberId, "wake.targetMemberId"),
        status: "pending",
        createdAt: spec.createdAt,
      };
    });
    const request = command("work.create", requestId, { work, team, route, profile: currentProfile, spec, wakes: wakeRecords });
    return this.#mutate((state) => {
      const replay = checkCommand(state, request, () => state.works[work.workId] && same(state.works[work.workId].work, work) && wakeRecords.every((wake) => state.wakes[wake.wakeId] && same(state.wakes[wake.wakeId], wake)));
      if (replay) return { events: [], result: { replayed: true, work: snapshotWork(state.works[work.workId]), wakes: wakeRecords.map((wake) => snapshotWake(state.wakes[wake.wakeId])) } };
      if (state.works[work.workId]) throw new Error("WORK_ALREADY_EXISTS");
      if (wakeRecords.some((wake) => state.wakes[wake.wakeId])) throw new Error("WAKE_ALREADY_EXISTS");
      const events = [{ type: "work-created", at: spec.createdAt, command: request, payload: { work, team, route, profile: currentProfile, spec, actorId } }];
      for (const wake of wakeRecords) events.push({ type: "wake-enqueued", at: spec.createdAt, payload: { wake } });
      return {
        events,
        result: { replayed: false, work: null, wakes: [] },
      };
    }).then(async (result) => result?.work ? result : { ...result, work: await this.getWork(work.workId), wakes: await Promise.all(wakeRecords.map((wake) => this.getWake(wake.wakeId))) });
  }

  async changeWorkSpec({ workId, spec, profile, actorId, expectedEpoch, requestId } = {}) {
    const currentProfile = profileFor(profile);
    if (!isWorkSpec(spec)) throw new Error("WorkSpec is invalid");
    const request = command("work.spec.change", requestId, { workId, spec, actorId, expectedEpoch, profileId: currentProfile.profileId });
    return this.#mutate((state) => {
      const entry = state.works[workId];
      if (!entry) throw new Error("WORK_NOT_FOUND");
      verifyProfile(entry.work, currentProfile);
      const replay = checkCommand(state, request, () => entry.currentWorkSpec && same(entry.currentWorkSpec, spec));
      if (replay) return { events: [], result: { replayed: true, work: snapshotWork(entry) } };
      if (entry.status !== "open" || spec.workId !== workId || spec.revision !== entry.currentWorkSpec.revision + 1 || expectedEpoch !== entry.epoch) throw new Error("WORK_EPOCH_OR_SPEC_CONFLICT");
      return {
        events: [{ type: "work-spec-changed", at: spec.createdAt, command: request, payload: { workId, spec, actorId, expectedEpoch } }],
        result: { replayed: false, work: null },
      };
    }).then(async (result) => result?.work ? result : { ...result, work: await this.getWork(workId) });
  }

  async createTask({ task, team, member, profile, actorId, expectedEpoch, requestId, wake } = {}) {
    const currentProfile = profileFor(profile);
    if (!isTaskSpec(task) || !isTeamConfig(team) || !isMemberConfig(member)) throw new Error("Task admission requires valid TaskSpec, TeamConfig, and MemberConfig");
    if (task.assigneeMemberId !== member.memberId || member.teamId !== team.teamId || member.controlProfileId !== currentProfile.profileId || !member.enabled) throw new Error("TASK_ASSIGNEE_BINDING_MISMATCH");
    const request = command("task.create", requestId, { task, teamId: team.teamId, member, actorId, expectedEpoch, profileId: currentProfile.profileId, wake: wake ?? null });
    const wakeRecord = wake ? {
      wakeId: sha256({ kind: wake.kind ?? "task-assignment", taskId: task.taskId, requestId }),
      kind: wake.kind ?? "task-assignment",
      workId: task.workId,
      taskId: task.taskId,
      targetMemberId: identifier(wake.targetMemberId ?? member.memberId, "wake.targetMemberId"),
      status: "pending",
      createdAt: task.createdAt,
    } : null;
    return this.#mutate((state) => {
      const entry = state.works[task.workId];
      if (!entry) throw new Error("WORK_NOT_FOUND");
      verifyProfile(entry.work, currentProfile);
      const replay = checkCommand(state, request, () => state.tasks[task.taskId]?.spec && same(state.tasks[task.taskId].spec, task));
      if (replay) return { events: [], result: { replayed: true, task: snapshotTask(state.tasks[task.taskId]), wake: wakeRecord ? snapshotWake(state.wakes[wakeRecord.wakeId]) : null } };
      if (entry.status !== "open" || expectedEpoch !== entry.epoch || state.tasks[task.taskId]) throw new Error("TASK_WORK_CONFLICT");
      const events = [{ type: "task-created", at: task.createdAt, command: request, payload: { task, actorId, expectedEpoch } }];
      if (wakeRecord) events.push({ type: "wake-enqueued", at: task.createdAt, payload: { wake: wakeRecord } });
      return { events, result: { replayed: false, task: null, wake: null } };
    }).then(async (result) => result?.task ? result : { ...result, task: await this.getTask(task.taskId), wake: wakeRecord ? await this.getWake(wakeRecord.wakeId) : null });
  }

  async cancelTask({ workId, taskId, profile, actorId, reason, expectedEpoch, requestId } = {}) {
    const currentProfile = profileFor(profile);
    const normalizedReason = bounded(reason, "reason", 2048);
    const request = command("task.cancel", requestId, { workId, taskId, actorId, reason: normalizedReason, expectedEpoch, profileId: currentProfile.profileId });
    return this.#mutate((state) => {
      const entry = state.works[workId];
      const task = state.tasks[taskId];
      if (!entry || !task) throw new Error("TASK_NOT_FOUND");
      verifyProfile(entry.work, currentProfile);
      const replay = checkCommand(state, request, () => task.status === "cancelled");
      if (replay) return { events: [], result: { replayed: true, task: snapshotTask(task) } };
      if (entry.status !== "open" || task.spec.workId !== workId || task.result || task.status === "cancelled" || expectedEpoch !== entry.epoch) throw new Error("TASK_CANCEL_CONFLICT");
      return { events: [{ type: "task-cancelled", at: this.#now(), command: request, payload: { workId, taskId, actorId, reason: normalizedReason, expectedEpoch } }], result: { replayed: false, task: null } };
    }).then(async (result) => result?.task ? result : { ...result, task: await this.getTask(taskId) });
  }

  async submitResult({ result, team, member, profile, actorId, expectedEpoch, requestId, toolResultStore } = {}) {
    const currentProfile = profileFor(profile);
    if (!isResult(result) || !isTeamConfig(team) || !isMemberConfig(member)) throw new Error("Result submission requires valid Result, TeamConfig, and MemberConfig");
    if (result.producerMemberId !== member.memberId || member.teamId !== team.teamId || member.controlProfileId !== currentProfile.profileId || !member.enabled) throw new Error("RESULT_PRODUCER_BINDING_MISMATCH");
    if (!toolResultStore || typeof toolResultStore.get !== "function" || typeof toolResultStore.markRetention !== "function") {
      if (result.toolResultIds.length > 0) throw new TypeError("ToolResult store is required for cited ToolResults");
    }
    const retentionUntil = new Date(Date.parse(result.createdAt) + currentProfile.toolResultRetentionMs).toISOString();
    for (const toolResultId of result.toolResultIds) {
      const observed = await toolResultStore.get(toolResultId);
      if (!observed) throw new Error("TOOL_RESULT_NOT_FOUND");
      if (observed.workId !== result.workId || observed.taskId !== result.taskId) throw new Error("TOOL_RESULT_OWNER_MISMATCH");
      await toolResultStore.markRetention(toolResultId, { workId: result.workId, until: retentionUntil });
    }
    const request = command("task.result.submit", requestId, { result, teamId: team.teamId, member, actorId, expectedEpoch, profileId: currentProfile.profileId });
    return this.#mutate((state) => {
      const entry = state.works[result.workId];
      const task = state.tasks[result.taskId];
      if (!entry || !task) throw new Error("TASK_NOT_FOUND");
      verifyProfile(entry.work, currentProfile);
      const replay = checkCommand(state, request, () => task.result && same(task.result, result));
      if (replay) return { events: [], result: { replayed: true, result: clone(task.result) } };
      if (entry.status !== "open" || task.spec.workId !== result.workId || task.spec.assigneeMemberId !== member.memberId || task.result || task.status === "cancelled" || expectedEpoch !== entry.epoch) throw new Error("RESULT_TASK_CONFLICT");
      return { events: [{ type: "result-submitted", at: result.createdAt, command: request, payload: { result, actorId, expectedEpoch } }], result: { replayed: false, result: null } };
    }).then(async (value) => value?.result ? value : { ...value, result: await this.getResult(result.resultId) });
  }

  async enqueueWake({ workId, taskId, targetMemberId, kind = "leader-resume", requestId, at = this.#now() } = {}) {
    if (!["task-assignment", "leader-resume", "result-notification", "human-reply"].includes(kind)) throw new Error("Unsupported wake kind");
    const wake = { wakeId: sha256({ kind, workId, taskId: taskId ?? null, requestId }), kind, ...(workId ? { workId: identifier(workId, "workId") } : {}), ...(taskId ? { taskId: identifier(taskId, "taskId") } : {}), targetMemberId: identifier(targetMemberId, "targetMemberId"), status: "pending", createdAt: timestamp(at, "at") };
    const request = command("wake.enqueue", requestId, wake);
    return this.#mutate((state) => {
      const replay = checkCommand(state, request, () => state.wakes[wake.wakeId] && same(state.wakes[wake.wakeId], wake));
      if (replay) return { events: [], result: { replayed: true, wake: snapshotWake(state.wakes[wake.wakeId]) } };
      if (state.wakes[wake.wakeId]) throw new Error("WAKE_ALREADY_EXISTS");
      return { events: [{ type: "wake-enqueued", at: wake.createdAt, command: request, payload: { wake } }], result: { replayed: false, wake } };
    });
  }

  async claimWake({ wakeId, consumerId, requestId, at = this.#now() } = {}) {
    const normalizedWakeId = digest(wakeId, "wakeId");
    const normalizedConsumer = identifier(consumerId, "consumerId");
    const request = command("wake.claim", requestId, { wakeId: normalizedWakeId, consumerId: normalizedConsumer });
    return this.#mutate((state) => {
      const wake = state.wakes[normalizedWakeId];
      if (!wake) throw new Error("WAKE_NOT_FOUND");
      const replay = checkCommand(state, request, () => wake.status === "claimed" && wake.consumerId === normalizedConsumer);
      if (replay) return { events: [], result: { replayed: true, wake: snapshotWake(wake) } };
      if (wake.status !== "pending") throw new Error("WAKE_CLAIM_CONFLICT");
      return { events: [{ type: "wake-claimed", at: timestamp(at, "at"), command: request, payload: { wakeId: normalizedWakeId, consumerId: normalizedConsumer } }], result: { replayed: false, wake: null } };
    }).then(async (result) => result?.wake ? result : { ...result, wake: await this.getWake(normalizedWakeId) });
  }

  async ackWake({ wakeId, consumerId, receiptId, requestId, at = this.#now() } = {}) {
    const normalizedWakeId = digest(wakeId, "wakeId");
    const normalizedConsumer = identifier(consumerId, "consumerId");
    const normalizedReceipt = bounded(receiptId, "receiptId", 256);
    const request = command("wake.ack", requestId, { wakeId: normalizedWakeId, consumerId: normalizedConsumer, receiptId: normalizedReceipt });
    return this.#mutate((state) => {
      const wake = state.wakes[normalizedWakeId];
      if (!wake) throw new Error("WAKE_NOT_FOUND");
      const replay = checkCommand(state, request, () => wake.status === "acked" && wake.consumerId === normalizedConsumer && wake.receiptId === normalizedReceipt);
      if (replay) return { events: [], result: { replayed: true, wake: snapshotWake(wake) } };
      if (wake.status !== "claimed" || wake.consumerId !== normalizedConsumer) throw new Error("WAKE_ACK_CONFLICT");
      return { events: [{ type: "wake-acked", at: timestamp(at, "at"), command: request, payload: { wakeId: normalizedWakeId, consumerId: normalizedConsumer, receiptId: normalizedReceipt } }], result: { replayed: false, wake: null } };
    }).then(async (result) => result?.wake ? result : { ...result, wake: await this.getWake(normalizedWakeId) });
  }

  async getWork(workId) {
    const id = identifier(workId, "workId");
    return this.#read((state) => state.works[id] ? snapshotWork(state.works[id]) : undefined);
  }

  async listWorks() {
    return this.#read((state) => Object.values(state.works).map(snapshotWork));
  }

  async getTask(taskId) {
    const id = identifier(taskId, "taskId");
    return this.#read((state) => state.tasks[id] ? snapshotTask(state.tasks[id]) : undefined);
  }

  async listTasks({ workId } = {}) {
    if (workId !== undefined) identifier(workId, "workId");
    return this.#read((state) => Object.values(state.tasks)
      .filter((task) => workId === undefined || task.spec.workId === workId)
      .map(snapshotTask));
  }

  async getResult(resultId) {
    const id = identifier(resultId, "resultId");
    return this.#read((state) => state.results[id] ? clone(state.results[id]) : undefined);
  }

  async listResults({ workId } = {}) {
    if (workId !== undefined) identifier(workId, "workId");
    return this.#read((state) => Object.values(state.results)
      .filter((result) => workId === undefined || result.workId === workId)
      .map(clone));
  }

  async getWake(wakeId) {
    const id = digest(wakeId, "wakeId");
    return this.#read((state) => state.wakes[id] ? snapshotWake(state.wakes[id]) : undefined);
  }

  async listOutbox({ status } = {}) {
    if (status !== undefined && !["pending", "claimed", "acked"].includes(status)) throw new Error("Unsupported outbox status");
    return this.#read((state) => Object.values(state.wakes).filter((wake) => status === undefined || wake.status === status).map(snapshotWake));
  }

  async health() {
    return this.#read((state) => ({ sequence: state.sequence, journalHash: state.previousHash, workCount: Object.keys(state.works).length, taskCount: Object.keys(state.tasks).length, outboxCount: Object.keys(state.wakes).length }));
  }
}

export { GENESIS_HASH };

import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { withFileLock } from "../persistence/file-lock.mjs";

const STATE_VERSION = 2;
const ID = /^[A-Za-z0-9@!#$%&*+./:=?_-]{1,160}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const ERROR_CODE = /^[A-Z0-9_:-]{1,96}$/u;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_TIMELINE_ENTRIES = 4096;
const MAX_OUTBOX_ENTRIES = 1024;
const MAX_TASKS_PER_WORK = 256;
const MAX_INPUTS = 32;
const MAX_REFS = 64;
const MAX_LIST_ITEMS = 64;
const TERMINAL_WORK_STATUSES = new Set(["completed", "stopped"]);

function clone(value) { return structuredClone(value); }
function same(left, right) { return canonicalJson(left) === canonicalJson(right); }
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}
function exact(value, allowed, name) {
  object(value, name);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error(`${name} contains unknown fields: ${unexpected.join(",")}`);
}
function bounded(value, name, limit = 4096, { singleLine = true } = {}) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > limit || /\u0000/u.test(value) || (singleLine && /[\r\n]/u.test(value))) {
    throw new TypeError(`${name} is missing or exceeds the bounded limit`);
  }
  return value;
}
function optionalBounded(value, name, limit = 4096) {
  return value === undefined ? undefined : bounded(value, name, limit);
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
  return new Date(normalized).toISOString();
}
function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${name} must be a positive bounded integer`);
  return value;
}
function stringList(input, name, maximum = MAX_LIST_ITEMS) {
  if (!Array.isArray(input) || input.length > maximum) throw new TypeError(`${name} must be a bounded array`);
  const values = input.map((value, index) => bounded(value, `${name}[${index}]`, 2048));
  if (new Set(values).size !== values.length) throw new Error(`${name} contains duplicates`);
  return Object.freeze(values);
}
function idList(input, name, maximum = MAX_LIST_ITEMS) {
  if (!Array.isArray(input) || input.length > maximum) throw new TypeError(`${name} must be a bounded array`);
  const values = input.map((value, index) => identifier(value, `${name}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${name} contains duplicates`);
  return Object.freeze(values);
}
function freezeDigest(record) {
  const body = Object.freeze({ ...record });
  return Object.freeze({ ...body, contentDigest: sha256(canonicalJson(body)) });
}
function recordInput(value) {
  const { kind: _kind, schemaVersion: _schemaVersion, contentDigest: _contentDigest, ...input } = value;
  return input;
}
function digestRecord(value, recreate) {
  try { return !!value && typeof value === "object" && !Array.isArray(value) && same(recreate(recordInput(value)), value); } catch { return false; }
}

export function createContentRef(input) {
  exact(input, new Set(["repositoryId", "commitSha", "adapter", "ref"]), "ContentRef");
  const git = input.repositoryId !== undefined || input.commitSha !== undefined;
  const adapter = input.adapter !== undefined || input.ref !== undefined;
  if (git === adapter) throw new Error("ContentRef must be exactly one Git or Adapter reference");
  if (git) return Object.freeze({ repositoryId: identifier(input.repositoryId, "repositoryId"), commitSha: bounded(input.commitSha, "commitSha", 128) });
  return Object.freeze({ adapter: identifier(input.adapter, "adapter"), ref: bounded(input.ref, "ref", 512) });
}
export function isContentRef(value) {
  try { return same(createContentRef(value), value); } catch { return false; }
}
function contentRefList(input, name, maximum = MAX_REFS) {
  if (!Array.isArray(input) || input.length > maximum) throw new TypeError(`${name} must be a bounded array`);
  const values = input.map(createContentRef);
  const keys = values.map(canonicalJson);
  if (new Set(keys).size !== keys.length) throw new Error(`${name} contains duplicates`);
  return Object.freeze(values);
}

export function createControlProfile(input) {
  exact(input, new Set(["profileId", "revision", "maxTimelineEntries", "maxOutboxEntries", "maxTasksPerWork", "toolResultRetentionMs"]), "ControlProfile");
  return freezeDigest({
    kind: "tiangong.control-profile", schemaVersion: 1,
    profileId: identifier(input.profileId, "profileId"),
    revision: positiveInteger(input.revision, "revision"),
    maxTimelineEntries: positiveInteger(input.maxTimelineEntries, "maxTimelineEntries", MAX_TIMELINE_ENTRIES),
    maxOutboxEntries: positiveInteger(input.maxOutboxEntries, "maxOutboxEntries", MAX_OUTBOX_ENTRIES),
    maxTasksPerWork: positiveInteger(input.maxTasksPerWork, "maxTasksPerWork", MAX_TASKS_PER_WORK),
    toolResultRetentionMs: positiveInteger(input.toolResultRetentionMs, "toolResultRetentionMs", 365 * 24 * 60 * 60 * 1000),
  });
}
export function isControlProfile(value) { return digestRecord(value, createControlProfile); }

export function createTeamConfig(input) {
  exact(input, new Set(["teamId", "revision", "leaderMemberId", "memberIds", "controlProfileId", "createdAt"]), "TeamConfig");
  const members = idList(input.memberIds, "memberIds");
  const leader = identifier(input.leaderMemberId, "leaderMemberId");
  if (!members.includes(leader)) throw new Error("leaderMemberId must be present in memberIds");
  return freezeDigest({ kind: "tiangong.team-config", schemaVersion: 1, teamId: identifier(input.teamId, "teamId"), revision: positiveInteger(input.revision, "revision"), leaderMemberId: leader, memberIds: members, controlProfileId: identifier(input.controlProfileId, "controlProfileId"), createdAt: timestamp(input.createdAt, "createdAt") });
}
export function isTeamConfig(value) { return digestRecord(value, createTeamConfig); }

export function createTeamRouteBinding(input) {
  exact(input, new Set(["routeId", "teamId", "revision", "channel", "roomId", "createdAt"]), "TeamRouteBinding");
  if (input.channel !== "matrix") throw new Error("TeamRouteBinding channel must be matrix");
  return freezeDigest({ kind: "tiangong.team-route-binding", schemaVersion: 1, routeId: identifier(input.routeId, "routeId"), teamId: identifier(input.teamId, "teamId"), revision: positiveInteger(input.revision, "revision"), channel: "matrix", roomId: bounded(input.roomId, "roomId", 256), createdAt: timestamp(input.createdAt, "createdAt") });
}
export function isTeamRouteBinding(value) { return digestRecord(value, createTeamRouteBinding); }

export function createMemberConfig(input) {
  exact(input, new Set(["memberId", "teamId", "workerName", "matrixUserId", "role", "controlProfileId", "enabled", "createdAt", "runtime", "model", "allowedSkills"]), "MemberConfig");
  const runtime = input.runtime ?? (input.role === "developer" || input.role === "implementor" ? "codex-app-server" : "openclaw-built-in");
  if (!["openclaw-built-in", "codex-app-server"].includes(runtime)) throw new Error("MemberConfig runtime is unsupported");
  return freezeDigest({
    kind: "tiangong.member-config", schemaVersion: 2,
    memberId: identifier(input.memberId, "memberId"), teamId: identifier(input.teamId, "teamId"),
    workerName: identifier(input.workerName, "workerName"), matrixUserId: bounded(input.matrixUserId, "matrixUserId", 256),
    role: bounded(input.role, "role", 128), controlProfileId: identifier(input.controlProfileId, "controlProfileId"),
    enabled: input.enabled === true, runtime, model: identifier(input.model ?? (runtime === "codex-app-server" ? "deepseek-v4-flash" : "deepseek-chat"), "model"),
    allowedSkills: idList(input.allowedSkills ?? [], "allowedSkills", 64), createdAt: timestamp(input.createdAt, "createdAt"),
  });
}
export function isMemberConfig(value) { return digestRecord(value, createMemberConfig); }

export function createWorkSpec(input) {
  exact(input, new Set(["workId", "revision", "goal", "scope", "constraints", "doneWhen", "unresolvedAssumptions", "createdAt"]), "WorkSpec");
  const doneWhen = stringList(input.doneWhen, "doneWhen", 32);
  if (doneWhen.length === 0) throw new Error("doneWhen must not be empty");
  return Object.freeze({
    kind: "tiangong.work-spec", schemaVersion: 2, workId: identifier(input.workId, "workId"), revision: positiveInteger(input.revision, "revision"),
    goal: bounded(input.goal, "goal", 4096, { singleLine: false }), scope: stringList(input.scope ?? [], "scope", 32),
    constraints: stringList(input.constraints ?? [], "constraints", 32), doneWhen,
    unresolvedAssumptions: stringList(input.unresolvedAssumptions ?? [], "unresolvedAssumptions", 32), createdAt: timestamp(input.createdAt, "createdAt"),
  });
}
export function isWorkSpec(value) { try { return same(createWorkSpec(recordInput(value)), value); } catch { return false; } }

export function createTaskSpec(input) {
  exact(input, new Set(["taskId", "workId", "assigneeMemberId", "objective", "inputs", "constraints", "createdAt"]), "TaskSpec");
  return Object.freeze({
    kind: "tiangong.task-spec", schemaVersion: 2, taskId: identifier(input.taskId, "taskId"), workId: identifier(input.workId, "workId"),
    assigneeMemberId: identifier(input.assigneeMemberId, "assigneeMemberId"), objective: bounded(input.objective, "objective", 4096, { singleLine: false }),
    inputs: contentRefList(input.inputs ?? [], "inputs", MAX_INPUTS), constraints: stringList(input.constraints ?? [], "constraints", 32), createdAt: timestamp(input.createdAt, "createdAt"),
  });
}
export function isTaskSpec(value) { try { return same(createTaskSpec(recordInput(value)), value); } catch { return false; } }

export function createResult(input) {
  exact(input, new Set(["workId", "taskId", "submittedBy", "summary", "deliverableRefs", "toolResultRefs", "createdAt"]), "Result");
  const toolResultRefs = (input.toolResultRefs ?? []).map((value, index) => digest(value, `toolResultRefs[${index}]`));
  if (toolResultRefs.length > MAX_REFS || new Set(toolResultRefs).size !== toolResultRefs.length) throw new Error("toolResultRefs must be bounded and unique");
  return Object.freeze({
    kind: "tiangong.result", schemaVersion: 2, workId: identifier(input.workId, "workId"), taskId: identifier(input.taskId, "taskId"),
    submittedBy: identifier(input.submittedBy, "submittedBy"), summary: bounded(input.summary, "summary", 8192, { singleLine: false }),
    deliverableRefs: contentRefList(input.deliverableRefs ?? [], "deliverableRefs"),
    toolResultRefs: Object.freeze(toolResultRefs),
    createdAt: timestamp(input.createdAt, "createdAt"),
  });
}
export function isResult(value) { try { return same(createResult(recordInput(value)), value); } catch { return false; } }

function workRecord(input) {
  return Object.freeze({
    kind: "tiangong.work", schemaVersion: 2, workId: identifier(input.workId, "workId"), teamId: identifier(input.teamId, "teamId"),
    routeId: identifier(input.routeId, "routeId"), roomId: bounded(input.roomId, "roomId", 256), title: bounded(input.title, "title", 160),
    actorId: bounded(input.actorId, "actorId", 256), sourceEventId: bounded(input.sourceEventId, "sourceEventId", 256),
    controlProfileId: identifier(input.controlProfileId, "controlProfileId"), leaderSessionId: identifier(input.leaderSessionId, "leaderSessionId"),
    createdAt: timestamp(input.createdAt, "createdAt"),
  });
}
function bindingKey(roomId, eventId) { return `${roomId}\u0000${eventId}`; }
function commandKey(scope, requestId) { return `${scope}\u0000${requestId}`; }
function admissionKey(roomId, eventId) { return bindingKey(roomId, eventId); }
function sessionFor(workId, teamId, routeId) { return `leader-${sha256({ workId, teamId, routeId }).slice(0, 48)}`; }
function workIdFor(teamId, routeId, eventId) { return `work-${sha256({ teamId, routeId, eventId }).slice(0, 48)}`; }
function emptyState() { return { version: STATE_VERSION, works: {}, tasks: {}, results: {}, bindings: {}, admissions: {}, wakes: {}, commands: {} }; }
function snapshotWork(entry) { return clone({ work: entry.work, epoch: entry.epoch, status: entry.status, currentWorkSpec: entry.currentWorkSpec, currentPlanRef: entry.currentPlanRef, timeline: entry.timeline }); }
function snapshotTask(entry) { return clone({ spec: entry.spec, status: entry.result ? "reported" : entry.cancellation ? "cancelled" : "assigned", result: entry.result, cancellation: entry.cancellation }); }
function snapshotAdmission(entry) { return clone(entry); }
function snapshotWake(entry) { return clone(entry); }
function validatePath(filePath) { if (typeof filePath !== "string" || !isAbsolute(filePath)) throw new TypeError("CoordinationStore filePath must be absolute"); return filePath; }

function assertStoredState(state) {
  if (!state || state.version !== STATE_VERSION || !state.works || !state.tasks || !state.results || !state.bindings || !state.admissions || !state.wakes || !state.commands) throw new Error("Coordination state is invalid or obsolete");
  return state;
}
async function loadState(filePath, maxBytes) {
  try {
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maxBytes) throw new Error("Coordination state file is invalid");
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      await chmod(filePath, 0o600);
      if (((await lstat(filePath)).mode & 0o077) !== 0) throw new Error("Coordination state permissions cannot be restricted");
    }
    return assertStoredState(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
}
async function saveState(filePath, state) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${randomUUID()}`;
  await writeFile(temporary, `${canonicalJson(state)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, filePath);
}
function replay(state, scope, requestId, payload) {
  const request = identifier(requestId, "requestId");
  const key = commandKey(scope, request);
  const hash = sha256({ scope, payload });
  if (state.commands[key]) {
    if (state.commands[key] !== hash) throw new Error("COMMAND_REQUEST_CONFLICT");
    return { request, key, hash, replayed: true };
  }
  return { request, key, hash, replayed: false };
}
function recordCommand(state, identity) { state.commands[identity.key] = identity.hash; }
function assertProfile(entry, profile) { if (!isControlProfile(profile) || entry.work.controlProfileId !== profile.profileId) throw new Error("CONTROL_PROFILE_MISMATCH"); }
function assertTimeline(entry) { if (entry.timeline.length >= Math.min(entry.profile.maxTimelineEntries, MAX_TIMELINE_ENTRIES)) throw new Error("WORK_TIMELINE_LIMIT_EXCEEDED"); }
function appendTimeline(entry, { type, at, actorId, requestId, payload, epoch = entry.epoch }) {
  assertTimeline(entry);
  entry.timeline.push({ sequence: entry.timeline.length + 1, type, at: timestamp(at, "timeline.at"), actorId: bounded(actorId, "actorId", 256), requestId: requestId ?? null, epoch, payload: clone(payload) });
}
function earlierPending(state, admission) {
  return Object.values(state.admissions).some((entry) => entry.roomId === admission.roomId && entry.status === "pending" && (entry.receivedAt < admission.receivedAt || (entry.receivedAt === admission.receivedAt && entry.eventId < admission.eventId)));
}
function normalizeGuard(result) {
  const value = result ?? {};
  for (const field of ["activeExecutions", "unresolvedOperations", "pendingApprovals", "unreadableContentRefs"]) {
    if (!Array.isArray(value[field] ?? []) || (value[field] ?? []).some((entry) => typeof entry !== "string" || entry.length > 512)) throw new Error("CLOSE_GUARD_RESPONSE_INVALID");
  }
  return { activeExecutions: value.activeExecutions ?? [], unresolvedOperations: value.unresolvedOperations ?? [], pendingApprovals: value.pendingApprovals ?? [], unreadableContentRefs: value.unreadableContentRefs ?? [] };
}

export class CoordinationStore {
  #filePath; #maxStateBytes; #now; #queue = Promise.resolve(); #closeGuard; #cancellationGuard; #contentRefResolver;
  constructor({ filePath, now = () => new Date().toISOString(), maxStateBytes = MAX_STATE_BYTES, closeGuard, cancellationGuard, contentRefResolver } = {}) {
    this.#filePath = validatePath(filePath);
    if (typeof now !== "function") throw new TypeError("CoordinationStore now must be a function");
    if (!Number.isSafeInteger(maxStateBytes) || maxStateBytes < 1024 || maxStateBytes > MAX_STATE_BYTES) throw new TypeError("maxStateBytes is outside the bounded range");
    this.#now = now; this.#maxStateBytes = maxStateBytes;
    this.#closeGuard = closeGuard ?? { async inspect() { return {}; } };
    this.#cancellationGuard = cancellationGuard ?? { async stopAndInspect() { return { stopped: true, writerReleased: true, unresolvedOperations: [] }; } };
    this.#contentRefResolver = contentRefResolver;
  }
  async #mutate(callback) {
    const operation = this.#queue.then(() => withFileLock(this.#filePath, async () => {
      const state = await loadState(this.#filePath, this.#maxStateBytes);
      const result = await callback(state);
      if (result?.changed) await saveState(this.#filePath, state);
      return result?.value;
    }));
    this.#queue = operation.catch(() => {}); return operation;
  }
  async #read(callback) { await this.#queue; return withFileLock(this.#filePath, async () => callback(await loadState(this.#filePath, this.#maxStateBytes))); }

  async enqueueMessageAdmission({ team, route, profile, actorId, eventId, receivedAt = this.#now(), requestId } = {}) {
    if (!isTeamConfig(team) || !isTeamRouteBinding(route) || !isControlProfile(profile)) throw new Error("Message admission requires current Team, route, and ControlProfile");
    if (route.teamId !== team.teamId || team.controlProfileId !== profile.profileId) throw new Error("MESSAGE_ADMISSION_BINDING_MISMATCH");
    const admission = { roomId: bounded(route.roomId, "roomId", 256), eventId: bounded(eventId, "eventId", 256), teamId: team.teamId, routeId: route.routeId, actorId: bounded(actorId, "actorId", 256), status: "pending", receivedAt: timestamp(receivedAt, "receivedAt"), attempts: 0, lastErrorCode: null, leaseOwner: null, leaseUntil: null };
    const identityPayload = { ...admission, profileId: profile.profileId };
    return this.#mutate((state) => {
      const identity = replay(state, "message.admit", requestId, identityPayload);
      const key = admissionKey(admission.roomId, admission.eventId);
      if (identity.replayed) {
        const current = state.admissions[key];
        if (!current) throw new Error("COMMAND_REPLAY_STATE_MISSING");
        return { changed: false, value: { replayed: true, admission: snapshotAdmission(current), binding: state.bindings[key] ? clone(state.bindings[key]) : null } };
      }
      if (state.admissions[key]) throw new Error("MATRIX_MESSAGE_ALREADY_ADMITTED");
      state.admissions[key] = admission; recordCommand(state, identity);
      return { changed: true, value: { replayed: false, admission: snapshotAdmission(admission), binding: null } };
    });
  }

  async leaseMessageAdmission({ roomId, eventId, consumerId, leaseMs = 120_000 } = {}) {
    const consumer = identifier(consumerId, "consumerId");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60_000) throw new Error("MESSAGE_ADMISSION_LEASE_INVALID");
    return this.#mutate((state) => {
      const admission = state.admissions[admissionKey(roomId, eventId)];
      if (!admission || admission.status !== "pending") throw new Error("MESSAGE_ADMISSION_NOT_PENDING");
      const now = timestamp(this.#now(), "now");
      if (admission.leaseOwner && Date.parse(admission.leaseUntil) > Date.parse(now)) {
        if (admission.leaseOwner !== consumer) throw new Error("MESSAGE_ADMISSION_LEASE_CONFLICT");
        return { changed: false, value: { replayed: true, admission: snapshotAdmission(admission) } };
      }
      admission.leaseOwner = consumer; admission.leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString(); admission.attempts += 1;
      return { changed: true, value: { replayed: false, admission: snapshotAdmission(admission) } };
    });
  }

  async recordAdmissionFailure({ roomId, eventId, errorCode, requestId } = {}) {
    const code = bounded(errorCode, "errorCode", 96); if (!ERROR_CODE.test(code)) throw new Error("ADMISSION_ERROR_CODE_INVALID");
    return this.#mutate((state) => {
      const key = admissionKey(roomId, eventId); const admission = state.admissions[key]; if (!admission || admission.status !== "pending") throw new Error("MESSAGE_ADMISSION_NOT_PENDING");
      const identity = replay(state, "message.admit.failure", requestId, { roomId, eventId, errorCode: code });
      if (identity.replayed) return { changed: false, value: { replayed: true, admission: snapshotAdmission(admission) } };
      admission.lastErrorCode = code; admission.leaseOwner = null; admission.leaseUntil = null; recordCommand(state, identity);
      return { changed: true, value: { replayed: false, admission: snapshotAdmission(admission) } };
    });
  }

  async routeMessage({ roomId, eventId, team, route, profile, actorId, expectedEpoch, requestId, targetWorkId, title, leaderSessionId } = {}) {
    if (!isTeamConfig(team) || !isTeamRouteBinding(route) || !isControlProfile(profile) || actorId !== team.leaderMemberId) throw new Error("MESSAGE_ROUTE_ACTOR_NOT_LEADER");
    if (route.roomId !== roomId || route.teamId !== team.teamId || team.controlProfileId !== profile.profileId) throw new Error("MESSAGE_ROUTE_BINDING_MISMATCH");
    return this.#mutate((state) => {
      const key = admissionKey(roomId, eventId); const admission = state.admissions[key];
      if (!admission || admission.teamId !== team.teamId || admission.routeId !== route.routeId) throw new Error("MESSAGE_ADMISSION_NOT_FOUND");
      if (admission.leaseOwner && admission.leaseOwner !== actorId) throw new Error("MESSAGE_ADMISSION_LEASE_CONFLICT");
      const requestedTarget = targetWorkId ? identifier(targetWorkId, "targetWorkId") : null;
      const payload = { roomId, eventId, targetWorkId: requestedTarget, title: title ?? null, actorId, expectedEpoch: expectedEpoch ?? null, profileId: profile.profileId };
      const identity = replay(state, "message.route", requestId, payload);
      if (identity.replayed || admission.status === "routed") {
        const binding = state.bindings[key]; if (!binding) throw new Error("COMMAND_REPLAY_STATE_MISSING");
        return { changed: false, value: { replayed: true, admission: snapshotAdmission(admission), binding: clone(binding), work: snapshotWork(state.works[binding.workId]) } };
      }
      if (earlierPending(state, admission)) throw new Error("MESSAGE_ROUTE_ORDER_CONFLICT");
      let entry;
      if (requestedTarget) {
        entry = state.works[requestedTarget];
        if (!entry || entry.status !== "open" || entry.work.teamId !== team.teamId || entry.work.routeId !== route.routeId || expectedEpoch !== entry.epoch) throw new Error("MESSAGE_ROUTE_TARGET_CONFLICT");
        assertProfile(entry, profile); entry.epoch += 1;
        appendTimeline(entry, { type: "matrix-message-associated", at: this.#now(), actorId, requestId: identity.request, epoch: entry.epoch, payload: { roomId, eventId, humanActorId: admission.actorId } });
      } else {
        const workId = workIdFor(team.teamId, route.routeId, eventId); if (state.works[workId]) throw new Error("WORK_ALREADY_EXISTS");
        const createdAt = admission.receivedAt; const sessionId = leaderSessionId ?? sessionFor(workId, team.teamId, route.routeId);
        const work = workRecord({ workId, teamId: team.teamId, routeId: route.routeId, roomId, title: bounded(title, "title", 160), actorId: admission.actorId, sourceEventId: eventId, controlProfileId: profile.profileId, leaderSessionId: sessionId, createdAt });
        entry = { work, team, route, profile, epoch: 0, status: "open", currentWorkSpec: null, currentPlanRef: null, timeline: [] };
        appendTimeline(entry, { type: "work-created", at: createdAt, actorId, requestId: identity.request, epoch: 0, payload: { work, source: { roomId, eventId, actorId: admission.actorId } } });
        state.works[workId] = entry;
      }
      const binding = { roomId, eventId, workId: entry.work.workId, actorId: admission.actorId, associatedBy: actorId, associatedAt: this.#now(), correctedAt: null };
      state.bindings[key] = binding; admission.status = "routed"; admission.workId = entry.work.workId; admission.routedAt = binding.associatedAt; admission.leaseOwner = null; admission.leaseUntil = null; recordCommand(state, identity);
      return { changed: true, value: { replayed: false, admission: snapshotAdmission(admission), binding: clone(binding), work: snapshotWork(entry) } };
    });
  }

  async correctMessageAssociation({ roomId, eventId, correctionEventId, team, route, profile, actorId, expectedSourceEpoch, expectedTargetEpoch, requestId, targetWorkId, title, stopSourceIfEmpty = false } = {}) {
    if (!isTeamConfig(team) || !isTeamRouteBinding(route) || !isControlProfile(profile) || actorId !== team.leaderMemberId) throw new Error("MESSAGE_CORRECTION_ACTOR_NOT_LEADER");
    if (route.roomId !== roomId || route.teamId !== team.teamId || team.controlProfileId !== profile.profileId) throw new Error("MESSAGE_CORRECTION_BINDING_MISMATCH");
    return this.#mutate(async (state) => {
      const originalKey = bindingKey(roomId, eventId); const correctionKey = admissionKey(roomId, correctionEventId);
      const current = state.bindings[originalKey]; const correction = state.admissions[correctionKey];
      if (!current || !correction || correction.status !== "pending" || correction.actorId === actorId) throw new Error("MESSAGE_CORRECTION_INPUT_INVALID");
      if (correction.leaseOwner && correction.leaseOwner !== actorId) throw new Error("MESSAGE_ADMISSION_LEASE_CONFLICT");
      const source = state.works[current.workId]; if (!source || source.status !== "open" || source.epoch !== expectedSourceEpoch) throw new Error("MESSAGE_CORRECTION_SOURCE_CONFLICT");
      const requestedTarget = targetWorkId ? identifier(targetWorkId, "targetWorkId") : null;
      const identity = replay(state, "message.correct", requestId, { roomId, eventId, correctionEventId, sourceWorkId: source.work.workId, targetWorkId: requestedTarget, title: title ?? null, actorId, expectedSourceEpoch, expectedTargetEpoch: expectedTargetEpoch ?? null, stopSourceIfEmpty });
      if (identity.replayed) {
        const binding = state.bindings[originalKey]; return { changed: false, value: { replayed: true, binding: clone(binding), sourceWork: snapshotWork(source), targetWork: snapshotWork(state.works[binding.workId]) } };
      }
      let target;
      if (requestedTarget) {
        target = state.works[requestedTarget];
        if (!target || target.status !== "open" || target.work.teamId !== team.teamId || target.work.routeId !== route.routeId || target.epoch !== expectedTargetEpoch || target.work.workId === source.work.workId) throw new Error("MESSAGE_CORRECTION_TARGET_CONFLICT");
      } else {
        const newId = workIdFor(team.teamId, route.routeId, correctionEventId); if (state.works[newId]) throw new Error("WORK_ALREADY_EXISTS");
        const work = workRecord({ workId: newId, teamId: team.teamId, routeId: route.routeId, roomId, title: bounded(title, "title", 160), actorId: correction.actorId, sourceEventId: correctionEventId, controlProfileId: profile.profileId, leaderSessionId: sessionFor(newId, team.teamId, route.routeId), createdAt: correction.receivedAt });
        target = { work, team, route, profile, epoch: 0, status: "open", currentWorkSpec: null, currentPlanRef: null, timeline: [] };
        appendTimeline(target, { type: "work-created", at: correction.receivedAt, actorId, requestId: identity.request, epoch: 0, payload: { work, source: { roomId, eventId: correctionEventId, actorId: correction.actorId } } });
        state.works[newId] = target;
      }
      const sourceTasks = Object.values(state.tasks).filter((task) => task.spec.workId === source.work.workId);
      if (stopSourceIfEmpty) {
        if (sourceTasks.length > 0) throw new Error("MESSAGE_CORRECTION_SOURCE_NOT_EMPTY");
        const guard = normalizeGuard(await this.#closeGuard.inspect({ work: snapshotWork(source), tasks: [], resultRefs: [], action: "stop" }));
        if (guard.activeExecutions.length || guard.unresolvedOperations.length || guard.pendingApprovals.length || guard.unreadableContentRefs.length) throw new Error("MESSAGE_CORRECTION_SOURCE_NOT_EMPTY");
      }
      source.epoch += 1; target.epoch += 1;
      const at = this.#now(); const correctionPayload = { roomId, eventId, correctionEventId, sourceWorkId: source.work.workId, targetWorkId: target.work.workId, humanActorId: correction.actorId };
      appendTimeline(source, { type: "message-association-corrected", at, actorId, requestId: identity.request, epoch: source.epoch, payload: correctionPayload });
      appendTimeline(target, { type: "message-association-corrected", at, actorId, requestId: identity.request, epoch: target.epoch, payload: correctionPayload });
      if (stopSourceIfEmpty) { source.status = "stopped"; appendTimeline(source, { type: "work-stopped", at, actorId, requestId: identity.request, epoch: source.epoch, payload: { reason: `Message association corrected to ${target.work.workId}` } }); }
      const corrected = { ...current, workId: target.work.workId, associatedBy: actorId, associatedAt: at, correctedAt: at };
      state.bindings[originalKey] = corrected;
      state.bindings[correctionKey] = { roomId, eventId: correctionEventId, workId: target.work.workId, actorId: correction.actorId, associatedBy: actorId, associatedAt: at, correctedAt: null };
      correction.status = "routed"; correction.workId = target.work.workId; correction.routedAt = at; correction.leaseOwner = null; correction.leaseUntil = null; recordCommand(state, identity);
      return { changed: true, value: { replayed: false, binding: clone(corrected), sourceWork: snapshotWork(source), targetWork: snapshotWork(target) } };
    });
  }

  async createWork({ workId, team, route, profile, spec = null, title = "Requirement pending", actorId, sourceEventId, requestId, leaderSessionId, wakes = [] } = {}) {
    if (!isTeamConfig(team) || !isTeamRouteBinding(route) || !isControlProfile(profile) || (spec !== null && !isWorkSpec(spec))) throw new Error("Work admission requires valid bindings and optional WorkSpec");
    const id = identifier(workId, "workId");
    if (route.teamId !== team.teamId || team.controlProfileId !== profile.profileId || (spec && spec.workId !== id)) throw new Error("WORK_ADMISSION_BINDING_MISMATCH");
    if (!Array.isArray(wakes) || wakes.length > 2) throw new TypeError("Work wakes must contain at most two entries");
    const createdAt = spec?.createdAt ?? this.#now();
    const work = workRecord({ workId: id, teamId: team.teamId, routeId: route.routeId, roomId: route.roomId, title, actorId, sourceEventId, controlProfileId: profile.profileId, leaderSessionId: leaderSessionId ?? sessionFor(id, team.teamId, route.routeId), createdAt });
    const created = await this.#mutate((state) => {
      const identity = replay(state, "work.create", requestId, { work, team, route, profile, spec });
      if (identity.replayed) {
        const existing = state.works[id]; if (!existing) throw new Error("COMMAND_REPLAY_STATE_MISSING");
        return { changed: false, value: { replayed: true, work: snapshotWork(existing) } };
      }
      const key = bindingKey(route.roomId, sourceEventId);
      if (state.works[id]) throw new Error("WORK_ALREADY_EXISTS");
      if (state.bindings[key]) throw new Error("MATRIX_MESSAGE_ALREADY_BOUND");
      const entry = { work, team, route, profile, epoch: 0, status: "open", currentWorkSpec: spec, currentPlanRef: null, timeline: [] };
      appendTimeline(entry, { type: "work-created", at: createdAt, actorId, requestId: identity.request, epoch: 0, payload: { work, source: { roomId: route.roomId, eventId: sourceEventId, actorId }, ...(spec ? { spec } : {}) } });
      state.works[id] = entry;
      state.bindings[key] = { roomId: route.roomId, eventId: sourceEventId, workId: id, actorId, associatedBy: team.leaderMemberId, associatedAt: createdAt, correctedAt: null };
      state.admissions[key] = { roomId: route.roomId, eventId: sourceEventId, teamId: team.teamId, routeId: route.routeId, actorId, status: "routed", receivedAt: createdAt, attempts: 0, lastErrorCode: null, leaseOwner: null, leaseUntil: null, workId: id, routedAt: createdAt };
      recordCommand(state, identity);
      return { changed: true, value: { replayed: false, work: snapshotWork(entry) } };
    });
    const wakeRecords = [];
    if (!created.replayed) for (const wake of wakes) wakeRecords.push((await this.enqueueWake({ workId: id, targetMemberId: wake.targetMemberId, kind: wake.kind, requestId: `${requestId}-${wake.kind}`, at: createdAt })).wake);
    else wakeRecords.push(...(await this.listOutbox()).filter((wake) => wake.workId === id));
    return { ...created, wakes: wakeRecords };
  }

  async changeWorkTitle({ workId, title, profile, actorId, expectedEpoch, requestId } = {}) {
    const normalized = bounded(title, "title", 160); return this.#workChange("work.title.change", { workId, profile, actorId, expectedEpoch, requestId, payload: { title: normalized }, type: "work-title-changed", apply: (entry) => { entry.work = Object.freeze({ ...entry.work, title: normalized }); } });
  }
  async changeWorkSpec({ workId, spec, profile, actorId, expectedEpoch, requestId } = {}) {
    if (!isWorkSpec(spec) || spec.workId !== workId) throw new Error("WorkSpec is invalid");
    return this.#workChange("work.spec.change", { workId, profile, actorId, expectedEpoch, requestId, payload: { spec }, type: "work-spec-changed", validate: (entry) => spec.revision === (entry.currentWorkSpec?.revision ?? 0) + 1, apply: (entry) => { entry.currentWorkSpec = spec; }, at: spec.createdAt });
  }
  async changeWorkPlan({ workId, planRef, reason, profile, actorId, expectedEpoch, requestId } = {}) {
    const ref = createContentRef(planRef); const normalizedReason = bounded(reason, "reason", 2048);
    return this.#workChange("work.plan.change", { workId, profile, actorId, expectedEpoch, requestId, payload: { planRef: ref, reason: normalizedReason }, type: "work-plan-changed", apply: (entry) => { entry.currentPlanRef = ref; } });
  }
  async #workChange(scope, { workId, profile, actorId, expectedEpoch, requestId, payload, type, validate = () => true, apply, at = this.#now() }) {
    return this.#mutate((state) => {
      const id = identifier(workId, "workId"); const entry = state.works[id]; if (!entry) throw new Error("WORK_NOT_FOUND"); assertProfile(entry, profile);
      const identity = replay(state, scope, requestId, { workId: id, actorId, expectedEpoch, profileId: profile.profileId, ...payload });
      if (identity.replayed) return { changed: false, value: { replayed: true, work: snapshotWork(entry) } };
      if (actorId !== entry.team.leaderMemberId) throw new Error("WORK_ACTOR_NOT_LEADER");
      if (entry.status !== "open" || entry.epoch !== expectedEpoch || !validate(entry)) throw new Error("WORK_EPOCH_OR_CHANGE_CONFLICT");
      entry.epoch += 1; apply(entry); appendTimeline(entry, { type, at, actorId, requestId: identity.request, epoch: entry.epoch, payload: { workId: id, ...payload } }); recordCommand(state, identity);
      return { changed: true, value: { replayed: false, work: snapshotWork(entry) } };
    });
  }

  async createTask({ task, team, member, profile, actorId, expectedEpoch, requestId, wake } = {}) {
    if (!isTaskSpec(task) || !isTeamConfig(team) || !isMemberConfig(member) || !isControlProfile(profile)) throw new Error("Task admission requires valid bindings");
    if (actorId !== team.leaderMemberId) throw new Error("TASK_ACTOR_NOT_LEADER");
    if (task.assigneeMemberId !== member.memberId || member.teamId !== team.teamId || member.controlProfileId !== profile.profileId || !member.enabled) throw new Error("TASK_ASSIGNEE_BINDING_MISMATCH");
    return this.#mutate((state) => {
      const entry = state.works[task.workId]; if (!entry) throw new Error("WORK_NOT_FOUND"); assertProfile(entry, profile);
      const identity = replay(state, "task.create", requestId, { task, teamId: team.teamId, memberId: member.memberId, actorId, expectedEpoch, wake: wake ?? null });
      if (identity.replayed) return { changed: false, value: { replayed: true, task: snapshotTask(state.tasks[task.taskId]), wake: null } };
      if (entry.status !== "open" || !entry.currentWorkSpec || entry.epoch !== expectedEpoch || state.tasks[task.taskId] || Object.values(state.tasks).filter((item) => item.spec.workId === task.workId).length >= profile.maxTasksPerWork) throw new Error("TASK_WORK_CONFLICT");
      entry.epoch += 1; state.tasks[task.taskId] = { spec: task, result: null, cancellation: null };
      appendTimeline(entry, { type: "task-created", at: task.createdAt, actorId, requestId: identity.request, epoch: entry.epoch, payload: { task } }); recordCommand(state, identity);
      return { changed: true, value: { replayed: false, task: snapshotTask(state.tasks[task.taskId]), wake: null } };
    }).then(async (result) => {
      if (!wake || result.replayed) return result;
      const enqueued = await this.enqueueWake({ workId: task.workId, taskId: task.taskId, targetMemberId: member.memberId, kind: wake.kind ?? "task-assignment", requestId: `${requestId}-wake`, at: task.createdAt });
      return { ...result, wake: enqueued.wake };
    });
  }

  async cancelTask({ workId, taskId, team, profile, actorId, reason, expectedEpoch, requestId } = {}) {
    if (!isTeamConfig(team) || actorId !== team.leaderMemberId) throw new Error("TASK_CANCEL_ACTOR_NOT_LEADER");
    const normalizedReason = bounded(reason, "reason", 2048);
    return this.#mutate(async (state) => {
      const entry = state.works[workId]; const task = state.tasks[taskId]; if (!entry || !task || task.spec.workId !== workId) throw new Error("TASK_NOT_FOUND"); assertProfile(entry, profile);
      const identity = replay(state, "task.cancel", requestId, { workId, taskId, actorId, reason: normalizedReason, expectedEpoch, profileId: profile.profileId });
      if (identity.replayed) return { changed: false, value: { replayed: true, task: snapshotTask(task) } };
      if (entry.status !== "open" || entry.epoch !== expectedEpoch || task.result || task.cancellation) throw new Error("TASK_CANCEL_CONFLICT");
      const guard = await this.#cancellationGuard.stopAndInspect({ workId, taskId });
      if (guard?.stopped !== true || guard?.writerReleased !== true || !Array.isArray(guard?.unresolvedOperations) || guard.unresolvedOperations.length) throw new Error("TASK_CANCEL_GUARD_FAILED");
      const at = this.#now(); entry.epoch += 1; task.cancellation = { actorId, reason: normalizedReason, at };
      appendTimeline(entry, { type: "task-cancelled", at, actorId, requestId: identity.request, epoch: entry.epoch, payload: { workId, taskId, reason: normalizedReason } }); recordCommand(state, identity);
      return { changed: true, value: { replayed: false, task: snapshotTask(task) } };
    });
  }

  async submitResult({ result, team, member, profile, actorId, expectedEpoch, requestId, toolResultStore, contentRefResolver = this.#contentRefResolver } = {}) {
    if (!isResult(result) || !isTeamConfig(team) || !isMemberConfig(member) || !isControlProfile(profile)) throw new Error("Result submission requires valid bindings");
    if (result.submittedBy !== member.memberId || actorId !== member.memberId || member.teamId !== team.teamId || member.controlProfileId !== profile.profileId || !member.enabled) throw new Error("RESULT_PRODUCER_BINDING_MISMATCH");
    if (result.deliverableRefs.length && (!contentRefResolver || typeof contentRefResolver.canRead !== "function")) throw new Error("CONTENT_REF_RESOLVER_UNAVAILABLE");
    for (const ref of result.deliverableRefs) if (!await contentRefResolver.canRead(ref)) throw new Error("CONTENT_REF_UNREADABLE");
    if (result.toolResultRefs.length && (!toolResultStore || typeof toolResultStore.get !== "function" || typeof toolResultStore.markRetention !== "function")) throw new Error("TOOL_RESULT_STORE_UNAVAILABLE");
    const retentionUntil = new Date(Date.parse(result.createdAt) + profile.toolResultRetentionMs).toISOString();
    for (const id of result.toolResultRefs) {
      const observed = await toolResultStore.get(id); if (!observed) throw new Error("TOOL_RESULT_NOT_FOUND");
      if (observed.workId !== result.workId || observed.taskId !== result.taskId || observed.actorId !== actorId) throw new Error("TOOL_RESULT_OWNER_MISMATCH");
      await toolResultStore.markRetention(id, { workId: result.workId, until: retentionUntil });
    }
    return this.#mutate((state) => {
      const entry = state.works[result.workId]; const task = state.tasks[result.taskId]; if (!entry || !task || task.spec.workId !== result.workId) throw new Error("TASK_NOT_FOUND"); assertProfile(entry, profile);
      const identity = replay(state, "task.result.submit", requestId, { result, teamId: team.teamId, memberId: member.memberId, actorId, expectedEpoch });
      if (identity.replayed) return { changed: false, value: { replayed: true, result: clone(task.result) } };
      if (entry.status !== "open" || entry.epoch !== expectedEpoch || task.spec.assigneeMemberId !== member.memberId || task.result || task.cancellation) throw new Error("RESULT_TASK_CONFLICT");
      entry.epoch += 1; task.result = result; state.results[result.taskId] = result;
      appendTimeline(entry, { type: "result-submitted", at: result.createdAt, actorId, requestId: identity.request, epoch: entry.epoch, payload: { result } }); recordCommand(state, identity);
      return { changed: true, value: { replayed: false, result: clone(result) } };
    });
  }

  async closeWork({ workId, team, profile, actorId, action, reason, expectedEpoch, requestId } = {}) {
    if (!isTeamConfig(team) || !isControlProfile(profile) || actorId !== team.leaderMemberId) throw new Error("WORK_CLOSE_ACTOR_NOT_LEADER");
    if (!["complete", "stop"].includes(action)) throw new Error("WORK_CLOSE_INVALID");
    const normalizedReason = bounded(reason, "reason", 4096);
    return this.#mutate(async (state) => {
      const entry = state.works[workId]; if (!entry) throw new Error("WORK_NOT_FOUND"); assertProfile(entry, profile);
      const identity = replay(state, "work.close", requestId, { workId, teamId: team.teamId, actorId, action, reason: normalizedReason, expectedEpoch, profileId: profile.profileId });
      if (identity.replayed) return { changed: false, value: { replayed: true, action, work: snapshotWork(entry) } };
      if (entry.status !== "open" || entry.epoch !== expectedEpoch || entry.work.teamId !== team.teamId || (action === "complete" && !entry.currentWorkSpec)) throw new Error("WORK_CLOSE_CONFLICT");
      const tasks = Object.values(state.tasks).filter((task) => task.spec.workId === workId);
      if (tasks.some((task) => !task.result && !task.cancellation)) throw new Error("WORK_CLOSE_GUARD_FAILED");
      const resultRefs = tasks.flatMap((task) => task.result?.deliverableRefs ?? []);
      const guard = normalizeGuard(await this.#closeGuard.inspect({ work: snapshotWork(entry), tasks: tasks.map(snapshotTask), resultRefs: clone(resultRefs), action }));
      if (guard.activeExecutions.length || guard.unresolvedOperations.length || guard.pendingApprovals.length || guard.unreadableContentRefs.length) throw new Error("WORK_CLOSE_GUARD_FAILED");
      if (resultRefs.length) {
        if (!this.#contentRefResolver || typeof this.#contentRefResolver.canRead !== "function") throw new Error("WORK_CLOSE_GUARD_FAILED");
        for (const ref of resultRefs) if (!await this.#contentRefResolver.canRead(ref)) throw new Error("WORK_CLOSE_GUARD_FAILED");
      }
      const at = this.#now(); entry.epoch += 1; entry.status = action === "complete" ? "completed" : "stopped";
      appendTimeline(entry, { type: action === "complete" ? "work-completed" : "work-stopped", at, actorId, requestId: identity.request, epoch: entry.epoch, payload: { reason: normalizedReason } }); recordCommand(state, identity);
      return { changed: true, value: { replayed: false, action, work: snapshotWork(entry) } };
    });
  }

  async enqueueWake({ workId, taskId, targetMemberId, kind = "leader-resume", requestId, at = this.#now() } = {}) {
    if (!["task-assignment", "leader-resume", "result-notification", "human-reply"].includes(kind)) throw new Error("Unsupported wake kind");
    const wake = { wakeId: sha256({ kind, workId: workId ?? null, taskId: taskId ?? null, requestId }), ...(workId ? { workId: identifier(workId, "workId") } : {}), ...(taskId ? { taskId: identifier(taskId, "taskId") } : {}), kind, targetMemberId: identifier(targetMemberId, "targetMemberId"), status: "pending", createdAt: timestamp(at, "at") };
    return this.#mutate((state) => {
      const identity = replay(state, "wake.enqueue", requestId, wake);
      if (identity.replayed) return { changed: false, value: { replayed: true, wake: snapshotWake(state.wakes[wake.wakeId]) } };
      if (Object.values(state.wakes).filter((entry) => entry.status !== "acked").length >= MAX_OUTBOX_ENTRIES || state.wakes[wake.wakeId]) throw new Error("OUTBOX_LIMIT_EXCEEDED");
      state.wakes[wake.wakeId] = wake; recordCommand(state, identity); return { changed: true, value: { replayed: false, wake: snapshotWake(wake) } };
    });
  }
  async claimWake({ wakeId, consumerId, requestId, at = this.#now() } = {}) {
    return this.#mutate((state) => {
      const id = digest(wakeId, "wakeId"); const consumer = identifier(consumerId, "consumerId"); const wake = state.wakes[id]; if (!wake) throw new Error("WAKE_NOT_FOUND");
      const identity = replay(state, "wake.claim", requestId, { wakeId: id, consumerId: consumer });
      if (identity.replayed) return { changed: false, value: { replayed: true, wake: snapshotWake(wake) } };
      if (wake.status !== "pending") throw new Error("WAKE_CLAIM_CONFLICT");
      wake.status = "claimed"; wake.consumerId = consumer; wake.claimedAt = timestamp(at, "at"); recordCommand(state, identity); return { changed: true, value: { replayed: false, wake: snapshotWake(wake) } };
    });
  }
  async ackWake({ wakeId, consumerId, receiptId, requestId, at = this.#now() } = {}) {
    return this.#mutate((state) => {
      const id = digest(wakeId, "wakeId"); const consumer = identifier(consumerId, "consumerId"); const receipt = bounded(receiptId, "receiptId", 256); const wake = state.wakes[id]; if (!wake) throw new Error("WAKE_NOT_FOUND");
      const identity = replay(state, "wake.ack", requestId, { wakeId: id, consumerId: consumer, receiptId: receipt });
      if (identity.replayed) return { changed: false, value: { replayed: true, wake: snapshotWake(wake) } };
      if (wake.status !== "claimed" || wake.consumerId !== consumer) throw new Error("WAKE_ACK_CONFLICT");
      wake.status = "acked"; wake.receiptId = receipt; wake.ackedAt = timestamp(at, "at"); recordCommand(state, identity); return { changed: true, value: { replayed: false, wake: snapshotWake(wake) } };
    });
  }

  async getWork(workId) { const id = identifier(workId, "workId"); return this.#read((state) => state.works[id] ? snapshotWork(state.works[id]) : undefined); }
  async listWorks({ teamId, roomId, status } = {}) { return this.#read((state) => Object.values(state.works).filter((entry) => (teamId === undefined || entry.work.teamId === teamId) && (roomId === undefined || entry.work.roomId === roomId) && (status === undefined || entry.status === status)).map(snapshotWork)); }
  async getTask(taskId) { const id = identifier(taskId, "taskId"); return this.#read((state) => state.tasks[id] ? snapshotTask(state.tasks[id]) : undefined); }
  async listTasks({ workId } = {}) { return this.#read((state) => Object.values(state.tasks).filter((task) => workId === undefined || task.spec.workId === workId).map(snapshotTask)); }
  async getResult(taskId) { const id = identifier(taskId, "taskId"); return this.#read((state) => state.results[id] ? clone(state.results[id]) : undefined); }
  async listResults({ workId } = {}) { return this.#read((state) => Object.values(state.results).filter((result) => workId === undefined || result.workId === workId).map(clone)); }
  async getMessageBinding(roomId, eventId) { return this.#read((state) => state.bindings[bindingKey(roomId, eventId)] ? clone(state.bindings[bindingKey(roomId, eventId)]) : undefined); }
  async listMessageAdmissions({ roomId, status } = {}) { if (status !== undefined && !["pending", "routed"].includes(status)) throw new Error("MESSAGE_ADMISSION_STATUS_INVALID"); return this.#read((state) => Object.values(state.admissions).filter((entry) => (roomId === undefined || entry.roomId === roomId) && (status === undefined || entry.status === status)).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.eventId.localeCompare(b.eventId)).map(snapshotAdmission)); }
  async admissionMetrics({ roomId } = {}) { const pending = await this.listMessageAdmissions({ roomId, status: "pending" }); return { pendingCount: pending.length, oldestReceivedAt: pending[0]?.receivedAt ?? null, lastErrorCode: [...pending].reverse().find((entry) => entry.lastErrorCode)?.lastErrorCode ?? null }; }
  async getWake(wakeId) { const id = digest(wakeId, "wakeId"); return this.#read((state) => state.wakes[id] ? snapshotWake(state.wakes[id]) : undefined); }
  async listOutbox({ status } = {}) { if (status !== undefined && !["pending", "claimed", "acked"].includes(status)) throw new Error("Unsupported outbox status"); return this.#read((state) => Object.values(state.wakes).filter((wake) => status === undefined || wake.status === status).map(snapshotWake)); }
  async health() { return this.#read((state) => ({ backend: "file", workCount: Object.keys(state.works).length, taskCount: Object.keys(state.tasks).length, pendingAdmissionCount: Object.values(state.admissions).filter((entry) => entry.status === "pending").length, outboxCount: Object.keys(state.wakes).length })); }
}

export const GENESIS_HASH = undefined;

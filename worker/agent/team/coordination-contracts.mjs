import { canonicalJson, sha256 } from "../canonical-json.mjs";
const ID = /^[A-Za-z0-9@!#$%&*+./:=?_-]{1,160}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const MAX_TIMELINE_ENTRIES = 4096;
const MAX_OUTBOX_ENTRIES = 1024;
const MAX_TASKS_PER_WORK = 256;
const MAX_INPUTS = 32;
const MAX_REFS = 64;
const MAX_LIST_ITEMS = 64;
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
  exact(input, new Set(["memberId", "teamId", "workerName", "matrixUserId", "role", "controlProfileId", "enabled", "createdAt", "revision", "runtime", "model", "agentPackageId", "agentPackageVersion", "allowedSkills"]), "MemberConfig");
  const responsibility = input.role === "team_leader" ? "leader" : input.role === "implementor" ? "developer" : input.role;
  const runtime = input.runtime ?? "openclaw-built-in";
  if (runtime !== "openclaw-built-in") throw new Error("MemberConfig runtime is unsupported");
  const agentPackageVersion = bounded(input.agentPackageVersion ?? "1.0.0", "agentPackageVersion", 32);
  if (!/^\d+\.\d+\.\d+$/u.test(agentPackageVersion)) throw new Error("MemberConfig Agent package version is invalid");
  return freezeDigest({
    kind: "tiangong.member-config", schemaVersion: 5,
    memberId: identifier(input.memberId, "memberId"), teamId: identifier(input.teamId, "teamId"), revision: positiveInteger(input.revision ?? 1, "revision"),
    workerName: identifier(input.workerName, "workerName"), matrixUserId: bounded(input.matrixUserId, "matrixUserId", 256),
    role: bounded(input.role, "role", 128), controlProfileId: identifier(input.controlProfileId, "controlProfileId"),
    enabled: input.enabled === true, runtime, model: identifier(input.model ?? "glm-5", "model"),
    agentPackageId: identifier(input.agentPackageId ?? `tiangong-${responsibility}`, "agentPackageId"), agentPackageVersion,
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

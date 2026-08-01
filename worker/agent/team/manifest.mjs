import { canonicalJson, sha256 } from "../canonical-json.mjs";

// Tiangong-owned immutable team-coordination manifests.
//
// AgentTeams v1.2.0 coordinates teams through shared files, Matrix
// @mentions, and MinIO sync rather than a structured Project/Task RPC
// (verified by the v1.2.0 leader oracle). TeamTaskPort therefore writes
// Tiangong-owned immutable manifests to the shared filesystem and binds
// every accept/dispatch/result to a content digest, so the Leader can
// verify source, assignee, and result independently of chat prose.
//
// These types are the Phase-1 TeamTaskPort data contract, grounded on the
// architecture baseline (Project/Task binding). Phase 2 promotes the full
// TeamPlaybook closed resolver and TransitionPolicy on top of them.

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;
export const TASK_KINDS = Object.freeze(["design", "implement", "assess", "release"]);
const TASK_KIND_SET = new Set(TASK_KINDS);
export const TEAM_ROLES = Object.freeze([
  "team_leader",
  "designer",
  "implementor",
  "assessor",
  "operator",
]);
const ROLE_SET = new Set(TEAM_ROLES);

function demandString(value, name) {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function demandPattern(value, name, pattern) {
  demandString(value, name);
  if (!pattern.test(value)) throw new Error(`${name} has an invalid format: ${value}`);
  return value;
}

function demandTimestamp(value, name) {
  demandPattern(value, name, ISO_PATTERN);
  return value;
}

function freezeWithDigest(record) {
  const base = Object.freeze({ ...record });
  return Object.freeze({ ...base, contentDigest: sha256(canonicalJson(base)) });
}

function validateRoleBindings(input) {
  if (input === null || typeof input !== "object") {
    throw new TypeError("roleBindings must be an object");
  }
  const entries = Object.entries(input);
  if (entries.length === 0) throw new Error("roleBindings must list at least one role");
  const normalized = {};
  for (const [role, workerName] of entries) {
    if (!ROLE_SET.has(role)) throw new Error(`Unsupported team role: ${role}`);
    demandPattern(workerName, `roleBindings.${role}`, ID_PATTERN);
    normalized[role] = workerName;
  }
  return Object.freeze(normalized);
}

function validateRefs(input, name) {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input)) throw new TypeError(`${name} must be an array`);
  const refs = input.map((ref) => demandPattern(ref, `${name} entry`, ID_PATTERN));
  if (new Set(refs).size !== refs.length) throw new Error(`${name} contains duplicates`);
  return Object.freeze(refs);
}

export function createProjectBinding(input) {
  if (input === null || typeof input !== "object") {
    throw new TypeError("project binding input must be an object");
  }
  return freezeWithDigest({
    kind: "tiangong.project-binding",
    schemaVersion: 1,
    projectId: demandPattern(input.projectId, "projectId", ID_PATTERN),
    playbookId: demandString(input.playbookId, "playbookId"),
    playbookVersion: demandString(input.playbookVersion, "playbookVersion"),
    playbookDigest: demandPattern(input.playbookDigest, "playbookDigest", DIGEST_PATTERN),
    roleBindings: validateRoleBindings(input.roleBindings),
    createdAt: demandTimestamp(input.createdAt, "createdAt"),
  });
}

export function createTaskBinding(input) {
  if (input === null || typeof input !== "object") {
    throw new TypeError("task binding input must be an object");
  }
  const revisionIndex = input.revisionIndex;
  if (!Number.isInteger(revisionIndex) || revisionIndex < 0) {
    throw new TypeError("revisionIndex must be a non-negative integer");
  }
  if (!TASK_KIND_SET.has(input.taskKind)) {
    throw new Error(`Unsupported task kind: ${input.taskKind}`);
  }
  return freezeWithDigest({
    kind: "tiangong.task-binding",
    schemaVersion: 1,
    taskId: demandPattern(input.taskId, "taskId", ID_PATTERN),
    projectId: demandPattern(input.projectId, "projectId", ID_PATTERN),
    playbookStepId: demandString(input.playbookStepId, "playbookStepId"),
    taskKind: input.taskKind,
    revisionIndex,
    assignee: demandPattern(input.assignee, "assignee", ID_PATTERN),
    completionContractDigest: demandPattern(
      input.completionContractDigest,
      "completionContractDigest",
      DIGEST_PATTERN,
    ),
    inputRefs: validateRefs(input.inputRefs, "inputRefs"),
    createdAt: demandTimestamp(input.createdAt, "createdAt"),
  });
}

export function isProjectBinding(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.kind === "tiangong.project-binding" &&
    typeof value.contentDigest === "string" &&
    DIGEST_PATTERN.test(value.contentDigest)
  );
}

export function isTaskBinding(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.kind === "tiangong.task-binding" &&
    typeof value.contentDigest === "string" &&
    DIGEST_PATTERN.test(value.contentDigest)
  );
}

export function verifyContentDigest(value) {
  if (value === null || typeof value !== "object") return false;
  const { contentDigest, ...rest } = value;
  if (typeof contentDigest !== "string" || !DIGEST_PATTERN.test(contentDigest)) return false;
  return sha256(canonicalJson(rest)) === contentDigest;
}

export function verifyBindingDigest(binding) {
  return verifyContentDigest(binding);
}

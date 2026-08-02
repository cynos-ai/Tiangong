// ResultEnvelope: the Tiangong structured deliverable a Worker submits as a
// Task result (architecture §8). It does not replace the upstream
// result.md / Task status; it carries the binding echo, source provenance,
// professional Claim, Artifact/Evidence manifests, and an optional blocker or
// revision request. A claim is never Evidence by itself.

import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { TASK_KINDS, TEAM_ROLES } from "../team/manifest.mjs";
import { createChangeRevisionRef } from "./change-revision-ref.mjs";

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;
const TASK_KIND_SET = new Set(TASK_KINDS);
const ROLE_SET = new Set(TEAM_ROLES.filter((role) => role !== "team_leader"));
const TASK_KIND_ROLE = Object.freeze({
  design: "designer",
  implement: "implementor",
  assess: "assessor",
  release: "operator",
});
const CLAIM_MAX = 8192;
const SUMMARY_MAX = 4096;
// taskKinds whose Result must seal a ChangeRevisionRef.
const REQUIRES_REVISION_REF = new Set(["implement", "release"]);

function demandString(value, name) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} must be a non-empty string`);
  return value;
}
function demandPattern(value, name, pattern) {
  demandString(value, name);
  if (!pattern.test(value)) throw new Error(`${name} has an invalid format: ${value}`);
  return value;
}
function frozenRefArray(input, name) {
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

export function createResultEnvelope(input) {
  if (input === null || typeof input !== "object") {
    throw new TypeError("result envelope input must be an object");
  }
  if (!Number.isInteger(input.revisionIndex) || input.revisionIndex < 0) {
    throw new TypeError("revisionIndex must be a non-negative integer");
  }
  if (!TASK_KIND_SET.has(input.taskKind)) {
    throw new Error(`Unsupported task kind: ${input.taskKind}`);
  }
  if (!ROLE_SET.has(input.sourceRole)) {
    throw new Error(`Unsupported source role: ${input.sourceRole}`);
  }
  if (TASK_KIND_ROLE[input.taskKind] !== input.sourceRole) {
    throw new Error(`sourceRole ${input.sourceRole} cannot produce a ${input.taskKind} result`);
  }

  const record = {
    kind: "tiangong.result-envelope",
    schemaVersion: 1,
    taskId: demandPattern(input.taskId, "taskId", ID_PATTERN),
    projectId: demandPattern(input.projectId, "projectId", ID_PATTERN),
    producer: demandPattern(input.producer, "producer", ID_PATTERN),
    taskKind: input.taskKind,
    revisionIndex: input.revisionIndex,
    sourceRole: input.sourceRole,
    playbookDigest: demandPattern(input.playbookDigest, "playbookDigest", DIGEST_PATTERN),
    taskBindingDigest: demandPattern(input.taskBindingDigest, "taskBindingDigest", DIGEST_PATTERN),
    completionContractDigest: demandPattern(input.completionContractDigest, "completionContractDigest", DIGEST_PATTERN),
    sourceProfileDigest: demandPattern(input.sourceProfileDigest, "sourceProfileDigest", DIGEST_PATTERN),
    sourceSkillId: demandString(input.sourceSkillId, "sourceSkillId"),
    skillDigest: demandPattern(input.skillDigest, "skillDigest", DIGEST_PATTERN),
    artifactRefs: frozenRefArray(input.artifactRefs, "artifactRefs"),
    evidenceRefs: frozenRefArray(input.evidenceRefs, "evidenceRefs"),
    createdAt: demandPattern(input.createdAt, "createdAt", ISO_PATTERN),
  };

  // A blocker envelope reports why the Worker cannot proceed; otherwise a
  // non-empty professional claim is required.
  if (input.blocker !== undefined && input.blocker !== null && input.blocker !== "") {
    record.blocker = demandString(input.blocker, "blocker");
    if (record.blocker.length > SUMMARY_MAX) throw new Error("blocker exceeds the maximum length");
  } else {
    record.claim = demandString(input.claim, "claim");
    if (record.claim.length > CLAIM_MAX) throw new Error("claim exceeds the maximum length");
  }

  if (input.changeRevisionRef !== undefined && input.changeRevisionRef !== null) {
    record.changeRevisionRef = createChangeRevisionRef(input.changeRevisionRef);
  }
  if (REQUIRES_REVISION_REF.has(input.taskKind) && !record.changeRevisionRef && !record.blocker) {
    throw new Error(`${input.taskKind} result must seal a changeRevisionRef unless it is a blocker`);
  }

  if (input.revisionRequest !== undefined && input.revisionRequest !== null) {
    if (input.taskKind !== "assess") {
      throw new Error("Only an assessor result may carry a revision request");
    }
    const summary = demandString(input.revisionRequest.summary, "revisionRequest.summary");
    if (summary.length > SUMMARY_MAX) throw new Error("revisionRequest.summary exceeds the maximum length");
    record.revisionRequest = Object.freeze({ summary });
  }

  return freezeWithDigest(record);
}

export function isResultEnvelope(value) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const recreated = createResultEnvelope({
      taskId: value.taskId,
      projectId: value.projectId,
      producer: value.producer,
      taskKind: value.taskKind,
      revisionIndex: value.revisionIndex,
      sourceRole: value.sourceRole,
      playbookDigest: value.playbookDigest,
      taskBindingDigest: value.taskBindingDigest,
      completionContractDigest: value.completionContractDigest,
      artifactRefs: value.artifactRefs,
      evidenceRefs: value.evidenceRefs,
      createdAt: value.createdAt,
      sourceProfileDigest: value.sourceProfileDigest,
      sourceSkillId: value.sourceSkillId,
      skillDigest: value.skillDigest,
      blocker: value.blocker,
      claim: value.claim,
      changeRevisionRef: value.changeRevisionRef,
      revisionRequest: value.revisionRequest,
    });
    return canonicalJson(recreated) === canonicalJson(value);
  } catch {
    return false;
  }
}

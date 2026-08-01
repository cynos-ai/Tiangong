import { canonicalJson, sha256 } from "../canonical-json.mjs";
import { practiceRunFail } from "./errors.mjs";
import { projectReviewReadCoverage } from "./review-read-coverage.mjs";
import { normalizeMemberPath, resourceSelectorDigest, TARGET_ID_PATTERN } from "./review-targets.mjs";

const MAX_CLAIM_BYTES = 256 * 1024;
const MAX_OBSERVATIONS = 256;
const MAX_TEXT_BYTES = 16 * 1024;
const LEVELS = new Set(["critical", "major", "minor", "note"]);
const CONFIDENCE = new Set(["low", "medium", "high"]);
const OUTCOMES = new Set(["accept", "changes_requested", "blocked"]);
const STATUSES = new Set(["addressed", "not_addressed"]);
const CHECKPOINT_IDS = [
  "claim-schema-valid",
  "criteria-covered",
  "scope-matches-final",
  "targets-fully-consumed",
  "observation-targets-valid",
  "outcome-consistent",
  "static-review-limitation-recorded",
  "no-mutation-observed",
];

function exact(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    practiceRunFail("CLAIM_SCHEMA_INVALID", `${name} has missing or unknown fields`);
  }
}

function text(value, name) {
  if (typeof value !== "string" || value.trim() === "" || Buffer.byteLength(value) > MAX_TEXT_BYTES
      || value.includes("\u0000")) practiceRunFail("CLAIM_SCHEMA_INVALID", `${name} must be bounded text`);
  return value;
}

function normalizeClaimMember(value) {
  try { return normalizeMemberPath(value); }
  catch { practiceRunFail("CLAIM_SCHEMA_INVALID", "observation memberPath is invalid"); }
}

export function validateReviewClaim(value) {
  exact(value, ["criteriaResults", "report", "scope"], "completion claim");
  let encoded;
  try { encoded = canonicalJson(value); }
  catch { practiceRunFail("CLAIM_SCHEMA_INVALID", "Completion claim is not canonical JSON data"); }
  if (Buffer.byteLength(encoded) > MAX_CLAIM_BYTES) practiceRunFail("CLAIM_LIMIT_EXCEEDED", "Completion claim is oversized");
  if (!Array.isArray(value.criteriaResults) || value.criteriaResults.length === 0 || value.criteriaResults.length > 32) {
    practiceRunFail("CLAIM_SCHEMA_INVALID", "criteriaResults must be a non-empty bounded array");
  }
  const criteriaResults = value.criteriaResults.map((item) => {
    exact(item, ["criterionId", "explanation", "status"], "criterion result");
    if (typeof item.criterionId !== "string" || Buffer.byteLength(item.criterionId) > 64
        || !/^criterion-[1-9][0-9]*$/u.test(item.criterionId) || !STATUSES.has(item.status)) {
      practiceRunFail("CLAIM_SCHEMA_INVALID", "criterion result identity is invalid");
    }
    return { criterionId: item.criterionId, status: item.status, explanation: text(item.explanation, "criterion explanation") };
  });
  exact(value.scope, ["targetIds"], "claim scope");
  if (!Array.isArray(value.scope.targetIds) || value.scope.targetIds.length === 0 || value.scope.targetIds.length > 64
      || value.scope.targetIds.some((targetId) => typeof targetId !== "string" || !TARGET_ID_PATTERN.test(targetId))) {
    practiceRunFail("CLAIM_SCHEMA_INVALID", "claim scope target IDs are invalid");
  }
  exact(value.report, ["limitations", "nextActions", "observations", "outcome", "synopsis"], "review report");
  if (!OUTCOMES.has(value.report.outcome)) practiceRunFail("CLAIM_SCHEMA_INVALID", "report outcome is invalid");
  text(value.report.synopsis, "report synopsis");
  if (!Array.isArray(value.report.observations) || value.report.observations.length > MAX_OBSERVATIONS) {
    practiceRunFail("CLAIM_SCHEMA_INVALID", "report observations are invalid");
  }
  const observations = value.report.observations.map((item) => {
    exact(item, ["confidence", "level", "rationale", "statement", "suggestedAction", "target"], "observation");
    if (!LEVELS.has(item.level) || !CONFIDENCE.has(item.confidence)) {
      practiceRunFail("CLAIM_SCHEMA_INVALID", "observation enum is invalid");
    }
    const keys = Object.keys(item.target ?? {}).sort().join(",");
    if (!["targetId", "lineEnd,lineStart,targetId", "memberPath,targetId", "lineEnd,lineStart,memberPath,targetId"].includes(keys)
        || !TARGET_ID_PATTERN.test(item.target?.targetId)) {
      practiceRunFail("CLAIM_SCHEMA_INVALID", "observation target has invalid schema");
    }
    const target = { targetId: item.target.targetId };
    if (Object.hasOwn(item.target, "memberPath")) target.memberPath = normalizeClaimMember(item.target.memberPath);
    if (Object.hasOwn(item.target, "lineStart")) {
      if (!Number.isSafeInteger(item.target.lineStart) || item.target.lineStart < 1
          || !Number.isSafeInteger(item.target.lineEnd) || item.target.lineEnd < item.target.lineStart) {
        practiceRunFail("CLAIM_SCHEMA_INVALID", "observation target line range is invalid");
      }
      target.lineStart = item.target.lineStart;
      target.lineEnd = item.target.lineEnd;
    }
    return {
      ...item,
      target,
      statement: text(item.statement, "observation statement"),
      rationale: text(item.rationale, "observation rationale"),
      suggestedAction: text(item.suggestedAction, "observation suggestedAction"),
    };
  });
  if (!Array.isArray(value.report.limitations) || value.report.limitations.length !== 1) {
    practiceRunFail("CLAIM_SCHEMA_INVALID", "report limitations must contain exactly one item");
  }
  const limitation = value.report.limitations[0];
  exact(limitation, ["code", "detail"], "report limitation");
  if (limitation.code !== "STATIC_REVIEW_ONLY") practiceRunFail("CLAIM_SCHEMA_INVALID", "limitation code is invalid");
  text(limitation.detail, "limitation detail");
  if (!Array.isArray(value.report.nextActions) || value.report.nextActions.length > 256
      || value.report.nextActions.some((item) => typeof item !== "string" || item.trim() === ""
        || Buffer.byteLength(item) > MAX_TEXT_BYTES || item.includes("\u0000"))) {
    practiceRunFail("CLAIM_SCHEMA_INVALID", "nextActions must be bounded non-empty strings");
  }
  const claim = structuredClone({
    criteriaResults,
    scope: { targetIds: value.scope.targetIds },
    report: {
      ...value.report,
      observations,
      limitations: [structuredClone(limitation)],
      nextActions: [...value.report.nextActions],
    },
  });
  return Object.freeze({ claim: Object.freeze(claim), digest: sha256(claim) });
}

function result(checkpointId, satisfied, reasonCode, selectedEventRefs) {
  const item = { checkpointId, satisfied };
  if (!satisfied) item.reasonCode = reasonCode;
  if (selectedEventRefs) item.selectedEventRefs = structuredClone(selectedEventRefs);
  return item;
}

function observationValid(observation, run, coverage) {
  const target = run.scope.targets.find((entry) => entry.targetId === observation.target.targetId);
  const targetCoverage = coverage.targets.find((entry) => entry.targetId === observation.target.targetId);
  if (!target || targetCoverage?.status !== "complete") return false;
  let selector;
  if (["file", "git_diff"].includes(target.kind)) {
    if (Object.hasOwn(observation.target, "memberPath")) return false;
    if (target.kind === "git_diff" && Object.hasOwn(observation.target, "lineStart")) return false;
    selector = resourceSelectorDigest(target.targetId, null);
  } else {
    if (!Object.hasOwn(observation.target, "memberPath")) return false;
    selector = resourceSelectorDigest(target.targetId, observation.target.memberPath);
  }
  const facts = coverage.resourceFacts[selector];
  if (!facts) return false;
  return observation.target.lineStart === undefined || observation.target.lineEnd <= facts.contentLines;
}

export function evaluateReviewCheckpoint({ run, validatedClaim, projection, evaluatedAt }) {
  const claim = validatedClaim.claim;
  const results = [result("claim-schema-valid", true)];
  const expectedCriteria = new Set(run.acceptanceCriteria.map((criterion) => criterion.id));
  const actualCriteria = claim.criteriaResults.map((criterion) => criterion.criterionId);
  const criteriaCovered = actualCriteria.length === expectedCriteria.size
    && new Set(actualCriteria).size === actualCriteria.length && actualCriteria.every((id) => expectedCriteria.has(id));
  results.push(result("criteria-covered", criteriaCovered, "CRITERIA_COVERAGE_INVALID"));
  const targetIds = run.scope.targets.map((target) => target.targetId);
  const scopeMatches = claim.scope.targetIds.length === targetIds.length
    && claim.scope.targetIds.every((targetId, index) => targetId === targetIds[index]);
  results.push(result("scope-matches-final", scopeMatches, "CLAIM_SCOPE_MISMATCH"));
  const coverage = projectReviewReadCoverage(run, projection);
  results.push(result(
    "targets-fully-consumed",
    coverage.satisfied,
    coverage.reason,
    coverage.satisfied ? coverage.selectedEventRefs : undefined,
  ));
  const observationsValid = coverage.satisfied
    && claim.report.observations.every((observation) => observationValid(observation, run, coverage));
  results.push(result("observation-targets-valid", observationsValid, "OBSERVATION_TARGET_INVALID"));
  const notAddressed = claim.criteriaResults.some((entry) => entry.status === "not_addressed");
  const critical = claim.report.observations.some((entry) => entry.level === "critical");
  const major = claim.report.observations.some((entry) => entry.level === "major");
  const expectedOutcome = critical || notAddressed ? "blocked" : major ? "changes_requested" : "accept";
  const outcomeValid = claim.report.outcome === expectedOutcome && (!notAddressed || claim.report.nextActions.length > 0)
    && (claim.report.outcome !== "blocked" || critical || notAddressed)
    && (claim.report.outcome !== "changes_requested" || (major && !critical && !notAddressed));
  results.push(result("outcome-consistent", outcomeValid, "REPORT_OUTCOME_INCONSISTENT"));
  results.push(result("static-review-limitation-recorded",
    claim.report.limitations.length === 1 && claim.report.limitations[0].code === "STATIC_REVIEW_ONLY",
    "STATIC_LIMITATION_REQUIRED"));
  const noMutation = !projection.executions.some((entry) => ["write", "edit", "bash"].includes(entry.toolName)
    && entry.status === "success");
  results.push(result("no-mutation-observed", noMutation, "MUTATION_OBSERVED"));
  if (results.map((item) => item.checkpointId).join(",") !== CHECKPOINT_IDS.join(",")) {
    throw new Error("Review checkpoint set changed unexpectedly");
  }
  return Object.freeze({
    schemaVersion: 2,
    runId: run.runId,
    runRevision: run.revision,
    claimDigest: validatedClaim.digest,
    evidenceTerminalHash: projection.boundary.hash,
    allSatisfied: results.every((item) => item.satisfied),
    results: Object.freeze(results.map(Object.freeze)),
    evaluatedAt,
  });
}

import { practiceRunFail } from "./errors.mjs";

const MUTATION_TOOLS = new Set(["write", "edit", "bash"]);
const COVERAGE_STATUSES = new Set(["complete", "unread", "partial", "blocked"]);
const BLOCK_REASONS = new Set([
  "TARGET_CHANGED", "TARGET_UNAVAILABLE", "GIT_OBJECT_UNAVAILABLE", "TARGET_EVIDENCE_LIMIT_EXCEEDED",
]);

function fail(message) {
  practiceRunFail("REVIEW_GUIDANCE_INVARIANT_VIOLATION", message);
}

function stableUnique(values) { return [...new Set(values)]; }

function action(code, targetRefs = [], reasonCodes = []) {
  return Object.freeze({
    code,
    targetRefs: Object.freeze([...targetRefs]),
    reasonCodes: Object.freeze([...reasonCodes]),
  });
}

function assertCoverage(run, coverage) {
  if (!coverage || !Array.isArray(coverage.targets) || coverage.targets.length !== run.scope.targets.length) {
    fail("Review coverage does not match the final target scope");
  }
  for (const [index, target] of coverage.targets.entries()) {
    const expected = run.scope.targets[index];
    if (!target || target.targetId !== expected.targetId || target.kind !== expected.kind
        || target.snapshotIdentity !== expected.snapshot.identity || !COVERAGE_STATUSES.has(target.status)
        || (target.status === "complete" && target.reasonCode !== null)
        || (["unread", "partial"].includes(target.status) && target.reasonCode !== "TARGET_CONSUMPTION_INCOMPLETE")
        || (target.status === "blocked" && !BLOCK_REASONS.has(target.reasonCode))) {
      fail("Review coverage contains an invalid target projection");
    }
  }
  const firstIncomplete = coverage.targets.find((target) => target.status !== "complete");
  if (coverage.satisfied !== (firstIncomplete === undefined)
      || coverage.reason !== (firstIncomplete?.reasonCode ?? null)) {
    fail("Review coverage summary conflicts with target projections");
  }
}

function failedCheckpointReasons(run) {
  if (!run.lastCheckpoint) return [];
  if (run.lastCheckpoint.allSatisfied === true || !Array.isArray(run.lastCheckpoint.results)) {
    fail("An active review run has invalid checkpoint state");
  }
  const reasons = [];
  for (const item of run.lastCheckpoint.results) {
    if (!item || typeof item.satisfied !== "boolean") fail("Review checkpoint state is invalid");
    if (!item.satisfied) {
      if (typeof item.reasonCode !== "string" || item.reasonCode === "") fail("Failed checkpoint reason is missing");
      reasons.push(item.reasonCode);
    }
  }
  if (reasons.length === 0) fail("Active failed checkpoint has no failed result");
  return stableUnique(reasons);
}

export function deriveReviewNextAction({ run, coverage, evidenceProjection } = {}) {
  if (run === undefined || run === null) return action("NONE");
  if (run.status !== "active" || !Array.isArray(run.scope?.targets) || run.scope.targets.length === 0) {
    fail("Review guidance requires a valid active target run");
  }
  if (!Array.isArray(evidenceProjection?.executions)) fail("Review guidance requires validated Evidence");
  if (evidenceProjection.executions.some((entry) => MUTATION_TOOLS.has(entry.toolName) && entry.status === "success")) {
    fail("Reviewer run contains successful mutation Evidence");
  }
  assertCoverage(run, coverage);
  const blocked = coverage.targets.filter((target) => target.status === "blocked");
  if (blocked.length > 0) {
    return action(
      "RESOLVE_TARGET_BLOCKER",
      blocked.map((target) => target.targetId),
      stableUnique(blocked.map((target) => target.reasonCode)),
    );
  }
  const incomplete = coverage.targets.filter((target) => target.status !== "complete");
  if (incomplete.length > 0) {
    return action(
      "CONSUME_REMAINING_TARGETS",
      incomplete.map((target) => target.targetId),
      ["TARGET_CONSUMPTION_INCOMPLETE"],
    );
  }
  const failed = failedCheckpointReasons(run);
  if (failed.length > 0) return action("ADDRESS_CHECKPOINT_FAILURE", [], failed);
  return action("CHECK_COMPLETION");
}

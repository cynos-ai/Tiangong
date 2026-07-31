import { practiceRunFail } from "./errors.mjs";

const MUTATION_TOOLS = new Set(["write", "edit", "bash"]);
const COVERAGE_STATUSES = new Set(["complete", "unread", "partial", "mixed_version"]);

function fail(message) {
  practiceRunFail("REVIEW_GUIDANCE_INVARIANT_VIOLATION", message);
}

function stableUnique(values) {
  return [...new Set(values)];
}

function action(code, targetRefs = [], reasonCodes = []) {
  return Object.freeze({
    code,
    targetRefs: Object.freeze([...targetRefs]),
    reasonCodes: Object.freeze([...reasonCodes]),
  });
}

function assertCoverage(run, coverage) {
  if (!coverage || !Array.isArray(coverage.files) || coverage.files.length !== run.scope.files.length) {
    fail("Review coverage does not match the final scope");
  }
  for (const [index, file] of coverage.files.entries()) {
    const expectedReason = file?.status === "complete"
      ? null
      : file?.status === "mixed_version"
        ? "FILE_VERSION_MIXED"
        : "SCOPE_READ_INCOMPLETE";
    if (!file || file.path !== run.scope.files[index] || file.targetRef !== `scope-file-${index + 1}` ||
        !COVERAGE_STATUSES.has(file.status) || file.reasonCode !== expectedReason) {
      fail("Review coverage contains an invalid file projection");
    }
  }
  const firstIncomplete = coverage.files.find((file) => file.status !== "complete");
  const allComplete = firstIncomplete === undefined;
  if (coverage.satisfied !== allComplete || coverage.reason !== (firstIncomplete?.reasonCode ?? null)) {
    fail("Review coverage summary conflicts with its file projections");
  }
}

function failedCheckpointReasons(run) {
  if (!run.lastCheckpoint) return [];
  if (run.lastCheckpoint.allSatisfied === true || !Array.isArray(run.lastCheckpoint.results)) {
    fail("An active review run has an invalid checkpoint state");
  }
  const reasons = [];
  for (const item of run.lastCheckpoint.results) {
    if (!item || typeof item.satisfied !== "boolean") fail("Review checkpoint state is invalid");
    if (!item.satisfied) {
      if (typeof item.reasonCode !== "string" || item.reasonCode === "") {
        fail("A failed review checkpoint is missing its reason code");
      }
      reasons.push(item.reasonCode);
    }
  }
  if (reasons.length === 0) fail("An active failed checkpoint has no failed result");
  return stableUnique(reasons);
}

export function deriveReviewNextAction({ run, coverage, evidenceProjection } = {}) {
  if (run === undefined || run === null) return action("NONE");
  if (run.status !== "active" || !Array.isArray(run.scope?.files) || run.scope.files.length === 0) {
    fail("Review guidance requires a valid active run");
  }
  if (!Array.isArray(evidenceProjection?.executions)) {
    fail("Review guidance requires a validated Evidence projection");
  }
  if (evidenceProjection.executions.some((entry) => MUTATION_TOOLS.has(entry.toolName))) {
    fail("A Reviewer run contains a successful mutation execution");
  }

  assertCoverage(run, coverage);
  const remaining = coverage.files.filter((file) => file.status !== "complete");
  if (remaining.length > 0) {
    return action(
      "READ_REMAINING_SCOPE",
      remaining.map((file) => file.targetRef),
      stableUnique(remaining.map((file) => file.reasonCode)),
    );
  }

  const failedReasons = failedCheckpointReasons(run);
  if (failedReasons.length > 0) return action("ADDRESS_CHECKPOINT_FAILURE", [], failedReasons);
  return action("CHECK_COMPLETION");
}

import { practiceRunFail } from "./errors.mjs";

const MAX_SEGMENTS_PER_RESOURCE = 128;
const MAX_SELECTED_EVENT_REFS = 2048;
const BLOCKING_ERRORS = new Set([
  "TARGET_CHANGED", "TARGET_UNAVAILABLE", "GIT_OBJECT_UNAVAILABLE", "TARGET_ARTIFACT_INVALID",
]);

function targetCoverage(target, status, reasonCode, selectedEventRefs) {
  return Object.freeze({
    targetId: target.targetId,
    kind: target.kind,
    snapshotIdentity: target.snapshot.identity,
    status,
    reasonCode,
    selectedEventRefs: Object.freeze([...selectedEventRefs]),
  });
}

function selectIntervals(entries, totalLines) {
  const selected = [];
  const used = new Set();
  let covered = 0;
  while (covered < totalLines) {
    const candidates = entries.filter((entry) => !used.has(entry)
      && entry.resultMetadata.returnedLineStart <= covered + 1
      && entry.resultMetadata.returnedLineEnd > covered);
    if (candidates.length === 0) break;
    candidates.sort((left, right) => right.resultMetadata.returnedLineEnd - left.resultMetadata.returnedLineEnd
      || left.completedRef.sequence - right.completedRef.sequence);
    const chosen = candidates[0];
    used.add(chosen);
    selected.push(chosen);
    covered = chosen.resultMetadata.returnedLineEnd;
  }
  return { covered, selected };
}

export function projectReviewReadCoverage(run, projection) {
  if (!run?.scope || !Array.isArray(run.scope.targets) || !Array.isArray(projection?.executions)
      || !Array.isArray(projection?.resources)) {
    throw new TypeError("A materialized target run and Evidence projection are required");
  }
  const successful = projection.executions.filter((entry) => entry.toolName === "read" && entry.status === "success");
  const failures = projection.executions.filter((entry) => entry.toolName === "read" && entry.status === "error");
  const targets = [];
  const resourceFacts = {};
  const selectedEventRefs = [];

  for (const target of run.scope.targets) {
    const resources = projection.resources.filter((resource) => resource.targetId === target.targetId);
    if (resources.length === 0) practiceRunFail("STATE_CORRUPTED", "Target has no materialized coverage resources");
    let completeCount = 0;
    let unreadCount = 0;
    let blocker = null;
    const targetRefs = [];
    for (const resource of resources) {
      const entries = successful.filter((entry) => entry.operation.input.resourceSelectorDigest === resource.selectorDigest)
        .sort((left, right) => left.completedRef.sequence - right.completedRef.sequence);
      const factKey = resource.selectorDigest;
      resourceFacts[factKey] = Object.freeze({ ...resource });
      if (entries.length > MAX_SEGMENTS_PER_RESOURCE) {
        blocker ??= "TARGET_EVIDENCE_LIMIT_EXCEEDED";
        continue;
      }
      const selected = selectIntervals(entries, resource.contentLines);
      if (selected.covered >= resource.contentLines) {
        completeCount += 1;
        for (const entry of selected.selected) targetRefs.push(entry.startedRef, entry.completedRef);
        continue;
      }
      if (entries.length === 0) unreadCount += 1;
      const latestFailure = failures
        .filter((entry) => entry.operation.input.resourceSelectorDigest === resource.selectorDigest)
        .sort((left, right) => right.completedRef.sequence - left.completedRef.sequence)[0];
      if (latestFailure && BLOCKING_ERRORS.has(latestFailure.errorCode)) blocker ??= latestFailure.errorCode;
    }
    let status;
    let reasonCode = null;
    if (blocker) {
      status = "blocked";
      reasonCode = blocker;
    } else if (completeCount === resources.length) {
      status = "complete";
      selectedEventRefs.push(...targetRefs);
    } else if (unreadCount === resources.length) {
      status = "unread";
      reasonCode = "TARGET_CONSUMPTION_INCOMPLETE";
    } else {
      status = "partial";
      reasonCode = "TARGET_CONSUMPTION_INCOMPLETE";
    }
    targets.push(targetCoverage(target, status, reasonCode, status === "complete" ? targetRefs : []));
  }

  if (selectedEventRefs.length > MAX_SELECTED_EVENT_REFS) {
    practiceRunFail("EVIDENCE_LIMIT_EXCEEDED", "Selected Evidence references exceed the fixed limit");
  }
  const firstIncomplete = targets.find((target) => target.status !== "complete");
  return Object.freeze({
    satisfied: firstIncomplete === undefined,
    reason: firstIncomplete?.reasonCode ?? null,
    targets: Object.freeze(targets),
    resourceFacts: Object.freeze(resourceFacts),
    selectedEventRefs: Object.freeze(selectedEventRefs),
  });
}

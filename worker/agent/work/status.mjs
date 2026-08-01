const STATUS_MARKER = "Tiangong machine status";

export function workStatusForRun(run) {
  if (!run) return Object.freeze({
    assurance: "direct-unverified",
    runId: null,
    practiceId: null,
    state: "none",
    checkpoint: "not-applicable",
    scopeRevision: 0,
    scopeTargetCount: 0,
  });
  const checkpoint = run.lastCheckpoint ? run.lastCheckpoint.allSatisfied ? "passed" : "failed" : "not-run";
  return Object.freeze({
    assurance: "worker-local",
    runId: run.runId,
    practiceId: run.practiceId,
    state: run.status,
    checkpoint,
    scopeRevision: run.scope.revision,
    scopeTargetCount: run.scope.targets.length,
  });
}

export function renderWorkStatus(status) {
  if (!status) return "";
  return [
    "---",
    STATUS_MARKER,
    `assurance: ${status.assurance}`,
    `work: ${status.runId ?? "none"}`,
    `practice: ${status.practiceId ?? "none"}`,
    `state: ${status.state}`,
    `checkpoint: ${status.checkpoint}`,
    `scope: revision ${status.scopeRevision}, targets ${status.scopeTargetCount}`,
    `verification: ${status.assurance === "worker-local" ? "static-review-only" : "not-verified"}`,
  ].join("\n");
}

export function escapeMachineStatusMarker(text) {
  return text.replaceAll(STATUS_MARKER, "Tiangong model-provided status text");
}

export function completedReviewTargetFacts(run, projection) {
  const selected = new Set((run.lastCheckpoint?.selectedEventRefs ?? []).map((ref) => `${ref.sequence}:${ref.eventHash}`));
  return run.scope.targets.map((target) => {
    const executions = projection.executions.filter((item) => item.toolName === "read" && item.status === "success"
      && item.resource.targetId === target.targetId
      && selected.has(`${item.completedRef.sequence}:${item.completedRef.eventHash}`));
    if (executions.length === 0) throw new Error("Completed review is missing selected target consumption Evidence");
    return {
      targetId: target.targetId,
      kind: target.kind,
      snapshotIdentity: target.snapshot.identity,
      descriptor: structuredClone(target.descriptor.value),
      completedRefs: executions.map((item) => item.completedRef),
    };
  });
}

function observationLocation(target) {
  let location = target.targetId;
  if (target.memberPath !== undefined) location += `/${target.memberPath}`;
  if (target.lineStart !== undefined) location += `:${target.lineStart}-${target.lineEnd}`;
  return location;
}

export function renderCompletedReview({ run, claim, targetFacts = [] }) {
  const observations = claim.report.observations.length === 0 ? "- none"
    : claim.report.observations.map((item) =>
      `- [${item.level}] ${observationLocation(item.target)}: ${item.statement}\n  rationale: ${item.rationale}\n  suggested action: ${item.suggestedAction}\n  confidence: ${item.confidence}`,
    ).join("\n");
  const criteria = claim.criteriaResults
    .map((item) => `- ${item.criterionId}: ${item.status} — ${item.explanation}`).join("\n");
  const next = claim.report.nextActions.length === 0 ? "- none"
    : claim.report.nextActions.map((item) => `- ${item}`).join("\n");
  return [
    "Review claim",
    `outcome: ${claim.report.outcome}`,
    claim.report.synopsis,
    "",
    "Criteria",
    criteria,
    "",
    "Observations",
    observations,
    "",
    "Next actions",
    next,
    "",
    "Machine completion facts",
    `run: ${run.runId}`,
    `scope revision: ${run.scope.revision}`,
    `scope targets: ${run.scope.targets.map((target) => target.targetId).join(", ")}`,
    ...targetFacts.map((fact) =>
      `target: ${fact.targetId}; kind: ${fact.kind}; snapshot: ${fact.snapshotIdentity}; Evidence: ${fact.completedRefs.map((ref) => `${ref.sequence}/${ref.eventHash}`).join(",")}`),
    `checkpoint: ${run.lastCheckpoint?.allSatisfied ? "passed" : "failed"}`,
    `claim digest: ${run.lastCheckpoint?.claimDigest}`,
    `Evidence terminal hash: ${run.lastCheckpoint?.evidenceTerminalHash}`,
    "",
    "Verification limitation",
    "worker-local static-review-only; no tests or runtime commands were executed.",
  ].join("\n");
}

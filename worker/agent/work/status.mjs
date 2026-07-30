const STATUS_MARKER = "Tiangong machine status";

export function workStatusForRun(run) {
  if (!run) return Object.freeze({
    assurance: "direct-unverified",
    runId: null,
    practiceId: null,
    state: "none",
    checkpoint: "not-applicable",
    scopeRevision: 0,
    scopeFileCount: 0,
  });
  const checkpoint = run.lastCheckpoint
    ? run.lastCheckpoint.allSatisfied ? "passed" : "failed"
    : "not-run";
  return Object.freeze({
    assurance: "worker-local",
    runId: run.runId,
    practiceId: run.practiceId,
    state: run.status,
    checkpoint,
    scopeRevision: run.scope.revision,
    scopeFileCount: run.scope.files.length,
  });
}

export function renderWorkStatus(status) {
  if (!status) return "";
  const lines = [
    "---",
    STATUS_MARKER,
    `assurance: ${status.assurance}`,
    `work: ${status.runId ?? "none"}`,
    `practice: ${status.practiceId ?? "none"}`,
    `state: ${status.state}`,
    `checkpoint: ${status.checkpoint}`,
    `scope: revision ${status.scopeRevision}, files ${status.scopeFileCount}`,
    `verification: ${status.assurance === "worker-local" ? "static-review-only" : "not-verified"}`,
  ];
  return lines.join("\n");
}

export function escapeMachineStatusMarker(text) {
  return text.replaceAll(STATUS_MARKER, "Tiangong model-provided status text");
}

export function completedReviewFileFacts(run, projection) {
  const selected = new Set((run.lastCheckpoint?.selectedEventRefs ?? []).map((ref) => `${ref.sequence}:${ref.eventHash}`));
  const facts = [];
  for (const path of run.scope.files) {
    const executions = projection.executions
      .filter((item) => item.toolName === "read" && item.operation.target === path &&
        selected.has(`${item.completedRef.sequence}:${item.completedRef.eventHash}`));
    if (executions.length === 0) throw new Error("Completed review is missing its selected read Evidence");
    const execution = executions.at(-1);
    facts.push({
      path,
      fileDigest: execution.resultMetadata.fileDigest,
      fullFileBytes: execution.resultMetadata.fullFileBytes,
      fullFileLines: execution.resultMetadata.fullFileLines,
      completedRefs: executions.map((item) => item.completedRef),
    });
  }
  return facts;
}

export function renderCompletedReview({ run, claim, fileFacts = [] }) {
  const observations = claim.report.observations.length === 0
    ? "- none"
    : claim.report.observations.map((item) => {
      const lines = item.target.lineStart === undefined ? "" : `:${item.target.lineStart}-${item.target.lineEnd}`;
      return `- [${item.level}] ${item.target.path}${lines}: ${item.statement}\n  rationale: ${item.rationale}\n  suggested action: ${item.suggestedAction}\n  confidence: ${item.confidence}`;
    }).join("\n");
  const criteria = claim.criteriaResults
    .map((item) => `- ${item.criterionId}: ${item.status} — ${item.explanation}`)
    .join("\n");
  const next = claim.report.nextActions.length === 0 ? "- none" : claim.report.nextActions.map((item) => `- ${item}`).join("\n");
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
    `scope files: ${run.scope.files.join(", ")}`,
    ...fileFacts.map((fact) =>
      `file: ${fact.path}; digest: ${fact.fileDigest}; bytes: ${fact.fullFileBytes}; lines: ${fact.fullFileLines}; Evidence: ${fact.completedRefs.map((ref) => `${ref.sequence}/${ref.eventHash}`).join(",")}`),
    `checkpoint: ${run.lastCheckpoint?.allSatisfied ? "passed" : "failed"}`,
    `claim digest: ${run.lastCheckpoint?.claimDigest}`,
    `Evidence terminal hash: ${run.lastCheckpoint?.evidenceTerminalHash}`,
    "",
    "Verification limitation",
    "worker-local static-review-only; no tests or runtime commands were executed.",
  ].join("\n");
}

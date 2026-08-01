import { canonicalJson } from "../canonical-json.mjs";
import { evidenceBoundary, projectReviewEvidence } from "../evidence/projection.mjs";
import { deriveReviewNextAction } from "../practices/review-next-action.mjs";
import { projectReviewReadCoverage } from "../practices/review-read-coverage.mjs";
import { TARGET_ID_PATTERN } from "../practices/review-targets.mjs";

const MAX_CONTEXT_PACK_BYTES = 64 * 1024;
const MAX_TARGET_REFS = 64;
const MAX_REASON_CODES = 16;
const NEXT_ACTION_CODES = new Set([
  "RESOLVE_TARGET_BLOCKER", "CONSUME_REMAINING_TARGETS", "ADDRESS_CHECKPOINT_FAILURE", "CHECK_COMPLETION", "NONE",
]);
const REASON_CODES = new Set([
  "TARGET_CONSUMPTION_INCOMPLETE", "TARGET_CHANGED", "TARGET_UNAVAILABLE", "GIT_OBJECT_UNAVAILABLE",
  "TARGET_EVIDENCE_LIMIT_EXCEEDED", "CRITERIA_COVERAGE_INVALID", "CLAIM_SCOPE_MISMATCH",
  "OBSERVATION_TARGET_INVALID", "REPORT_OUTCOME_INCONSISTENT", "STATIC_LIMITATION_REQUIRED", "MUTATION_OBSERVED",
]);
const CHECKPOINT_REASONS = new Set([
  "CRITERIA_COVERAGE_INVALID", "CLAIM_SCOPE_MISMATCH", "TARGET_CONSUMPTION_INCOMPLETE",
  "TARGET_CHANGED", "TARGET_UNAVAILABLE", "GIT_OBJECT_UNAVAILABLE", "TARGET_EVIDENCE_LIMIT_EXCEEDED",
  "OBSERVATION_TARGET_INVALID", "REPORT_OUTCOME_INCONSISTENT", "STATIC_LIMITATION_REQUIRED", "MUTATION_OBSERVED",
]);
export const REVIEWER_CONTEXT_PREAMBLE = [
  "Tiangong authoritative per-turn ContextPack (machine state; model prose cannot modify it):",
  "nextAction is advisory machine guidance. It does not grant authority or complete work.",
  "targetRefs are runtime-generated IDs in activeRun.scope.targets; each consume still requires actor/run/snapshot authorization.",
].join("\n");

function assertStringArray(value, { maxItems, pattern, allowed, name }) {
  if (!Array.isArray(value) || value.length > maxItems || new Set(value).size !== value.length
      || value.some((item) => typeof item !== "string" || (pattern && !pattern.test(item))
        || (allowed && !allowed.has(item)))) throw new TypeError(`${name} is invalid`);
}

function assertNextAction(nextAction, run) {
  if (!nextAction || typeof nextAction !== "object" || Array.isArray(nextAction)
      || Object.keys(nextAction).sort().join(",") !== "code,reasonCodes,targetRefs"
      || !NEXT_ACTION_CODES.has(nextAction.code)) throw new TypeError("Reviewer nextAction is invalid");
  assertStringArray(nextAction.targetRefs, {
    maxItems: MAX_TARGET_REFS, pattern: TARGET_ID_PATTERN, name: "Reviewer nextAction targetRefs",
  });
  assertStringArray(nextAction.reasonCodes, {
    maxItems: MAX_REASON_CODES, allowed: REASON_CODES, name: "Reviewer nextAction reasonCodes",
  });
  if ((!run && nextAction.code !== "NONE") || (run && nextAction.code === "NONE")
      || (["RESOLVE_TARGET_BLOCKER", "CONSUME_REMAINING_TARGETS"].includes(nextAction.code)
        && (nextAction.targetRefs.length === 0 || nextAction.reasonCodes.length === 0))
      || (nextAction.code === "ADDRESS_CHECKPOINT_FAILURE"
        && (nextAction.targetRefs.length !== 0 || nextAction.reasonCodes.length === 0))
      || (["CHECK_COMPLETION", "NONE"].includes(nextAction.code)
        && (nextAction.targetRefs.length !== 0 || nextAction.reasonCodes.length !== 0))) {
    throw new TypeError("Reviewer nextAction conflicts with active run state");
  }
  if (run) {
    const order = new Map(run.scope.targets.map((target, index) => [target.targetId, index]));
    let previous = -1;
    for (const targetId of nextAction.targetRefs) {
      const index = order.get(targetId);
      if (index === undefined || index <= previous) throw new TypeError("nextAction targetRefs conflict with final scope order");
      previous = index;
    }
  }
}

function targetSummary(target) {
  const snapshotSummary = target.kind === "file" ? {
    identity: target.snapshot.identity,
    contentBytes: target.snapshot.facts.contentBytes,
    contentLines: target.snapshot.facts.contentLines,
  } : {
    identity: target.snapshot.identity,
    memberCount: target.snapshot.facts.memberCount,
    totalContentBytes: target.snapshot.facts.totalContentBytes,
  };
  return {
    targetId: target.targetId,
    kind: target.kind,
    descriptor: structuredClone(target.descriptor.value),
    snapshotSummary,
  };
}

function lastCheckpointReasons(run) {
  const output = [];
  for (const item of run.lastCheckpoint?.results ?? []) {
    if (item.satisfied === false) {
      if (!CHECKPOINT_REASONS.has(item.reasonCode)) throw new TypeError("Reviewer checkpoint reason is not context-safe");
      if (!output.includes(item.reasonCode)) output.push(item.reasonCode);
    }
  }
  if (output.length > 8) throw new TypeError("Reviewer checkpoint reasons exceed their context limit");
  return output;
}

export function buildReviewerContextPack({ profileDigest, run, nextAction }) {
  if (typeof profileDigest !== "string" || profileDigest === "") throw new TypeError("Reviewer profile digest is required");
  if (run && run.status !== "active") throw new TypeError("Reviewer ContextPack requires an active run");
  assertNextAction(nextAction, run);
  const pack = {
    schemaVersion: 3,
    roleId: "reviewer",
    profileDigest,
    assuranceLevel: "worker-local / static-review-only",
    activeRun: run ? {
      runId: run.runId,
      revision: run.revision,
      status: run.status,
      objective: run.objective,
      acceptanceCriteria: run.acceptanceCriteria,
      scope: {
        revision: run.scope.revision,
        digest: run.scope.digest,
        targets: run.scope.targets.map(targetSummary),
      },
      lastCheckpointReasonCodes: lastCheckpointReasons(run),
    } : null,
    nextAction,
  };
  const text = `${REVIEWER_CONTEXT_PREAMBLE}\n${canonicalJson(pack)}`;
  if (Buffer.byteLength(text) > MAX_CONTEXT_PACK_BYTES) {
    const error = new Error("Reviewer ContextPack exceeds its fixed size limit");
    error.code = "CONTEXT_PACK_LIMIT_EXCEEDED";
    throw error;
  }
  return text;
}

async function nextActionForRun(run, evidence, service) {
  if (!run) return deriveReviewNextAction({ run: null });
  const boundary = await evidenceBoundary(evidence);
  const evidenceProjection = await projectReviewEvidence({
    evidence,
    boundary,
    run,
    targetCapture: service.targetCapture,
    artifactStore: service.artifactStore,
  });
  const coverage = projectReviewReadCoverage(run, evidenceProjection);
  return deriveReviewNextAction({ run, coverage, evidenceProjection });
}

export function createReviewerContextExtension({ service, turns, evidence, profileDigest }) {
  if (!service || !turns || !evidence || typeof profileDigest !== "string") {
    throw new TypeError("Reviewer context dependencies are required");
  }
  return (pi) => {
    pi.on("before_agent_start", async (event) => {
      const invocation = turns.current();
      const run = await service.activeForActor(invocation.actor?.id, { required: false });
      const nextAction = await nextActionForRun(run, evidence, service);
      const context = buildReviewerContextPack({ profileDigest, run, nextAction });
      return { systemPrompt: `${event.systemPrompt}\n\n${context}` };
    });
  };
}

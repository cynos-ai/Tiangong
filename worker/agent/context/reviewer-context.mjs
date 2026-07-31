import { canonicalJson } from "../canonical-json.mjs";
import { evidenceBoundary, projectReviewEvidence } from "../evidence/projection.mjs";
import { deriveReviewNextAction } from "../practices/review-next-action.mjs";
import { projectReviewReadCoverage } from "../practices/review-read-coverage.mjs";

const MAX_CONTEXT_PACK_BYTES = 64 * 1024;
const MAX_TARGET_REFS = 64;
const MAX_REASON_CODES = 16;
const NEXT_ACTION_CODES = new Set([
  "READ_REMAINING_SCOPE",
  "ADDRESS_CHECKPOINT_FAILURE",
  "CHECK_COMPLETION",
  "NONE",
]);
const CONTEXT_PREAMBLE = [
  "Tiangong authoritative per-turn ContextPack (machine state; model prose cannot modify it):",
  "nextAction is advisory machine guidance. It does not grant authority or complete work.",
  "scope-file-N refers to activeRun.scope.files[N-1].",
].join("\n");

function assertStringArray(value, { maxItems, pattern, name }) {
  if (!Array.isArray(value) || value.length > maxItems || new Set(value).size !== value.length ||
      value.some((item) => typeof item !== "string" || !pattern.test(item))) {
    throw new TypeError(`${name} is invalid`);
  }
}

function assertNextAction(nextAction, run) {
  if (!nextAction || typeof nextAction !== "object" || Array.isArray(nextAction) ||
      Object.keys(nextAction).sort().join(",") !== "code,reasonCodes,targetRefs" ||
      !NEXT_ACTION_CODES.has(nextAction.code)) {
    throw new TypeError("Reviewer nextAction is invalid");
  }
  assertStringArray(nextAction.targetRefs, {
    maxItems: MAX_TARGET_REFS,
    pattern: /^scope-file-[1-9][0-9]*$/u,
    name: "Reviewer nextAction targetRefs",
  });
  assertStringArray(nextAction.reasonCodes, {
    maxItems: MAX_REASON_CODES,
    pattern: /^[A-Z][A-Z0-9_]{0,63}$/u,
    name: "Reviewer nextAction reasonCodes",
  });
  if ((!run && nextAction.code !== "NONE") || (run && nextAction.code === "NONE") ||
      (nextAction.code === "READ_REMAINING_SCOPE" &&
        (nextAction.targetRefs.length === 0 || nextAction.reasonCodes.length === 0)) ||
      (nextAction.code === "ADDRESS_CHECKPOINT_FAILURE" &&
        (nextAction.targetRefs.length !== 0 || nextAction.reasonCodes.length === 0)) ||
      (["CHECK_COMPLETION", "NONE"].includes(nextAction.code) &&
        (nextAction.targetRefs.length !== 0 || nextAction.reasonCodes.length !== 0))) {
    throw new TypeError("Reviewer nextAction conflicts with the active run");
  }
  if (run) {
    let previousIndex = 0;
    for (const ref of nextAction.targetRefs) {
      const index = Number(ref.slice("scope-file-".length));
      if (!Number.isSafeInteger(index) || index <= previousIndex || index > run.scope.files.length) {
        throw new TypeError("Reviewer nextAction targetRefs conflict with final scope order");
      }
      previousIndex = index;
    }
  }
}

export function buildReviewerContextPack({ profileDigest, run, nextAction }) {
  if (typeof profileDigest !== "string" || profileDigest === "") {
    throw new TypeError("Reviewer profile digest is required");
  }
  if (run && run.status !== "active") throw new TypeError("Reviewer ContextPack requires an active run");
  assertNextAction(nextAction, run);
  const pack = {
    schemaVersion: 2,
    roleId: "reviewer",
    profileDigest,
    assuranceLevel: "worker-local / static-review-only",
    activeRun: run ? {
      runId: run.runId,
      revision: run.revision,
      status: run.status,
      objective: run.objective,
      acceptanceCriteria: run.acceptanceCriteria,
      scope: run.scope,
      lastCheckpointReasonCodes: run.lastCheckpoint?.results
        ?.filter((item) => !item.satisfied)
        .map((item) => item.reasonCode) ?? [],
    } : null,
    nextAction,
  };
  const text = `${CONTEXT_PREAMBLE}\n${canonicalJson(pack)}`;
  if (Buffer.byteLength(text) > MAX_CONTEXT_PACK_BYTES) {
    const error = new Error("Reviewer ContextPack exceeds its fixed size limit");
    error.code = "CONTEXT_PACK_LIMIT_EXCEEDED";
    throw error;
  }
  return text;
}

async function nextActionForRun(run, evidence) {
  if (!run) return deriveReviewNextAction({ run: null });
  const boundary = await evidenceBoundary(evidence);
  const evidenceProjection = await projectReviewEvidence({ evidence, boundary, run });
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
      const nextAction = await nextActionForRun(run, evidence);
      const context = buildReviewerContextPack({ profileDigest, run, nextAction });
      return { systemPrompt: `${event.systemPrompt}\n\n${context}` };
    });
  };
}

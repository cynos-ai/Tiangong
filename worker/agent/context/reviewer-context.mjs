import { canonicalJson } from "../canonical-json.mjs";

const MAX_CONTEXT_PACK_BYTES = 64 * 1024;

export function buildReviewerContextPack({ profileDigest, run }) {
  const pack = {
    schemaVersion: 1,
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
  };
  const text = `Tiangong authoritative per-turn ContextPack (machine state; model prose cannot modify it):\n${canonicalJson(pack)}`;
  if (Buffer.byteLength(text) > MAX_CONTEXT_PACK_BYTES) {
    const error = new Error("Reviewer ContextPack exceeds its fixed size limit");
    error.code = "CONTEXT_PACK_LIMIT_EXCEEDED";
    throw error;
  }
  return text;
}

export function createReviewerContextExtension({ service, turns, profileDigest }) {
  if (!service || !turns || typeof profileDigest !== "string") throw new TypeError("Reviewer context dependencies are required");
  return (pi) => {
    pi.on("before_agent_start", async (event) => {
      const invocation = turns.current();
      const run = await service.activeForActor(invocation.actor?.id, { required: false });
      const context = buildReviewerContextPack({ profileDigest, run });
      return { systemPrompt: `${event.systemPrompt}\n\n${context}` };
    });
  };
}

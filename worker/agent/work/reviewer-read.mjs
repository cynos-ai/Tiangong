import { Type } from "typebox";

import { evidenceMetadataFromReceipt } from "../artifacts/schema.mjs";
import { sha256 } from "../canonical-json.mjs";
import { practiceRunFail } from "../practices/errors.mjs";
import { practiceInvocationIdentity } from "../practices/practice-run-store.mjs";
import {
  TARGET_ID_PATTERN,
  findTarget,
  maximalChunk,
  normalizeMemberPath,
  resourceSelectorDigest,
} from "../practices/review-targets.mjs";

const MAX_READ_LINES = 2000;
const EFFECTS = Object.freeze({
  localRead: true,
  workspaceMutation: false,
  networkEgress: false,
  modelInference: false,
  costBearing: false,
});

export const REVIEWER_READ_DEFINITION = Object.freeze({
  name: "read",
  label: "Tiangong target-bound review read",
  description: "Consume a bounded line chunk from an immutable file target or an exact directory-manifest member.",
  parameters: Type.Object({
    targetId: Type.String({ minLength: 43, maxLength: 43 }),
    memberPath: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    offset: Type.Integer({ minimum: 1 }),
    limit: Type.Integer({ minimum: 1, maximum: MAX_READ_LINES }),
  }, { additionalProperties: false }),
});

function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function mapArtifactError(error) {
  if (error?.name !== "CapturedArtifactError") throw error;
  if (["ARTIFACT_LIMIT_EXCEEDED", "ARTIFACT_PRODUCER_NOT_ALLOWED", "ARTIFACT_METADATA_INVALID"].includes(error.code)) {
    practiceRunFail("TARGET_LIMIT_EXCEEDED", "Consumed target artifact violates its producer limit");
  }
  if (error.code === "ARTIFACT_QUOTA_EXCEEDED") {
    practiceRunFail("CAPTURE_LIMIT_EXCEEDED", "Consumed target artifacts exceed aggregate quota");
  }
  practiceRunFail("TARGET_UNAVAILABLE", "Consumed target artifact storage is unavailable");
}

export async function prepareReviewerRead({ service, params, invocation }) {
  if (!exact(params, ["limit", "offset", "targetId"])
      && !exact(params, ["limit", "memberPath", "offset", "targetId"])) {
    practiceRunFail("INVALID_TARGET", "read input has missing or unknown fields");
  }
  if (!TARGET_ID_PATTERN.test(params.targetId)
      || (Object.hasOwn(params, "memberPath") && typeof params.memberPath !== "string")) {
    practiceRunFail("INVALID_TARGET", "read input identity shape is invalid");
  }
  if (!Number.isSafeInteger(params.offset) || params.offset < 1
      || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > MAX_READ_LINES) {
    practiceRunFail("TARGET_RANGE_INVALID", "Target consume range is invalid");
  }
  const memberPath = Object.hasOwn(params, "memberPath") ? normalizeMemberPath(params.memberPath) : null;
  const actorId = invocation.actor?.id;
  const run = await service.activeForActor(actorId);
  await service.targetCapture.initialize();
  const selectorDigest = resourceSelectorDigest(params.targetId, memberPath);
  const operation = Object.freeze({
    policyVersion: "review-target-consume-v2",
    category: "read-only",
    toolName: "read",
    effects: EFFECTS,
    workspaceScope: service.targetCapture.workspaceScope,
    roleId: run.roleId,
    profileDigest: run.profileDigest,
    practiceId: run.practiceId,
    practiceVersion: 2,
    state: { runId: run.runId, expectedRunRevision: run.revision, targetId: params.targetId },
    input: {
      resourceSelectorDigest: selectorDigest,
      offset: params.offset,
      limit: params.limit,
      consumePolicyVersion: "review-target-consume-v1",
    },
  });
  return Object.freeze({
    operation,
    memberPath,
    selectorDigest,
    actorId,
    run,
    invocationIdentity: practiceInvocationIdentity({
      sessionId: invocation.sessionId,
      turnId: invocation.turnId,
      toolCallId: invocation.toolCallId,
    }),
  });
}

export async function executeReviewerRead(prepared, { service, actionDigest }) {
  const current = await service.activeForActor(prepared.actorId);
  if (current.runId !== prepared.run.runId || current.revision !== prepared.run.revision) {
    practiceRunFail("STALE_RUN_REVISION", "PracticeRun revision changed before target consume");
  }
  const target = findTarget(current, prepared.operation.state.targetId);
  if ((target.kind === "file" && prepared.memberPath !== null)
      || (target.kind === "directory_snapshot" && prepared.memberPath === null)) {
    practiceRunFail("TARGET_KIND_MISMATCH", "read memberPath shape conflicts with target kind");
  }
  if (resourceSelectorDigest(target.targetId, prepared.memberPath) !== prepared.selectorDigest) {
    practiceRunFail("INVALID_TARGET", "read resource selector binding changed");
  }
  const resource = await service.targetCapture.captureResource(target, prepared.memberPath);
  const chunk = maximalChunk(resource.lines, prepared.operation.input.offset, prepared.operation.input.limit);
  const canonicalBytes = Buffer.from(chunk.text, "utf8");
  let receipt;
  try {
    receipt = await service.artifactStore.put({
      binding: {
        kind: "practice_target",
        sessionHash: service.artifactStore.sessionHash,
        actorId: prepared.actorId,
        practiceRunId: current.runId,
        targetId: target.targetId,
        invocationIdentity: prepared.invocationIdentity,
        sourceOperationDigest: actionDigest,
      },
      purpose: "review_target_chunk",
      ordinal: 0,
      mediaType: "text/plain;charset=utf-8",
      encoding: "utf-8",
      truncated: chunk.truncated,
      producerId: "review-target-consume",
      producerVersion: 1,
      transformVersion: 1,
      canonicalBytes,
    });
  } catch (error) {
    mapArtifactError(error);
  }
  const artifact = evidenceMetadataFromReceipt(receipt);
  const reviewTargetConsume = Object.freeze({
    targetId: target.targetId,
    snapshotIdentity: target.snapshot.identity,
    resourceSelectorDigest: prepared.selectorDigest,
    fullContentDigest: resource.contentDigest,
    fullContentBytes: resource.contentBytes,
    fullContentLines: resource.contentLines,
    encoding: "utf-8",
    requestedOffset: prepared.operation.input.offset,
    requestedLimit: prepared.operation.input.limit,
    returnedLineStart: chunk.lineStart,
    returnedLineEnd: chunk.lineEnd,
    truncated: chunk.truncated,
    artifact,
  });
  return {
    content: [{ type: "text", text: chunk.text }],
    details: {
      targetId: target.targetId,
      memberPath: prepared.memberPath,
      returnedLineStart: chunk.lineStart,
      returnedLineEnd: chunk.lineEnd,
      fullContentBytes: resource.contentBytes,
      fullContentLines: resource.contentLines,
      truncated: chunk.truncated,
    },
    reviewTargetConsume,
  };
}

export function reviewerReadEvidenceMetadata(result) {
  return { metadata: { reviewTargetConsume: result.reviewTargetConsume } };
}

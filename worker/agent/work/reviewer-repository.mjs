import { Type } from "typebox";

import { evidenceMetadataFromReceipt } from "../artifacts/schema.mjs";
import { canonicalJson } from "../canonical-json.mjs";
import { practiceRunFail } from "../practices/errors.mjs";
import { practiceInvocationIdentity } from "../practices/practice-run-store.mjs";
import {
  TARGET_ID_PATTERN,
  findTarget,
  gitInspectionPrefixDigest,
  normalizeGitPathPrefix,
  repositoryInspectionSelectorDigest,
} from "../practices/review-targets.mjs";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RESULTS = 200;
const EFFECTS = Object.freeze({
  localRead: true,
  workspaceMutation: false,
  networkEgress: false,
  modelInference: false,
  costBearing: false,
});

export const REVIEWER_REPOSITORY_DEFINITION = Object.freeze({
  name: "inspect_repository",
  label: "Inspect review repository snapshot",
  description: "List bounded members from an immutable commit target manifest without accessing live Git.",
  parameters: Type.Object({
    targetId: Type.String({ minLength: 43, maxLength: 43 }),
    action: Type.Literal("list_commit"),
    prefix: Type.String({ minLength: 1, maxLength: 1024 }),
    offset: Type.Integer({ minimum: 0 }),
    limit: Type.Integer({ minimum: 1, maximum: MAX_RESULTS }),
  }, { additionalProperties: false }),
});

function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function prefixMatches(path, prefix) {
  return prefix === "." || path === prefix || path.startsWith(`${prefix}/`);
}

function validateParams(params) {
  if (!exact(params, ["action", "limit", "offset", "prefix", "targetId"])
      || !TARGET_ID_PATTERN.test(params?.targetId) || params.action !== "list_commit") {
    practiceRunFail("GIT_INSPECTION_INVALID", "Repository inspection input is invalid");
  }
  if (!Number.isSafeInteger(params.offset) || params.offset < 0
      || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > MAX_RESULTS) {
    practiceRunFail("TARGET_RANGE_INVALID", "Repository inspection range is invalid");
  }
}

function mapArtifactError(error) {
  if (error?.name !== "CapturedArtifactError") throw error;
  if (["ARTIFACT_LIMIT_EXCEEDED", "ARTIFACT_PRODUCER_NOT_ALLOWED", "ARTIFACT_METADATA_INVALID"].includes(error.code)) {
    practiceRunFail("TARGET_LIMIT_EXCEEDED", "Repository inspection output violates its producer limit");
  }
  if (error.code === "ARTIFACT_QUOTA_EXCEEDED") {
    practiceRunFail("CAPTURE_LIMIT_EXCEEDED", "Repository inspection artifacts exceed aggregate quota");
  }
  practiceRunFail("TARGET_ARTIFACT_INVALID", "Repository inspection artifact storage is unavailable");
}

export async function prepareRepositoryInspection({ service, params, invocation }) {
  validateParams(params);
  let normalizedPrefix;
  try { normalizedPrefix = normalizeGitPathPrefix(params.prefix); }
  catch (error) {
    if (["TARGET_SELECTOR_INVALID", "TARGET_SENSITIVE_PATH_DENIED", "TARGET_LIMIT_EXCEEDED"].includes(error?.code)) {
      practiceRunFail("GIT_INSPECTION_INVALID", "Repository inspection prefix is invalid");
    }
    throw error;
  }
  const actorId = invocation.actor?.id;
  const run = await service.activeForActor(actorId);
  await service.targetCapture.initialize();
  const selectorDigest = repositoryInspectionSelectorDigest({
    targetId: params.targetId,
    action: params.action,
    prefix: normalizedPrefix,
    offset: params.offset,
    limit: params.limit,
  });
  const operation = Object.freeze({
    policyVersion: "review-git-inspect-v1",
    category: "read-only",
    toolName: "inspect_repository",
    effects: EFFECTS,
    workspaceScope: service.targetCapture.workspaceScope,
    roleId: run.roleId,
    profileDigest: run.profileDigest,
    practiceId: run.practiceId,
    practiceVersion: 2,
    state: { runId: run.runId, expectedRunRevision: run.revision, targetId: params.targetId },
    input: {
      action: "list_commit",
      selectorDigest,
      prefixDigest: gitInspectionPrefixDigest(normalizedPrefix),
      prefixBytes: Buffer.byteLength(normalizedPrefix, "utf8"),
      offset: params.offset,
      limit: params.limit,
      inspectionPolicyVersion: "review-git-inspection-v1",
    },
  });
  return Object.freeze({
    operation,
    actorId,
    run,
    normalizedPrefix,
    selectorDigest,
    invocationIdentity: practiceInvocationIdentity({
      sessionId: invocation.sessionId,
      turnId: invocation.turnId,
      toolCallId: invocation.toolCallId,
    }),
  });
}

function listOutput(targetId, prefix, offset, totalMatchingMembers, members) {
  return {
    schemaVersion: 1,
    kind: "git-commit-list",
    targetId,
    prefix,
    offset,
    returnedCount: members.length,
    totalMatchingMembers,
    truncated: offset + members.length < totalMatchingMembers,
    members,
  };
}

export async function executeRepositoryInspection(prepared, { service, actionDigest }) {
  const current = await service.activeForActor(prepared.actorId);
  if (current.runId !== prepared.run.runId || current.revision !== prepared.run.revision) {
    practiceRunFail("STALE_RUN_REVISION", "PracticeRun revision changed before repository inspection");
  }
  const target = findTarget(current, prepared.operation.state.targetId);
  if (target.kind !== "commit") {
    practiceRunFail("GIT_INSPECTION_UNSUPPORTED", "inspect_repository requires a commit target");
  }
  const manifest = await service.targetCapture.readCommitManifest(target);
  const matching = manifest.members.filter((member) => prefixMatches(member.path, prepared.normalizedPrefix));
  if (matching.length === 0) practiceRunFail("GIT_PREFIX_EMPTY", "Repository prefix matches no manifest member");
  const { offset, limit } = prepared.operation.input;
  if (offset >= matching.length) practiceRunFail("TARGET_RANGE_INVALID", "Repository list offset is outside the matching range");

  const members = [];
  for (const member of matching.slice(offset, offset + limit)) {
    const candidate = {
      path: member.path,
      mode: member.mode,
      contentBytes: member.contentBytes,
      contentLines: member.contentLines,
    };
    const next = [...members, candidate];
    const bytes = Buffer.byteLength(canonicalJson(listOutput(
      target.targetId,
      prepared.normalizedPrefix,
      offset,
      matching.length,
      next,
    )), "utf8");
    if (bytes > MAX_OUTPUT_BYTES) break;
    members.push(candidate);
  }
  if (members.length === 0) practiceRunFail("TARGET_LIMIT_EXCEEDED", "Repository inspection member cannot fit its output bound");
  const output = listOutput(target.targetId, prepared.normalizedPrefix, offset, matching.length, members);
  const text = canonicalJson(output);
  const bytes = Buffer.from(text, "utf8");
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
      purpose: "git_commit_list",
      ordinal: 0,
      mediaType: "application/vnd.tiangong.git-commit-list+json;version=1",
      encoding: "utf-8",
      truncated: false,
      producerId: "review-git-inspect",
      producerVersion: 1,
      transformVersion: 1,
      canonicalBytes: bytes,
    });
  } catch (error) {
    mapArtifactError(error);
  }
  const reviewRepositoryInspection = Object.freeze({
    targetId: target.targetId,
    snapshotIdentity: target.snapshot.identity,
    action: "list_commit",
    selectorDigest: prepared.selectorDigest,
    resultCount: members.length,
    truncated: output.truncated,
    artifact: evidenceMetadataFromReceipt(receipt),
  });
  return {
    content: [{ type: "text", text }],
    details: {
      targetId: target.targetId,
      action: "list_commit",
      resultCount: members.length,
      truncated: output.truncated,
    },
    reviewRepositoryInspection,
  };
}

export function repositoryInspectionEvidenceMetadata(result) {
  return { metadata: { reviewRepositoryInspection: result.reviewRepositoryInspection } };
}

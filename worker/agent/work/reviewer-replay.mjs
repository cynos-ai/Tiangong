import { canonicalJson, idempotencyKey, operationDigest, sha256 } from "../canonical-json.mjs";
import { projectReviewEvidence } from "../evidence/projection.mjs";
import { practiceRunFail } from "../practices/errors.mjs";
import { practiceInvocationIdentity } from "../practices/practice-run-store.mjs";
import {
  expectedArtifactContentIdentity,
  normalizeMemberPath,
  normalizeRelativePath,
  repositoryInspectionSelectorDigest,
  resourceSelectorDigest,
} from "../practices/review-targets.mjs";

function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function inspectionSelector(params) {
  const prefix = normalizeRelativePath(params.prefix, { allowRoot: true, sensitive: false });
  const queryDigest = params.action === "search"
    ? sha256(canonicalJson({ schemaId: "tiangong.directory-query.v1", query: params.query })) : null;
  return sha256(canonicalJson({
    schemaId: "tiangong.directory-inspection-selector.v1",
    action: params.action,
    prefix,
    offset: params.action === "list" ? params.offset : null,
    limit: params.action === "list" ? params.limit : null,
    queryDigest,
    maxResults: params.action === "search" ? params.maxResults : null,
  }));
}

function paramsMatch(toolName, params, operation) {
  if (toolName === "read") {
    if (!exact(params, ["limit", "offset", "targetId"])
        && !exact(params, ["limit", "memberPath", "offset", "targetId"])) return false;
    const memberPath = Object.hasOwn(params, "memberPath") ? normalizeMemberPath(params.memberPath) : null;
    return params.targetId === operation.state.targetId && params.offset === operation.input.offset
      && params.limit === operation.input.limit
      && resourceSelectorDigest(params.targetId, memberPath) === operation.input.resourceSelectorDigest;
  }
  if (toolName === "inspect_repository") {
    return exact(params, ["action", "limit", "offset", "prefix", "targetId"])
      && params.action === "list_commit" && params.targetId === operation.state.targetId
      && repositoryInspectionSelectorDigest({
        targetId: params.targetId,
        action: params.action,
        prefix: normalizeRelativePath(params.prefix, { allowRoot: true }),
        offset: params.offset,
        limit: params.limit,
      }) === operation.input.selectorDigest;
  }
  const keys = params.action === "list" ? ["action", "limit", "offset", "prefix", "targetId"]
    : ["action", "maxResults", "prefix", "query", "targetId"];
  return exact(params, keys) && params.targetId === operation.state.targetId
    && inspectionSelector(params) === operation.input.selectorDigest;
}

function artifactRequest(service, gate, artifact, targetId) {
  return {
    artifactKey: artifact.artifactKey,
    artifactRefDigest: artifact.artifactRefDigest,
    expectedBinding: {
      kind: "practice_target",
      sessionHash: service.artifactStore.sessionHash,
      actorId: gate.actorId,
      practiceRunId: gate.practiceRunId,
      targetId,
      invocationIdentity: practiceInvocationIdentity({
        sessionId: gate.sessionId, turnId: gate.turnId, toolCallId: gate.toolCallId,
      }),
      sourceOperationDigest: gate.operationDigest,
    },
    expectedContentIdentity: expectedArtifactContentIdentity({
      contentIdentity: {
        purpose: artifact.purpose,
        contentDigest: artifact.contentDigest,
        contentBytes: artifact.contentBytes,
        contentLines: artifact.contentLines,
        mediaType: artifact.mediaType,
        truncated: artifact.truncated,
        producerId: artifact.producerId,
        producerVersion: artifact.producerVersion,
        transformVersion: artifact.transformVersion,
      },
      ordinal: artifact.ordinal,
      encoding: artifact.encoding,
    }),
  };
}

export async function durableReviewerReplay({ service, evidence, toolName, params, invocation }) {
  const invocationIdentity = practiceInvocationIdentity({
    sessionId: invocation.sessionId,
    turnId: invocation.turnId,
    toolCallId: invocation.toolCallId,
  });
  const records = await evidence.readAll();
  const completions = records.filter((record) => record.type === "tool.execution.completed"
    && record.status === "success" && record.toolName === toolName
    && practiceInvocationIdentity({
      sessionId: record.sessionId, turnId: record.turnId, toolCallId: record.toolCallId,
    }) === invocationIdentity);
  if (completions.length === 0) return null;
  if (completions.length !== 1) practiceRunFail("EVIDENCE_AMBIGUOUS", "Reviewer invocation has ambiguous successful Evidence");
  const completion = completions[0];
  const gates = records.filter((record) => record.type === "gate.decided" && record.decision === "allow"
    && record.sessionId === completion.sessionId && record.turnId === completion.turnId
    && record.toolCallId === completion.toolCallId && record.toolName === toolName
    && record.sequence < completion.sequence).sort((left, right) => left.sequence - right.sequence);
  if (gates.length === 0) practiceRunFail("EVIDENCE_AMBIGUOUS", "Reviewer replay Gate Evidence is missing");
  const gate = gates.at(-1);
  if (gates.some((candidate) => candidate.actorId !== gate.actorId
      || candidate.operationDigest !== gate.operationDigest || candidate.idempotencyKey !== gate.idempotencyKey
      || operationDigest(candidate.operation) !== candidate.operationDigest)
      || gate.actorId !== invocation.actor?.id || !paramsMatch(toolName, params, gate.operation)
      || operationDigest(gate.operation) !== gate.operationDigest
      || gate.idempotencyKey !== idempotencyKey({
        sessionId: gate.sessionId, turnId: gate.turnId, toolCallId: gate.toolCallId,
        operationDigest: gate.operationDigest,
      })) practiceRunFail("INVOCATION_CONFLICT", "Reviewer invocation changed its target operation");
  const state = await service.state();
  const run = state.runs[gate.practiceRunId];
  if (!run || run.origin.actorId !== gate.actorId) practiceRunFail("TARGET_NOT_FOUND", "Replay target run is unavailable");
  const projection = await projectReviewEvidence({
    evidence,
    boundary: { sequence: completion.sequence, hash: completion.hash },
    run,
    targetCapture: service.targetCapture,
    artifactStore: service.artifactStore,
  });
  const execution = projection.executions.find((entry) => entry.completedRef?.sequence === completion.sequence);
  if (!execution || execution.status !== "success" || execution.toolName !== toolName) {
    practiceRunFail("EVIDENCE_JOIN_INVALID", "Reviewer replay lifecycle is invalid");
  }
  const metadata = toolName === "read"
    ? completion.metadata.reviewTargetConsume
    : toolName === "inspect_repository"
      ? completion.metadata.reviewRepositoryInspection
      : completion.metadata.reviewDirectoryInspection;
  let artifact;
  try {
    artifact = await service.artifactStore.readFromEvidence(artifactRequest(service, gate, metadata.artifact, metadata.targetId));
  } catch {
    practiceRunFail("TARGET_ARTIFACT_INVALID", "Reviewer replay Artifact is invalid");
  }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(artifact.bytes);
  const details = toolName === "read" ? {
    targetId: metadata.targetId,
    memberPath: Object.hasOwn(params, "memberPath") ? normalizeMemberPath(params.memberPath) : null,
    returnedLineStart: metadata.returnedLineStart,
    returnedLineEnd: metadata.returnedLineEnd,
    fullContentBytes: metadata.fullContentBytes,
    fullContentLines: metadata.fullContentLines,
    truncated: metadata.truncated,
  } : {
    targetId: metadata.targetId,
    action: metadata.action,
    resultCount: metadata.resultCount,
    truncated: metadata.truncated,
  };
  return Object.freeze({
    durableReplay: true,
    operation: gate.operation,
    operationDigest: gate.operationDigest,
    idempotencyKey: gate.idempotencyKey,
    result: { content: [{ type: "text", text }], details },
  });
}

import { idempotencyKey, operationDigest, sha256 } from "../canonical-json.mjs";
import { practiceRunFail } from "../practices/errors.mjs";
import { practiceInvocationIdentity } from "../practices/practice-run-store.mjs";
import { expectedArtifactContentIdentity, resourceSelectorDigest } from "../practices/review-targets.mjs";

const GENESIS_HASH = "0".repeat(64);
const MUTATION_TOOLS = new Set(["write", "edit", "bash"]);
const DIGEST = /^[a-f0-9]{64}$/u;
const EFFECTS = Object.freeze({
  localRead: true,
  workspaceMutation: false,
  networkEgress: false,
  modelInference: false,
  costBearing: false,
});

function ref(record) {
  return {
    sessionId: record.sessionId,
    turnId: record.turnId,
    toolCallId: record.toolCallId,
    sequence: record.sequence,
    eventHash: record.hash,
  };
}

function exact(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function sameIdentity(left, right) {
  return left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.toolCallId === right.toolCallId && left.operationDigest === right.operationDigest
    && left.idempotencyKey === right.idempotencyKey && left.actorId === right.actorId
    && left.practiceRunId === right.practiceRunId && left.roleId === right.roleId
    && left.profileDigest === right.profileDigest && left.practiceId === right.practiceId
    && left.practiceVersion === right.practiceVersion;
}

function assertBoundary(records, boundary) {
  if (!boundary || !Number.isSafeInteger(boundary.sequence) || boundary.sequence < 0
      || typeof boundary.hash !== "string") {
    practiceRunFail("EVIDENCE_BOUNDARY_INVALID", "Evidence terminal boundary is invalid");
  }
  if (boundary.sequence === 0) {
    if (boundary.hash !== GENESIS_HASH || records.length !== 0) {
      practiceRunFail("EVIDENCE_BOUNDARY_INVALID", "Evidence genesis boundary does not match the chain");
    }
    return [];
  }
  const terminal = records.find((record) => record.sequence === boundary.sequence);
  if (!terminal || terminal.hash !== boundary.hash) {
    practiceRunFail("EVIDENCE_BOUNDARY_INVALID", "Evidence terminal boundary is not in the verified chain");
  }
  return records.filter((record) => record.sequence <= boundary.sequence);
}

function exactly(records, predicate, reason) {
  const selected = records.filter(predicate);
  if (selected.length !== 1) practiceRunFail("EVIDENCE_AMBIGUOUS", reason);
  return selected[0];
}

function assertEffects(value) {
  if (!exact(value, Object.keys(EFFECTS)) || Object.entries(EFFECTS).some(([key, expected]) => value[key] !== expected)) {
    practiceRunFail("EVIDENCE_OPERATION_INVALID", "Reviewer Evidence effects are invalid");
  }
}

function validateArtifactMetadata(value, purpose) {
  if (!exact(value, [
    "artifactKey", "artifactRefDigest", "ordinal", "contentDigest", "contentBytes", "contentLines",
    "mediaType", "encoding", "truncated", "purpose", "producerId", "producerVersion", "transformVersion",
  ]) || !DIGEST.test(value.artifactKey) || !DIGEST.test(value.artifactRefDigest) || value.ordinal !== 0
      || !DIGEST.test(value.contentDigest) || !Number.isSafeInteger(value.contentBytes) || value.contentBytes < 0
      || !Number.isSafeInteger(value.contentLines) || value.contentLines < 1 || value.encoding !== "utf-8"
      || typeof value.truncated !== "boolean" || value.purpose !== purpose
      || value.producerVersion !== 1 || value.transformVersion !== 1) {
    practiceRunFail("EVIDENCE_RESULT_INVALID", "Captured Artifact Evidence metadata is invalid");
  }
}

async function targetResources(run, targetCapture) {
  const bySelector = new Map();
  for (const target of run.scope.targets) {
    if (target.kind === "file") {
      const selectorDigest = resourceSelectorDigest(target.targetId, null);
      bySelector.set(selectorDigest, Object.freeze({
        selectorDigest,
        targetId: target.targetId,
        memberPath: null,
        snapshotIdentity: target.snapshot.identity,
        contentDigest: target.snapshot.facts.contentDigest,
        contentBytes: target.snapshot.facts.contentBytes,
        contentLines: target.snapshot.facts.contentLines,
      }));
    } else {
      const manifest = await targetCapture.readDirectoryManifest(target);
      for (const member of manifest.members) {
        const selectorDigest = resourceSelectorDigest(target.targetId, member.path);
        if (bySelector.has(selectorDigest)) practiceRunFail("STATE_CORRUPTED", "Review resource selector digest is ambiguous");
        bySelector.set(selectorDigest, Object.freeze({
          selectorDigest,
          targetId: target.targetId,
          memberPath: member.path,
          snapshotIdentity: target.snapshot.identity,
          contentDigest: member.contentDigest,
          contentBytes: member.contentBytes,
          contentLines: member.contentLines,
        }));
      }
    }
  }
  return bySelector;
}

function validateReadOperation(operation, run) {
  if (!exact(operation, [
    "category", "effects", "input", "policyVersion", "practiceId", "practiceVersion", "profileDigest",
    "roleId", "state", "toolName", "workspaceScope",
  ]) || !exact(operation.input, ["consumePolicyVersion", "limit", "offset", "resourceSelectorDigest"])
      || !exact(operation.state, ["expectedRunRevision", "runId", "targetId"])
      || operation.policyVersion !== "review-target-consume-v2" || operation.category !== "read-only"
      || operation.toolName !== "read" || operation.state.runId !== run.runId
      || !Number.isSafeInteger(operation.state.expectedRunRevision) || operation.state.expectedRunRevision < 1
      || operation.state.expectedRunRevision > run.revision
      || !run.scope.targets.some((target) => target.targetId === operation.state.targetId)
      || !DIGEST.test(operation.input.resourceSelectorDigest)
      || !Number.isSafeInteger(operation.input.offset) || operation.input.offset < 1
      || !Number.isSafeInteger(operation.input.limit) || operation.input.limit < 1 || operation.input.limit > 2000
      || operation.input.consumePolicyVersion !== "review-target-consume-v1"
      || !DIGEST.test(operation.workspaceScope) || operation.profileDigest !== run.profileDigest
      || operation.roleId !== run.roleId || operation.practiceId !== run.practiceId || operation.practiceVersion !== 2) {
    practiceRunFail("EVIDENCE_OPERATION_INVALID", "Read Evidence operation is not bound to the current run");
  }
  assertEffects(operation.effects);
}

function validateReadMetadata(value, operation, resource) {
  if (!exact(value, [
    "artifact", "encoding", "fullContentBytes", "fullContentDigest", "fullContentLines", "requestedLimit",
    "requestedOffset", "resourceSelectorDigest", "returnedLineEnd", "returnedLineStart", "snapshotIdentity",
    "targetId", "truncated",
  ]) || value.targetId !== operation.state.targetId || value.targetId !== resource.targetId
      || value.snapshotIdentity !== resource.snapshotIdentity
      || value.resourceSelectorDigest !== operation.input.resourceSelectorDigest
      || value.fullContentDigest !== resource.contentDigest || value.fullContentBytes !== resource.contentBytes
      || value.fullContentLines !== resource.contentLines || value.encoding !== "utf-8"
      || value.requestedOffset !== operation.input.offset || value.requestedLimit !== operation.input.limit
      || value.returnedLineStart !== operation.input.offset
      || !Number.isSafeInteger(value.returnedLineEnd) || value.returnedLineEnd < value.returnedLineStart
      || value.returnedLineEnd > Math.min(value.fullContentLines, value.requestedOffset + value.requestedLimit - 1)
      || value.truncated !== (value.returnedLineEnd < value.fullContentLines)) {
    practiceRunFail("EVIDENCE_RESULT_INVALID", "Read Evidence result metadata conflicts with its target resource");
  }
  validateArtifactMetadata(value.artifact, "review_target_chunk");
  if (value.artifact.mediaType !== "text/plain;charset=utf-8" || value.artifact.producerId !== "review-target-consume"
      || value.artifact.truncated !== value.truncated
      || value.artifact.contentLines !== value.returnedLineEnd - value.returnedLineStart + 1) {
    practiceRunFail("EVIDENCE_RESULT_INVALID", "Read Artifact metadata conflicts with its returned range");
  }
}

function validateInspectionOperation(operation, run) {
  if (!exact(operation, [
    "category", "effects", "input", "policyVersion", "practiceId", "practiceVersion", "profileDigest",
    "roleId", "state", "toolName", "workspaceScope",
  ]) || !exact(operation.state, ["expectedRunRevision", "runId", "targetId"])
      || !exact(operation.input, [
        "action", "inspectionPolicyVersion", "limit", "maxResults", "offset", "prefixBytes", "prefixDigest",
        "queryBytes", "queryDigest", "selectorDigest",
      ]) || operation.policyVersion !== "review-directory-inspect-v1" || operation.toolName !== "inspect_directory"
      || operation.category !== "read-only" || operation.state.runId !== run.runId
      || !Number.isSafeInteger(operation.state.expectedRunRevision)
      || operation.state.expectedRunRevision < 1 || operation.state.expectedRunRevision > run.revision
      || !run.scope.targets.some((target) => target.targetId === operation.state.targetId && target.kind === "directory_snapshot")
      || !["list", "search"].includes(operation.input.action) || !DIGEST.test(operation.input.selectorDigest)
      || !DIGEST.test(operation.input.prefixDigest) || operation.input.inspectionPolicyVersion !== "review-directory-inspection-v1"
      || operation.practiceVersion !== 2 || operation.profileDigest !== run.profileDigest || operation.roleId !== run.roleId
      || operation.practiceId !== run.practiceId || !DIGEST.test(operation.workspaceScope)
      || !Number.isSafeInteger(operation.input.prefixBytes) || operation.input.prefixBytes < 1 || operation.input.prefixBytes > 1024
      || (operation.input.action === "list" && (
        !Number.isSafeInteger(operation.input.offset) || operation.input.offset < 0
        || !Number.isSafeInteger(operation.input.limit) || operation.input.limit < 1 || operation.input.limit > 200
        || operation.input.queryDigest !== null || operation.input.queryBytes !== null || operation.input.maxResults !== null
      )) || (operation.input.action === "search" && (
        operation.input.offset !== null || operation.input.limit !== null || !DIGEST.test(operation.input.queryDigest)
        || !Number.isSafeInteger(operation.input.queryBytes) || operation.input.queryBytes < 1 || operation.input.queryBytes > 256
        || !Number.isSafeInteger(operation.input.maxResults) || operation.input.maxResults < 1 || operation.input.maxResults > 200
      ))) {
    practiceRunFail("EVIDENCE_OPERATION_INVALID", "Directory inspection Evidence operation is invalid");
  }
  assertEffects(operation.effects);
}

function validateInspectionMetadata(value, operation, target) {
  if (!exact(value, ["action", "artifact", "resultCount", "selectorDigest", "snapshotIdentity", "targetId", "truncated"])
      || value.targetId !== target.targetId || value.snapshotIdentity !== target.snapshot.identity
      || value.action !== operation.input.action || value.selectorDigest !== operation.input.selectorDigest
      || !Number.isSafeInteger(value.resultCount) || value.resultCount < 0 || typeof value.truncated !== "boolean") {
    practiceRunFail("EVIDENCE_RESULT_INVALID", "Directory inspection Evidence metadata is invalid");
  }
  const purpose = value.action === "list" ? "directory_list" : "directory_search";
  validateArtifactMetadata(value.artifact, purpose);
  const mediaType = value.action === "list"
    ? "application/vnd.tiangong.directory-list+json;version=1"
    : "application/vnd.tiangong.directory-search+json;version=1";
  if (value.artifact.mediaType !== mediaType || value.artifact.producerId !== "review-directory-inspect"
      || value.artifact.truncated !== value.truncated) {
    practiceRunFail("EVIDENCE_RESULT_INVALID", "Directory inspection Artifact metadata is invalid");
  }
}

async function validateEvidenceArtifact({ artifactStore, artifact, gate, targetId }) {
  const binding = {
    kind: "practice_target",
    sessionHash: artifactStore.sessionHash,
    actorId: gate.actorId,
    practiceRunId: gate.practiceRunId,
    targetId,
    invocationIdentity: practiceInvocationIdentity({
      sessionId: gate.sessionId, turnId: gate.turnId, toolCallId: gate.toolCallId,
    }),
    sourceOperationDigest: gate.operationDigest,
  };
  try {
    return await artifactStore.readFromEvidence({
      artifactKey: artifact.artifactKey,
      artifactRefDigest: artifact.artifactRefDigest,
      expectedBinding: binding,
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
    });
  } catch {
    practiceRunFail("TARGET_ARTIFACT_INVALID", "Review Evidence references an invalid Captured Artifact");
  }
}

export async function evidenceBoundary(evidence) {
  const records = await evidence.readAll();
  const terminal = records.at(-1);
  return Object.freeze({ sequence: terminal?.sequence ?? 0, hash: terminal?.hash ?? GENESIS_HASH });
}

export async function projectReviewEvidence({ evidence, boundary, run, targetCapture, artifactStore }) {
  if (!targetCapture || !artifactStore) throw new TypeError("Review Evidence projection requires target artifact dependencies");
  const records = assertBoundary(await evidence.readAll(), boundary);
  const resources = await targetResources(run, targetCapture);
  const gates = records.filter((record) => record.type === "gate.decided"
    && record.practiceRunId === run.runId && record.actorId === run.origin.actorId
    && (["read", "inspect_directory"].includes(record.toolName) || MUTATION_TOOLS.has(record.toolName)));
  const gateGroups = new Map();
  for (const gate of gates) {
    const identity = `${gate.sessionId}\u0000${gate.turnId}\u0000${gate.toolCallId}\u0000${gate.toolName}`;
    const group = gateGroups.get(identity) ?? [];
    group.push(gate);
    gateGroups.set(identity, group);
  }
  const executions = [];
  for (const [identity, unsortedGroup] of gateGroups) {
    const group = unsortedGroup.sort((left, right) => left.sequence - right.sequence);
    const firstGate = group[0];
    for (const candidate of group) {
      if (candidate.decision !== firstGate.decision || !sameIdentity(firstGate, candidate)
          || operationDigest(candidate.operation) !== candidate.operationDigest
          || candidate.idempotencyKey !== idempotencyKey({
            sessionId: candidate.sessionId,
            turnId: candidate.turnId,
            toolCallId: candidate.toolCallId,
            operationDigest: candidate.operationDigest,
          })) {
        practiceRunFail("EVIDENCE_OPERATION_INVALID", "Repeated run-bound Evidence changed its operation identity");
      }
    }
    if (firstGate.decision !== "allow") {
      if (group.length !== 1) practiceRunFail("EVIDENCE_AMBIGUOUS", "Denied run-bound Gate identity was repeated");
      continue;
    }
    let gate;
    let started;
    let completed;
    for (let index = 0; index < group.length; index += 1) {
      const candidate = group[index];
      const previousGateSequence = index === 0 ? 0 : group[index - 1].sequence;
      const nextGateSequence = group[index + 1]?.sequence ?? Number.MAX_SAFE_INTEGER;
      exactly(records, (record) => (record.type === "tool.proposed" || record.type === "tool.resumed")
        && record.sessionId === candidate.sessionId && record.turnId === candidate.turnId
        && record.toolCallId === candidate.toolCallId && record.toolName === candidate.toolName
        && record.sequence > previousGateSequence && record.sequence < candidate.sequence,
      "Run-bound execution attempt does not have exactly one proposal");
      const attemptStarted = exactly(records, (record) => record.type === "tool.execution.started"
        && record.idempotencyKey === candidate.idempotencyKey && record.operationDigest === candidate.operationDigest
        && record.sequence > candidate.sequence && record.sequence < nextGateSequence,
      "Allowed run-bound execution attempt does not have exactly one start");
      const terminals = records.filter((record) => record.type === "tool.execution.completed"
        && record.idempotencyKey === candidate.idempotencyKey && record.operationDigest === candidate.operationDigest
        && record.sequence > attemptStarted.sequence && record.sequence < nextGateSequence);
      if (!sameIdentity(candidate, attemptStarted) || terminals.some((record) => !sameIdentity(candidate, record))) {
        practiceRunFail("EVIDENCE_JOIN_INVALID", "Run-bound Evidence lifecycle fields conflict");
      }
      if (index < group.length - 1) {
        if (terminals.length > 1 || terminals.some((record) => record.status === "success")) {
          practiceRunFail("EVIDENCE_AMBIGUOUS", "A successful or ambiguous execution was retried");
        }
      } else {
        if (terminals.length !== 1) {
          practiceRunFail("EVIDENCE_AMBIGUOUS", "Latest run-bound execution lacks one terminal event");
        }
        gate = candidate;
        started = attemptStarted;
        [completed] = terminals;
      }
    }
    if (gate.toolName === "read") validateReadOperation(gate.operation, run);
    if (gate.toolName === "inspect_directory") validateInspectionOperation(gate.operation, run);
    if (completed.status !== "success") {
      executions.push(Object.freeze({
        practiceRunId: run.runId,
        toolName: gate.toolName,
        invocationIdentity: identity,
        operationDigest: gate.operationDigest,
        operation: structuredClone(gate.operation),
        status: "error",
        errorCode: completed.errorCode ?? "TOOL_EXECUTION_FAILED",
        completedRef: ref(completed),
      }));
      continue;
    }
    if (gate.toolName === "read") {
      const resource = resources.get(gate.operation.input.resourceSelectorDigest);
      if (!resource) practiceRunFail("EVIDENCE_OPERATION_INVALID", "Read Evidence selector is not in the final target scope");
      const metadata = completed.metadata?.reviewTargetConsume;
      validateReadMetadata(metadata, gate.operation, resource);
      const artifact = await validateEvidenceArtifact({
        artifactStore, artifact: metadata.artifact, gate, targetId: resource.targetId,
      });
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(artifact.bytes);
      if (text.split("\n").length !== metadata.artifact.contentLines) {
        practiceRunFail("TARGET_ARTIFACT_INVALID", "Review consume Artifact line facts are invalid");
      }
      executions.push(Object.freeze({
        practiceRunId: run.runId,
        toolName: "read",
        invocationIdentity: identity,
        operationDigest: gate.operationDigest,
        operation: structuredClone(gate.operation),
        status: "success",
        resource,
        resultMetadata: structuredClone(metadata),
        startedRef: ref(started),
        completedRef: ref(completed),
      }));
    } else if (gate.toolName === "inspect_directory") {
      const target = run.scope.targets.find((entry) => entry.targetId === gate.operation.state.targetId);
      const metadata = completed.metadata?.reviewDirectoryInspection;
      validateInspectionMetadata(metadata, gate.operation, target);
      const artifact = await validateEvidenceArtifact({
        artifactStore, artifact: metadata.artifact, gate, targetId: target.targetId,
      });
      let result;
      try {
        result = JSON.parse(artifact.bytes.toString("utf8"));
      } catch {
        practiceRunFail("TARGET_ARTIFACT_INVALID", "Directory inspection Artifact JSON is invalid");
      }
      if (result.targetId !== metadata.targetId || result.returnedCount !== metadata.resultCount
          || result.truncated !== metadata.truncated
          || result.kind !== (metadata.action === "list" ? "directory-list" : "directory-search")) {
        practiceRunFail("TARGET_ARTIFACT_INVALID", "Directory inspection Artifact conflicts with Evidence");
      }
      executions.push(Object.freeze({
        practiceRunId: run.runId,
        toolName: "inspect_directory",
        invocationIdentity: identity,
        operationDigest: gate.operationDigest,
        operation: structuredClone(gate.operation),
        status: "success",
        resultMetadata: structuredClone(metadata),
        startedRef: ref(started),
        completedRef: ref(completed),
      }));
    } else {
      executions.push(Object.freeze({
        practiceRunId: run.runId,
        toolName: gate.toolName,
        invocationIdentity: identity,
        operationDigest: gate.operationDigest,
        operation: structuredClone(gate.operation),
        status: "success",
        startedRef: ref(started),
        completedRef: ref(completed),
      }));
    }
  }
  return Object.freeze({
    boundary: Object.freeze({ ...boundary }),
    executions: Object.freeze(executions),
    resources: Object.freeze([...resources.values()]),
    digest: sha256(executions),
  });
}

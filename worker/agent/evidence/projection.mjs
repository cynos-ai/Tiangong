import { idempotencyKey, operationDigest, sha256 } from "../canonical-json.mjs";
import { practiceRunFail } from "../practices/errors.mjs";

const GENESIS_HASH = "0".repeat(64);
const MAX_SELECTED_EVENT_REFS = 2048;
const MUTATION_TOOLS = new Set(["write", "edit", "bash"]);

function ref(record) {
  return {
    sessionId: record.sessionId,
    turnId: record.turnId,
    toolCallId: record.toolCallId,
    sequence: record.sequence,
    eventHash: record.hash,
  };
}

function sameIdentity(left, right) {
  return left.sessionId === right.sessionId && left.turnId === right.turnId &&
    left.toolCallId === right.toolCallId && left.operationDigest === right.operationDigest &&
    left.idempotencyKey === right.idempotencyKey && left.actorId === right.actorId &&
    left.practiceRunId === right.practiceRunId && left.roleId === right.roleId &&
    left.profileDigest === right.profileDigest && left.practiceId === right.practiceId &&
    left.practiceVersion === right.practiceVersion;
}

function assertBoundary(records, boundary) {
  if (!boundary || !Number.isSafeInteger(boundary.sequence) || boundary.sequence < 0 ||
      typeof boundary.hash !== "string") {
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

function validateMetadata(metadata) {
  const keys = [
    "fileDigest", "fullFileBytes", "fullFileLines", "returnedBytes", "returnedLineEnd",
    "returnedLineStart", "returnedLines", "truncated",
  ];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      Object.keys(metadata).sort().join(",") !== keys.sort().join(",") ||
      !/^[a-f0-9]{64}$/u.test(metadata.fileDigest) ||
      !Number.isSafeInteger(metadata.fullFileBytes) || metadata.fullFileBytes < 0 ||
      !Number.isSafeInteger(metadata.fullFileLines) || metadata.fullFileLines < 1 ||
      !Number.isSafeInteger(metadata.returnedLineStart) || metadata.returnedLineStart < 1 ||
      !Number.isSafeInteger(metadata.returnedLineEnd) || metadata.returnedLineEnd < metadata.returnedLineStart ||
      metadata.returnedLineEnd > metadata.fullFileLines ||
      !Number.isSafeInteger(metadata.returnedBytes) || metadata.returnedBytes < 0 ||
      metadata.returnedLines !== metadata.returnedLineEnd - metadata.returnedLineStart + 1 ||
      typeof metadata.truncated !== "boolean") {
    practiceRunFail("EVIDENCE_RESULT_INVALID", "Read Evidence result metadata is invalid");
  }
}

export async function evidenceBoundary(evidence) {
  const records = await evidence.readAll();
  const terminal = records.at(-1);
  return Object.freeze({
    sequence: terminal?.sequence ?? 0,
    hash: terminal?.hash ?? GENESIS_HASH,
  });
}

export async function projectReviewEvidence({ evidence, boundary, run }) {
  const records = assertBoundary(await evidence.readAll(), boundary);
  const gates = records.filter((record) => record.type === "gate.decided" &&
    record.practiceRunId === run.runId && record.actorId === run.origin.actorId &&
    (record.toolName === "read" || MUTATION_TOOLS.has(record.toolName)));
  const executions = [];
  const selectedRefs = [];
  const identities = new Set();
  for (const gate of gates) {
    const identity = `${gate.sessionId}\u0000${gate.turnId}\u0000${gate.toolCallId}\u0000${gate.idempotencyKey}`;
    if (identities.has(identity)) practiceRunFail("EVIDENCE_AMBIGUOUS", "Duplicate run-bound Gate identity");
    identities.add(identity);
    if (gate.decision !== "allow") continue;
    if (operationDigest(gate.operation) !== gate.operationDigest || gate.idempotencyKey !== idempotencyKey({
      sessionId: gate.sessionId,
      turnId: gate.turnId,
      toolCallId: gate.toolCallId,
      operationDigest: gate.operationDigest,
    })) {
      practiceRunFail("EVIDENCE_OPERATION_INVALID", "Run-bound Evidence operation identity is invalid");
    }
    const proposed = exactly(records, (record) =>
      (record.type === "tool.proposed" || record.type === "tool.resumed") &&
      record.sessionId === gate.sessionId && record.turnId === gate.turnId &&
      record.toolCallId === gate.toolCallId && record.toolName === gate.toolName && record.sequence < gate.sequence,
    "Run-bound execution does not have exactly one proposal");
    const started = exactly(records, (record) => record.type === "tool.execution.started" &&
      record.idempotencyKey === gate.idempotencyKey && record.operationDigest === gate.operationDigest,
    "Allowed run-bound execution does not have exactly one start");
    const completed = exactly(records, (record) =>
      ["tool.execution.completed", "tool.execution.replayed"].includes(record.type) &&
      record.idempotencyKey === gate.idempotencyKey && record.operationDigest === gate.operationDigest,
    "Allowed run-bound execution does not have exactly one terminal event");
    if (!(proposed.sequence < gate.sequence && gate.sequence < started.sequence && started.sequence < completed.sequence) ||
        !sameIdentity(gate, started) || !sameIdentity(gate, completed)) {
      practiceRunFail("EVIDENCE_JOIN_INVALID", "Run-bound Evidence lifecycle fields or order conflict");
    }
    if (completed.status !== "success") continue;
    if (gate.toolName === "read") {
      const operation = gate.operation;
      const operationKeys = [
        "category", "input", "policyVersion", "practiceId", "practiceVersion", "profileDigest",
        "roleId", "state", "target", "toolName", "workspaceScope",
      ];
      if (!operation || Object.keys(operation).sort().join(",") !== operationKeys.sort().join(",") ||
          Object.keys(operation.input ?? {}).sort().join(",") !== "limit,offset" ||
          Object.keys(operation.state ?? {}).sort().join(",") !== "expectedRunRevision,runId" ||
          operation.policyVersion !== "review-read-v1" || operation.category !== "read-only" ||
          operation.toolName !== "read" || operation.state?.runId !== run.runId ||
          !Number.isSafeInteger(operation.state?.expectedRunRevision) || operation.state.expectedRunRevision < 1 ||
          operation.state.expectedRunRevision > run.revision || !run.scope.files.includes(operation.target) ||
          !Number.isSafeInteger(operation.input?.offset) || operation.input.offset < 1 ||
          !Number.isSafeInteger(operation.input?.limit) || operation.input.limit < 1 ||
          typeof operation.workspaceScope !== "string" || !/^[a-f0-9]{64}$/u.test(operation.workspaceScope) ||
          operation.profileDigest !== run.profileDigest || operation.roleId !== run.roleId ||
          operation.practiceId !== run.practiceId ||
          operation.practiceVersion !== run.practiceVersion) {
        practiceRunFail("EVIDENCE_OPERATION_INVALID", "Read Evidence operation is not bound to the current run");
      }
      if (completed.type !== "tool.execution.completed") {
        practiceRunFail("EVIDENCE_JOIN_INVALID", "Reviewer reads cannot use replay Evidence");
      }
      validateMetadata(completed.resultMetadata);
      if (completed.resultMetadata.returnedLineStart !== operation.input.offset ||
          completed.resultMetadata.returnedLineEnd > operation.input.offset + operation.input.limit - 1 ||
          completed.resultMetadata.truncated !==
            (completed.resultMetadata.returnedLineEnd < completed.resultMetadata.fullFileLines)) {
        practiceRunFail("EVIDENCE_RESULT_INVALID", "Read Evidence range conflicts with its operation");
      }
    }
    const refs = [ref(started), ref(completed)];
    selectedRefs.push(...refs);
    executions.push({
      practiceRunId: run.runId,
      toolName: gate.toolName,
      invocationIdentity: identity,
      operationDigest: gate.operationDigest,
      operation: structuredClone(gate.operation),
      resultMetadata: completed.resultMetadata ? structuredClone(completed.resultMetadata) : null,
      startedRef: refs[0],
      completedRef: refs[1],
    });
  }
  if (selectedRefs.length > MAX_SELECTED_EVENT_REFS) {
    practiceRunFail("EVIDENCE_LIMIT_EXCEEDED", "Selected Evidence references exceed the fixed limit");
  }
  return Object.freeze({
    boundary: Object.freeze({ ...boundary }),
    executions: Object.freeze(executions.map(Object.freeze)),
    selectedEventRefs: Object.freeze(selectedRefs.map(Object.freeze)),
    digest: sha256(executions),
  });
}

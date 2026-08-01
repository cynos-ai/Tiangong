import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson, idempotencyKey, sha256 } from "../canonical-json.mjs";
import { withFileLock } from "../persistence/file-lock.mjs";
import { validateReviewScope, reviewScopeDigest } from "./review-targets.mjs";
import { PracticeRunError, practiceRunFail } from "./errors.mjs";

const SCHEMA_VERSION = 2;
const GENESIS_HASH = "0".repeat(64);
const MAX_JOURNAL_RECORD_BYTES = 1024 * 1024;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const RUN_ID_PATTERN = /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EVENT_ID_PATTERN = /^event-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const CHECKPOINT_IDS = [
  "claim-schema-valid",
  "criteria-covered",
  "scope-matches-final",
  "targets-fully-consumed",
  "observation-targets-valid",
  "outcome-consistent",
  "static-review-limitation-recorded",
  "no-mutation-observed",
];
const ABANDON_REASON_CODES = new Set([
  "superseded_by_new_request", "unsupported_scope", "cannot_complete", "user_cancelled", "other",
]);
const RECORD_KEYS = [
  "actionDigest", "actorId", "eventType", "hash", "inputDigest", "invocationIdentity", "invocationKey",
  "operation", "payload", "payloadDigest", "previousHash", "requestDigest", "runId", "runRevision",
  "schemaVersion", "sequence", "sourceMessageId", "stateEventId", "timestamp", "toolCallId", "turnId",
];
const EFFECTS = Object.freeze({
  localRead: true,
  workspaceMutation: false,
  networkEgress: false,
  modelInference: false,
  costBearing: false,
});

function emptyState() {
  return {
    sequence: 0,
    previousHash: GENESIS_HASH,
    activeRunId: null,
    runs: {},
    invocations: {},
    journalBytes: 0,
    journalIdentity: null,
  };
}

function requiredString(value, name) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} is required`);
  return value;
}

function assertDigest(value, name) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    practiceRunFail("STATE_CORRUPTED", `${name} is not a lowercase SHA-256 digest`);
  }
}

function assertExactKeys(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    practiceRunFail("STATE_CORRUPTED", `${name} has an invalid schema`);
  }
}

function assertTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    practiceRunFail("STATE_CORRUPTED", "PracticeRun journal timestamp is invalid");
  }
}

function assertReference(value, directory) {
  if (typeof value !== "string" || !new RegExp(`^${directory}/[a-f0-9]{64}\\.json$`, "u").test(value)) {
    practiceRunFail("STATE_CORRUPTED", "PracticeRun protected payload reference is invalid");
  }
}

function assertEffects(value) {
  assertExactKeys(value, Object.keys(EFFECTS), "operation effects");
  if (canonicalJson(value) !== canonicalJson(EFFECTS)) practiceRunFail("STATE_CORRUPTED", "Operation effects are invalid");
}

function validateOperation(record, expected) {
  assertExactKeys(record.operation, [
    "category", "effects", "input", "origin", "policyVersion", "practiceId", "practiceVersion",
    "profileDigest", "roleId", "state", "toolName", "workspaceScope",
  ], "PracticeRun operation");
  assertExactKeys(record.operation.origin, ["actorId", "requestDigest", "sourceMessageId"], "operation origin");
  assertEffects(record.operation.effects);
  assertDigest(record.operation.workspaceScope, "workspace scope");
  if (record.operation.policyVersion !== "practice-run-v2" || record.operation.category !== "state-transition"
      || record.operation.toolName !== expected.toolName || record.operation.roleId !== expected.roleId
      || record.operation.profileDigest !== expected.profileDigest || record.operation.practiceId !== expected.practiceId
      || record.operation.practiceVersion !== 2 || record.operation.origin.actorId !== record.actorId
      || record.operation.origin.sourceMessageId !== record.sourceMessageId
      || record.operation.origin.requestDigest !== record.requestDigest) {
    practiceRunFail("STATE_CORRUPTED", "PracticeRun operation metadata conflicts with its event");
  }
  if (expected.run) {
    assertExactKeys(record.operation.state, ["expectedRunRevision", "runId"], "operation state");
    if (record.operation.state.runId !== expected.run.runId
        || record.operation.state.expectedRunRevision !== expected.run.revision) {
      practiceRunFail("STATE_CORRUPTED", "PracticeRun operation state binding is invalid");
    }
  } else if (record.operation.state !== null) {
    practiceRunFail("STATE_CORRUPTED", "start_work operation state must be null");
  }
}

function validateCriteriaMetadata(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return false;
  return value.every((criterion) => {
    try {
      assertExactKeys(criterion, ["bytes", "digest"], "criterion operation metadata");
      assertDigest(criterion.digest, "criterion digest");
      return Number.isSafeInteger(criterion.bytes) && criterion.bytes > 0;
    } catch {
      return false;
    }
  });
}

function assertCapturedByRecord(targets, record) {
  for (const target of targets) {
    for (const artifact of target.snapshot.artifacts) {
      if (artifact.storeBinding.invocationIdentity !== record.invocationIdentity
          || artifact.storeBinding.sourceOperationDigest !== record.actionDigest) {
        practiceRunFail("STATE_CORRUPTED", "Target artifact capture binding conflicts with its admission event");
      }
    }
  }
}

function requestsMatchTargets(requests, targets) {
  return canonicalJson(requests) === canonicalJson(targets.map((target) => ({
    kind: target.kind,
    ...target.descriptor.value,
  })));
}

function assertPolicyInput(input) {
  if (input.capturePolicyVersion !== "review-target-capture-v1"
      || input.workspacePolicyVersion !== "workspace-target-policy-v1"
      || input.textPolicyVersion !== "review-text-lines-v1"
      || !Array.isArray(input.targetRequests) || input.targetRequests.length === 0
      || input.targetRequestsDigest !== sha256(canonicalJson({
        schemaId: "tiangong.target-requests.v1", targets: input.targetRequests,
      }))) {
    practiceRunFail("STATE_CORRUPTED", "Target admission policy input is invalid");
  }
}

function validateStartPayload(record, state, sessionId) {
  const payload = record.payload;
  assertExactKeys(payload, [
    "origin", "practiceId", "practiceVersion", "profileDigest", "roleId", "scope", "spec",
    "targetCapturePolicyVersion", "targetKindRegistryVersion",
  ], "run.started payload");
  assertExactKeys(payload.origin, ["actorId", "messageId", "requestDigest", "requestPayloadRef"], "run origin");
  assertExactKeys(payload.spec, ["digest", "payloadRef"], "run spec reference");
  if (!ID_PATTERN.test(payload.roleId) || !ID_PATTERN.test(payload.practiceId) || payload.practiceVersion !== 2
      || payload.targetCapturePolicyVersion !== "review-target-capture-v1"
      || payload.targetKindRegistryVersion !== "review-target-kinds-v1") {
    practiceRunFail("STATE_CORRUPTED", "run.started role, practice, or target policy metadata is invalid");
  }
  assertDigest(payload.profileDigest, "profile digest");
  assertDigest(payload.origin.requestDigest, "request digest");
  assertReference(payload.origin.requestPayloadRef, "requests");
  assertDigest(payload.spec.digest, "run spec digest");
  assertReference(payload.spec.payloadRef, "specs");
  validateReviewScope(payload.scope, {
    sessionHash: sha256(sessionId), actorId: record.actorId, runId: record.runId,
  });
  validateOperation(record, {
    toolName: "start_work", roleId: payload.roleId, profileDigest: payload.profileDigest,
    practiceId: payload.practiceId,
  });
  assertExactKeys(record.operation.input, [
    "capturePolicyVersion", "criteria", "objectiveBytes", "objectiveDigest", "targetRequests",
    "targetRequestsDigest", "textPolicyVersion", "workspacePolicyVersion",
  ], "start_work operation input");
  assertDigest(record.operation.input.objectiveDigest, "objective digest");
  assertPolicyInput(record.operation.input);
  assertCapturedByRecord(payload.scope.targets, record);
  if (!Number.isSafeInteger(record.operation.input.objectiveBytes) || record.operation.input.objectiveBytes <= 0
      || !validateCriteriaMetadata(record.operation.input.criteria)
      || !requestsMatchTargets(record.operation.input.targetRequests, payload.scope.targets) || record.runRevision !== 1
      || payload.scope.revision !== 1 || payload.origin.actorId !== record.actorId
      || payload.origin.messageId !== record.sourceMessageId || payload.origin.requestDigest !== record.requestDigest
      || state.activeRunId !== null || state.runs[record.runId]) {
    practiceRunFail("STATE_CORRUPTED", "Invalid run.started transition");
  }
  return {
    schemaVersion: 2,
    runId: record.runId,
    sessionId,
    roleId: payload.roleId,
    profileDigest: payload.profileDigest,
    practiceId: payload.practiceId,
    practiceVersion: payload.practiceVersion,
    status: "active",
    revision: 1,
    origin: structuredClone(payload.origin),
    spec: structuredClone(payload.spec),
    scope: structuredClone(payload.scope),
    lastCheckpoint: null,
    startedAt: record.timestamp,
    updatedAt: record.timestamp,
    finishedAt: null,
  };
}

function validateScopePayload(record, run, sessionId) {
  const payload = record.payload;
  validateOperation(record, {
    toolName: "extend_scope", roleId: run.roleId, profileDigest: run.profileDigest,
    practiceId: run.practiceId, run,
  });
  assertExactKeys(payload, [
    "addedTargets", "expectedRunRevision", "newScopeDigest", "previousScopeDigest",
    "sourceRequestDigest", "sourceRequestPayloadRef",
  ], "scope.revised payload");
  assertExactKeys(record.operation.input, [
    "capturePolicyVersion", "previousScopeDigest", "targetRequests", "targetRequestsDigest",
    "textPolicyVersion", "workspacePolicyVersion",
  ], "extend_scope operation input");
  assertPolicyInput(record.operation.input);
  assertDigest(payload.previousScopeDigest, "previous scope digest");
  assertDigest(payload.newScopeDigest, "new scope digest");
  assertDigest(payload.sourceRequestDigest, "scope source request digest");
  assertReference(payload.sourceRequestPayloadRef, "requests");
  if (!Array.isArray(payload.addedTargets) || payload.addedTargets.length === 0
      || payload.expectedRunRevision !== run.revision || payload.previousScopeDigest !== run.scope.digest
      || record.operation.input.previousScopeDigest !== run.scope.digest
      || payload.sourceRequestDigest !== record.requestDigest || record.runRevision !== run.revision + 1) {
    practiceRunFail("STATE_CORRUPTED", "Invalid scope.revised transition");
  }
  assertCapturedByRecord(payload.addedTargets, record);
  if (!requestsMatchTargets(record.operation.input.targetRequests, payload.addedTargets)) {
    practiceRunFail("STATE_CORRUPTED", "scope.revised target requests conflict with added targets");
  }
  const finalTargets = [...run.scope.targets, ...payload.addedTargets];
  const scope = { revision: run.scope.revision + 1, targets: finalTargets, digest: payload.newScopeDigest };
  validateReviewScope(scope, { sessionHash: sha256(sessionId), actorId: run.origin.actorId, runId: run.runId });
  if (payload.newScopeDigest !== reviewScopeDigest(finalTargets)) {
    practiceRunFail("STATE_CORRUPTED", "scope.revised digest is invalid");
  }
  const existingIds = new Set(run.scope.targets.map((target) => target.targetId));
  if (payload.addedTargets.some((target) => existingIds.has(target.targetId))) {
    practiceRunFail("STATE_CORRUPTED", "scope.revised target IDs are not append-only");
  }
  return scope;
}

function validateEventRef(ref, run, boundary, identities) {
  assertExactKeys(ref, ["eventHash", "sequence", "sessionId", "toolCallId", "turnId"], "Evidence event ref");
  assertDigest(ref.eventHash, "Evidence event hash");
  const identity = `${ref.sequence}:${ref.eventHash}`;
  if (ref.sessionId !== run.sessionId || !Number.isSafeInteger(ref.sequence) || ref.sequence <= 0
      || ref.sequence > boundary || identities.has(identity)
      || [ref.turnId, ref.toolCallId].some((entry) => typeof entry !== "string" || entry === "")) {
    practiceRunFail("STATE_CORRUPTED", "Checkpoint Evidence event ref is invalid or duplicated");
  }
  identities.add(identity);
}

function validateCheckpointResult(value, record, run, allSatisfied) {
  assertExactKeys(value, [
    "allSatisfied", "claimDigest", "evaluatedAt", "evidenceTerminalHash", "results", "runId",
    "runRevision", "schemaVersion",
  ], "checkpoint result");
  if (value.schemaVersion !== 2 || value.runId !== run.runId || value.runRevision !== run.revision
      || value.allSatisfied !== allSatisfied || !Array.isArray(value.results) || value.results.length !== 8) {
    practiceRunFail("STATE_CORRUPTED", "Checkpoint result identity is invalid");
  }
  assertDigest(value.claimDigest, "checkpoint claim digest");
  assertDigest(value.evidenceTerminalHash, "checkpoint Evidence terminal hash");
  assertTimestamp(value.evaluatedAt);
  const ids = new Set();
  for (const item of value.results) {
    const keys = ["checkpointId", "satisfied"];
    if (item.satisfied === false) keys.push("reasonCode");
    if (Object.hasOwn(item, "selectedEventRefs")) keys.push("selectedEventRefs");
    assertExactKeys(item, keys, "checkpoint item");
    if (!ID_PATTERN.test(item.checkpointId) || typeof item.satisfied !== "boolean" || ids.has(item.checkpointId)
        || (item.satisfied === false && (typeof item.reasonCode !== "string" || item.reasonCode === ""))
        || (item.satisfied === true && Object.hasOwn(item, "reasonCode"))) {
      practiceRunFail("STATE_CORRUPTED", "Checkpoint item is invalid");
    }
    ids.add(item.checkpointId);
    if (item.selectedEventRefs && (!Array.isArray(item.selectedEventRefs) || item.selectedEventRefs.length > 2048)) {
      practiceRunFail("STATE_CORRUPTED", "Checkpoint selected Evidence refs are invalid");
    }
  }
  if (value.results.map((item) => item.checkpointId).join(",") !== CHECKPOINT_IDS.join(",")
      || value.results.every((item) => item.satisfied) !== value.allSatisfied
      || value.claimDigest !== record.payload.claim.digest
      || value.evidenceTerminalHash !== record.payload.evidenceBoundary.hash) {
    practiceRunFail("STATE_CORRUPTED", "Checkpoint result conflicts with its journal payload");
  }
}

function validateCheckpointPayload(record, run, completed) {
  const payload = record.payload;
  assertExactKeys(payload, [
    "checkpointResult", "claim", "evidenceBoundary", "selectedEventRefs", "sourceRequestDigest",
    "sourceRequestPayloadRef",
  ], "checkpoint payload");
  assertExactKeys(payload.claim, ["digest", "payloadRef"], "checkpoint claim reference");
  assertExactKeys(payload.evidenceBoundary, ["hash", "sequence"], "checkpoint Evidence boundary");
  assertDigest(payload.claim.digest, "checkpoint claim digest");
  assertReference(payload.claim.payloadRef, "claims");
  assertDigest(payload.evidenceBoundary.hash, "checkpoint Evidence terminal hash");
  assertDigest(payload.sourceRequestDigest, "checkpoint source request digest");
  assertReference(payload.sourceRequestPayloadRef, "requests");
  if (!Number.isSafeInteger(payload.evidenceBoundary.sequence) || payload.evidenceBoundary.sequence < 0
      || !Array.isArray(payload.selectedEventRefs) || payload.selectedEventRefs.length > 2048) {
    practiceRunFail("STATE_CORRUPTED", "Checkpoint Evidence boundary or refs are invalid");
  }
  const expectedRefs = payload.checkpointResult.results.flatMap((item) => item.selectedEventRefs ?? []);
  if (canonicalJson(expectedRefs) !== canonicalJson(payload.selectedEventRefs)) {
    practiceRunFail("STATE_CORRUPTED", "Checkpoint selected Evidence refs conflict with its results");
  }
  const identities = new Set();
  for (const ref of payload.selectedEventRefs) validateEventRef(ref, run, payload.evidenceBoundary.sequence, identities);
  validateOperation(record, {
    toolName: "check_completion", roleId: run.roleId, profileDigest: run.profileDigest,
    practiceId: run.practiceId, run,
  });
  assertExactKeys(record.operation.input, [
    "checkpointSetId", "checkpointSetVersion", "claimDigest", "completionSchemaId",
    "completionSchemaVersion", "evidenceTerminalHash", "evidenceTerminalSequence", "finalScopeDigest",
  ], "check_completion operation input");
  if (record.operation.input.checkpointSetId !== "review-v2" || record.operation.input.checkpointSetVersion !== 2
      || record.operation.input.completionSchemaId !== "review-claim-v2"
      || record.operation.input.completionSchemaVersion !== 2
      || record.operation.input.claimDigest !== payload.claim.digest
      || record.operation.input.finalScopeDigest !== run.scope.digest
      || record.operation.input.evidenceTerminalHash !== payload.evidenceBoundary.hash
      || record.operation.input.evidenceTerminalSequence !== payload.evidenceBoundary.sequence
      || payload.sourceRequestDigest !== record.requestDigest || record.runRevision !== run.revision + 1) {
    practiceRunFail("STATE_CORRUPTED", "Invalid check_completion transition");
  }
  validateCheckpointResult(payload.checkpointResult, record, run, completed);
}

function validateAbandonPayload(record, run) {
  const payload = record.payload;
  validateOperation(record, {
    toolName: "abandon_work", roleId: run.roleId, profileDigest: run.profileDigest,
    practiceId: run.practiceId, run,
  });
  assertExactKeys(payload, [
    "reasonCode", "sourceRequestDigest", "sourceRequestPayloadRef", "summaryDigest", "summaryPayloadRef",
  ], "run.abandoned payload");
  assertExactKeys(record.operation.input, ["reasonCode", "summaryBytes", "summaryDigest"], "abandon_work operation input");
  assertDigest(record.operation.input.summaryDigest, "abandonment summary digest");
  assertDigest(payload.sourceRequestDigest, "source request digest");
  assertDigest(payload.summaryDigest, "summary digest");
  assertReference(payload.sourceRequestPayloadRef, "requests");
  assertReference(payload.summaryPayloadRef, "notes");
  if (!ABANDON_REASON_CODES.has(payload.reasonCode) || record.operation.input.reasonCode !== payload.reasonCode
      || !Number.isSafeInteger(record.operation.input.summaryBytes) || record.operation.input.summaryBytes <= 0
      || record.runRevision !== run.revision + 1 || payload.sourceRequestDigest !== record.requestDigest) {
    practiceRunFail("STATE_CORRUPTED", "Invalid run.abandoned transition");
  }
}

function applyRecord(state, record, sessionId) {
  assertExactKeys(record, RECORD_KEYS, "PracticeRun journal record");
  if (record.schemaVersion !== SCHEMA_VERSION) {
    practiceRunFail("UNSUPPORTED_STATE_SCHEMA", "PracticeRun journal schema is not supported by this runtime");
  }
  const { hash, ...unsigned } = record;
  if (record.sequence !== state.sequence + 1 || record.previousHash !== state.previousHash || hash !== sha256(unsigned)) {
    practiceRunFail("STATE_CORRUPTED", `Invalid PracticeRun journal at sequence ${state.sequence + 1}`);
  }
  if (!RUN_ID_PATTERN.test(record.runId) || !EVENT_ID_PATTERN.test(record.stateEventId)
      || !Number.isSafeInteger(record.runRevision) || record.runRevision <= 0
      || typeof record.actorId !== "string" || record.actorId === "" || Buffer.byteLength(record.actorId) > 512
      || typeof record.sourceMessageId !== "string" || record.sourceMessageId === "" || record.sourceMessageId.length > 512
      || typeof record.turnId !== "string" || record.turnId === ""
      || typeof record.toolCallId !== "string" || record.toolCallId === "") {
    practiceRunFail("STATE_CORRUPTED", "PracticeRun journal identity fields are invalid");
  }
  for (const [name, value] of [
    ["action digest", record.actionDigest], ["input digest", record.inputDigest],
    ["invocation identity", record.invocationIdentity], ["invocation key", record.invocationKey],
    ["payload digest", record.payloadDigest], ["request digest", record.requestDigest],
    ["previous hash", record.previousHash], ["record hash", record.hash],
  ]) assertDigest(value, name);
  if (record.invocationIdentity !== practiceInvocationIdentity({
    sessionId, turnId: record.turnId, toolCallId: record.toolCallId,
  }) || record.invocationKey !== idempotencyKey({
    sessionId, turnId: record.turnId, toolCallId: record.toolCallId, operationDigest: record.actionDigest,
  }) || record.actionDigest !== sha256(record.operation) || record.payloadDigest !== sha256(record.payload)) {
    practiceRunFail("STATE_CORRUPTED", "PracticeRun invocation, operation, or payload digest mismatch");
  }
  assertTimestamp(record.timestamp);
  if (state.invocations[record.invocationIdentity]) {
    practiceRunFail("STATE_CORRUPTED", "Duplicate PracticeRun invocation identity in journal");
  }

  if (record.eventType === "run.started") {
    const run = validateStartPayload(record, state, sessionId);
    state.runs[run.runId] = run;
    state.activeRunId = run.runId;
  } else {
    const run = state.runs[record.runId];
    if (!run || state.activeRunId !== run.runId || run.status !== "active" || run.origin.actorId !== record.actorId) {
      practiceRunFail("STATE_CORRUPTED", "PracticeRun journal targets a non-active or mismatched run");
    }
    if (record.eventType === "scope.revised") {
      run.scope = validateScopePayload(record, run, sessionId);
      run.revision = record.runRevision;
      run.updatedAt = record.timestamp;
    } else if (record.eventType === "checkpoint.evaluated" || record.eventType === "run.completed") {
      const completed = record.eventType === "run.completed";
      validateCheckpointPayload(record, run, completed);
      run.lastCheckpoint = {
        ...structuredClone(record.payload.checkpointResult),
        claimPayloadRef: record.payload.claim.payloadRef,
        evidenceTerminalSequence: record.payload.evidenceBoundary.sequence,
        selectedEventRefs: structuredClone(record.payload.selectedEventRefs),
        completionTurnId: record.turnId,
        completionToolCallId: record.toolCallId,
      };
      run.revision = record.runRevision;
      run.updatedAt = record.timestamp;
      if (completed) {
        run.status = "done";
        run.finishedAt = record.timestamp;
        state.activeRunId = null;
      }
    } else if (record.eventType === "run.abandoned") {
      validateAbandonPayload(record, run);
      run.status = "abandoned";
      run.revision = record.runRevision;
      run.updatedAt = record.timestamp;
      run.finishedAt = record.timestamp;
      state.activeRunId = null;
    } else {
      practiceRunFail("STATE_CORRUPTED", "Unsupported PracticeRun journal event type");
    }
  }

  state.invocations[record.invocationIdentity] = {
    actionDigest: record.actionDigest,
    invocationKey: record.invocationKey,
    runId: record.runId,
    stateEventId: record.stateEventId,
    eventType: record.eventType,
    sequence: record.sequence,
    eventHash: record.hash,
    actorId: record.actorId,
    sourceMessageId: record.sourceMessageId,
    requestDigest: record.requestDigest,
    inputDigest: record.inputDigest,
    operation: structuredClone(record.operation),
    resultRun: structuredClone(state.runs[record.runId]),
  };
  state.sequence = record.sequence;
  state.previousHash = record.hash;
}

function snapshotFor(state) {
  return {
    schemaVersion: SCHEMA_VERSION,
    journalSequence: state.sequence,
    journalHash: state.previousHash,
    activeRunId: state.activeRunId,
    runs: state.runs,
    invocations: state.invocations,
  };
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  let entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) practiceRunFail("STATE_CORRUPTED", "PracticeRun state directory is invalid");
  if ((entry.mode & 0o077) !== 0) {
    await chmod(path, 0o700);
    entry = await lstat(path);
    if ((entry.mode & 0o077) !== 0) practiceRunFail("STATE_CORRUPTED", "PracticeRun state permissions cannot be restricted");
  }
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function safeState(state) {
  return structuredClone({
    sequence: state.sequence, terminalHash: state.previousHash, activeRunId: state.activeRunId, runs: state.runs,
  });
}

export function practiceInvocationIdentity({ sessionId, turnId, toolCallId }) {
  return sha256({
    sessionId: requiredString(sessionId, "sessionId"),
    turnId: requiredString(turnId, "turnId"),
    toolCallId: requiredString(toolCallId, "toolCallId"),
  });
}

export function practiceInvocationKey({ sessionId, turnId, toolCallId }, actionDigest) {
  assertDigest(actionDigest, "action digest");
  return idempotencyKey({
    sessionId: requiredString(sessionId, "sessionId"),
    turnId: requiredString(turnId, "turnId"),
    toolCallId: requiredString(toolCallId, "toolCallId"),
    operationDigest: actionDigest,
  });
}

export class PracticeRunStore {
  #clock;
  #filePath;
  #queue = Promise.resolve();
  #sessionId;
  #snapshotPath;
  #uuid;

  constructor({ filePath, snapshotPath, sessionId, clock = () => new Date(), uuid = () => crypto.randomUUID() }) {
    for (const [name, value] of Object.entries({ filePath, snapshotPath, sessionId })) {
      if (typeof value !== "string" || value === "") throw new TypeError(`${name} is required`);
    }
    this.#filePath = filePath;
    this.#snapshotPath = snapshotPath;
    this.#sessionId = sessionId;
    this.#clock = clock;
    this.#uuid = uuid;
  }

  async #loadJournal() {
    const state = emptyState();
    let handle;
    try {
      handle = await open(this.#filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code === "ENOENT") return state;
      if (error?.code === "ELOOP") practiceRunFail("STATE_CORRUPTED", "PracticeRun journal cannot be a symbolic link");
      throw error;
    }
    let text;
    try {
      let entry = await handle.stat();
      if (!entry.isFile()) practiceRunFail("STATE_CORRUPTED", "PracticeRun journal is invalid");
      if ((entry.mode & 0o077) !== 0) {
        await handle.chmod(0o600);
        entry = await handle.stat();
        if ((entry.mode & 0o077) !== 0) practiceRunFail("STATE_CORRUPTED", "PracticeRun journal permissions cannot be restricted");
      }
      const bytes = await handle.readFile();
      text = bytes.toString("utf8");
      state.journalBytes = bytes.byteLength;
      state.journalIdentity = `${entry.dev}:${entry.ino}`;
    } finally {
      await handle.close();
    }
    if (text !== "" && !text.endsWith("\n")) practiceRunFail("STATE_CORRUPTED", "PracticeRun journal has a partial record");
    for (const line of text.split("\n")) {
      if (line === "") continue;
      if (Buffer.byteLength(line) > MAX_JOURNAL_RECORD_BYTES) practiceRunFail("STATE_CORRUPTED", "PracticeRun journal record is oversized");
      let record;
      try { record = JSON.parse(line); } catch { practiceRunFail("STATE_CORRUPTED", "PracticeRun journal contains invalid JSON"); }
      if (record?.schemaVersion !== SCHEMA_VERSION) {
        practiceRunFail("UNSUPPORTED_STATE_SCHEMA", "PracticeRun journal schema is not supported by this runtime");
      }
      applyRecord(state, record, this.#sessionId);
    }
    return state;
  }

  async #writeSnapshot(state) {
    const snapshot = snapshotFor(state);
    const directory = dirname(this.#snapshotPath);
    await ensurePrivateDirectory(directory);
    const temporary = `${this.#snapshotPath}.${process.pid}.${this.#uuid()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${canonicalJson(snapshot)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await rename(temporary, this.#snapshotPath);
      await syncDirectory(directory);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async #reconcileSnapshot(state) {
    const expected = canonicalJson(snapshotFor(state));
    let valid = false;
    let handle;
    try { handle = await open(this.#snapshotPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (!["ENOENT", "ELOOP"].includes(error?.code)) throw error; }
    if (handle) {
      try {
        let entry = await handle.stat();
        if (entry.isFile()) {
          if ((entry.mode & 0o077) !== 0) { await handle.chmod(0o600); entry = await handle.stat(); }
          if ((entry.mode & 0o077) !== 0) practiceRunFail("STATE_CORRUPTED", "PracticeRun snapshot permissions cannot be restricted");
          try { valid = canonicalJson(JSON.parse(await handle.readFile("utf8"))) === expected; }
          catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        }
      } finally { await handle.close(); }
    }
    if (!valid) await this.#writeSnapshot(state);
  }

  async #append(state, input) {
    const timestamp = this.#clock().toISOString();
    const unsigned = {
      schemaVersion: SCHEMA_VERSION,
      sequence: state.sequence + 1,
      runId: input.runId,
      runRevision: input.runRevision,
      stateEventId: `event-${this.#uuid()}`,
      eventType: input.eventType,
      invocationIdentity: input.invocationIdentity,
      invocationKey: input.invocationKey,
      actionDigest: input.actionDigest,
      actorId: input.actorId,
      sourceMessageId: input.sourceMessageId,
      turnId: input.turnId,
      toolCallId: input.toolCallId,
      requestDigest: input.requestDigest,
      inputDigest: input.inputDigest,
      operation: input.operation,
      payloadDigest: sha256(input.payload),
      payload: input.payload,
      previousHash: state.previousHash,
      timestamp,
    };
    const record = { ...unsigned, hash: sha256(unsigned) };
    const line = `${canonicalJson(record)}\n`;
    if (Buffer.byteLength(line) > MAX_JOURNAL_RECORD_BYTES) practiceRunFail("TARGET_LIMIT_EXCEEDED", "PracticeRun journal record is oversized");
    const validatedState = structuredClone(state);
    applyRecord(validatedState, record, this.#sessionId);
    const directory = dirname(this.#filePath);
    await ensurePrivateDirectory(directory);
    const creating = state.journalIdentity === null;
    const handle = await open(this.#filePath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    let metadata;
    try {
      metadata = await handle.stat();
      const identity = `${metadata.dev}:${metadata.ino}`;
      if (!metadata.isFile() || metadata.size !== state.journalBytes
          || (state.journalIdentity !== null && identity !== state.journalIdentity)) {
        practiceRunFail("STATE_CORRUPTED", "PracticeRun journal changed during append");
      }
      if ((metadata.mode & 0o077) !== 0) { await handle.chmod(0o600); metadata = await handle.stat(); }
      if ((metadata.mode & 0o077) !== 0) practiceRunFail("STATE_CORRUPTED", "PracticeRun journal permissions cannot be restricted");
      await handle.writeFile(line);
      await handle.sync();
      metadata = await handle.stat();
    } finally { await handle.close(); }
    if (creating) await syncDirectory(directory);
    Object.assign(state, validatedState);
    state.journalBytes = metadata.size;
    state.journalIdentity = `${metadata.dev}:${metadata.ino}`;
    await this.#writeSnapshot(state);
    return record;
  }

  async #withState(callback) {
    const operation = this.#queue.then(() => withFileLock(this.#filePath, async () => {
      try {
        const state = await this.#loadJournal();
        await this.#reconcileSnapshot(state);
        return await callback(state);
      } catch (error) {
        if (error instanceof PracticeRunError) throw error;
        practiceRunFail("STATE_CORRUPTED", "PracticeRun state could not be loaded or persisted");
      }
    }));
    this.#queue = operation.catch(() => {});
    return operation;
  }

  #replayOrConflict(state, input, { requireAction = true } = {}) {
    const existing = state.invocations[input.invocationIdentity];
    if (!existing) return undefined;
    if (existing.actorId !== input.actorId) practiceRunFail("RUN_REQUESTER_MISMATCH", "Requester does not own this invocation");
    if (existing.sourceMessageId !== input.sourceMessageId || existing.requestDigest !== input.requestDigest
        || existing.inputDigest !== input.inputDigest || (requireAction
          && (existing.actionDigest !== input.actionDigest || existing.invocationKey !== input.invocationKey))) {
      practiceRunFail("INVOCATION_CONFLICT", "PracticeRun invocation changed its action");
    }
    return {
      replayed: true,
      stateEventId: existing.stateEventId,
      eventType: existing.eventType,
      actionDigest: existing.actionDigest,
      invocationKey: existing.invocationKey,
      operation: structuredClone(existing.operation),
      run: structuredClone(existing.resultRun),
      sequence: existing.sequence,
      terminalHash: existing.eventHash,
    };
  }

  async state() { return this.#withState((state) => safeState(state)); }
  async replay(input) { return this.#withState((state) => this.#replayOrConflict(state, input, { requireAction: false })); }

  async activeForActor(actorId, { required = true } = {}) {
    requiredString(actorId, "actorId");
    return this.#withState((state) => {
      const run = state.activeRunId ? state.runs[state.activeRunId] : undefined;
      if (!run) {
        if (required) practiceRunFail("ACTIVE_RUN_REQUIRED", "An active PracticeRun is required");
        return undefined;
      }
      if (run.origin.actorId !== actorId) practiceRunFail("RUN_REQUESTER_MISMATCH", "Requester does not own the active PracticeRun");
      return structuredClone(run);
    });
  }

  async start(input) {
    return this.#withState(async (state) => {
      const replay = this.#replayOrConflict(state, input);
      if (replay) return replay;
      const active = state.activeRunId ? state.runs[state.activeRunId] : undefined;
      if (active) {
        if (active.origin.actorId !== input.actorId) practiceRunFail("RUN_REQUESTER_MISMATCH", "Requester does not own the active run");
        practiceRunFail("ACTIVE_RUN_EXISTS", "An active PracticeRun already exists");
      }
      const record = await this.#append(state, input);
      return this.#result(state, record);
    });
  }

  async extend(input) { return this.#transition(input, "scope extension"); }
  async checkpoint(input) { return this.#transition(input, "checkpoint evaluation"); }
  async abandon(input) { return this.#transition(input, "abandonment"); }

  async #transition(input, name) {
    return this.#withState(async (state) => {
      const replay = this.#replayOrConflict(state, input);
      if (replay) return replay;
      const run = state.activeRunId ? state.runs[state.activeRunId] : undefined;
      if (!run) practiceRunFail("ACTIVE_RUN_REQUIRED", "An active PracticeRun is required");
      if (run.origin.actorId !== input.actorId) practiceRunFail("RUN_REQUESTER_MISMATCH", "Requester does not own the active run");
      if (input.runId !== run.runId || run.status !== "active") practiceRunFail("RUN_NOT_ACTIVE", "Selected PracticeRun is not active");
      if (input.expectedRunRevision !== run.revision || input.runRevision !== run.revision + 1) {
        practiceRunFail("STALE_RUN_REVISION", `PracticeRun revision changed before ${name}`);
      }
      const record = await this.#append(state, input);
      return this.#result(state, record);
    });
  }

  #result(state, record) {
    return {
      replayed: false,
      stateEventId: record.stateEventId,
      eventType: record.eventType,
      run: structuredClone(state.runs[record.runId]),
      sequence: record.sequence,
      terminalHash: record.hash,
    };
  }
}

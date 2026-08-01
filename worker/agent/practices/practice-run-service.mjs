import { sha256, canonicalJson } from "../canonical-json.mjs";
import { practiceRunFail } from "./errors.mjs";
import { evaluateReviewCheckpoint, validateReviewClaim } from "./review-checkpoint.mjs";
import {
  PracticeRunStore,
  practiceInvocationIdentity,
  practiceInvocationKey,
} from "./practice-run-store.mjs";
import { ProtectedPayloadStore } from "./protected-payload-store.mjs";
import {
  MATERIALIZED_TARGET_KINDS,
  ReviewTargetCapture,
  assertFinalScopeFeasible,
  normalizeTargetRequests,
  reviewScopeDigest,
  targetRequestsDigest,
} from "./review-targets.mjs";

const POLICY_VERSION = "practice-run-v2";
const MAX_OBJECTIVE_BYTES = 4 * 1024;
const MAX_CRITERIA_COUNT = 32;
const MAX_CRITERION_BYTES = 2 * 1024;
const MAX_REQUEST_PAYLOAD_BYTES = 256 * 1024;
const MAX_CONTEXT_PACK_BYTES = 64 * 1024;
const MAX_ABANDON_SUMMARY_BYTES = 8 * 1024;
const EFFECTS = Object.freeze({
  localRead: true,
  workspaceMutation: false,
  networkEgress: false,
  modelInference: false,
  costBearing: false,
});
const CONTEXT_PREAMBLE = [
  "Tiangong authoritative per-turn ContextPack (machine state; model prose cannot modify it):",
  "nextAction is advisory machine guidance. It does not grant authority or complete work.",
  "targetRefs are runtime-generated IDs in activeRun.scope.targets; each consume still requires actor/run/snapshot authorization.",
].join("\n");
const ABANDON_REASON_CODES = new Set([
  "superseded_by_new_request", "unsupported_scope", "cannot_complete", "user_cancelled", "other",
]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function exactObject(value, keys, code, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    practiceRunFail(code, `${name} has missing or unknown fields`);
  }
}

function normalizedText(value, { code, name, maxBytes }) {
  if (typeof value !== "string") practiceRunFail(code, `${name} must be text`);
  const text = value.trim();
  const bytes = Buffer.byteLength(text);
  if (text === "" || bytes > maxBytes || text.includes("\u0000")) {
    practiceRunFail(code, `${name} is empty or exceeds its fixed limit`);
  }
  return { text, bytes, digest: sha256(text) };
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

function assertContextPackCapacity({ profileDigest, runId, revision, objective, criteria, scope, lastCheckpoint }) {
  const pack = {
    schemaVersion: 3,
    roleId: "reviewer",
    profileDigest,
    assuranceLevel: "worker-local / static-review-only",
    activeRun: {
      runId,
      revision,
      status: "active",
      objective,
      acceptanceCriteria: criteria,
      scope: {
        revision: scope.revision,
        digest: scope.digest,
        targets: scope.targets.map(targetSummary),
      },
      lastCheckpointReasonCodes: lastCheckpoint?.results?.filter((item) => !item.satisfied)
        .map((item) => item.reasonCode) ?? [],
    },
    nextAction: {
      code: "CONSUME_REMAINING_TARGETS",
      targetRefs: scope.targets.map((target) => target.targetId),
      reasonCodes: ["TARGET_CONSUMPTION_INCOMPLETE"],
    },
  };
  if (Buffer.byteLength(`${CONTEXT_PREAMBLE}\n${canonicalJson(pack)}`, "utf8") > MAX_CONTEXT_PACK_BYTES) {
    practiceRunFail("CONTEXT_PACK_LIMIT_EXCEEDED", "Reviewer ContextPack exceeds its fixed size limit");
  }
}

function invocationContext(invocation, sessionId) {
  if (!invocation || typeof invocation !== "object") throw new TypeError("invocation is required");
  if (invocation.sessionId !== sessionId) practiceRunFail("STATE_CORRUPTED", "Invocation session mismatch");
  const actorId = invocation.actor?.id;
  const sourceMessageId = invocation.actor?.messageId;
  const prompt = invocation.ingress?.prompt;
  if (typeof actorId !== "string" || actorId === "") practiceRunFail("AUTHENTICATED_ACTOR_REQUIRED", "Authenticated actor is required");
  if (typeof sourceMessageId !== "string" || sourceMessageId === "") practiceRunFail("SOURCE_MESSAGE_ID_REQUIRED", "Source message ID is required");
  if (typeof prompt !== "string" || prompt === "" || Buffer.byteLength(prompt) > MAX_REQUEST_PAYLOAD_BYTES) {
    practiceRunFail("REQUEST_PAYLOAD_INVALID", "Ingress request is missing or oversized");
  }
  const { turnId, toolCallId } = invocation;
  if (typeof turnId !== "string" || turnId === "" || typeof toolCallId !== "string" || toolCallId === "") {
    throw new TypeError("turnId and toolCallId are required");
  }
  const requestPayload = { actorId, messageId: sourceMessageId, prompt };
  return {
    actorId, sourceMessageId, turnId, toolCallId, requestPayload, requestDigest: sha256(requestPayload),
  };
}

function actionIdentity(sessionId, context, operation) {
  const actionDigest = sha256(operation);
  const invocationIdentity = practiceInvocationIdentity({
    sessionId, turnId: context.turnId, toolCallId: context.toolCallId,
  });
  return {
    actionDigest,
    invocationIdentity,
    invocationKey: practiceInvocationKey({
      sessionId, turnId: context.turnId, toolCallId: context.toolCallId,
    }, actionDigest),
  };
}

function operationBase({ toolName, profile, profileDigest, practice, context, workspaceScope, state }) {
  return {
    policyVersion: POLICY_VERSION,
    category: "state-transition",
    toolName,
    effects: EFFECTS,
    workspaceScope,
    roleId: profile.roleId,
    profileDigest,
    practiceId: practice.id,
    practiceVersion: 2,
    origin: {
      actorId: context.actorId,
      sourceMessageId: context.sourceMessageId,
      requestDigest: context.requestDigest,
    },
    state,
  };
}

function captureInput(targets) {
  return {
    targetRequests: targets,
    targetRequestsDigest: targetRequestsDigest(targets),
    capturePolicyVersion: "review-target-capture-v1",
    workspacePolicyVersion: "workspace-target-policy-v1",
    textPolicyVersion: "review-text-lines-v1",
  };
}

export class PracticeRunService {
  #artifactStore;
  #clock;
  #payloads;
  #prepared = new WeakMap();
  #profile;
  #profileDigest;
  #reviewPractice;
  #sessionId;
  #store;
  #targetCapture;
  #uuid;

  constructor({
    sessionId,
    workspaceDir,
    profileBundle,
    journalPath,
    snapshotPath,
    protectedDirectory,
    artifactStore,
    clock = () => new Date(),
    uuid = () => crypto.randomUUID(),
  }) {
    for (const [name, value] of Object.entries({
      sessionId, workspaceDir, journalPath, snapshotPath, protectedDirectory,
    })) if (typeof value !== "string" || value === "") throw new TypeError(`${name} is required`);
    if (!artifactStore) throw new TypeError("artifactStore is required");
    if (!Object.isFrozen(profileBundle) || profileBundle.profile?.roleId !== "reviewer") {
      throw new TypeError("PracticeRunService requires the validated Reviewer profile");
    }
    const reviewPractice = profileBundle.practices.find((entry) => entry.definition.id === "review");
    if (!reviewPractice || reviewPractice.definition.version !== 2
        || !profileBundle.profile.practiceIds.includes("review")) {
      throw new TypeError("Reviewer profile does not authorize review practice v2");
    }
    if (canonicalJson(profileBundle.profile.targetKindIds) !== canonicalJson(MATERIALIZED_TARGET_KINDS)) {
      throw new TypeError("Reviewer target kinds are not fully materialized");
    }
    this.#sessionId = sessionId;
    this.#clock = clock;
    this.#profile = profileBundle.profile;
    this.#profileDigest = profileBundle.profileDigest;
    this.#reviewPractice = reviewPractice.definition;
    this.#uuid = uuid;
    this.#artifactStore = artifactStore;
    this.#payloads = new ProtectedPayloadStore({ directory: protectedDirectory });
    this.#store = new PracticeRunStore({ filePath: journalPath, snapshotPath, sessionId, clock, uuid });
    this.#targetCapture = new ReviewTargetCapture({ workspaceDir, artifactStore, clock });
  }

  get targetCapture() { return this.#targetCapture; }
  get artifactStore() { return this.#artifactStore; }

  #validatePractice(practiceId) {
    if (practiceId !== this.#reviewPractice.id || !this.#profile.practiceIds.includes(practiceId)) {
      practiceRunFail("PRACTICE_NOT_ALLOWED", "Practice is not authorized by the fixed role profile");
    }
  }

  #markPrepared(prepared, kind) {
    const frozen = deepFreeze(prepared);
    this.#prepared.set(frozen, kind);
    return frozen;
  }

  #assertPrepared(prepared, kind) {
    if (!prepared || this.#prepared.get(prepared) !== kind) throw new TypeError(`A service-prepared ${kind} transition is required`);
  }

  #inputDigest(toolName, params) {
    return sha256({ toolName, profileDigest: this.#profileDigest, params });
  }

  #assertInvocationProfile(invocation) {
    if (invocation.profileDigest !== this.#profileDigest) practiceRunFail("STATE_CORRUPTED", "Invocation profile digest mismatch");
  }

  async #replay(toolName, params, invocation) {
    const context = invocationContext(invocation, this.#sessionId);
    this.#assertInvocationProfile(invocation);
    const replay = await this.#store.replay({
      invocationIdentity: practiceInvocationIdentity({
        sessionId: this.#sessionId, turnId: context.turnId, toolCallId: context.toolCallId,
      }),
      actorId: context.actorId,
      sourceMessageId: context.sourceMessageId,
      requestDigest: context.requestDigest,
      inputDigest: this.#inputDigest(toolName, params),
    });
    return replay ? { ...replay, run: await this.#hydrate(replay.run) } : undefined;
  }

  async #hydrate(run) {
    if (!run) return undefined;
    const spec = await this.#payloads.read("spec", run.spec.payloadRef);
    exactObject(spec, ["acceptanceCriteria", "objective", "schemaVersion"], "STATE_CORRUPTED", "Run spec");
    if (spec.schemaVersion !== 2 || sha256(spec) !== run.spec.digest) {
      practiceRunFail("STATE_CORRUPTED", "Run spec does not match its journal reference");
    }
    const hydrated = structuredClone(run);
    delete hydrated.spec;
    hydrated.objective = structuredClone(spec.objective);
    hydrated.acceptanceCriteria = structuredClone(spec.acceptanceCriteria);
    return hydrated;
  }

  async #uniqueIds(count, prefix, existing = new Set()) {
    const output = [];
    for (let index = 0; index < count; index += 1) {
      let selected = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = `${prefix}-${this.#uuid()}`;
        if (!existing.has(candidate) && !output.includes(candidate)) { selected = candidate; break; }
      }
      if (!selected) practiceRunFail(prefix === "target" ? "TARGET_ID_GENERATION_FAILED" : "STATE_CORRUPTED", "Runtime ID generation failed");
      output.push(selected);
    }
    return output;
  }

  async prepareStart(params, invocation) {
    exactObject(params, ["acceptanceCriteria", "objective", "practiceId", "targets"], "INVALID_TARGET", "start_work input");
    const replay = await this.#replay("start_work", params, invocation);
    if (replay) return this.#markPrepared({ replay, operation: replay.operation }, "start");
    const context = invocationContext(invocation, this.#sessionId);
    this.#assertInvocationProfile(invocation);
    const active = await this.#store.activeForActor(context.actorId, { required: false });
    if (active) practiceRunFail("ACTIVE_RUN_EXISTS", "An active PracticeRun already exists");
    this.#validatePractice(params.practiceId);
    const objective = normalizedText(params.objective, { code: "INVALID_OBJECTIVE", name: "objective", maxBytes: MAX_OBJECTIVE_BYTES });
    if (!Array.isArray(params.acceptanceCriteria) || params.acceptanceCriteria.length === 0
        || params.acceptanceCriteria.length > MAX_CRITERIA_COUNT) {
      practiceRunFail("INVALID_CRITERIA", "Acceptance criteria must be a non-empty bounded array");
    }
    const criteria = params.acceptanceCriteria.map((criterion, index) => ({
      id: `criterion-${index + 1}`,
      ...normalizedText(criterion, { code: "INVALID_CRITERIA", name: "criterion", maxBytes: MAX_CRITERION_BYTES }),
    }));
    if (new Set(criteria.map((criterion) => criterion.text)).size !== criteria.length) {
      practiceRunFail("INVALID_CRITERIA", "Acceptance criteria must be unique after normalization");
    }
    const targets = normalizeTargetRequests(params.targets, this.#profile.targetKindIds);
    await this.#targetCapture.initialize();
    const operation = {
      ...operationBase({
        toolName: "start_work", profile: this.#profile, profileDigest: this.#profileDigest,
        practice: this.#reviewPractice, context, workspaceScope: this.#targetCapture.workspaceScope, state: null,
      }),
      input: {
        objectiveDigest: objective.digest,
        objectiveBytes: objective.bytes,
        criteria: criteria.map(({ digest, bytes }) => ({ digest, bytes })),
        ...captureInput(targets),
      },
    };
    return this.#markPrepared({
      context, operation, objective, criteria, targets,
      inputDigest: this.#inputDigest("start_work", params),
      ...actionIdentity(this.#sessionId, context, operation),
    }, "start");
  }

  async commitStart(prepared) {
    this.#assertPrepared(prepared, "start");
    if (prepared.replay) return prepared.replay;
    const state = await this.#store.state();
    const existingRuns = new Set(Object.keys(state.runs));
    const [runId] = await this.#uniqueIds(1, "run", existingRuns);
    const allTargetIds = new Set(Object.values(state.runs).flatMap((run) => run.scope.targets.map((target) => target.targetId)));
    const targetIds = await this.#uniqueIds(prepared.targets.length, "target", allTargetIds);
    const targets = await this.#targetCapture.captureTargets({
      requests: prepared.targets,
      runId,
      targetIds,
      actorId: prepared.context.actorId,
      invocationIdentity: prepared.invocationIdentity,
      sourceOperationDigest: prepared.actionDigest,
    });
    assertFinalScopeFeasible(targets);
    const scope = { revision: 1, targets, digest: reviewScopeDigest(targets) };
    const objective = { text: prepared.objective.text, source: "model_normalized" };
    const acceptanceCriteria = prepared.criteria.map((criterion) => ({
      id: criterion.id, description: criterion.text, source: "model_normalized",
    }));
    assertContextPackCapacity({
      profileDigest: this.#profileDigest, runId, revision: 1, objective,
      criteria: acceptanceCriteria, scope, lastCheckpoint: null,
    });
    const request = await this.#payloads.put("request", prepared.context.requestPayload);
    const spec = await this.#payloads.put("spec", { schemaVersion: 2, objective, acceptanceCriteria });
    const result = await this.#store.start({
      eventType: "run.started", runId, runRevision: 1,
      actorId: prepared.context.actorId, sourceMessageId: prepared.context.sourceMessageId,
      turnId: prepared.context.turnId, toolCallId: prepared.context.toolCallId,
      invocationIdentity: prepared.invocationIdentity, invocationKey: prepared.invocationKey,
      actionDigest: prepared.actionDigest, requestDigest: prepared.context.requestDigest,
      inputDigest: prepared.inputDigest, operation: prepared.operation,
      payload: {
        roleId: this.#profile.roleId,
        profileDigest: this.#profileDigest,
        practiceId: this.#reviewPractice.id,
        practiceVersion: 2,
        origin: {
          actorId: prepared.context.actorId, messageId: prepared.context.sourceMessageId,
          requestDigest: request.digest, requestPayloadRef: request.ref,
        },
        spec: { digest: spec.digest, payloadRef: spec.ref },
        scope,
        targetCapturePolicyVersion: "review-target-capture-v1",
        targetKindRegistryVersion: "review-target-kinds-v1",
      },
    });
    return { ...result, run: await this.#hydrate(result.run) };
  }

  async start(params, invocation) { return this.commitStart(await this.prepareStart(params, invocation)); }

  async prepareExtend(params, invocation) {
    exactObject(params, ["targets"], "INVALID_TARGET", "extend_scope input");
    const replay = await this.#replay("extend_scope", params, invocation);
    if (replay) return this.#markPrepared({ replay, operation: replay.operation }, "extend");
    const context = invocationContext(invocation, this.#sessionId);
    this.#assertInvocationProfile(invocation);
    const run = await this.activeForActor(context.actorId);
    const targets = normalizeTargetRequests(params.targets, this.#profile.targetKindIds);
    await this.#targetCapture.initialize();
    const operation = {
      ...operationBase({
        toolName: "extend_scope", profile: this.#profile, profileDigest: this.#profileDigest,
        practice: this.#reviewPractice, context, workspaceScope: this.#targetCapture.workspaceScope,
        state: { runId: run.runId, expectedRunRevision: run.revision },
      }),
      input: { ...captureInput(targets), previousScopeDigest: run.scope.digest },
    };
    return this.#markPrepared({
      context, run, targets, operation, inputDigest: this.#inputDigest("extend_scope", params),
      ...actionIdentity(this.#sessionId, context, operation),
    }, "extend");
  }

  async commitExtend(prepared) {
    this.#assertPrepared(prepared, "extend");
    if (prepared.replay) return prepared.replay;
    const existingIds = new Set(prepared.run.scope.targets.map((target) => target.targetId));
    const targetIds = await this.#uniqueIds(prepared.targets.length, "target", existingIds);
    const addedTargets = await this.#targetCapture.captureTargets({
      requests: prepared.targets,
      runId: prepared.run.runId,
      targetIds,
      actorId: prepared.context.actorId,
      invocationIdentity: prepared.invocationIdentity,
      sourceOperationDigest: prepared.actionDigest,
    });
    const finalTargets = [...prepared.run.scope.targets, ...addedTargets];
    const existingSnapshots = new Set(prepared.run.scope.targets.map((target) => canonicalJson({
      kind: target.kind, descriptor: target.descriptor, snapshotIdentity: target.snapshot.identity,
    })));
    if (addedTargets.some((target) => existingSnapshots.has(canonicalJson({
      kind: target.kind, descriptor: target.descriptor, snapshotIdentity: target.snapshot.identity,
    })))) practiceRunFail("SCOPE_TARGET_ALREADY_PRESENT", "Target snapshot is already in the final scope");
    assertFinalScopeFeasible(finalTargets);
    const scope = {
      revision: prepared.run.scope.revision + 1,
      targets: finalTargets,
      digest: reviewScopeDigest(finalTargets),
    };
    assertContextPackCapacity({
      profileDigest: this.#profileDigest, runId: prepared.run.runId,
      revision: prepared.run.revision + 1, objective: prepared.run.objective,
      criteria: prepared.run.acceptanceCriteria, scope, lastCheckpoint: prepared.run.lastCheckpoint,
    });
    const request = await this.#payloads.put("request", prepared.context.requestPayload);
    const result = await this.#store.extend({
      eventType: "scope.revised", runId: prepared.run.runId,
      expectedRunRevision: prepared.run.revision, runRevision: prepared.run.revision + 1,
      actorId: prepared.context.actorId, sourceMessageId: prepared.context.sourceMessageId,
      turnId: prepared.context.turnId, toolCallId: prepared.context.toolCallId,
      invocationIdentity: prepared.invocationIdentity, invocationKey: prepared.invocationKey,
      actionDigest: prepared.actionDigest, requestDigest: prepared.context.requestDigest,
      inputDigest: prepared.inputDigest, operation: prepared.operation,
      payload: {
        addedTargets,
        expectedRunRevision: prepared.run.revision,
        previousScopeDigest: prepared.run.scope.digest,
        newScopeDigest: scope.digest,
        sourceRequestDigest: request.digest,
        sourceRequestPayloadRef: request.ref,
      },
    });
    return { ...result, run: await this.#hydrate(result.run) };
  }

  async extend(params, invocation) { return this.commitExtend(await this.prepareExtend(params, invocation)); }

  async prepareCompletion(params, invocation, evidenceBoundaryProvider) {
    exactObject(params, ["completionClaim"], "CLAIM_SCHEMA_INVALID", "check_completion input");
    const replay = await this.#replay("check_completion", params, invocation);
    if (replay) {
      const claim = await this.claimForRun(replay.run);
      return this.#markPrepared({ replay: { ...replay, claim, checkpointResult: replay.run.lastCheckpoint }, operation: replay.operation }, "completion");
    }
    const context = invocationContext(invocation, this.#sessionId);
    this.#assertInvocationProfile(invocation);
    const run = await this.activeForActor(context.actorId);
    const validatedClaim = validateReviewClaim(params.completionClaim);
    if (typeof evidenceBoundaryProvider !== "function") throw new TypeError("Evidence boundary provider is required");
    const evidenceBoundary = await evidenceBoundaryProvider();
    if (!evidenceBoundary || !Number.isSafeInteger(evidenceBoundary.sequence) || evidenceBoundary.sequence < 0
        || typeof evidenceBoundary.hash !== "string" || !/^[a-f0-9]{64}$/u.test(evidenceBoundary.hash)) {
      practiceRunFail("EVIDENCE_BOUNDARY_INVALID", "Evidence terminal boundary is invalid");
    }
    await this.#targetCapture.initialize();
    const operation = {
      ...operationBase({
        toolName: "check_completion", profile: this.#profile, profileDigest: this.#profileDigest,
        practice: this.#reviewPractice, context, workspaceScope: this.#targetCapture.workspaceScope,
        state: { runId: run.runId, expectedRunRevision: run.revision },
      }),
      input: {
        completionSchemaId: "review-claim-v2", completionSchemaVersion: 2,
        checkpointSetId: "review-v2", checkpointSetVersion: 2,
        claimDigest: validatedClaim.digest, finalScopeDigest: run.scope.digest,
        evidenceTerminalSequence: evidenceBoundary.sequence, evidenceTerminalHash: evidenceBoundary.hash,
      },
    };
    return this.#markPrepared({
      context, run, validatedClaim, evidenceBoundary: { ...evidenceBoundary }, operation,
      inputDigest: this.#inputDigest("check_completion", params),
      ...actionIdentity(this.#sessionId, context, operation),
    }, "completion");
  }

  async persistCompletionClaim(prepared) {
    this.#assertPrepared(prepared, "completion");
    if (prepared.replay) return undefined;
    const claim = await this.#payloads.put("claim", prepared.validatedClaim.claim);
    if (claim.digest !== prepared.validatedClaim.digest) practiceRunFail("STATE_CORRUPTED", "Protected claim changed before checkpoint");
    return claim;
  }

  async commitCompletion(prepared, projection, claim) {
    this.#assertPrepared(prepared, "completion");
    if (prepared.replay) return prepared.replay;
    if (projection?.boundary?.sequence !== prepared.evidenceBoundary.sequence
        || projection?.boundary?.hash !== prepared.evidenceBoundary.hash) {
      practiceRunFail("EVIDENCE_BOUNDARY_INVALID", "Projected Evidence does not match completion boundary");
    }
    if (claim?.digest !== prepared.validatedClaim.digest || typeof claim.ref !== "string") {
      practiceRunFail("STATE_CORRUPTED", "Durable protected claim is required before checkpoint");
    }
    const checkpointResult = evaluateReviewCheckpoint({
      run: prepared.run, validatedClaim: prepared.validatedClaim, projection,
      evaluatedAt: this.#clock().toISOString(),
    });
    const request = await this.#payloads.put("request", prepared.context.requestPayload);
    const completed = checkpointResult.allSatisfied;
    const result = await this.#store.checkpoint({
      eventType: completed ? "run.completed" : "checkpoint.evaluated",
      runId: prepared.run.runId, expectedRunRevision: prepared.run.revision,
      runRevision: prepared.run.revision + 1, actorId: prepared.context.actorId,
      sourceMessageId: prepared.context.sourceMessageId, turnId: prepared.context.turnId,
      toolCallId: prepared.context.toolCallId, invocationIdentity: prepared.invocationIdentity,
      invocationKey: prepared.invocationKey, actionDigest: prepared.actionDigest,
      requestDigest: prepared.context.requestDigest, inputDigest: prepared.inputDigest,
      operation: prepared.operation,
      payload: {
        claim: { digest: claim.digest, payloadRef: claim.ref },
        evidenceBoundary: { ...prepared.evidenceBoundary }, checkpointResult,
        selectedEventRefs: checkpointResult.results.flatMap((item) => item.selectedEventRefs ?? []),
        sourceRequestDigest: request.digest, sourceRequestPayloadRef: request.ref,
      },
    });
    return {
      ...result, run: await this.#hydrate(result.run), claim: structuredClone(prepared.validatedClaim.claim),
      checkpointResult, requestDigest: request.digest,
    };
  }

  async prepareAbandon(params, invocation) {
    exactObject(params, ["reasonCode", "summary"], "INVALID_ABANDONMENT", "abandon_work input");
    const replay = await this.#replay("abandon_work", params, invocation);
    if (replay) return this.#markPrepared({ replay, operation: replay.operation }, "abandon");
    const context = invocationContext(invocation, this.#sessionId);
    this.#assertInvocationProfile(invocation);
    const run = await this.activeForActor(context.actorId);
    if (!ABANDON_REASON_CODES.has(params.reasonCode)) practiceRunFail("INVALID_ABANDONMENT", "Abandonment reason is unsupported");
    const summary = normalizedText(params.summary, {
      code: "INVALID_ABANDONMENT", name: "abandonment summary", maxBytes: MAX_ABANDON_SUMMARY_BYTES,
    });
    await this.#targetCapture.initialize();
    const operation = {
      ...operationBase({
        toolName: "abandon_work", profile: this.#profile, profileDigest: this.#profileDigest,
        practice: this.#reviewPractice, context, workspaceScope: this.#targetCapture.workspaceScope,
        state: { runId: run.runId, expectedRunRevision: run.revision },
      }),
      input: { reasonCode: params.reasonCode, summaryDigest: summary.digest, summaryBytes: summary.bytes },
    };
    return this.#markPrepared({
      context, run, reasonCode: params.reasonCode, summary, operation,
      inputDigest: this.#inputDigest("abandon_work", params),
      ...actionIdentity(this.#sessionId, context, operation),
    }, "abandon");
  }

  async commitAbandon(prepared) {
    this.#assertPrepared(prepared, "abandon");
    if (prepared.replay) return prepared.replay;
    const [request, note] = await Promise.all([
      this.#payloads.put("request", prepared.context.requestPayload),
      this.#payloads.put("note", { summary: prepared.summary.text }),
    ]);
    const result = await this.#store.abandon({
      eventType: "run.abandoned", runId: prepared.run.runId,
      expectedRunRevision: prepared.run.revision, runRevision: prepared.run.revision + 1,
      actorId: prepared.context.actorId, sourceMessageId: prepared.context.sourceMessageId,
      turnId: prepared.context.turnId, toolCallId: prepared.context.toolCallId,
      invocationIdentity: prepared.invocationIdentity, invocationKey: prepared.invocationKey,
      actionDigest: prepared.actionDigest, requestDigest: prepared.context.requestDigest,
      inputDigest: prepared.inputDigest, operation: prepared.operation,
      payload: {
        reasonCode: prepared.reasonCode, summaryDigest: note.digest, summaryPayloadRef: note.ref,
        sourceRequestDigest: request.digest, sourceRequestPayloadRef: request.ref,
      },
    });
    return { ...result, run: await this.#hydrate(result.run) };
  }

  async abandon(params, invocation) { return this.commitAbandon(await this.prepareAbandon(params, invocation)); }

  async activeForActor(actorId, options) {
    if (typeof actorId !== "string" || actorId === "") practiceRunFail("AUTHENTICATED_ACTOR_REQUIRED", "Authenticated actor is required");
    return this.#hydrate(await this.#store.activeForActor(actorId, options));
  }

  async latestForActor(actorId) {
    if (typeof actorId !== "string" || actorId === "") practiceRunFail("AUTHENTICATED_ACTOR_REQUIRED", "Authenticated actor is required");
    const state = await this.#store.state();
    const runs = Object.values(state.runs).filter((run) => run.origin.actorId === actorId);
    const latest = runs.at(-1);
    return latest ? this.#hydrate(latest) : undefined;
  }

  async claimForRun(run) {
    const ref = run?.lastCheckpoint?.claimPayloadRef;
    if (!ref) return undefined;
    const claim = await this.#payloads.read("claim", ref);
    if (sha256(claim) !== run.lastCheckpoint.claimDigest) practiceRunFail("STATE_CORRUPTED", "Protected claim does not match checkpoint digest");
    return claim;
  }

  state() { return this.#store.state(); }
}

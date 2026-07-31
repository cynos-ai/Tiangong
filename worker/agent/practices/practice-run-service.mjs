import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { sha256 } from "../canonical-json.mjs";
import { resolveWorkspacePath } from "../tools/operations.mjs";
import { practiceRunFail } from "./errors.mjs";
import {
  PracticeRunStore,
  practiceInvocationIdentity,
  practiceInvocationKey,
} from "./practice-run-store.mjs";
import { ProtectedPayloadStore } from "./protected-payload-store.mjs";

const POLICY_VERSION = "practice-run-v1";
const MAX_OBJECTIVE_BYTES = 4 * 1024;
const MAX_CRITERIA_COUNT = 32;
const MAX_CRITERION_BYTES = 2 * 1024;
const MAX_SCOPE_FILES = 64;
const MAX_SCOPE_PATH_BYTES = 1024;
const MAX_SCOPE_TOTAL_PATH_BYTES = 32 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SCOPE_BYTES_AT_ADMISSION = 16 * 1024 * 1024;
const MAX_REQUEST_PAYLOAD_BYTES = 256 * 1024;
const MAX_ABANDON_SUMMARY_BYTES = 8 * 1024;
const ABANDON_REASON_CODES = new Set([
  "superseded_by_new_request",
  "unsupported_scope",
  "cannot_complete",
  "user_cancelled",
  "other",
]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function exactObject(value, keys, code, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
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

function invocationContext(invocation, sessionId) {
  if (!invocation || typeof invocation !== "object") throw new TypeError("invocation is required");
  if (invocation.sessionId !== sessionId) practiceRunFail("STATE_CORRUPTED", "Invocation session mismatch");
  const actorId = invocation.actor?.id;
  const sourceMessageId = invocation.actor?.messageId;
  const prompt = invocation.ingress?.prompt;
  if (typeof actorId !== "string" || actorId === "") {
    practiceRunFail("AUTHENTICATED_ACTOR_REQUIRED", "An authenticated actor is required");
  }
  if (typeof sourceMessageId !== "string" || sourceMessageId === "") {
    practiceRunFail("SOURCE_MESSAGE_ID_REQUIRED", "A stable source message identifier is required");
  }
  if (typeof prompt !== "string" || prompt === "" || Buffer.byteLength(prompt) > MAX_REQUEST_PAYLOAD_BYTES) {
    practiceRunFail("REQUEST_PAYLOAD_INVALID", "Ingress request text is missing or exceeds its fixed limit");
  }
  const turnId = invocation.turnId;
  const toolCallId = invocation.toolCallId;
  if (typeof turnId !== "string" || turnId === "" || typeof toolCallId !== "string" || toolCallId === "") {
    throw new TypeError("turnId and toolCallId are required");
  }
  const requestPayload = { actorId, messageId: sourceMessageId, prompt };
  return {
    actorId,
    sourceMessageId,
    turnId,
    toolCallId,
    requestPayload,
    requestDigest: sha256(requestPayload),
  };
}

function actionIdentity(sessionId, context, operation) {
  const actionDigest = sha256(operation);
  const identity = practiceInvocationIdentity({
    sessionId,
    turnId: context.turnId,
    toolCallId: context.toolCallId,
  });
  return {
    actionDigest,
    invocationIdentity: identity,
    invocationKey: practiceInvocationKey({
      sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCallId,
    }, actionDigest),
  };
}

function mapPathError(error) {
  if (error?.code === "ENOENT") practiceRunFail("PATH_NOT_REGULAR_FILE", "Scope path is not a regular file");
  if (/outside the authorized workspace/iu.test(error?.message ?? "")) {
    practiceRunFail("PATH_OUTSIDE_WORKSPACE", "Scope path is outside the authorized workspace");
  }
  if (/symbolic link/iu.test(error?.message ?? "")) {
    practiceRunFail("SYMLINK_DENIED", "Symbolic links are not allowed in PracticeRun scope");
  }
  if (/credential-bearing|runtime state directory/iu.test(error?.message ?? "")) {
    practiceRunFail("SENSITIVE_PATH_DENIED", "Sensitive paths are not allowed in PracticeRun scope");
  }
  throw error;
}

export class PracticeRunService {
  #payloads;
  #prepared = new WeakMap();
  #profile;
  #profileDigest;
  #reviewPractice;
  #sessionId;
  #store;
  #uuid;
  #workspaceDir;

  constructor({
    sessionId,
    workspaceDir,
    profileBundle,
    journalPath,
    snapshotPath,
    protectedDirectory,
    clock,
    uuid = () => crypto.randomUUID(),
  }) {
    for (const [name, value] of Object.entries({
      sessionId,
      workspaceDir,
      journalPath,
      snapshotPath,
      protectedDirectory,
    })) {
      if (typeof value !== "string" || value === "") throw new TypeError(`${name} is required`);
    }
    if (!Object.isFrozen(profileBundle) || profileBundle.profile?.roleId !== "reviewer") {
      throw new TypeError("PracticeRunService requires the validated Reviewer profile");
    }
    const reviewPractice = profileBundle.practices.find((entry) => entry.definition.id === "review");
    if (!reviewPractice || !profileBundle.profile.practiceIds.includes("review")) {
      throw new TypeError("Reviewer profile does not authorize the review practice");
    }
    this.#sessionId = sessionId;
    this.#workspaceDir = workspaceDir;
    this.#profile = profileBundle.profile;
    this.#profileDigest = profileBundle.profileDigest;
    this.#reviewPractice = reviewPractice.definition;
    this.#uuid = uuid;
    this.#payloads = new ProtectedPayloadStore({ directory: protectedDirectory });
    this.#store = new PracticeRunStore({
      filePath: journalPath,
      snapshotPath,
      sessionId,
      clock,
      uuid,
    });
  }

  async #normalizeScope(files) {
    if (!Array.isArray(files) || files.length === 0 || files.length > MAX_SCOPE_FILES) {
      practiceRunFail("INVALID_SCOPE", "Scope files must be a non-empty bounded array");
    }
    const normalized = [];
    let totalPathBytes = 0;
    let totalFileBytes = 0;
    for (const file of files) {
      if (typeof file !== "string" || file === "" || isAbsolute(file) || file.includes("\u0000")) {
        practiceRunFail("INVALID_SCOPE", "Scope paths must be non-empty workspace-relative strings");
      }
      let resolved;
      try {
        resolved = await resolveWorkspacePath(this.#workspaceDir, file);
      } catch (error) {
        mapPathError(error);
      }
      const pathBytes = Buffer.byteLength(resolved.relativePath);
      if (pathBytes === 0 || pathBytes > MAX_SCOPE_PATH_BYTES) {
        practiceRunFail("SCOPE_LIMIT_EXCEEDED", "A scope path exceeds its fixed size limit");
      }
      totalPathBytes += pathBytes;
      if (totalPathBytes > MAX_SCOPE_TOTAL_PATH_BYTES) {
        practiceRunFail("SCOPE_LIMIT_EXCEEDED", "Scope paths exceed their aggregate size limit");
      }
      let entry;
      try {
        entry = await lstat(resolved.absolutePath);
      } catch (error) {
        mapPathError(error);
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        practiceRunFail("PATH_NOT_REGULAR_FILE", "Scope path is not a regular file");
      }
      if (entry.size > MAX_FILE_BYTES) {
        practiceRunFail("SCOPE_LIMIT_EXCEEDED", "A scoped file exceeds its admission size limit");
      }
      totalFileBytes += entry.size;
      if (totalFileBytes > MAX_SCOPE_BYTES_AT_ADMISSION) {
        practiceRunFail("SCOPE_LIMIT_EXCEEDED", "Scoped files exceed their aggregate admission limit");
      }
      normalized.push(resolved.relativePath);
    }
    if (new Set(normalized).size !== normalized.length) {
      practiceRunFail("INVALID_SCOPE", "Scope files must be unique after normalization");
    }
    return normalized;
  }

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
    if (!prepared || this.#prepared.get(prepared) !== kind) {
      throw new TypeError(`A service-prepared ${kind} transition is required`);
    }
  }

  #inputDigest(toolName, params) {
    return sha256({ toolName, profileDigest: this.#profileDigest, params });
  }

  async #replay(toolName, params, invocation) {
    const context = invocationContext(invocation, this.#sessionId);
    this.#assertInvocationProfile(invocation);
    const invocationIdentity = practiceInvocationIdentity({
      sessionId: this.#sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCallId,
    });
    const replay = await this.#store.replay({
      invocationIdentity,
      actorId: context.actorId,
      sourceMessageId: context.sourceMessageId,
      requestDigest: context.requestDigest,
      inputDigest: this.#inputDigest(toolName, params),
    });
    return replay ? { ...replay, run: await this.#hydrate(replay.run) } : undefined;
  }

  #assertInvocationProfile(invocation) {
    if (invocation.profileDigest !== this.#profileDigest) {
      practiceRunFail("STATE_CORRUPTED", "Invocation profile digest mismatch");
    }
  }

  async #hydrate(run) {
    if (!run) return undefined;
    const spec = await this.#payloads.read("spec", run.spec.payloadRef);
    exactObject(spec, ["acceptanceCriteria", "objective", "schemaVersion"], "STATE_CORRUPTED", "Run spec");
    if (spec.schemaVersion !== 1 || sha256(spec) !== run.spec.digest) {
      practiceRunFail("STATE_CORRUPTED", "Run spec does not match its journal reference");
    }
    const hydrated = structuredClone(run);
    delete hydrated.spec;
    hydrated.objective = structuredClone(spec.objective);
    hydrated.acceptanceCriteria = structuredClone(spec.acceptanceCriteria);
    return hydrated;
  }

  async prepareStart(params, invocation) {
    exactObject(params, ["acceptanceCriteria", "files", "objective", "practiceId"], "INVALID_SCOPE", "start_work input");
    const replay = await this.#replay("start_work", params, invocation);
    if (replay) return this.#markPrepared({ replay, operation: replay.operation }, "start");
    const context = invocationContext(invocation, this.#sessionId);
    this.#assertInvocationProfile(invocation);
    const active = await this.#store.activeForActor(context.actorId, { required: false });
    if (active) practiceRunFail("ACTIVE_RUN_EXISTS", "An active PracticeRun already exists");
    this.#validatePractice(params.practiceId);
    const objective = normalizedText(params.objective, {
      code: "INVALID_OBJECTIVE",
      name: "objective",
      maxBytes: MAX_OBJECTIVE_BYTES,
    });
    if (!Array.isArray(params.acceptanceCriteria) || params.acceptanceCriteria.length === 0 ||
        params.acceptanceCriteria.length > MAX_CRITERIA_COUNT) {
      practiceRunFail("INVALID_CRITERIA", "Acceptance criteria must be a non-empty bounded array");
    }
    const criteria = params.acceptanceCriteria.map((criterion, index) => ({
      id: `criterion-${index + 1}`,
      ...normalizedText(criterion, {
        code: "INVALID_CRITERIA",
        name: "criterion",
        maxBytes: MAX_CRITERION_BYTES,
      }),
    }));
    if (new Set(criteria.map((criterion) => criterion.text)).size !== criteria.length) {
      practiceRunFail("INVALID_CRITERIA", "Acceptance criteria must be unique after normalization");
    }
    const files = await this.#normalizeScope(params.files);
    const scopeDigest = sha256(files);
    const operation = {
      policyVersion: POLICY_VERSION,
      category: "state-transition",
      toolName: "start_work",
      roleId: this.#profile.roleId,
      profileDigest: this.#profileDigest,
      practiceId: this.#reviewPractice.id,
      practiceVersion: this.#reviewPractice.version,
      origin: {
        actorId: context.actorId,
        sourceMessageId: context.sourceMessageId,
        requestDigest: context.requestDigest,
      },
      input: {
        objectiveDigest: objective.digest,
        objectiveBytes: objective.bytes,
        criteria: criteria.map(({ digest, bytes }) => ({ digest, bytes })),
        scopeFiles: files,
        scopeDigest,
      },
    };
    return this.#markPrepared({
      context,
      operation,
      objective,
      criteria,
      files,
      scopeDigest,
      inputDigest: this.#inputDigest("start_work", params),
      ...actionIdentity(this.#sessionId, context, operation),
    }, "start");
  }

  async commitStart(prepared) {
    this.#assertPrepared(prepared, "start");
    if (prepared.replay) return prepared.replay;
    const request = await this.#payloads.put("request", prepared.context.requestPayload);
    const specPayload = {
      schemaVersion: 1,
      objective: { text: prepared.objective.text, source: "model_normalized" },
      acceptanceCriteria: prepared.criteria.map((criterion) => ({
        id: criterion.id,
        description: criterion.text,
        source: "model_normalized",
      })),
    };
    const spec = await this.#payloads.put("spec", specPayload);
    const result = await this.#store.start({
      eventType: "run.started",
      runId: `run-${this.#uuid()}`,
      runRevision: 1,
      actorId: prepared.context.actorId,
      sourceMessageId: prepared.context.sourceMessageId,
      turnId: prepared.context.turnId,
      toolCallId: prepared.context.toolCallId,
      invocationIdentity: prepared.invocationIdentity,
      invocationKey: prepared.invocationKey,
      actionDigest: prepared.actionDigest,
      requestDigest: prepared.context.requestDigest,
      inputDigest: prepared.inputDigest,
      operation: prepared.operation,
      payload: {
        roleId: this.#profile.roleId,
        profileDigest: this.#profileDigest,
        practiceId: this.#reviewPractice.id,
        practiceVersion: this.#reviewPractice.version,
        origin: {
          actorId: prepared.context.actorId,
          messageId: prepared.context.sourceMessageId,
          requestDigest: request.digest,
          requestPayloadRef: request.ref,
        },
        spec: { digest: spec.digest, payloadRef: spec.ref },
        scope: {
          revision: 1,
          files: prepared.files,
          digest: prepared.scopeDigest,
          source: "model_normalized",
        },
      },
    });
    return { ...result, run: await this.#hydrate(result.run) };
  }

  async start(params, invocation) {
    return this.commitStart(await this.prepareStart(params, invocation));
  }

  async prepareExtend(params, invocation) {
    exactObject(params, ["files"], "INVALID_SCOPE", "extend_scope input");
    const replay = await this.#replay("extend_scope", params, invocation);
    if (replay) return this.#markPrepared({ replay, operation: replay.operation }, "extend");
    const context = invocationContext(invocation, this.#sessionId);
    this.#assertInvocationProfile(invocation);
    const run = await this.#store.activeForActor(context.actorId);
    const newFiles = await this.#normalizeScope(params.files);
    const existing = new Set(run.scope.files);
    if (newFiles.some((file) => existing.has(file))) {
      practiceRunFail("SCOPE_FILE_ALREADY_PRESENT", "Scope extension contains an existing file");
    }
    const finalFiles = await this.#normalizeScope([...run.scope.files, ...newFiles]);
    const operation = {
      policyVersion: POLICY_VERSION,
      category: "state-transition",
      toolName: "extend_scope",
      roleId: run.roleId,
      profileDigest: run.profileDigest,
      practiceId: run.practiceId,
      practiceVersion: run.practiceVersion,
      origin: {
        actorId: context.actorId,
        sourceMessageId: context.sourceMessageId,
        requestDigest: context.requestDigest,
      },
      state: { runId: run.runId, expectedRunRevision: run.revision },
      input: {
        addedFiles: newFiles,
        previousScopeDigest: run.scope.digest,
        newScopeDigest: sha256(finalFiles),
      },
    };
    return this.#markPrepared({
      context,
      run,
      newFiles,
      finalFiles,
      operation,
      inputDigest: this.#inputDigest("extend_scope", params),
      ...actionIdentity(this.#sessionId, context, operation),
    }, "extend");
  }

  async commitExtend(prepared) {
    this.#assertPrepared(prepared, "extend");
    if (prepared.replay) return prepared.replay;
    const request = await this.#payloads.put("request", prepared.context.requestPayload);
    const result = await this.#store.extend({
      eventType: "scope.revised",
      runId: prepared.run.runId,
      expectedRunRevision: prepared.run.revision,
      runRevision: prepared.run.revision + 1,
      actorId: prepared.context.actorId,
      sourceMessageId: prepared.context.sourceMessageId,
      turnId: prepared.context.turnId,
      toolCallId: prepared.context.toolCallId,
      invocationIdentity: prepared.invocationIdentity,
      invocationKey: prepared.invocationKey,
      actionDigest: prepared.actionDigest,
      requestDigest: prepared.context.requestDigest,
      inputDigest: prepared.inputDigest,
      operation: prepared.operation,
      payload: {
        addedFiles: prepared.newFiles,
        previousScopeDigest: prepared.run.scope.digest,
        newScopeDigest: sha256(prepared.finalFiles),
        source: "model_normalized",
        sourceRequestDigest: request.digest,
        sourceRequestPayloadRef: request.ref,
      },
    });
    return { ...result, run: await this.#hydrate(result.run) };
  }

  async extend(params, invocation) {
    return this.commitExtend(await this.prepareExtend(params, invocation));
  }

  async prepareAbandon(params, invocation) {
    exactObject(params, ["reasonCode", "summary"], "INVALID_ABANDONMENT", "abandon_work input");
    const replay = await this.#replay("abandon_work", params, invocation);
    if (replay) return this.#markPrepared({ replay, operation: replay.operation }, "abandon");
    const context = invocationContext(invocation, this.#sessionId);
    this.#assertInvocationProfile(invocation);
    const run = await this.#store.activeForActor(context.actorId);
    if (!ABANDON_REASON_CODES.has(params.reasonCode)) {
      practiceRunFail("INVALID_ABANDONMENT", "Abandonment reason code is unsupported");
    }
    const summary = normalizedText(params.summary, {
      code: "INVALID_ABANDONMENT",
      name: "abandonment summary",
      maxBytes: MAX_ABANDON_SUMMARY_BYTES,
    });
    const operation = {
      policyVersion: POLICY_VERSION,
      category: "state-transition",
      toolName: "abandon_work",
      roleId: run.roleId,
      profileDigest: run.profileDigest,
      practiceId: run.practiceId,
      practiceVersion: run.practiceVersion,
      origin: {
        actorId: context.actorId,
        sourceMessageId: context.sourceMessageId,
        requestDigest: context.requestDigest,
      },
      state: { runId: run.runId, expectedRunRevision: run.revision },
      input: {
        reasonCode: params.reasonCode,
        summaryDigest: summary.digest,
        summaryBytes: summary.bytes,
      },
    };
    return this.#markPrepared({
      context,
      run,
      reasonCode: params.reasonCode,
      summary,
      operation,
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
      eventType: "run.abandoned",
      runId: prepared.run.runId,
      expectedRunRevision: prepared.run.revision,
      runRevision: prepared.run.revision + 1,
      actorId: prepared.context.actorId,
      sourceMessageId: prepared.context.sourceMessageId,
      turnId: prepared.context.turnId,
      toolCallId: prepared.context.toolCallId,
      invocationIdentity: prepared.invocationIdentity,
      invocationKey: prepared.invocationKey,
      actionDigest: prepared.actionDigest,
      requestDigest: prepared.context.requestDigest,
      inputDigest: prepared.inputDigest,
      operation: prepared.operation,
      payload: {
        reasonCode: prepared.reasonCode,
        summaryDigest: note.digest,
        summaryPayloadRef: note.ref,
        sourceRequestDigest: request.digest,
        sourceRequestPayloadRef: request.ref,
      },
    });
    return { ...result, run: await this.#hydrate(result.run) };
  }

  async abandon(params, invocation) {
    return this.commitAbandon(await this.prepareAbandon(params, invocation));
  }

  async activeForActor(actorId, options) {
    return this.#hydrate(await this.#store.activeForActor(actorId, options));
  }

  state() {
    return this.#store.state();
  }
}

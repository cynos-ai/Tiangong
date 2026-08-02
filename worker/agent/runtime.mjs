import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import {
  assertRuntimeProfileMaterialized,
  loadFixedRoleProfileBundle,
} from "./config/role-profile.mjs";
import { buildBaseSystemPrompt } from "./context/base-system-prompt.mjs";
import { CapturedArtifactStore } from "./artifacts/store.mjs";
import { createReviewerContextExtension } from "./context/reviewer-context.mjs";
import { projectReviewEvidence } from "./evidence/projection.mjs";
import { EvidenceRecorder } from "./evidence/recorder.mjs";
import {
  approvalOutcomeText,
  approvalPrompt,
  parseApprovalCommand,
} from "./gates/approval-command.mjs";
import { assertApprovalSubject } from "./gates/approval-subject.mjs";
import { PolicyGate } from "./gates/policy-gate.mjs";
import { ReviewerPracticeGate } from "./gates/reviewer-practice-gate.mjs";
import { IdempotencyStore } from "./idempotency/store.mjs";
import { ModelGateway } from "./model-gateway.mjs";
import { PeerReplyRouter } from "./peer-reply-router.mjs";
import { parsePeerTransportCommand, PeerTransportProbe } from "./peer-transport-probe.mjs";
import { createAgentTeamsPendingStorage } from "./pending-operation/agentteams-storage.mjs";
import { PendingOperationStore } from "./pending-operation/store.mjs";
import { PracticeRunService } from "./practices/practice-run-service.mjs";
import {
  assertSessionCapacity,
  defaultStateDirectory,
  PersistentSessionStore,
} from "./session-store.mjs";
import { createCoreToolRegistry } from "./tools/registry.mjs";
import { createReviewerToolRegistry } from "./work/reviewer-tools.mjs";
import { getPlaybook } from "./playbook/registry.mjs";
import { defaultTiangongRoot } from "./team/shared-fs.mjs";
import { createTeamChannel } from "./team/channel-adapter.mjs";
import { createLeaderSync } from "./team/sync-adapter.mjs";
import { createLeaderToolRegistry } from "./work/leader-tools.mjs";
import { createMemberToolRegistry } from "./work/member-tools.mjs";
import { completedReviewTargetFacts, renderCompletedReview, workStatusForRun } from "./work/status.mjs";
import { createTurnResult } from "./turn-contract.mjs";
import { TurnContextController } from "./turn-context.mjs";
import { createPiSessionTraceObserver } from "../observability/pi-session-tracing.mjs";
import { createProviderTraceBridge } from "../observability/provider-tracing.mjs";
import { observabilityOutcome } from "../observability/tracing.mjs";

function assistantText(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function usageFromMessage(message) {
  const usage = message?.usage;
  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;
  const cacheRead = usage?.cacheRead ?? 0;
  const cacheWrite = usage?.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: usage?.totalTokens ?? input + output + cacheRead + cacheWrite,
  };
}

function routedTurnResult(request, state, route, input) {
  const result = createTurnResult(request, { ...input, replyTarget: route.replyTarget });
  state.peerReplies.commit(route, { text: result.text, replyTarget: result.replyTarget });
  return result;
}

async function tracedOperation(observability, name, attributes, signal, task) {
  const operation = observability?.startOperation(name, attributes);
  try {
    const result = await task();
    operation?.end("complete");
    return result;
  } catch (error) {
    operation?.end(observabilityOutcome(signal), error);
    throw error;
  }
}

function appendControlMessage(state, content, details) {
  state.sessionManager.appendCustomMessageEntry("tiangong-control", content, false, details);
  state.session.agent.state.messages = [
    ...state.session.agent.state.messages,
    {
      role: "custom",
      customType: "tiangong-control",
      content,
      display: false,
      details,
      timestamp: Date.now(),
    },
  ];
}

function appendDeterministicAssistantMessage(state, content) {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "tiangong-control",
    provider: "tiangong",
    model: "peer-transport-v1",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  state.sessionManager.appendMessage(message);
  state.session.agent.state.messages = [...state.session.agent.state.messages, message];
}

export class TiangongAgentRuntime {
  #gateway;
  #profileBundle;
  #sessions = new Map();
  #stores = new Map();

  constructor({ configPath, provider, profileBundle }) {
    this.#gateway = new ModelGateway({ configPath, provider });
    this.#profileBundle = profileBundle ? Promise.resolve(profileBundle) : null;
  }

  #trustedProfileBundle() {
    if (!this.#profileBundle) this.#profileBundle = loadFixedRoleProfileBundle();
    return this.#profileBundle;
  }

  async #createSession(request, model, modelRuntime, profileBundle) {
    const stateDirectory = defaultStateDirectory(request.workspaceDir);
    let sessionStore = this.#stores.get(stateDirectory);
    if (!sessionStore) {
      sessionStore = new PersistentSessionStore({ stateDirectory });
      this.#stores.set(stateDirectory, sessionStore);
    }
    const persisted = await sessionStore.open(request);
    const evidence = new EvidenceRecorder({
      filePath: persisted.paths.evidenceFilePath,
    });
    const idempotencyStore = new IdempotencyStore({
      filePath: persisted.paths.idempotencyFilePath,
    });
    const pendingOperationStore = new PendingOperationStore({
      directory: persisted.paths.pendingOperationDirectory,
      remoteStorage: createAgentTeamsPendingStorage({ workspaceDir: request.workspaceDir }),
    });
    const turns = new TurnContextController();
    let practiceService = null;
    let gate;
    let registry;
    if (profileBundle.profile.roleId === "reviewer") {
      const artifactStore = new CapturedArtifactStore({
        stateDirectory,
        sessionId: request.sessionId,
      });
      practiceService = new PracticeRunService({
        sessionId: request.sessionId,
        workspaceDir: request.workspaceDir,
        profileBundle,
        journalPath: persisted.paths.practiceRunJournalPath,
        snapshotPath: persisted.paths.practiceRunSnapshotPath,
        protectedDirectory: persisted.paths.practiceRunProtectedDirectory,
        artifactStore,
        localGitLockPath: persisted.paths.localGitLockPath,
      });
      gate = new ReviewerPracticeGate({ profileBundle });
      registry = createReviewerToolRegistry({
        workspaceDir: request.workspaceDir,
        service: practiceService,
        gate,
        evidence,
        getInvocation: turns.current,
        inspectionLockPath: persisted.paths.reviewInspectionLockPath,
      });
    } else if (profileBundle.profile.roleId === "leader") {
      gate = new PolicyGate({ idempotencyStore });
      const playbook = getPlaybook("software-change-delivery");
      const teamDeps = {
        rootDir: defaultTiangongRoot(),
        env: process.env,
        channel: createTeamChannel({ evidence }),
        sync: createLeaderSync(),
        evidence,
        getInvocation: turns.current,
      };
      registry = createLeaderToolRegistry({ playbook, deps: teamDeps });
    } else if (profileBundle.profile.roleId === "team-member") {
      gate = new PolicyGate({ idempotencyStore });
      const teamDeps = {
        rootDir: defaultTiangongRoot(),
        env: process.env,
        channel: createTeamChannel({ evidence }),
        sync: createLeaderSync(),
        evidence,
        getInvocation: turns.current,
      };
      registry = createMemberToolRegistry({ deps: teamDeps });
    } else {
      gate = new PolicyGate({ idempotencyStore });
      registry = createCoreToolRegistry({
        workspaceDir: request.workspaceDir,
        rollbackDir: persisted.paths.rollbackDirectory,
        gate,
        evidence,
        idempotencyStore,
        pendingOperationStore,
        getInvocation: turns.current,
        profile: profileBundle.profile,
      });
    }
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });
    const providerTrace = createProviderTraceBridge();
    const resourceLoader = new DefaultResourceLoader({
      agentDir: persisted.paths.piDirectory,
      cwd: request.workspaceDir,
      noContextFiles: true,
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      extensionFactories: [
        providerTrace.extension,
        ...(practiceService ? [createReviewerContextExtension({
          service: practiceService,
          turns,
          evidence,
          profileDigest: profileBundle.profileDigest,
        })] : []),
      ],
      settingsManager,
      systemPrompt: buildBaseSystemPrompt(profileBundle),
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      agentDir: persisted.paths.piDirectory,
      cwd: request.workspaceDir,
      model,
      modelRuntime,
      tools: registry.names(),
      customTools: registry.definitions(),
      resourceLoader,
      sessionManager: persisted.manager,
      settingsManager,
      thinkingLevel: request.thinkingLevel,
    });
    registry.assertSession(session);
    return {
      session,
      sessionManager: persisted.manager,
      sessionStore,
      evidence,
      idempotencyStore,
      pendingOperationStore,
      practiceService,
      turns,
      registry,
      peerReplies: new PeerReplyRouter(),
      peerTransport: new PeerTransportProbe(),
      providerTrace,
      profileDigest: profileBundle.profileDigest,
      provider: request.provider,
      modelId: request.modelId,
      workspaceDir: request.workspaceDir,
    };
  }

  async #stateFor(request, model, modelRuntime, profileBundle) {
    let state = this.#sessions.get(request.sessionId);
    if (!state) {
      state = await this.#createSession(request, model, modelRuntime, profileBundle);
      this.#sessions.set(request.sessionId, state);
    } else {
      if (state.workspaceDir !== request.workspaceDir) {
        throw new Error("A Tiangong session cannot change workspace");
      }
      if (state.provider !== request.provider || state.modelId !== request.modelId) {
        await state.session.setModel(model);
        state.provider = request.provider;
        state.modelId = request.modelId;
      }
    }
    return state;
  }

  #handlePeerTransport(request, state, route, command, observability) {
    const plan = state.peerTransport.plan(command, request, route);
    const result = createTurnResult(request, {
      text: plan.text,
      replyTarget: plan.replyTarget,
    });
    appendDeterministicAssistantMessage(state, result.text);
    state.peerReplies.commit(route, { text: result.text, replyTarget: result.replyTarget });
    state.peerTransport.commit(plan);
    observability?.checkpoint(`peer.transport.${command.kind}`);
    return result;
  }

  async #handleApproval(request, state, route, command, observability) {
    const match = await state.idempotencyStore.findApproval(command.approvalId);
    if (!match) throw new Error("Approval request not found");
    const checkpoint = match.entry;
    const actorId = assertApprovalSubject(checkpoint, request.actor.id);

    if (command.action === "reject") {
      await state.idempotencyStore.reject(match.key, {
        operationDigest: checkpoint.operationDigest,
        rejectedBy: actorId,
        reasonCode: "HUMAN_REJECTED",
      });
      await state.evidence.append({
        type: "approval.rejected",
        sessionId: checkpoint.sessionId,
        turnId: checkpoint.turnId,
        toolCallId: checkpoint.toolCallId,
        approvalId: checkpoint.approvalId,
        operationDigest: checkpoint.operationDigest,
        actorId,
      });
      try {
        await state.pendingOperationStore.remove(match.key);
      } catch {
        await state.evidence.append({
          type: "operation.payload_cleanup_deferred",
          sessionId: checkpoint.sessionId,
          turnId: checkpoint.turnId,
          toolCallId: checkpoint.toolCallId,
          approvalId: checkpoint.approvalId,
          operationDigest: checkpoint.operationDigest,
          idempotencyKey: match.key,
        }).catch(() => {});
      }
      const text = approvalOutcomeText("reject", checkpoint);
      appendControlMessage(state, text, {
        approvalId: checkpoint.approvalId,
        operationDigest: checkpoint.operationDigest,
        outcome: "rejected",
      });
      return routedTurnResult(request, state, route, { text });
    }

    const wasCompleted = checkpoint.status === "completed";
    const recovered = wasCompleted
      ? undefined
      : await state.pendingOperationStore.load(match.key, checkpoint);
    await state.idempotencyStore.approve(match.key, {
      operationDigest: checkpoint.operationDigest,
      approvedBy: actorId,
    });
    await state.evidence.append({
      type: "approval.approved",
      sessionId: checkpoint.sessionId,
      turnId: checkpoint.turnId,
      toolCallId: checkpoint.toolCallId,
      approvalId: checkpoint.approvalId,
      operationDigest: checkpoint.operationDigest,
      actorId,
    });
    if (wasCompleted) {
      try {
        await state.pendingOperationStore.remove(match.key);
      } catch {
        await state.evidence.append({
          type: "operation.payload_cleanup_deferred",
          sessionId: checkpoint.sessionId,
          turnId: checkpoint.turnId,
          toolCallId: checkpoint.toolCallId,
          approvalId: checkpoint.approvalId,
          operationDigest: checkpoint.operationDigest,
          idempotencyKey: match.key,
        }).catch(() => {});
      }
      await state.evidence.append({
        type: "tool.execution.replayed",
        sessionId: checkpoint.sessionId,
        turnId: checkpoint.turnId,
        actorId,
        toolCallId: checkpoint.toolCallId,
        toolName: checkpoint.toolName,
        operationDigest: checkpoint.operationDigest,
        idempotencyKey: match.key,
      });
      const text = approvalOutcomeText("approve", checkpoint, true);
      appendControlMessage(state, text, {
        approvalId: checkpoint.approvalId,
        operationDigest: checkpoint.operationDigest,
        outcome: "replayed",
      });
      return routedTurnResult(request, state, route, { text, hadPotentialSideEffects: true });
    }

    const definition = state.registry.definitions().find((tool) => tool.name === checkpoint.toolName);
    if (!definition) throw new Error("Approved tool is no longer registered");
    const params = recovered.arguments;
    state.turns.begin({
      sessionId: checkpoint.sessionId,
      turnId: checkpoint.turnId,
      actor: request.actor,
      ingress: { prompt: request.prompt },
      profileDigest: state.profileDigest,
      resumed: true,
      observability,
    });
    try {
      await definition.execute(checkpoint.toolCallId, params, request.abortSignal);
    } finally {
      state.turns.end();
    }
    const text = approvalOutcomeText("approve", checkpoint, wasCompleted);
    appendControlMessage(state, text, {
      approvalId: checkpoint.approvalId,
      operationDigest: checkpoint.operationDigest,
      outcome: wasCompleted ? "replayed" : "executed",
    });
    return routedTurnResult(request, state, route, { text, hadPotentialSideEffects: true });
  }

  async runTurn(request, observability) {
    if (request.images.length > 0) throw new Error("The Tiangong agent runtime does not support image input yet");
    const profileBundle = assertRuntimeProfileMaterialized(await this.#trustedProfileBundle());
    observability?.checkpoint("runtime.start");
    const setup = observability?.startOperation("tiangong.runtime.setup");
    let resolved;
    let state;
    try {
      resolved = await tracedOperation(
        observability,
        "tiangong.gateway.resolve",
        {},
        request.abortSignal,
        () => this.#gateway.resolve({
          provider: request.provider,
          modelId: request.modelId,
          credential: request.credential,
        }),
      );
      observability?.checkpoint("gateway.resolved");
      state = await tracedOperation(
        observability,
        "tiangong.session.open_or_reuse",
        {},
        request.abortSignal,
        () => this.#stateFor(request, resolved.model, resolved.modelRuntime, profileBundle),
      );
      observability?.checkpoint("session.ready");
      setup?.end("complete");
    } catch (error) {
      setup?.end(observabilityOutcome(request.abortSignal), error);
      throw error;
    }
    state.session.setThinkingLevel(request.thinkingLevel);
    if (state.session.isStreaming) throw new Error("pi session is already processing a request");

    const route = state.peerReplies.plan(request.replyTarget);
    const transportCommand = parsePeerTransportCommand(request.prompt);
    if (transportCommand) {
      return this.#handlePeerTransport(request, state, route, transportCommand, observability);
    }
    const command = parseApprovalCommand(request.prompt);
    if (command) return this.#handleApproval(request, state, route, command, observability);

    let runBefore;
    if (state.practiceService) {
      try {
        runBefore = await state.practiceService.latestForActor(request.actor.id);
        await state.practiceService.activeForActor(request.actor.id, { required: false });
      } catch (error) {
        if (!["RUN_REQUESTER_MISMATCH", "AUTHENTICATED_ACTOR_REQUIRED"].includes(error?.code)) throw error;
        return routedTurnResult(request, state, route, {
          text: "Request denied: authenticated requester is unavailable or does not own the active work.",
          workStatus: workStatusForRun(null),
        });
      }
    }

    assertSessionCapacity(state.sessionManager.getEntries(), request.prompt);
    state.session.setActiveToolsByName(request.toolsEnabled ? state.registry.names() : []);
    let finalMessage;
    const modelTrace = createPiSessionTraceObserver(observability, request);
    const unsubscribe = state.session.subscribe((event) => {
      modelTrace.handle(event);
      if (event.type === "message_end" && event.message?.role === "assistant") finalMessage = event.message;
    });
    const abort = () => void state.session.abort().catch(() => {});
    request.abortSignal?.addEventListener("abort", abort, { once: true });
    state.turns.begin({
      sessionId: request.sessionId,
      turnId: request.turnId,
      actor: request.actor,
      ingress: { prompt: request.prompt },
      profileDigest: state.profileDigest,
      observability,
    });
    let completedTurn;
    let promptError;
    const agentTurn = observability?.startOperation("tiangong.pi.agent_turn");
    observability?.checkpoint("pi.agent_turn.start");
    const releaseProviderTrace = state.providerTrace.bind(modelTrace);
    try {
      await state.session.prompt(request.prompt);
      agentTurn?.end("complete");
    } catch (error) {
      promptError = error;
      agentTurn?.end(observabilityOutcome(request.abortSignal), error);
      throw error;
    } finally {
      releaseProviderTrace();
      modelTrace.finish(promptError);
      completedTurn = state.turns.end();
      unsubscribe();
      request.abortSignal?.removeEventListener("abort", abort);
    }

    if (completedTurn?.turnState.pending) {
      const pending = completedTurn.turnState.pending;
      return routedTurnResult(request, state, route, {
        text: approvalPrompt(pending),
        usage: usageFromMessage(finalMessage),
        pendingApproval: {
          approvalId: pending.approvalId,
          operationDigest: pending.operationDigest,
          idempotencyKey: pending.idempotencyKey,
        },
        workStatus: state.practiceService ? workStatusForRun(null) : undefined,
      });
    }

    const runAfter = state.practiceService
      ? await state.practiceService.latestForActor(request.actor.id)
      : undefined;
    let text = assistantText(finalMessage);
    if (runAfter?.status === "done" && runAfter.lastCheckpoint?.allSatisfied &&
        (runBefore?.runId !== runAfter.runId || runBefore.status !== "done" ||
          runAfter.lastCheckpoint.completionTurnId === request.turnId)) {
      const claim = await state.practiceService.claimForRun(runAfter);
      const projection = await projectReviewEvidence({
        evidence: state.evidence,
        boundary: {
          sequence: runAfter.lastCheckpoint.evidenceTerminalSequence,
          hash: runAfter.lastCheckpoint.evidenceTerminalHash,
        },
        run: runAfter,
        targetCapture: state.practiceService.targetCapture,
        artifactStore: state.practiceService.artifactStore,
      });
      text = renderCompletedReview({
        run: runAfter,
        claim,
        targetFacts: completedReviewTargetFacts(runAfter, projection),
      });
    }
    if (text === "") throw new Error(state.session.agent.state.errorMessage || "pi returned no assistant text");
    return routedTurnResult(request, state, route, {
      text,
      usage: usageFromMessage(finalMessage),
      workStatus: state.practiceService ? workStatusForRun(runAfter ?? runBefore) : undefined,
    });
  }

  async reset(sessionId) {
    const state = this.#sessions.get(sessionId);
    state?.session.dispose();
    this.#sessions.delete(sessionId);
    if (state) await state.sessionStore.reset(sessionId);
  }

  async dispose() {
    for (const state of this.#sessions.values()) state.session.dispose();
    this.#sessions.clear();
    await this.#gateway.dispose();
  }
}

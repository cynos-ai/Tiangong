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
import { EvidenceRecorder } from "./evidence/recorder.mjs";
import {
  approvalOutcomeText,
  approvalPrompt,
  parseApprovalCommand,
} from "./gates/approval-command.mjs";
import { assertApprovalSubject } from "./gates/approval-subject.mjs";
import { assertOperationApprovalSubject, deploymentApproverForWorker } from "./gates/explicit-subject-policy.mjs";
import { PolicyGate } from "./gates/policy-gate.mjs";
import { IdempotencyStore } from "./idempotency/store.mjs";
import { ModelGateway } from "./model-gateway.mjs";
import { PeerReplyRouter } from "./peer-reply-router.mjs";
import { parseSpecialistHandoffCommand, SpecialistHandoffProbe } from "./handoff-transport-probe.mjs";
import { parsePeerTransportCommand, PeerTransportProbe } from "./peer-transport-probe.mjs";
import { createAgentTeamsPendingStorage } from "./pending-operation/agentteams-storage.mjs";
import { PendingOperationStore } from "./pending-operation/store.mjs";
import {
  assertSessionCapacity,
  defaultStateDirectory,
  PersistentSessionStore,
} from "./session-store.mjs";
import { createCoreToolRegistry } from "./tools/registry.mjs";
import { readPlaybookManifest } from "./playbook/resolver.mjs";
import { deploymentBrokerEndpointForWorker } from "./deployment/client.mjs";
import { DeploymentReceiptStore } from "./deployment/receipt-store.mjs";
import { runnerBrokerEndpointForWorker } from "./runner/broker-client.mjs";
import { RunnerJournal } from "./runner/journal.mjs";
import { createRunnerBrokerPreparationClient } from "./runner/preparation-client.mjs";
import { defaultTiangongRoot } from "./team/shared-fs.mjs";
import { workerStatePaths } from "./persistence/state-paths.mjs";
import { createTeamChannel } from "./team/channel-adapter.mjs";
import { createLeaderRuntimeBinding } from "./team/leader-runtime-config.mjs";
import { projectDisposition } from "./team/project-chain.mjs";
import { createTeamSync } from "./team/sync-adapter.mjs";
import { TeamCoordinationGate } from "./team/tool-wrapper.mjs";
import { createLeaderToolRegistry } from "./work/leader-tools.mjs";
import { createMemberToolRegistry } from "./work/member-tools.mjs";
import { WorkRunStore } from "./work/work-run-store.mjs";
import { createTurnResult } from "./turn-contract.mjs";
import { TurnContextController } from "./turn-context.mjs";
import { createPiSessionTraceObserver } from "../observability/pi-session-tracing.mjs";
import { createProviderTraceBridge } from "../observability/provider-tracing.mjs";
import { observabilityOutcome } from "../observability/tracing.mjs";

const NO_REPLY_TEXT = '{"action":"NO_REPLY"}';

function assistantText(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function stableErrorCode(error, fallback) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
    ? error.code
    : fallback;
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
  #approvalConfig;
  #sessions = new Map();
  #stores = new Map();
  #sessionOperationTails = new Map();

  constructor({ configPath, provider, profileBundle, deploymentApprover = deploymentApproverForWorker({
    configured: process.env.TIANGONG_DEPLOYMENT_APPROVER,
    env: process.env,
  }) }) {
    this.#gateway = new ModelGateway({ configPath, provider });
    this.#profileBundle = profileBundle ? Promise.resolve(profileBundle) : null;
    this.#approvalConfig = Object.freeze({ deploymentApprover });
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
    const sharedPaths = workerStatePaths(stateDirectory);
    const idempotencyStore = new IdempotencyStore({
      filePath: sharedPaths.idempotencyFilePath,
    });
    const pendingOperationStore = new PendingOperationStore({
      directory: sharedPaths.pendingOperationDirectory,
      remoteStorage: createAgentTeamsPendingStorage({ workspaceDir: request.workspaceDir }),
    });
    const workRunStore = new WorkRunStore({ directory: sharedPaths.workRunDirectory });
    const turns = new TurnContextController();
    let gate;
    let registry;
    let channel;
    let coordinationStore;
    let leaderRuntimeBinding;
    let leaderIngress;
    if (profileBundle.runtimeKind === "leader") {
      gate = new TeamCoordinationGate();
      const playbook = readPlaybookManifest("software-change-delivery");
      channel = createTeamChannel({ evidence });
      const bindingFile = process.env.TIANGONG_LEADER_RUNTIME_BINDING_FILE;
      if (bindingFile) {
        if (!process.env.TIANGONG_COORDINATION_CONTROL_ENDPOINT || !process.env.TIANGONG_COORDINATION_CONTROL_TOKEN) {
          throw new Error("Leader runtime binding requires Coordination Control endpoint and token");
        }
        leaderRuntimeBinding = await createLeaderRuntimeBinding({
          filePath: bindingFile,
          controlEndpoint: process.env.TIANGONG_COORDINATION_CONTROL_ENDPOINT,
          controlToken: process.env.TIANGONG_COORDINATION_CONTROL_TOKEN,
          channel,
        });
        coordinationStore = leaderRuntimeBinding.coordinationStore;
        leaderIngress = leaderRuntimeBinding.leaderIngress;
      }
      const teamDeps = {
        rootDir: defaultTiangongRoot(),
        env: process.env,
        channel,
        sync: createTeamSync(),
        evidence,
        gate,
        getInvocation: turns.current,
        maxRevisionWaves: playbook.maxRevisionWaves,
        getProjectDisposition: (projectId) => projectDisposition(projectId, teamDeps),
        runnerBrokerPreparation: createRunnerBrokerPreparationClient({
          endpoint: process.env.TIANGONG_RUNNER_BROKER_PREPARATION_ENDPOINT,
        }),
        coordinationStore,
      };
      registry = createLeaderToolRegistry({ playbook, deps: teamDeps });
    } else if (profileBundle.runtimeKind === "member") {
      gate = new TeamCoordinationGate();
      channel = createTeamChannel({ evidence });
      const teamDeps = {
        rootDir: defaultTiangongRoot(),
        env: process.env,
        channel,
        sync: createTeamSync(),
        evidence,
        gate,
        getInvocation: turns.current,
        professionalRole: profileBundle.profile.roleId,
        sourceProfileDigest: profileBundle.profileDigest,
        sourceSkillId: profileBundle.skills[0].id,
        sourceSkillDigest: profileBundle.skills[0].digest,
        idempotencyStore,
        pendingOperationStore,
        workRunStore,
        deploymentBrokerEndpoint: deploymentBrokerEndpointForWorker({
          role: profileBundle.profile.roleId,
          env: process.env,
        }),
        deploymentReceiptStore: profileBundle.profile.roleId === "operator"
          ? new DeploymentReceiptStore({ filePath: sharedPaths.deploymentReceiptFilePath })
          : undefined,
        runnerBrokerEndpoint: runnerBrokerEndpointForWorker({
          role: profileBundle.profile.roleId,
          env: process.env,
        }),
        runnerJournal: ["implementor", "assessor"].includes(profileBundle.profile.roleId)
          ? new RunnerJournal({ filePath: sharedPaths.runnerJournalFilePath })
          : undefined,
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
      extensionFactories: [providerTrace.extension],
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
      workRunStore,
      turns,
      registry,
      channel,
      coordinationStore,
      leaderRuntimeBinding,
      leaderIngress,
      peerReplies: new PeerReplyRouter(),
      peerTransport: new PeerTransportProbe(),
      handoffTransport: new SpecialistHandoffProbe(),
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

  async #handleSpecialistHandoff(request, state, route, command, observability) {
    const plan = state.handoffTransport.plan(command, request, route);
    if (typeof state.channel?.sendSpecialistHandoff !== "function") {
      throw new Error("Specialist handoff channel is unavailable");
    }
    const delivery = await state.channel.sendSpecialistHandoff(plan.recipient.id, {
      workId: plan.workId,
      intentId: plan.intentId,
      sourceEventId: plan.sourceEventId,
      sourceSender: plan.sourceSender,
    });
    const replay = await state.channel.sendSpecialistHandoff(plan.recipient.id, {
      workId: plan.workId,
      intentId: plan.intentId,
      sourceEventId: plan.sourceEventId,
      sourceSender: plan.sourceSender,
    });
    if (delivery.transactionId !== replay.transactionId || delivery.eventId !== replay.eventId) {
      throw new Error("Specialist handoff replay did not preserve the Matrix event");
    }
    appendDeterministicAssistantMessage(
      state,
      `TG_HANDOFF_SENDER_ACK transaction_id=${delivery.transactionId} event_id=${delivery.eventId} replay_event_id=${replay.eventId}`,
    );
    state.handoffTransport.commit(plan);
    observability?.checkpoint("handoff.transport.sent");
    // OpenClaw recognizes this exact bounded envelope as a no-reply result;
    // returning an empty Harness result would emit its generic error message.
    return createTurnResult(request, { text: NO_REPLY_TEXT, replyTarget: null });
  }

  async #handleApproval(request, state, route, command, observability) {
    const match = await state.idempotencyStore.findApproval(command.approvalId);
    if (!match) throw new Error("Approval request not found");
    const checkpoint = match.entry;
    const actorId = assertOperationApprovalSubject({
      checkpoint,
      actorId: request.actor.id,
      config: this.#approvalConfig,
      assertRequester: assertApprovalSubject,
    });

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

    const definition = state.registry.definitions().find((tool) => tool.name === checkpoint.toolName);
    if (!definition) throw new Error("Approved tool is no longer registered");
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
      if (typeof definition.onApprovalResult === "function") {
        try {
          await definition.onApprovalResult(checkpoint.replayResult);
        } catch (error) {
          await state.evidence.append({
            type: "approval.completion_handoff_failed",
            sessionId: checkpoint.sessionId,
            turnId: checkpoint.turnId,
            toolCallId: checkpoint.toolCallId,
            approvalId: checkpoint.approvalId,
            operationDigest: checkpoint.operationDigest,
            errorCode: stableErrorCode(error, "APPROVAL_COMPLETION_HANDOFF_FAILED"),
          }).catch(() => {});
          throw error;
        }
      }
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
      const executionResult = await definition.execute(checkpoint.toolCallId, params, request.abortSignal);
      if (typeof definition.onApprovalResult === "function") {
        try {
          await definition.onApprovalResult(executionResult);
        } catch (error) {
          await state.evidence.append({
            type: "approval.completion_handoff_failed",
            sessionId: checkpoint.sessionId,
            turnId: checkpoint.turnId,
            toolCallId: checkpoint.toolCallId,
            approvalId: checkpoint.approvalId,
            operationDigest: checkpoint.operationDigest,
            errorCode: stableErrorCode(error, "APPROVAL_COMPLETION_HANDOFF_FAILED"),
          }).catch(() => {});
          throw error;
        }
      }
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

  #withSessionOperation(sessionId, operation) {
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new TypeError("sessionId is required");
    }
    const previous = this.#sessionOperationTails.get(sessionId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.#sessionOperationTails.set(sessionId, current);
    return previous.then(operation).finally(() => {
      release();
      if (this.#sessionOperationTails.get(sessionId) === current) {
        this.#sessionOperationTails.delete(sessionId);
      }
    });
  }

  async runTurn(request, observability) {
    return this.#withSessionOperation(request.sessionId, () => this.#runTurnUnlocked(request, observability));
  }

  /**
   * Admit a deployment-authored Matrix event before a Leader turn. The
   * binding and remote control token are loaded once with the session and the
   * request is never passed to the model as an authority signal.
   */
  async admitLeaderIngress(request, context) {
    return this.#withSessionOperation(request.sessionId, async () => {
      const profileBundle = assertRuntimeProfileMaterialized(await this.#trustedProfileBundle());
      if (profileBundle.runtimeKind !== "leader") throw new Error("Leader ingress is available only to the Leader runtime");
      const resolved = await this.#gateway.resolve({
        provider: request.provider,
        modelId: request.modelId,
        credential: request.credential,
      });
      const state = await this.#stateFor(request, resolved.model, resolved.modelRuntime, profileBundle);
      if (typeof state.leaderIngress !== "function") throw new Error("Leader Coordination Control binding is unavailable");
      return state.leaderIngress(context);
    });
  }

  async isLeaderRuntime() {
    const profileBundle = assertRuntimeProfileMaterialized(await this.#trustedProfileBundle());
    return profileBundle.runtimeKind === "leader";
  }

  async #runTurnUnlocked(request, observability) {
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
    if (state.handoffTransport.hasCommittedTurn(request.turnId)) {
      return createTurnResult(request, { text: NO_REPLY_TEXT, replyTarget: null });
    }
    if (route.replyTarget !== null && /TG_HANDOFF_[A-Z]+/u.test(request.prompt)) {
      return createTurnResult(request, { text: NO_REPLY_TEXT, replyTarget: null });
    }
    const handoffCommand = route.replyTarget === null
      ? parseSpecialistHandoffCommand(request.prompt)
      : null;
    if (handoffCommand) {
      return this.#handleSpecialistHandoff(request, state, route, handoffCommand, observability);
    }
    const transportCommand = parsePeerTransportCommand(request.prompt);
    if (transportCommand) {
      return this.#handlePeerTransport(request, state, route, transportCommand, observability);
    }
    const command = parseApprovalCommand(request.prompt);
    if (command) return this.#handleApproval(request, state, route, command, observability);

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
      });
    }

    const text = assistantText(finalMessage);
    if (text === "") throw new Error(state.session.agent.state.errorMessage || "pi returned no assistant text");
    return routedTurnResult(request, state, route, {
      text,
      usage: usageFromMessage(finalMessage),
    });
  }

  async reset(sessionId) {
    return this.#withSessionOperation(sessionId, async () => {
      const state = this.#sessions.get(sessionId);
      state?.session.dispose();
      this.#sessions.delete(sessionId);
      if (state) await state.sessionStore.reset(sessionId);
    });
  }

  async dispose() {
    for (const state of this.#sessions.values()) state.session.dispose();
    this.#sessions.clear();
    await this.#gateway.dispose();
  }
}

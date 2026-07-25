import { join } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { EvidenceRecorder } from "./evidence/recorder.mjs";
import {
  approvalOutcomeText,
  approvalPrompt,
  parseApprovalCommand,
} from "./gates/approval-command.mjs";
import { PolicyGate } from "./gates/policy-gate.mjs";
import { IdempotencyStore } from "./idempotency/store.mjs";
import { ModelGateway } from "./model-gateway.mjs";
import { PendingOperationStore } from "./pending-operation/store.mjs";
import { defaultStateDirectory, PersistentSessionStore } from "./session-store.mjs";
import { createCoreToolRegistry } from "./tools/registry.mjs";
import { createTurnResult } from "./turn-contract.mjs";
import { TurnContextController } from "./turn-context.mjs";

const SYSTEM_PROMPT = `You are the Tiangong agent runtime. Use only the tools exposed by the runtime. Tool authorization is enforced in code. A pending tool result means the operation did not execute; do not claim otherwise. Never invent an approval or alter an approval identifier.`;

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

export class TiangongAgentRuntime {
  #gateway;
  #sessions = new Map();
  #stores = new Map();

  constructor({ configPath, provider }) {
    this.#gateway = new ModelGateway({ configPath, provider });
  }

  async #createSession(request, model, modelRuntime) {
    const stateDirectory = defaultStateDirectory(request.workspaceDir);
    let sessionStore = this.#stores.get(stateDirectory);
    if (!sessionStore) {
      sessionStore = new PersistentSessionStore({ stateDirectory });
      this.#stores.set(stateDirectory, sessionStore);
    }
    const persisted = await sessionStore.open(request);
    const evidence = new EvidenceRecorder({
      filePath: join(persisted.directory, "evidence", "events.jsonl"),
    });
    const idempotencyStore = new IdempotencyStore({
      filePath: join(persisted.directory, "idempotency.json"),
    });
    const pendingOperationStore = new PendingOperationStore({
      directory: join(persisted.directory, "pending-operations"),
    });
    const turns = new TurnContextController();
    const gate = new PolicyGate({ idempotencyStore });
    const registry = createCoreToolRegistry({
      workspaceDir: request.workspaceDir,
      stateDir: persisted.directory,
      gate,
      evidence,
      idempotencyStore,
      pendingOperationStore,
      getInvocation: turns.current,
    });
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });
    const resourceLoader = new DefaultResourceLoader({
      agentDir: persisted.directory,
      cwd: request.workspaceDir,
      noContextFiles: true,
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      settingsManager,
      systemPrompt: SYSTEM_PROMPT,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      agentDir: persisted.directory,
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
      turns,
      registry,
      provider: request.provider,
      modelId: request.modelId,
      workspaceDir: request.workspaceDir,
    };
  }

  async #stateFor(request, model, modelRuntime) {
    let state = this.#sessions.get(request.sessionId);
    if (!state) {
      state = await this.#createSession(request, model, modelRuntime);
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

  async #handleApproval(request, state, command) {
    const match = await state.idempotencyStore.findApproval(command.approvalId);
    if (!match) throw new Error("Approval request not found");
    const checkpoint = match.entry;
    const actorId = request.actor.id;
    if (typeof actorId !== "string" || actorId === "") throw new Error("Approval subject is unavailable");
    if (checkpoint.requestedBy !== actorId && request.actor.isOwner !== true) {
      throw new Error("Approval subject is not authorized for this operation");
    }

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
      const text = approvalOutcomeText("reject", checkpoint);
      appendControlMessage(state, text, {
        approvalId: checkpoint.approvalId,
        operationDigest: checkpoint.operationDigest,
        outcome: "rejected",
      });
      return createTurnResult({ text });
    }

    const wasCompleted = checkpoint.status === "completed";
    const recovered = await state.pendingOperationStore.load(match.key, checkpoint);
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
    const definition = state.registry.definitions().find((tool) => tool.name === checkpoint.toolName);
    if (!definition) throw new Error("Approved tool is no longer registered");
    const params = recovered.arguments;
    state.turns.begin({
      sessionId: checkpoint.sessionId,
      turnId: checkpoint.turnId,
      actor: request.actor,
      resumed: true,
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
    return createTurnResult({ text, hadPotentialSideEffects: true });
  }

  async runTurn(request) {
    if (request.images.length > 0) throw new Error("The Tiangong agent runtime does not support image input yet");
    const resolved = await this.#gateway.resolve({
      provider: request.provider,
      modelId: request.modelId,
      credential: request.credential,
    });
    const state = await this.#stateFor(request, resolved.model, resolved.modelRuntime);
    state.session.setThinkingLevel(request.thinkingLevel);
    if (state.session.isStreaming) throw new Error("pi session is already processing a request");

    const command = parseApprovalCommand(request.prompt);
    if (command) return this.#handleApproval(request, state, command);

    state.session.setActiveToolsByName(request.toolsEnabled ? state.registry.names() : []);
    let finalMessage;
    const unsubscribe = state.session.subscribe((event) => {
      if (event.type === "message_end" && event.message?.role === "assistant") finalMessage = event.message;
    });
    const abort = () => void state.session.abort().catch(() => {});
    request.abortSignal?.addEventListener("abort", abort, { once: true });
    state.turns.begin({
      sessionId: request.sessionId,
      turnId: request.turnId,
      actor: request.actor,
    });
    let completedTurn;
    try {
      await state.session.prompt(request.prompt);
    } finally {
      completedTurn = state.turns.end();
      unsubscribe();
      request.abortSignal?.removeEventListener("abort", abort);
    }

    if (completedTurn?.turnState.pending) {
      const pending = completedTurn.turnState.pending;
      return createTurnResult({
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
    return createTurnResult({ text, usage: usageFromMessage(finalMessage) });
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

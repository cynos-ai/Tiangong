import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TiangongAgentRuntime } from "../agent/runtime.mjs";
import { createTurnRequest, normalizeReplyTarget } from "../agent/turn-contract.mjs";
import {
  DISABLED_OBSERVABILITY,
  observabilityOutcome,
} from "../observability/tracing.mjs";

const HARNESS_ID = "tiangong-pi";
const HARNESS_EVIDENCE_FILE = "/tmp/tiangong-pi-harness.last-run";
const SUPPORTED_PROVIDER = "agentteams-gateway";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const MATRIX_USER_ID = /^@[^:\s]+:[^\s]+$/u;
const MATRIX_EVENT_ID = /^\$[^\s]{1,255}$/u;
const MATRIX_ROOM_ID = /^![^\s]{1,255}$/u;

function stringSet(value) {
  return new Set(Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []);
}

function matrixPeerContext(params) {
  const channel = params.messageChannel ?? params.messageProvider;
  const senderId = params.senderId;
  const matrix = params.config?.channels?.matrix;
  if (channel !== "matrix" || typeof senderId !== "string" || !MATRIX_USER_ID.test(senderId) ||
      matrix?.groupPolicy !== "allowlist" || matrix?.dm?.policy !== "allowlist" ||
      !Array.isArray(matrix.groupAllowFrom) || !Array.isArray(matrix.dm.allowFrom)) {
    return { replyTarget: null, authorizedPeerTargets: [] };
  }
  const groupAllowFrom = stringSet(matrix.groupAllowFrom);
  const dmAllowFrom = stringSet(matrix.dm.allowFrom);
  if (!groupAllowFrom.has(senderId) && !dmAllowFrom.has(senderId)) {
    return { replyTarget: null, authorizedPeerTargets: [] };
  }
  const groupOnly = [...groupAllowFrom]
    .filter((id) => MATRIX_USER_ID.test(id) && !dmAllowFrom.has(id))
    .map((id) => ({
      channel: "matrix",
      id,
      source: "openclaw.matrix.group-only-sender",
    }));
  return {
    replyTarget: groupOnly.find((target) => target.id === senderId) ?? null,
    authorizedPeerTargets: groupOnly.filter((target) => target.id !== senderId),
  };
}

function projectedText(result) {
  let text = result?.text ?? "";
  const target = normalizeReplyTarget(result?.replyTarget);
  if (target && !text.includes(target.id)) text = `${target.id} ${text}`.trim();
  return text;
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, " ").slice(0, 500);
}

function abortError(signal) {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(signal.reason === undefined ? "Harness attempt aborted" : String(signal.reason));
}

function createAttemptAbortBoundary(params) {
  if (!Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0) {
    throw new Error("A positive OpenClaw Harness attempt timeout is required");
  }
  const controller = new AbortController();
  const upstream = params.abortSignal;
  const abortFromUpstream = () => controller.abort(upstream.reason);
  if (upstream?.aborted) abortFromUpstream();
  else upstream?.addEventListener("abort", abortFromUpstream, { once: true });
  const timeoutMs = Math.min(Math.floor(params.timeoutMs), 2_147_483_647);
  const timer = setTimeout(() => {
    controller.abort(new Error(`Tiangong Harness attempt timeout after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      upstream?.removeEventListener("abort", abortFromUpstream);
    },
  };
}

function openClawUsage(usage) {
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    cost: ZERO_COST,
  };
}

function createAssistantMessage(params, result, promptError, text) {
  return {
    role: "assistant",
    content: text === "" ? [] : [{ type: "text", text }],
    api: params.model?.api ?? "openai-completions",
    provider: params.provider,
    model: params.modelId,
    usage: openClawUsage(result?.usage),
    stopReason: params.abortSignal?.aborted ? "aborted" : promptError ? "error" : "stop",
    errorMessage: promptError ? errorMessage(promptError) : undefined,
    timestamp: Date.now(),
  };
}

export function buildAttemptResult(params, { result, promptError = null }) {
  const text = projectedText(result);
  const hasAssistant = text !== "" || promptError !== null;
  const assistant = hasAssistant ? createAssistantMessage(params, result, promptError, text) : undefined;
  const messagesSnapshot = [{ role: "user", content: params.prompt, timestamp: Date.now() }];
  if (assistant) messagesSnapshot.push(assistant);
  const abortReason = params.abortSignal?.reason;
  const timedOut = params.abortSignal?.aborted === true && /timeout/iu.test(String(abortReason ?? ""));
  return {
    aborted: params.abortSignal?.aborted === true,
    externalAbort: params.abortSignal?.aborted === true,
    timedOut,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError,
    promptErrorSource: promptError ? "prompt" : null,
    sessionIdUsed: params.sessionId,
    bootstrapPromptWarningSignaturesSeen: params.bootstrapPromptWarningSignaturesSeen,
    bootstrapPromptWarningSignature: params.bootstrapPromptWarningSignature,
    messagesSnapshot,
    assistantTexts: text === "" ? [] : [text],
    toolMetas: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    didSendViaMessagingTool: false,
    didSendDeterministicApprovalPrompt: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    successfulCronAdds: 0,
    cloudCodeAssistFormatError: false,
    attemptUsage: result?.usage ? {
      input: result.usage.input,
      output: result.usage.output,
      cacheRead: result.usage.cacheRead,
      cacheWrite: result.usage.cacheWrite,
      total: result.usage.totalTokens,
    } : undefined,
    replayMetadata: {
      hadPotentialSideEffects: result?.hadPotentialSideEffects === true,
      replaySafe: result?.hadPotentialSideEffects !== true,
    },
    itemLifecycle: {
      startedCount: hasAssistant ? 1 : 0,
      completedCount: hasAssistant ? 1 : 0,
      activeCount: 0,
    },
  };
}

function turnId(params) {
  const messageId = params.currentMessageId;
  return messageId === undefined || messageId === null
    ? params.runId
    : `${params.messageChannel ?? params.messageProvider ?? "channel"}:${messageId}`;
}

/**
 * Extract only the bounded, non-secret Matrix ingress facts needed by the
 * Leader admission seam. Raw event content stays in the channel adapter and
 * never enters TurnRequest or the model runtime.
 */
export function resolveOpenClawMatrixIngress(params) {
  const channel = params?.messageChannel ?? params?.messageProvider;
  if (params?.matrixIngress === undefined || params?.matrixIngress === null) {
    // OpenClaw's public EmbeddedRunAttemptParams already carries the
    // authenticated inbound Matrix envelope as separate fields: groupId is
    // the room, messageTo is the canonical `room:<roomId>` target, and
    // currentMessageId is the event ID. Keep this derivation deliberately
    // narrow; the channel adapter still re-reads the event with its own
    // authenticated Matrix token before admission, so these fields never
    // become the event-content oracle.
    const roomId = params?.groupId;
    if (channel !== "matrix" || typeof roomId !== "string" || !MATRIX_ROOM_ID.test(roomId) ||
        params?.messageTo !== `room:${roomId}` ||
        typeof params?.senderId !== "string" || !MATRIX_USER_ID.test(params.senderId) ||
        typeof params?.currentMessageId !== "string" || !MATRIX_EVENT_ID.test(params.currentMessageId)) {
      return null;
    }
    return Object.freeze({
      source: Object.freeze({
        channel: "matrix",
        authenticated: true,
        actorId: params.senderId,
        messageId: params.currentMessageId,
        route: "team-room",
      }),
      roomId,
      eventId: params.currentMessageId,
    });
  }
  const ingressKeys = typeof params.matrixIngress === "object" && !Array.isArray(params.matrixIngress)
    ? Object.keys(params.matrixIngress).sort().join(",") : "";
  if (channel !== "matrix" || typeof params.matrixIngress !== "object" || Array.isArray(params.matrixIngress) ||
      ingressKeys !== "authenticated,roomId,route" ||
      params.matrixIngress.authenticated !== true || params.matrixIngress.route !== "team-room" ||
      typeof params.senderId !== "string" || !MATRIX_USER_ID.test(params.senderId) ||
      typeof params.currentMessageId !== "string" || !MATRIX_EVENT_ID.test(params.currentMessageId) ||
      typeof params.matrixIngress.roomId !== "string" || !MATRIX_ROOM_ID.test(params.matrixIngress.roomId)) {
    throw new Error("OpenClaw Matrix ingress context is incomplete or unauthenticated");
  }
  return Object.freeze({
    source: Object.freeze({
      channel: "matrix",
      authenticated: true,
      actorId: params.senderId,
      messageId: params.currentMessageId,
      route: "team-room",
    }),
    roomId: params.matrixIngress.roomId,
    eventId: params.currentMessageId,
  });
}

export function toTurnRequest(params) {
  const peerContext = matrixPeerContext(params);
  return createTurnRequest({
    attemptId: params.runId,
    turnId: turnId(params),
    sessionId: params.sessionId,
    prompt: params.prompt,
    workspaceDir: params.workspaceDir,
    provider: params.provider,
    modelId: params.modelId,
    thinkingLevel: params.thinkLevel,
    toolsEnabled: params.disableTools !== true,
    credential: params.resolvedApiKey,
    images: params.images,
    abortSignal: params.abortSignal,
    actor: {
      id: params.senderId,
      displayName: params.senderName ?? params.senderUsername,
      channel: params.messageChannel ?? params.messageProvider,
      messageId: params.currentMessageId,
    },
    replyTarget: peerContext.replyTarget,
    authorizedPeerTargets: peerContext.authorizedPeerTargets,
  });
}

export function createTiangongPiHarness(options = {}) {
  const configPath = options.configPath ?? process.env.OPENCLAW_CONFIG_PATH ??
    join(process.env.HOME || "", "openclaw.json");
  const runtime = options.runtime ?? new TiangongAgentRuntime({
    configPath,
    provider: SUPPORTED_PROVIDER,
  });
  const harnessEvidenceFile = options.evidencePath ?? HARNESS_EVIDENCE_FILE;
  const observability = options.observability ?? DISABLED_OBSERVABILITY;
  const leaderIngress = options.leaderIngress;

  return {
    id: HARNESS_ID,
    label: "Tiangong pi agent harness",
    supports(context) {
      return context.provider === SUPPORTED_PROVIDER
        ? { supported: true, priority: 100 }
        : { supported: false, reason: `provider must be ${SUPPORTED_PROVIDER}` };
    },
    async runAttempt(params) {
      params.onAgentEvent?.({
        stream: "tiangong_pi.lifecycle",
        data: { harness: HARNESS_ID, phase: "start", runId: params.runId },
      });
      let abortBoundary;
      let attemptTrace;
      let effectiveParams = params;
      try {
        abortBoundary = createAttemptAbortBoundary(params);
        effectiveParams = { ...params, abortSignal: abortBoundary.signal };
        attemptTrace = observability.startAttempt({
          harnessId: HARNESS_ID,
          attemptId: params.runId,
          turnId: turnId(params),
          sessionId: params.sessionId,
          provider: params.provider,
          modelId: params.modelId,
          timeoutMs: Math.min(Math.floor(params.timeoutMs), 2_147_483_647),
        });
        await writeFile(
          harnessEvidenceFile,
          `harness=${HARNESS_ID}\nprovider=${params.provider}\nmodel=${params.modelId}\nstatus=running\n`,
          { mode: 0o600 },
        );
        if (effectiveParams.abortSignal.aborted) throw abortError(effectiveParams.abortSignal);
        const matrixIngress = resolveOpenClawMatrixIngress(effectiveParams);
        if (matrixIngress && typeof leaderIngress !== "function") {
          throw new Error("OpenClaw Matrix ingress is present but Leader admission is not wired");
        }
        if (matrixIngress) await leaderIngress(matrixIngress, effectiveParams);
        const result = await runtime.runTurn(toTurnRequest(effectiveParams), attemptTrace);
        await writeFile(
          harnessEvidenceFile,
          `harness=${HARNESS_ID}\nprovider=${params.provider}\nmodel=${params.modelId}\nstatus=pass\n`,
          { mode: 0o600 },
        );
        await params.onAssistantMessageStart?.();
        params.onAgentEvent?.({
          stream: "tiangong_pi.lifecycle",
          data: { harness: HARNESS_ID, phase: "complete", runId: params.runId },
        });
        attemptTrace?.finish("complete");
        return buildAttemptResult(effectiveParams, { result });
      } catch (error) {
        attemptTrace?.finish(observabilityOutcome(effectiveParams.abortSignal), error);
        const message = errorMessage(error);
        await writeFile(
          harnessEvidenceFile,
          `harness=${HARNESS_ID}\nprovider=${params.provider}\nmodel=${params.modelId}\nstatus=error\nerror=${message}\n`,
          { mode: 0o600 },
        ).catch(() => {});
        params.onAgentEvent?.({
          stream: "tiangong_pi.lifecycle",
          data: { harness: HARNESS_ID, phase: "error", runId: params.runId, error: message },
        });
        return buildAttemptResult(effectiveParams, { promptError: error });
      } finally {
        abortBoundary?.dispose();
      }
    },
    async reset(params) {
      if (params.sessionId) await runtime.reset(params.sessionId);
    },
    async dispose() {
      try {
        await runtime.dispose();
      } finally {
        await observability.shutdown();
      }
    },
  };
}

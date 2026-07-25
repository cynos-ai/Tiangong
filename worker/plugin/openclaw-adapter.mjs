import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TiangongAgentRuntime } from "../agent/runtime.mjs";
import { createTurnRequest } from "../agent/turn-contract.mjs";

const HARNESS_ID = "tiangong-pi";
const HARNESS_EVIDENCE_FILE = "/tmp/tiangong-pi-harness.last-run";
const SUPPORTED_PROVIDER = "agentteams-gateway";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/gu, " ").slice(0, 500);
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

function createAssistantMessage(params, result, promptError) {
  const text = result?.text ?? "";
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
  const text = result?.text ?? "";
  const hasAssistant = text !== "" || promptError !== null;
  const assistant = hasAssistant ? createAssistantMessage(params, result, promptError) : undefined;
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

export function toTurnRequest(params) {
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
  });
}

export function createTiangongPiHarness(options = {}) {
  const configPath = options.configPath ?? process.env.OPENCLAW_CONFIG_PATH ??
    join(process.env.HOME || "", "openclaw.json");
  const runtime = options.runtime ?? new TiangongAgentRuntime({
    configPath,
    provider: SUPPORTED_PROVIDER,
  });

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
      try {
        const result = await runtime.runTurn(toTurnRequest(params));
        await writeFile(
          HARNESS_EVIDENCE_FILE,
          `harness=${HARNESS_ID}\nprovider=${params.provider}\nmodel=${params.modelId}\nstatus=pass\n`,
          { mode: 0o600 },
        );
        await params.onAssistantMessageStart?.();
        params.onAgentEvent?.({
          stream: "tiangong_pi.lifecycle",
          data: { harness: HARNESS_ID, phase: "complete", runId: params.runId },
        });
        return buildAttemptResult(params, { result });
      } catch (error) {
        const message = errorMessage(error);
        await writeFile(
          HARNESS_EVIDENCE_FILE,
          `harness=${HARNESS_ID}\nprovider=${params.provider}\nmodel=${params.modelId}\nstatus=error\nerror=${message}\n`,
          { mode: 0o600 },
        ).catch(() => {});
        params.onAgentEvent?.({
          stream: "tiangong_pi.lifecycle",
          data: { harness: HARNESS_ID, phase: "error", runId: params.runId, error: message },
        });
        return buildAttemptResult(params, { promptError: error });
      }
    },
    async reset(params) {
      if (params.sessionId) await runtime.reset(params.sessionId);
    },
    async dispose() {
      await runtime.dispose();
    },
  };
}

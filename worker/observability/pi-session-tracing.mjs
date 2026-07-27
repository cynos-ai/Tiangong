import { observabilityOutcome } from "./tracing.mjs";

const MODEL_PROGRESS_INTERVAL_MS = 60_000;
const MAX_MODEL_PROGRESS_CHECKPOINTS = 32;

function isAssistant(event) {
  return event.message?.role === "assistant";
}

export function createPiSessionTraceObserver(observability, request, options = {}) {
  const now = options.now ?? Date.now;
  const progressIntervalMs = options.progressIntervalMs ?? MODEL_PROGRESS_INTERVAL_MS;
  const maxProgressCheckpoints = options.maxProgressCheckpoints ?? MAX_MODEL_PROGRESS_CHECKPOINTS;
  let activeModel;
  let responseStarted = false;
  let progressCheckpoints = 0;
  let lastProgressAt;

  function resetModelProgress() {
    responseStarted = false;
    progressCheckpoints = 0;
    lastProgressAt = undefined;
  }

  function responseStart() {
    if (!activeModel || responseStarted) return;
    responseStarted = true;
    observability?.checkpoint("model.response.start");
  }

  return {
    providerRequestReady() {
      activeModel?.end("error");
      activeModel = observability?.startOperation("gen_ai.chat", {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": request.provider,
        "gen_ai.request.model": request.modelId,
      });
      resetModelProgress();
      observability?.checkpoint("model.request.ready");
    },
    providerResponseReceived() {
      if (activeModel) observability?.checkpoint("model.response.received");
    },
    handle(event) {
      if (event.type === "turn_start") {
        activeModel?.end("error");
        activeModel = undefined;
        resetModelProgress();
        observability?.checkpoint("pi.turn.start");
      } else if (event.type === "message_start" && isAssistant(event) &&
          event.message.stopReason !== "error" && event.message.stopReason !== "aborted") {
        responseStart();
      } else if (event.type === "message_update" && isAssistant(event)) {
        responseStart();
        const observedAt = now();
        if (progressCheckpoints < maxProgressCheckpoints &&
            (lastProgressAt === undefined || observedAt - lastProgressAt >= progressIntervalMs)) {
          observability?.checkpoint("model.response.progress");
          progressCheckpoints += 1;
          lastProgressAt = observedAt;
        }
      } else if (event.type === "message_end" && isAssistant(event)) {
        const failed = event.message.stopReason === "error";
        const aborted = event.message.stopReason === "aborted";
        activeModel?.end(failed ? "error" : aborted ? observabilityOutcome(request.abortSignal) : "complete");
        activeModel = undefined;
      } else if (event.type === "auto_retry_start") {
        observability?.checkpoint("model.retry", {
          "tiangong.retry.attempt": event.attempt,
          "tiangong.retry.max_attempts": event.maxAttempts,
        });
      }
    },
    finish(error) {
      activeModel?.end(error ? observabilityOutcome(request.abortSignal) : "error", error);
      activeModel = undefined;
    },
  };
}

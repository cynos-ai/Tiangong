import { observabilityOutcome } from "./tracing.mjs";

export function createPiSessionTraceObserver(observability, request) {
  let activeModel;
  return {
    handle(event) {
      if (event.type === "turn_start") {
        activeModel?.end("error");
        activeModel = observability?.startOperation("gen_ai.chat", {
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": request.provider,
          "gen_ai.request.model": request.modelId,
        });
        observability?.checkpoint("model.start");
      } else if (event.type === "message_end" && event.message?.role === "assistant") {
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

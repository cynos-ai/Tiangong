import {
  AdmissionDeniedError,
  admitBeforeModel,
  admitBeforeTool,
} from "./admission-boundary.mjs";

const BLOCK_MESSAGE = "This Worker turn is not admitted by the current Tiangong binding.";

function denyDecision(error) {
  const reasonCode = error instanceof AdmissionDeniedError ? error.code : "ADMISSION_CONTEXT_UNAVAILABLE";
  return {
    reason: reasonCode,
    message: BLOCK_MESSAGE,
  };
}

export function createAdmissionHookHandlers({ resolveContext } = {}) {
  if (typeof resolveContext !== "function") {
    throw new TypeError("resolveContext is required");
  }

  return {
    async beforeAgentRun(event, ctx) {
      try {
        const context = await resolveContext({ phase: "model", event, ctx });
        admitBeforeModel(context);
        return undefined;
      } catch (error) {
        const decision = denyDecision(error);
        return { outcome: "block", ...decision };
      }
    },
    async beforeToolCall(event, ctx) {
      try {
        const context = await resolveContext({ phase: "tool", event, ctx });
        admitBeforeTool(context);
        return undefined;
      } catch (error) {
        const decision = denyDecision(error);
        return { block: true, blockReason: `${decision.reason}: ${BLOCK_MESSAGE}` };
      }
    },
  };
}

export function registerAdmissionHooks(api, { resolveContext, required = false } = {}) {
  if (typeof api?.on !== "function") {
    if (required) throw new Error("OpenClaw admission hook API is unavailable");
    return { enabled: false, reason: "hook-api-unavailable" };
  }
  const handlers = createAdmissionHookHandlers({ resolveContext });
  api.on("before_agent_run", handlers.beforeAgentRun, { priority: 100 });
  api.on("before_tool_call", handlers.beforeToolCall, { priority: 100 });
  return { enabled: true, hooks: ["before_agent_run", "before_tool_call"] };
}

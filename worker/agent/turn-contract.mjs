const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function requiredString(value, name) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

export function normalizeThinkingLevel(level) {
  return THINKING_LEVELS.has(level) ? level : "off";
}

export function createTurnRequest(input) {
  const request = {
    attemptId: requiredString(input.attemptId, "attemptId"),
    turnId: requiredString(input.turnId, "turnId"),
    sessionId: requiredString(input.sessionId, "sessionId"),
    prompt: requiredString(input.prompt, "prompt"),
    workspaceDir: requiredString(input.workspaceDir, "workspaceDir"),
    provider: requiredString(input.provider, "provider"),
    modelId: requiredString(input.modelId, "modelId"),
    thinkingLevel: normalizeThinkingLevel(input.thinkingLevel),
    toolsEnabled: input.toolsEnabled !== false,
    actor: {
      id: input.actor?.id ?? null,
      displayName: input.actor?.displayName ?? null,
      channel: input.actor?.channel ?? null,
      messageId: input.actor?.messageId ?? null,
    },
    images: Array.isArray(input.images) ? input.images : [],
    abortSignal: input.abortSignal,
  };
  Object.defineProperty(request, "credential", {
    value: requiredString(input.credential, "credential"),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(request);
}

export function createTurnResult({ text, usage, pendingApproval = null, hadPotentialSideEffects = false }) {
  if (typeof text !== "string") throw new TypeError("Turn result text must be a string");
  return Object.freeze({
    text,
    usage: {
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
    },
    pendingApproval,
    hadPotentialSideEffects: hadPotentialSideEffects === true,
  });
}

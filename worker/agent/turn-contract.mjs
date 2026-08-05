const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MATRIX_REPLY_SOURCE = "openclaw.matrix.group-only-sender";
const MATRIX_USER_ID = /^@[^:\s]+:[^\s]+$/u;
const MAX_AUTHORIZED_PEERS = 32;

function requiredString(value, name) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

export function normalizeReplyTarget(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("reply target must be a validated object");
  }
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "channel,id,source" ||
      value.channel !== "matrix" ||
      value.source !== MATRIX_REPLY_SOURCE ||
      typeof value.id !== "string" ||
      !MATRIX_USER_ID.test(value.id)) {
    throw new TypeError("reply target is malformed or unsupported");
  }
  return Object.freeze({ channel: value.channel, id: value.id, source: value.source });
}

export function normalizeAuthorizedPeerTargets(value) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_AUTHORIZED_PEERS) {
    throw new TypeError("authorized peer targets must be a bounded array");
  }
  const targets = value.map(normalizeReplyTarget);
  if (targets.some((target) => target === null)) {
    throw new TypeError("authorized peer targets cannot contain null");
  }
  const ids = new Set(targets.map((target) => target.id));
  if (ids.size !== targets.length) throw new TypeError("authorized peer targets must be unique");
  return Object.freeze(targets);
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
    actor: Object.freeze({
      id: input.actor?.id ?? null,
      displayName: input.actor?.displayName ?? null,
      channel: input.actor?.channel ?? null,
      messageId: input.actor?.messageId ?? null,
    }),
    replyTarget: normalizeReplyTarget(input.replyTarget),
    authorizedPeerTargets: normalizeAuthorizedPeerTargets(input.authorizedPeerTargets),
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

export function createTurnResult(request, input) {
  if (!input || typeof input !== "object") throw new TypeError("Turn result input must be an object");
  const requestedTarget = normalizeReplyTarget(request?.replyTarget);
  const authorizedPeers = normalizeAuthorizedPeerTargets(request?.authorizedPeerTargets);
  const authorizedIds = new Set(authorizedPeers.map((target) => target.id));
  if (requestedTarget) authorizedIds.add(requestedTarget.id);
  let replyTarget = requestedTarget;
  if (Object.hasOwn(input, "replyTarget")) {
    replyTarget = normalizeReplyTarget(input.replyTarget);
    if (replyTarget && !authorizedIds.has(replyTarget.id)) {
      throw new TypeError("Turn result replyTarget is not authorized for this ingress");
    }
  }
  const { text, usage, pendingApproval = null, hadPotentialSideEffects = false } = input;
  if (typeof text !== "string") throw new TypeError("Turn result text must be a string");
  return Object.freeze({
    text,
    usage: Object.freeze({
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
    }),
    pendingApproval,
    hadPotentialSideEffects: hadPotentialSideEffects === true,
    replyTarget,
  });
}

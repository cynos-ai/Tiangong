const MATRIX_USER_ID = /^@[^:\s]+:[^\s]+$/u;
const NON_EMPTY = /^[^\s]+$/u;

export class AdmissionDeniedError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "AdmissionDeniedError";
    this.code = reasonCode;
  }
}

function deny(code, message) {
  throw new AdmissionDeniedError(code, message);
}

function required(value, name) {
  if (typeof value !== "string" || !NON_EMPTY.test(value)) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function assertSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    deny("ADMISSION_SOURCE_INVALID", "authenticated ingress source is required");
  }
  required(source.channel, "source.channel");
  required(source.actorId, "source.actorId");
  required(source.messageId, "source.messageId");
  if (source.channel === "matrix" && !MATRIX_USER_ID.test(source.actorId)) {
    deny("ADMISSION_ACTOR_INVALID", "Matrix ingress requires an authenticated Matrix user id");
  }
  if (source.authenticated !== true) {
    deny("ADMISSION_SOURCE_UNAUTHENTICATED", "ingress source is not authenticated");
  }
  if (source.route !== "team-room" && source.route !== "worker-dm") {
    deny("ADMISSION_ROUTE_INVALID", "ingress route is not an admitted Worker route");
  }
  return Object.freeze({
    channel: source.channel,
    actorId: source.actorId,
    messageId: source.messageId,
    route: source.route,
  });
}

function assertBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    deny("ADMISSION_BINDING_INVALID", "current runtime binding is required");
  }
  required(binding.workerName, "binding.workerName");
  required(binding.runtimeLane, "binding.runtimeLane");
  required(binding.configRevision, "binding.configRevision");
  required(binding.capabilityRevision, "binding.capabilityRevision");
  if (binding.active !== true) deny("ADMISSION_BINDING_INACTIVE", "runtime binding is inactive");
  if (!Array.isArray(binding.allowedChannels) || !binding.allowedChannels.includes("matrix")) {
    deny("ADMISSION_CHANNEL_NOT_ALLOWED", "runtime binding does not admit Matrix ingress");
  }
  return binding;
}

function assertRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("admission request is required");
  }
  return {
    workerName: required(request.workerName, "request.workerName"),
    runtimeLane: required(request.runtimeLane, "request.runtimeLane"),
    turnId: required(request.turnId, "request.turnId"),
    requestDigest: required(request.requestDigest, "request.requestDigest"),
    configRevision: required(request.configRevision, "request.configRevision"),
    capabilityRevision: required(request.capabilityRevision, "request.capabilityRevision"),
  };
}

function assertBindingMatches(request, binding) {
  if (request.workerName !== binding.workerName || request.runtimeLane !== binding.runtimeLane) {
    deny("ADMISSION_BINDING_MISMATCH", "request is bound to a different Worker or runtime lane");
  }
}

function assertRevisionMatches(request, binding) {
  if (request.configRevision !== binding.configRevision ||
      request.capabilityRevision !== binding.capabilityRevision) {
    deny("ADMISSION_REVISION_STALE", "request uses a stale runtime or capability revision");
  }
}

export function admitBeforeModel({ source, binding, request } = {}) {
  const normalizedSource = assertSource(source);
  const currentBinding = assertBinding(binding);
  const normalizedRequest = assertRequest(request);
  assertBindingMatches(normalizedRequest, currentBinding);
  assertRevisionMatches(normalizedRequest, currentBinding);
  if (!currentBinding.allowedChannels.includes(normalizedSource.channel)) {
    deny("ADMISSION_CHANNEL_NOT_ALLOWED", "ingress channel is not allowed by the current binding");
  }
  return Object.freeze({
    phase: "model",
    source: normalizedSource,
    workerName: normalizedRequest.workerName,
    runtimeLane: normalizedRequest.runtimeLane,
    turnId: normalizedRequest.turnId,
    requestDigest: normalizedRequest.requestDigest,
    configRevision: currentBinding.configRevision,
    capabilityRevision: currentBinding.capabilityRevision,
  });
}

export function admitBeforeTool({ admission, binding, toolName, requestDigest } = {}) {
  if (!admission || admission.phase !== "model") {
    deny("ADMISSION_MODEL_REQUIRED", "a successful model admission is required before tool admission");
  }
  const currentBinding = assertBinding(binding);
  required(toolName, "toolName");
  required(requestDigest, "requestDigest");
  if (currentBinding.revoked === true) deny("ADMISSION_REVOKED", "runtime binding was revoked");
  if (admission.workerName !== currentBinding.workerName ||
      admission.runtimeLane !== currentBinding.runtimeLane) {
    deny("ADMISSION_BINDING_MISMATCH", "tool request is bound to a different Worker or runtime lane");
  }
  if (admission.configRevision !== currentBinding.configRevision ||
      admission.capabilityRevision !== currentBinding.capabilityRevision) {
    deny("ADMISSION_REVISION_STALE", "tool request uses a stale runtime or capability revision");
  }
  if (admission.requestDigest !== requestDigest) {
    deny("ADMISSION_REQUEST_CHANGED", "tool request content changed after model admission");
  }
  if (Array.isArray(currentBinding.deniedTools) && currentBinding.deniedTools.includes(toolName)) {
    deny("ADMISSION_TOOL_DENIED", "tool is denied by the current runtime binding");
  }
  return Object.freeze({
    ...admission,
    phase: "tool",
    toolName,
  });
}

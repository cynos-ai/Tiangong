import { AdmissionDeniedError } from "./admission-boundary.mjs";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 5000;

function deny(code, message) {
  throw new AdmissionDeniedError(code, message);
}

function boundedString(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    deny("ADMISSION_CONTEXT_INVALID", `${name} is missing or exceeds the bounded limit`);
  }
  return value;
}

function normalizeContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    deny("ADMISSION_CONTEXT_INVALID", "Control API admission response must be an object");
  }
  if (!value.source || !value.binding || !value.request) {
    deny("ADMISSION_CONTEXT_INVALID", "Control API admission response is incomplete");
  }
  boundedString(value.request.workerName, "request.workerName");
  boundedString(value.request.runtimeLane, "request.runtimeLane");
  boundedString(value.request.turnId, "request.turnId");
  boundedString(value.request.requestDigest, "request.requestDigest");
  boundedString(value.request.configRevision, "request.configRevision");
  boundedString(value.request.capabilityRevision, "request.capabilityRevision");
  return {
    source: value.source,
    binding: value.binding,
    request: value.request,
  };
}

export function createControlAdmissionResolver({
  url,
  fetchImpl = globalThis.fetch,
  timeoutMs = 1500,
  headers = {},
} = {}) {
  if (typeof url !== "string" || url.length === 0) {
    throw new TypeError("Control API admission URL is required");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError("Control API admission timeout is outside the bounded range");
  }
  let endpoint;
  try {
    endpoint = new URL(url);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("unsafe URL");
    }
  } catch {
    throw new TypeError("Control API admission URL is invalid");
  }

  return async ({ phase, event, ctx } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", ...headers },
        body: JSON.stringify({ phase, event, context: ctx }),
        signal: controller.signal,
      });
      if (!response || response.ok !== true) {
        deny("ADMISSION_CONTEXT_UNAVAILABLE", "Control API did not admit this turn");
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        deny("ADMISSION_CONTEXT_INVALID", "Control API admission response is too large");
      }
      let value;
      try { value = JSON.parse(text); } catch { deny("ADMISSION_CONTEXT_INVALID", "Control API admission response is not JSON"); }
      return normalizeContext(value);
    } catch (error) {
      if (error instanceof AdmissionDeniedError) throw error;
      deny(error?.name === "AbortError" ? "ADMISSION_CONTEXT_TIMEOUT" : "ADMISSION_CONTEXT_UNAVAILABLE", "Control API admission failed");
    } finally {
      clearTimeout(timer);
    }
  };
}

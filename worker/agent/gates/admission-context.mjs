import { AdmissionDeniedError } from "./admission-boundary.mjs";
import { normalizeAdmissionContext, normalizeAdmissionToolContext } from "./admission-context-file.mjs";

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

function summarizeHookInput({ phase, event = {}, ctx = {} } = {}) {
  const bounded = (value) => typeof value === "string" ? value.slice(0, 128) : null;
  return {
    phase: bounded(phase),
    event: phase === "tool"
      ? {
        toolName: bounded(event.toolName),
        toolCallId: bounded(event.toolCallId),
        sessionKey: bounded(event.sessionKey),
        messageId: bounded(event.messageId ?? event.eventId),
      }
      : {
        channel: bounded(event.channel),
        route: bounded(event.route),
        sessionKey: bounded(event.sessionKey),
        senderId: bounded(event.senderId),
        messageId: bounded(event.messageId ?? event.eventId ?? event.currentMessageId),
        contentLength: typeof event.content === "string" ? event.content.length : null,
        timestamp: Number.isSafeInteger(event.timestamp) ? event.timestamp : null,
      },
    context: {
      channelId: bounded(ctx.channelId),
      conversationId: bounded(ctx.conversationId),
      sessionKey: bounded(ctx.sessionKey),
      senderId: bounded(ctx.senderId),
      messageId: bounded(ctx.messageId ?? ctx.eventId ?? ctx.currentMessageId),
      route: bounded(ctx.route),
    },
  };
}

export function createControlAdmissionResolver({
  url,
  fetchImpl = globalThis.fetch,
  timeoutMs = 1500,
  headers = {},
  workerName = process.env.AGENTTEAMS_WORKER_NAME,
  runtimeLane = process.env.TIANGONG_RUNTIME_LANE,
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
        body: JSON.stringify({ admission: {
          ...summarizeHookInput({ phase, event, ctx }),
          ...(typeof workerName === "string" && workerName !== "" ? { workerName } : {}),
          ...(typeof runtimeLane === "string" && runtimeLane !== "" ? { runtimeLane } : {}),
        } }),
        signal: controller.signal,
      });
      if (!response || response.ok !== true) {
        let code = "ADMISSION_CONTEXT_UNAVAILABLE";
        try {
          const failureText = await response.text();
          const failure = JSON.parse(failureText);
          if (typeof failure?.error === "string" && /^ADMISSION_[A-Z0-9_]{1,63}$/u.test(failure.error)) code = failure.error;
        } catch {
          // Preserve the bounded unavailable code when a failure body is malformed.
        }
        deny(code, "Control API did not admit this turn");
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        deny("ADMISSION_CONTEXT_INVALID", "Control API admission response is too large");
      }
      let value;
      try { value = JSON.parse(text); } catch { deny("ADMISSION_CONTEXT_INVALID", "Control API admission response is not JSON"); }
      return phase === "tool" ? normalizeAdmissionToolContext(value) : normalizeAdmissionContext(value);
    } catch (error) {
      if (error instanceof AdmissionDeniedError) throw error;
      deny(error?.name === "AbortError" ? "ADMISSION_CONTEXT_TIMEOUT" : "ADMISSION_CONTEXT_UNAVAILABLE", "Control API admission failed");
    } finally {
      clearTimeout(timer);
    }
  };
}

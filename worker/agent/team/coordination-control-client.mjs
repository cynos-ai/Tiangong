import { parseLeaderResumeEvent } from "./leader-resume.mjs";

const MATRIX_EVENT_ID = /^\$[^\s]{1,255}$/u;
const MATRIX_ROOM_ID = /^![^\s]{1,255}$/u;
const MAX_RESPONSE_BYTES = 64 * 1024;

function endpointUrl(value) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("Coordination control endpoint is required");
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/v1/coordination/admit") {
    throw new TypeError("Coordination control endpoint must be a credential-free /v1/coordination/admit URL");
  }
  return parsed.href;
}

function controlOrigin(value) {
  const url = new URL(endpointUrl(value));
  return url.origin;
}

function controlPath(origin, path) {
  return `${origin}${path}`;
}

function tokenValue(value) {
  if (typeof value !== "string" || value.length < 16 || value.length > 512 || /\s/u.test(value)) throw new TypeError("Coordination control token is invalid");
  return value;
}

function required(value, name, pattern) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) throw new TypeError(`${name} is missing or invalid`);
  return value;
}

async function responseBody(response) {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Coordination control response exceeds the bounded contract");
  try { return text === "" ? {} : JSON.parse(text); } catch { throw new Error("Coordination control response is not valid JSON"); }
}

async function controlRequest({ fetchImpl, url, token, method = "GET", body } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const value = await responseBody(response);
  if (!response.ok) {
    const code = typeof value?.error === "string" && /^[A-Z0-9_:-]{1,96}$/u.test(value.error) ? value.error : "REMOTE_COORDINATION_FAILED";
    const error = new Error(`Coordination control rejected the request: ${code}`);
    error.code = code;
    throw error;
  }
  return value;
}

/**
 * Worker-side adapter for the deployment-owned Coordination Control API.
 * The Worker reads the event through its authenticated Matrix channel, then
 * sends only the bounded proof and never receives a database handle.
 */
export function createRemoteOpenClawLeaderAdmissionHook({ channel, endpoint, token, fetchImpl = globalThis.fetch } = {}) {
  if (!channel || typeof channel.readHumanEvent !== "function") throw new TypeError("Remote Leader admission requires a bound Matrix channel");
  if (typeof fetchImpl !== "function") throw new TypeError("Remote Leader admission requires fetch");
  const url = endpointUrl(endpoint);
  const origin = controlOrigin(url);
  const bearer = tokenValue(token);
  return async function remoteLeaderAdmission(context = {}) {
    const roomId = required(context.roomId, "context.roomId", MATRIX_ROOM_ID);
    const eventId = required(context.eventId, "context.eventId", MATRIX_EVENT_ID);
    const event = await channel.readHumanEvent(roomId, eventId);
    const isResume = parseLeaderResumeEvent(event) !== null;
    return controlRequest({
      fetchImpl,
      url: isResume ? controlPath(origin, "/v1/coordination/resume") : url,
      token: bearer,
      method: "POST",
      body: { source: context.source, event },
    });
  };
}

/**
 * HTTP-backed CoordinationStore facade for OpenClaw Worker coordination. It
 * implements bounded Task/Result writes plus the read/claim/ack methods needed
 * by the native Leader/member hooks; the Worker still has no database
 * connection or Team binding authority.
 */
export function createRemoteCoordinationStore({ endpoint, token, fetchImpl = globalThis.fetch, memberId } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Remote CoordinationStore requires fetch");
  const origin = controlOrigin(endpoint);
  const bearer = tokenValue(token);
  const actorId = memberId === undefined ? undefined : required(memberId, "memberId");
  return Object.freeze({
    async createTask({ task, actorId: requestedActorId, expectedEpoch, requestId } = {}) {
      return controlRequest({ fetchImpl, token: bearer, url: `${origin}/v1/coordination/tasks`, method: "POST", body: { task, actorId: requestedActorId ?? actorId, expectedEpoch, requestId } });
    },
    async submitResult({ result, actorId: requestedActorId, expectedEpoch, requestId } = {}) {
      return controlRequest({ fetchImpl, token: bearer, url: `${origin}/v1/coordination/results`, method: "POST", body: { result, actorId: requestedActorId ?? actorId, expectedEpoch, requestId } });
    },
    async getWork(workId) {
      const value = await controlRequest({ fetchImpl, token: bearer, url: `${origin}/v1/coordination/works/${encodeURIComponent(required(workId, "workId"))}` });
      return value.work;
    },
    async getTask(taskId) {
      const value = await controlRequest({ fetchImpl, token: bearer, url: `${origin}/v1/coordination/tasks/${encodeURIComponent(required(taskId, "taskId"))}` });
      return value.task;
    },
    async getResult(resultId) {
      const value = await controlRequest({ fetchImpl, token: bearer, url: `${origin}/v1/coordination/results/${encodeURIComponent(required(resultId, "resultId"))}` });
      return value.result;
    },
    async listOutbox({ status } = {}) {
      const query = status === undefined ? "" : `?status=${encodeURIComponent(status)}`;
      const value = await controlRequest({ fetchImpl, token: bearer, url: `${origin}/v1/coordination/wakes${query}` });
      if (!Array.isArray(value.wakes)) throw new Error("Coordination control wakes response is invalid");
      return value.wakes;
    },
    async claimWake({ wakeId, consumerId, requestId } = {}) {
      return controlRequest({ fetchImpl, token: bearer, url: `${origin}/v1/coordination/wakes/claim`, method: "POST", body: { wakeId, consumerId, requestId } });
    },
    async ackWake({ wakeId, consumerId, receiptId, requestId } = {}) {
      return controlRequest({ fetchImpl, token: bearer, url: `${origin}/v1/coordination/wakes/ack`, method: "POST", body: { wakeId, consumerId, receiptId, requestId } });
    },
  });
}

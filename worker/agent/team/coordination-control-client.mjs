import { parseLeaderResumeEvent } from "./leader-resume.mjs";

const MATRIX_EVENT_ID = /^\$[^\s]{1,255}$/u;
const MATRIX_ROOM_ID = /^![^\s]{1,255}$/u;
const MAX_RESPONSE_BYTES = 64 * 1024;

function endpointUrl(value) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("Coordination control endpoint is required");
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/v1/coordination/admit") throw new TypeError("Coordination control endpoint must be a credential-free /v1/coordination/admit URL");
  return parsed.href;
}
function origin(value) { return new URL(endpointUrl(value)).origin; }
function tokenValue(value) { if (typeof value !== "string" || value.length < 16 || value.length > 512 || /\s/u.test(value)) throw new TypeError("Coordination control token is invalid"); return value; }
function required(value, name, pattern) { if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) throw new TypeError(`${name} is missing or invalid`); return value; }
async function responseBody(response) { const text = await response.text(); if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Coordination response exceeds the bounded contract"); try { return text ? JSON.parse(text) : {}; } catch { throw new Error("Coordination response is not valid JSON"); } }
async function request({ fetchImpl, url, token, method = "GET", body } = {}) {
  const response = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const value = await responseBody(response);
  if (!response.ok) { const code = typeof value?.error === "string" && /^[A-Z0-9_:-]{1,96}$/u.test(value.error) ? value.error : "REMOTE_COORDINATION_FAILED"; throw Object.assign(new Error(`Coordination control rejected the request: ${code}`), { code }); }
  return value;
}

export function createRemoteOpenClawLeaderAdmissionHook({ channel, endpoint, token, fetchImpl = globalThis.fetch } = {}) {
  if (!channel || typeof channel.readHumanEvent !== "function") throw new TypeError("Remote Leader admission requires a bound Matrix channel");
  const base = origin(endpoint); const bearer = tokenValue(token);
  return async function remoteLeaderAdmission(context = {}) {
    const roomId = required(context.roomId, "context.roomId", MATRIX_ROOM_ID); const eventId = required(context.eventId, "context.eventId", MATRIX_EVENT_ID);
    const event = await channel.readHumanEvent(roomId, eventId); const resume = parseLeaderResumeEvent(event) !== null;
    return request({ fetchImpl, url: `${base}${resume ? "/v1/coordination/resume" : "/v1/coordination/admit"}`, token: bearer, method: "POST", body: { source: context.source, event } });
  };
}

export function createRemoteCoordinationStore({ endpoint, token, fetchImpl = globalThis.fetch, memberId } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Remote CoordinationStore requires fetch");
  const base = origin(endpoint); const bearer = tokenValue(token); const actor = memberId === undefined ? undefined : required(memberId, "memberId");
  const get = (path) => request({ fetchImpl, token: bearer, url: `${base}${path}` });
  const post = (path, body) => request({ fetchImpl, token: bearer, url: `${base}${path}`, method: "POST", body });
  return Object.freeze({
    async listWorks({ status } = {}) { const value = await get(`/v1/coordination/works${status ? `?status=${encodeURIComponent(status)}` : ""}`); return value.works; },
    async getWork(workId) { return (await get(`/v1/coordination/works/${encodeURIComponent(required(workId, "workId"))}`)).work; },
    async changeWorkTitle({ workId, title, actorId, expectedEpoch, requestId }) { return post(`/v1/coordination/works/${encodeURIComponent(workId)}/title`, { title, actorId: actorId ?? actor, expectedEpoch, requestId }); },
    async changeWorkSpec({ workId, spec, actorId, expectedEpoch, requestId }) { return post(`/v1/coordination/works/${encodeURIComponent(workId)}/spec`, { spec, actorId: actorId ?? actor, expectedEpoch, requestId }); },
    async changeWorkPlan({ workId, planRef, reason, actorId, expectedEpoch, requestId }) { return post(`/v1/coordination/works/${encodeURIComponent(workId)}/plan`, { planRef, reason, actorId: actorId ?? actor, expectedEpoch, requestId }); },
    async closeWork({ workId, action, reason, actorId, expectedEpoch, requestId }) { return post(`/v1/coordination/works/${encodeURIComponent(workId)}/close`, { action, reason, actorId: actorId ?? actor, expectedEpoch, requestId }); },
    async listMessageAdmissions({ status } = {}) { return get(`/v1/coordination/admissions${status ? `?status=${encodeURIComponent(status)}` : ""}`); },
    async routeMessage({ eventId, targetWorkId, title, expectedEpoch, actorId, requestId }) { return post("/v1/coordination/admissions/route", { eventId, ...(targetWorkId ? { targetWorkId } : {}), ...(title ? { title } : {}), ...(expectedEpoch !== undefined ? { expectedEpoch } : {}), actorId: actorId ?? actor, requestId }); },
    async correctMessageAssociation(input) { return post("/v1/coordination/admissions/correct", { ...input, actorId: input.actorId ?? actor }); },
    async recordAdmissionFailure({ eventId, errorCode, actorId, requestId }) { return post("/v1/coordination/admissions/failure", { eventId, errorCode, actorId: actorId ?? actor, requestId }); },
    async createTask({ task, actorId, expectedEpoch, requestId }) { return post("/v1/coordination/tasks", { task, actorId: actorId ?? actor, expectedEpoch, requestId }); },
    async cancelTask({ workId, taskId, reason, actorId, expectedEpoch, requestId }) { return post(`/v1/coordination/tasks/${encodeURIComponent(taskId)}/cancel`, { workId, reason, actorId: actorId ?? actor, expectedEpoch, requestId }); },
    async getTask(taskId) { return (await get(`/v1/coordination/tasks/${encodeURIComponent(required(taskId, "taskId"))}`)).task; },
    async submitResult({ result, actorId, expectedEpoch, requestId }) { return post("/v1/coordination/results", { result, actorId: actorId ?? actor, expectedEpoch, requestId }); },
    async getResult(taskId) { return (await get(`/v1/coordination/tasks/${encodeURIComponent(required(taskId, "taskId"))}/result`)).result; },
    async listOutbox({ status } = {}) { return (await get(`/v1/coordination/wakes${status ? `?status=${encodeURIComponent(status)}` : ""}`)).wakes; },
    async claimWake(body) { return post("/v1/coordination/wakes/claim", body); },
    async ackWake(body) { return post("/v1/coordination/wakes/ack", body); },
  });
}

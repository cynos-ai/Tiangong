import { canonicalJson, sha256 } from "../../worker/agent/canonical-json.mjs";
import { drainLeaderOutbox } from "../../worker/agent/team/leader-outbox.mjs";
import { leaderResumeEventBody } from "../../worker/agent/team/leader-resume.mjs";

const MATRIX_USER_ID = /^@[A-Za-z0-9._=+\/-]+:[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u;
const MATRIX_ROOM_ID = /^![^\s]{1,255}$/u;
const MATRIX_EVENT_ID = /^\$[^\s]{1,255}$/u;
const ID = /^[A-Za-z0-9@!#$%&*+./:=?_-]{1,160}$/u;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_INTERVAL_MS = 60_000;

function required(value, name, pattern) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) throw new TypeError(`${name} is missing or invalid`);
  return value;
}

function serviceBaseUrl(value) {
  const parsed = new URL(required(value, "matrixUrl"));
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new TypeError("matrixUrl must be a credential-free HTTP(S) URL");
  return parsed.href.replace(/\/$/u, "");
}

function errorCode(error, fallback = "MATRIX_WAKE_DELIVERY_FAILED") {
  return typeof error?.code === "string" && /^[A-Z0-9_:-]{1,96}$/u.test(error.code) ? error.code : fallback;
}

async function request({ fetchImpl, baseUrl, token, method, path, body } = {}) {
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw Object.assign(new Error("Matrix response exceeds the bounded contract"), { code: "MATRIX_RESPONSE_TOO_LARGE" });
  let value = {};
  if (text !== "") {
    try { value = JSON.parse(text); } catch { throw Object.assign(new Error("Matrix response is not valid JSON"), { code: "MATRIX_RESPONSE_INVALID" }); }
  }
  if (!response.ok) throw Object.assign(new Error(`Matrix request failed with HTTP ${response.status}`), { code: `MATRIX_HTTP_${response.status}` });
  return value;
}

function joinedMembers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.joined || typeof value.joined !== "object" || Array.isArray(value.joined)) throw Object.assign(new Error("Matrix joined-members response is invalid"), { code: "MATRIX_ROSTER_INVALID" });
  const ids = Object.keys(value.joined);
  if (ids.length > 128 || ids.some((id) => !MATRIX_USER_ID.test(id))) throw Object.assign(new Error("Matrix joined-members response is outside the bounded contract"), { code: "MATRIX_ROSTER_INVALID" });
  return new Set(ids);
}

function workAdmittedBody({ workId, sourceEventId, targetMatrixUserId }) {
  required(workId, "workId", ID);
  required(sourceEventId, "sourceEventId", MATRIX_EVENT_ID);
  required(targetMatrixUserId, "targetMatrixUserId", MATRIX_USER_ID);
  return {
    msgtype: "m.text",
    body: `${targetMatrixUserId} Tiangong Work admitted: work=${workId}. Read the durable Work facts before the next coordination action.`,
    "m.mentions": { user_ids: [targetMatrixUserId] },
    "com.tiangong.work": { version: 1, work_id: workId, source_event_id: sourceEventId },
  };
}

function transactionId(wake, roomId, targetMatrixUserId) {
  return `tiangong_coord_${sha256(canonicalJson({ kind: wake.kind, wakeId: wake.wakeId, workId: wake.workId ?? null, roomId, targetMatrixUserId }))}`;
}

/**
 * Deployment-owned PG outbox consumer. It is deliberately separate from the
 * Worker image: only this process receives the Matrix and database secrets.
 */
export function createMatrixWakeConsumer({
  store,
  binding,
  matrixUrl,
  matrixToken,
  consumerId = "tiangong-coordination-matrix",
  intervalMs = 2_000,
  maxEntries = 32,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!store || typeof store.getWork !== "function" || typeof store.listOutbox !== "function" || typeof store.claimWake !== "function" || typeof store.ackWake !== "function") throw new TypeError("Matrix wake consumer requires a CoordinationStore");
  if (!binding?.team || !binding.route || !binding.leaderMember) throw new TypeError("Matrix wake consumer requires a Leader runtime binding");
  const baseUrl = serviceBaseUrl(matrixUrl);
  const token = required(matrixToken, "matrixToken");
  required(consumerId, "consumerId", ID);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > MAX_INTERVAL_MS) throw new TypeError("intervalMs is outside the bounded range");
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 32) throw new TypeError("maxEntries is outside the bounded range");
  if (typeof fetchImpl !== "function") throw new TypeError("Matrix wake consumer requires fetch");
  const roomId = required(binding.route.roomId, "binding.route.roomId", MATRIX_ROOM_ID);
  const leaderMatrixUserId = required(binding.leaderMember.matrixUserId, "binding.leaderMember.matrixUserId", MATRIX_USER_ID);
  let timer;
  let running = false;
  let identityReady = false;
  let lastRunAt = null;
  let lastResult = null;
  let lastErrorCode = null;

  async function assertIdentity() {
    const who = await request({ fetchImpl, baseUrl, token, method: "GET", path: "/_matrix/client/v3/account/whoami" });
    if (who?.user_id !== leaderMatrixUserId) throw Object.assign(new Error("Matrix token is not bound to the configured Leader"), { code: "MATRIX_IDENTITY_MISMATCH" });
    const roster = joinedMembers(await request({ fetchImpl, baseUrl, token, method: "GET", path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members` }));
    if (!roster.has(leaderMatrixUserId)) throw Object.assign(new Error("Configured Leader is not joined to the Team room"), { code: "MATRIX_LEADER_NOT_JOINED" });
    identityReady = true;
  }

  async function send(wake) {
    const work = wake.workId ? await store.getWork(wake.workId) : undefined;
    let body;
    if (wake.kind === "leader-resume") {
      if (!work?.work || wake.targetMemberId !== binding.leaderMember.memberId || work.work.teamId !== binding.team.teamId || work.work.routeId !== binding.route.routeId) throw Object.assign(new Error("Leader resume wake is not bound to the current Team"), { code: "MATRIX_WAKE_BINDING_MISMATCH" });
      body = leaderResumeEventBody({ wakeId: wake.wakeId, workId: wake.workId, targetMemberId: wake.targetMemberId, targetMatrixUserId: leaderMatrixUserId });
    } else if (wake.kind === "human-reply") {
      if (!work?.work || wake.targetMemberId !== work.work.actorId || work.work.teamId !== binding.team.teamId || work.work.routeId !== binding.route.routeId) throw Object.assign(new Error("Human reply wake is not bound to the current Work"), { code: "MATRIX_WAKE_BINDING_MISMATCH" });
      body = workAdmittedBody({ workId: work.work.workId, sourceEventId: work.work.sourceEventId, targetMatrixUserId: leaderMatrixUserId });
    } else {
      throw Object.assign(new Error("Unsupported Matrix wake kind"), { code: "MATRIX_WAKE_KIND_UNSUPPORTED" });
    }
    const tx = transactionId(wake, roomId, leaderMatrixUserId);
    const response = await request({ fetchImpl, baseUrl, token, method: "PUT", path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${tx}`, body });
    if (!MATRIX_EVENT_ID.test(response?.event_id ?? "")) throw Object.assign(new Error("Matrix send response did not contain a valid event ID"), { code: "MATRIX_SEND_RESPONSE_INVALID" });
    return { receiptId: tx, eventIdDigest: sha256(response.event_id) };
  }

  async function drainOnce() {
    if (!identityReady) await assertIdentity();
    const result = await drainLeaderOutbox({
      store,
      consumerId,
      maxEntries,
      handlers: {
        "leader-resume": send,
        "human-reply": send,
      },
    });
    lastRunAt = new Date().toISOString();
    lastResult = result;
    lastErrorCode = null;
    return result;
  }

  async function tick() {
    try { await drainOnce(); } catch (error) { lastErrorCode = errorCode(error); }
  }

  return Object.freeze({
    async start() {
      if (running) return;
      await assertIdentity();
      running = true;
      await tick();
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
    },
    async stop() {
      running = false;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    drainOnce,
    health() {
      return { running, identityReady, lastRunAt, lastErrorCode, lastResult };
    },
  });
}

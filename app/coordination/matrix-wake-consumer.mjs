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

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function visibleMatrixMention(targetMatrixUserId) {
  const localpart = targetMatrixUserId.slice(1, targetMatrixUserId.indexOf(":"));
  const href = `https://matrix.to/#/${encodeURIComponent(targetMatrixUserId)}`;
  return `<a href="${href}">@${escapeHtml(localpart)}</a>`;
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
  const mention = visibleMatrixMention(targetMatrixUserId);
  return {
    msgtype: "m.text",
    body: `${targetMatrixUserId} Tiangong Work admitted: work=${workId}. Read the durable Work facts before the next coordination action.`,
    format: "org.matrix.custom.html",
    formatted_body: `${mention} Tiangong Work admitted: work=${escapeHtml(workId)}. Read the durable Work facts before the next coordination action.`,
    "m.mentions": { user_ids: [targetMatrixUserId] },
    "com.tiangong.work": { version: 1, work_id: workId, source_event_id: sourceEventId },
  };
}

function taskAssignedBody({ taskId, workId, targetMatrixUserId }) {
  required(taskId, "taskId", ID);
  required(workId, "workId", ID);
  required(targetMatrixUserId, "targetMatrixUserId", MATRIX_USER_ID);
  const mention = visibleMatrixMention(targetMatrixUserId);
  return {
    msgtype: "m.text",
    body: `${targetMatrixUserId} Tiangong Task assigned: work=${workId} task=${taskId}. Read the immutable TaskSpec and submit one Result.`,
    format: "org.matrix.custom.html",
    formatted_body: `${mention} Tiangong Task assigned: work=${escapeHtml(workId)} task=${escapeHtml(taskId)}. Read the immutable TaskSpec and submit one Result.`,
    "m.mentions": { user_ids: [targetMatrixUserId] },
    "com.tiangong.task": { version: 1, work_id: workId, task_id: taskId },
  };
}

function resultSubmittedBody({ taskId, workId, resultDigest, targetMatrixUserId }) {
  required(taskId, "taskId", ID);
  required(workId, "workId", ID);
  required(resultDigest, "resultDigest", /^[a-f0-9]{64}$/u);
  required(targetMatrixUserId, "targetMatrixUserId", MATRIX_USER_ID);
  const mention = visibleMatrixMention(targetMatrixUserId);
  return {
    msgtype: "m.text",
    body: `${targetMatrixUserId} Tiangong Result submitted: work=${workId} task=${taskId}. Review the durable Result.`,
    format: "org.matrix.custom.html",
    formatted_body: `${mention} Tiangong Result submitted: work=${escapeHtml(workId)} task=${escapeHtml(taskId)}. Review the durable Result.`,
    "m.mentions": { user_ids: [targetMatrixUserId] },
    "com.tiangong.result": { version: 1, work_id: workId, task_id: taskId, result_digest: resultDigest },
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
  if (!binding?.team || !binding.route || !binding.leaderMember || !Array.isArray(binding.members)) throw new TypeError("Matrix wake consumer requires a Leader runtime binding");
  const baseUrl = serviceBaseUrl(matrixUrl);
  const token = required(matrixToken, "matrixToken");
  required(consumerId, "consumerId", ID);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > MAX_INTERVAL_MS) throw new TypeError("intervalMs is outside the bounded range");
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 32) throw new TypeError("maxEntries is outside the bounded range");
  if (typeof fetchImpl !== "function") throw new TypeError("Matrix wake consumer requires fetch");
  const roomId = required(binding.route.roomId, "binding.route.roomId", MATRIX_ROOM_ID);
  const leaderMatrixUserId = required(binding.leaderMember.matrixUserId, "binding.leaderMember.matrixUserId", MATRIX_USER_ID);
  const membersById = new Map(binding.members.map((member) => [member.memberId, member]));
  if (membersById.size !== binding.members.length || binding.members.some((member) => member.teamId !== binding.team.teamId)) throw new TypeError("Matrix wake consumer member binding is invalid");
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

  async function recipientMatrixUserId(memberId) {
    const member = membersById.get(memberId);
    if (!member || !member.enabled) throw Object.assign(new Error("Wake target is not an enabled Team member"), { code: "MATRIX_WAKE_TARGET_INVALID" });
    const target = required(member.matrixUserId, "wake target matrix user", MATRIX_USER_ID);
    const roster = joinedMembers(await request({ fetchImpl, baseUrl, token, method: "GET", path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members` }));
    if (!roster.has(target)) throw Object.assign(new Error("Wake target is not joined to the Team room"), { code: "MATRIX_WAKE_TARGET_NOT_JOINED" });
    return target;
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
    } else if (wake.kind === "task-assignment") {
      if (!work?.work || !wake.taskId || work.work.teamId !== binding.team.teamId || work.work.routeId !== binding.route.routeId || wake.targetMemberId === binding.team.leaderMemberId) throw Object.assign(new Error("Task assignment wake is not bound to the current Team"), { code: "MATRIX_WAKE_BINDING_MISMATCH" });
      if (typeof store.getTask !== "function") throw Object.assign(new Error("Task assignment requires task reads"), { code: "MATRIX_TASK_GATEWAY_UNAVAILABLE" });
      const task = await store.getTask(wake.taskId);
      if (!task?.spec || task.spec.workId !== wake.workId || task.spec.assigneeMemberId !== wake.targetMemberId) throw Object.assign(new Error("Task assignment wake does not match its TaskSpec"), { code: "MATRIX_WAKE_BINDING_MISMATCH" });
      body = taskAssignedBody({ taskId: wake.taskId, workId: wake.workId, targetMatrixUserId: await recipientMatrixUserId(wake.targetMemberId) });
    } else if (wake.kind === "result-notification") {
      if (!work?.work || wake.targetMemberId !== binding.team.leaderMemberId || work.work.teamId !== binding.team.teamId || work.work.routeId !== binding.route.routeId) throw Object.assign(new Error("Result notification wake is not bound to the current Team"), { code: "MATRIX_WAKE_BINDING_MISMATCH" });
      if (typeof store.getTask !== "function") throw Object.assign(new Error("Result notification requires task reads"), { code: "MATRIX_RESULT_GATEWAY_UNAVAILABLE" });
      const task = await store.getTask(wake.taskId);
      if (!task?.result || task.spec.workId !== wake.workId) throw Object.assign(new Error("Result notification wake has no matching Result"), { code: "MATRIX_WAKE_BINDING_MISMATCH" });
      body = resultSubmittedBody({ taskId: wake.taskId, workId: wake.workId, resultDigest: task.result.contentDigest, targetMatrixUserId: leaderMatrixUserId });
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
        "task-assignment": send,
        "result-notification": send,
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

import { sha256 } from "../canonical-json.mjs";

const MATRIX_USER_ID = /^@[A-Za-z0-9._=+\/-]+:[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u;
const MATRIX_EVENT_ID = /^\$[^\s]{1,255}$/u;
const MATRIX_ROOM_ID = /^![^\s]{1,255}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9@!#$%&*+./:=?_-]{1,160}$/u;
const MAX_BODY_BYTES = 4096;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function required(value, name, pattern) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new TypeError(`${name} is missing or invalid`);
  }
  return value;
}

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("LEADER_RESUME_ENVELOPE_INVALID", `${name} must be an object`);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail("LEADER_RESUME_ENVELOPE_INVALID", `${name} contains unknown fields`);
}

/**
 * Extract the closed, machine-authored Leader resume envelope. A normal
 * human Matrix message returns null; a malformed control envelope fails
 * closed so it cannot be mistaken for a new Work request.
 */
export function parseLeaderResumeEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const content = event.content;
  if (!content || typeof content !== "object" || Array.isArray(content) || content["com.tiangong.leader-resume"] === undefined) return null;
  required(event.eventId, "event.eventId", MATRIX_EVENT_ID);
  required(event.roomId, "event.roomId", MATRIX_ROOM_ID);
  required(event.sender, "event.sender", MATRIX_USER_ID);
  if (event.type !== "m.room.message" || content.msgtype !== "m.text" ||
      typeof content.body !== "string" || content.body.length === 0 ||
      Buffer.byteLength(content.body) > MAX_BODY_BYTES || /[\u0000\r\n]/u.test(content.body)) {
    fail("LEADER_RESUME_EVENT_INVALID", "Leader resume must be a bounded Matrix text event");
  }
  const envelope = content["com.tiangong.leader-resume"];
  exactKeys(envelope, new Set(["version", "wake_id", "work_id", "target_member_id"]), "Leader resume envelope");
  if (envelope.version !== 1 || !DIGEST.test(envelope.wake_id ?? "") || !ID.test(envelope.work_id ?? "") || !ID.test(envelope.target_member_id ?? "")) {
    fail("LEADER_RESUME_ENVELOPE_INVALID", "Leader resume envelope fields are invalid");
  }
  return Object.freeze({
    version: 1,
    wakeId: envelope.wake_id,
    workId: envelope.work_id,
    targetMemberId: envelope.target_member_id,
    eventId: event.eventId,
    roomId: event.roomId,
    sender: event.sender,
  });
}

export function leaderResumeEventBody({ wakeId, workId, targetMemberId, targetMatrixUserId } = {}) {
  required(wakeId, "wakeId", DIGEST);
  required(workId, "workId", ID);
  required(targetMemberId, "targetMemberId", ID);
  required(targetMatrixUserId, "targetMatrixUserId", MATRIX_USER_ID);
  const target = `<a href="https://matrix.to/#/${targetMatrixUserId}">${targetMatrixUserId.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")}</a>`;
  return Object.freeze({
    msgtype: "m.text",
    body: `Tiangong Leader resume requested: work=${workId}. Read the durable Work facts before taking the next coordination action.`,
    format: "org.matrix.custom.html",
    formatted_body: `${target} Tiangong Leader resume requested: work=${workId}. Read the durable Work facts before taking the next coordination action.`,
    "m.mentions": { user_ids: [targetMatrixUserId] },
    "com.tiangong.leader-resume": {
      version: 1,
      wake_id: wakeId,
      work_id: workId,
      target_member_id: targetMemberId,
    },
  });
}

/**
 * Validate a Matrix control event that was re-read by the authenticated
 * Leader Worker, then return only the durable facts needed to resume the
 * Leader turn. This endpoint never creates a Work.
 */
export async function resumeLeaderMatrixEvent({ store, source, event, team, route, leaderMember } = {}) {
  if (!store || typeof store.getWork !== "function" || typeof store.getWake !== "function") {
    throw new TypeError("Leader resume requires a CoordinationStore with Work and wake reads");
  }
  if (!source || source.authenticated !== true || source.channel !== "matrix") fail("LEADER_RESUME_SOURCE_INVALID", "Leader resume source must be authenticated Matrix traffic");
  if (source.messageId !== event?.eventId || source.actorId !== event?.sender || source.route !== "team-room") {
    fail("LEADER_RESUME_SOURCE_MISMATCH", "Leader resume source does not match the Matrix event");
  }
  const envelope = parseLeaderResumeEvent(event);
  if (!envelope) fail("LEADER_RESUME_EVENT_INVALID", "Leader resume control envelope is required");
  if (!team || !route || !leaderMember || route.teamId !== team.teamId || leaderMember.teamId !== team.teamId ||
      leaderMember.memberId !== team.leaderMemberId || leaderMember.enabled !== true) {
    fail("LEADER_RESUME_BINDING_INVALID", "Current Team route and Leader binding are invalid");
  }
  if (envelope.roomId !== route.roomId || envelope.sender !== leaderMember.matrixUserId || envelope.targetMemberId !== leaderMember.memberId) {
    fail("LEADER_RESUME_BINDING_MISMATCH", "Leader resume event is not bound to the current Leader and Team room");
  }
  const work = await store.getWork(envelope.workId);
  if (!work?.work || work.work.teamId !== team.teamId || work.work.routeId !== route.routeId || work.work.leaderSessionId === undefined) {
    fail("LEADER_RESUME_WORK_NOT_FOUND", "Leader resume Work is not bound to the current Team");
  }
  const wake = await store.getWake(envelope.wakeId);
  if (!wake || wake.kind !== "leader-resume" || wake.workId !== envelope.workId || wake.targetMemberId !== leaderMember.memberId) {
    fail("LEADER_RESUME_WAKE_MISMATCH", "Leader resume wake is not bound to the current Work");
  }
  if (!["pending", "claimed", "acked"].includes(wake.status)) fail("LEADER_RESUME_WAKE_INVALID", "Leader resume wake has an invalid state");
  return Object.freeze({
    resumed: true,
    workId: envelope.workId,
    wakeId: envelope.wakeId,
    wakeStatus: wake.status,
    leaderSessionId: work.work.leaderSessionId,
    work: Object.freeze({
      workId: work.work.workId,
      teamId: work.work.teamId,
      routeId: work.work.routeId,
      status: work.status,
      epoch: work.epoch,
      currentWorkSpec: work.currentWorkSpec,
    }),
    eventIdDigest: sha256(envelope.eventId),
  });
}

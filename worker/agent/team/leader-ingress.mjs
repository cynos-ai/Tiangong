import { sha256 } from "../canonical-json.mjs";

import { admitHumanMatrixEvent } from "./leader-admission.mjs";

const MATRIX_EVENT_ID = /^\$[^\s]{1,255}$/u;
const MATRIX_ROOM_ID = /^![^\s]{1,255}$/u;

function required(value, name, pattern) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new TypeError(`${name} is missing or invalid`);
  }
  return value;
}

function boundedErrorCode(error) {
  const code = error?.code;
  return typeof code === "string" && /^[A-Z0-9_:-]{1,96}$/u.test(code) ? code : "MATRIX_REPLY_FAILED";
}

/**
 * Resolve one authenticated Matrix event, admit it into the durable Work
 * store, and attempt the visible reply. A reply failure does not roll back
 * Work: the store already contains a durable human-reply wake, so the caller
 * can retry delivery without admitting a second Work.
 */
export async function admitLeaderMatrixIngress({
  channel,
  store,
  source,
  roomId,
  eventId,
  team,
  route,
  profile,
  leaderMember,
  members = [],
  leaderSessionId,
  now,
} = {}) {
  if (!channel || typeof channel.readHumanEvent !== "function" || typeof channel.notifyWorkAdmitted !== "function") {
    throw new TypeError("Leader ingress requires a bound Matrix channel");
  }
  required(roomId, "roomId", MATRIX_ROOM_ID);
  required(eventId, "eventId", MATRIX_EVENT_ID);
  const event = await channel.readHumanEvent(roomId, eventId);
  const admission = await admitHumanMatrixEvent({
    store,
    source,
    event,
    team,
    route,
    profile,
    leaderMember,
    members,
    leaderSessionId,
    now,
  });
  const bindingDigest = sha256({
    teamId: team.teamId,
    routeId: route.routeId,
    profileId: profile.profileId,
    leaderMemberId: leaderMember.memberId,
  });
  try {
    const reply = await channel.notifyWorkAdmitted(event.sender, {
      roomId: event.roomId,
      workId: admission.work.work.workId,
      sourceEventId: event.eventId,
      bindingDigest,
    });
    return Object.freeze({ admission, reply: Object.freeze({ delivered: reply.delivered === true, eventIdDigest: reply.eventIdDigest }) });
  } catch (error) {
    return Object.freeze({
      admission,
      reply: Object.freeze({ delivered: false, pending: true, errorCode: boundedErrorCode(error) }),
    });
  }
}

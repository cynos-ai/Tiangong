import { sha256 } from "../canonical-json.mjs";
import {
  isControlProfile,
  isMemberConfig,
  isTeamConfig,
  isTeamRouteBinding,
} from "./coordination-store.mjs";

const MATRIX_USER_ID = /^@[A-Za-z0-9._=+\/-]+:[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u;
const MATRIX_EVENT_ID = /^\$[^\s]{1,255}$/u;
const MATRIX_ROOM_ID = /^![^\s]{1,255}$/u;
const MAX_BODY_BYTES = 4096;

export class LeaderAdmissionDeniedError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "LeaderAdmissionDeniedError";
    this.code = reasonCode;
  }
}

function deny(code, message) {
  throw new LeaderAdmissionDeniedError(code, message);
}

function required(value, name, pattern) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    throw new TypeError(`${name} is missing or invalid`);
  }
  return value;
}

function assertSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) deny("HUMAN_SOURCE_INVALID", "authenticated Matrix source is required");
  if (source.authenticated !== true || source.channel !== "matrix") deny("HUMAN_SOURCE_UNAUTHENTICATED", "Human ingress is not authenticated Matrix traffic");
  return Object.freeze({
    channel: "matrix",
    authenticated: true,
    actorId: required(source.actorId, "source.actorId", MATRIX_USER_ID),
    messageId: required(source.messageId, "source.messageId", MATRIX_EVENT_ID),
    route: required(source.route, "source.route"),
  });
}

function assertHumanEvent(event, source) {
  if (!event || typeof event !== "object" || Array.isArray(event)) deny("HUMAN_EVENT_INVALID", "Matrix event is required");
  const eventId = required(event.eventId, "event.eventId", MATRIX_EVENT_ID);
  const roomId = required(event.roomId, "event.roomId", MATRIX_ROOM_ID);
  const sender = required(event.sender, "event.sender", MATRIX_USER_ID);
  if (event.type !== "m.room.message") deny("HUMAN_EVENT_TYPE_UNSUPPORTED", "Only Matrix m.room.message events can admit Work");
  if (source.messageId !== eventId || source.actorId !== sender) deny("HUMAN_EVENT_SOURCE_MISMATCH", "Matrix event is not the authenticated ingress event");
  const content = event.content;
  if (!content || typeof content !== "object" || Array.isArray(content) || content.msgtype !== "m.text" ||
      typeof content.body !== "string" || content.body.length === 0 || Buffer.byteLength(content.body) > MAX_BODY_BYTES ||
      /[\u0000\r\n]/u.test(content.body)) {
    deny("HUMAN_EVENT_CONTENT_INVALID", "Human Matrix message must contain one bounded plain-text body");
  }
  if (Object.keys(content).some((key) => key.startsWith("com.tiangong."))) {
    deny("HUMAN_EVENT_CONTROL_CONTENT", "Tiangong control events cannot enter Human message admission");
  }
  return Object.freeze({ eventId, roomId, sender, body: content.body });
}

function assertAdmissionBindings({ team, route, profile, leaderMember, members, event }) {
  if (!isTeamConfig(team) || !isTeamRouteBinding(route) || !isControlProfile(profile) || !isMemberConfig(leaderMember)) {
    deny("HUMAN_BINDING_INVALID", "Current TeamConfig, route, ControlProfile, and Leader binding are required");
  }
  if (!Array.isArray(members) || members.length !== team.memberIds.length || members.some((member) => !isMemberConfig(member))) {
    deny("HUMAN_BINDING_INVALID", "The complete current Team member binding is required");
  }
  const memberIds = new Set(members.map((member) => member.memberId));
  if (memberIds.size !== members.length || team.memberIds.some((memberId) => !memberIds.has(memberId))) {
    deny("HUMAN_BINDING_MISMATCH", "The current Team member binding does not match TeamConfig");
  }
  if (route.teamId !== team.teamId || team.controlProfileId !== profile.profileId || leaderMember.teamId !== team.teamId ||
      leaderMember.controlProfileId !== profile.profileId || leaderMember.memberId !== team.leaderMemberId || leaderMember.enabled !== true) {
    deny("HUMAN_BINDING_MISMATCH", "Current Team route and Leader binding do not agree");
  }
  if (route.roomId !== event.roomId) deny("HUMAN_ROOM_NOT_BOUND", "The Matrix room is not bound to this Team");
  if (members.some((member) => member.matrixUserId === event.sender)) {
    deny("HUMAN_SENDER_IS_WORKER", "A Worker identity cannot be admitted as a Human Work request");
  }
}

export async function admitHumanMatrixEvent({ store, source, event, team, route, profile, leaderMember, members = [], now = () => new Date().toISOString() } = {}) {
  if (!store || typeof store.enqueueMessageAdmission !== "function") throw new TypeError("Leader admission requires a CoordinationStore with a durable message backlog");
  if (typeof now !== "function") throw new TypeError("Leader admission clock is required");
  const normalizedSource = assertSource(source);
  if (normalizedSource.route !== "team-room") deny("HUMAN_ROUTE_NOT_BOUND", "Only the bound Team room can admit a Work");
  const normalizedEvent = assertHumanEvent(event, normalizedSource);
  assertAdmissionBindings({ team, route, profile, leaderMember, members, event: normalizedEvent });

  const admissionDigest = sha256({ teamId: team.teamId, routeId: route.routeId, eventId: normalizedEvent.eventId });
  const admitted = await store.enqueueMessageAdmission({
    team,
    route,
    profile,
    actorId: normalizedSource.actorId,
    eventId: normalizedEvent.eventId,
    receivedAt: now(),
    requestId: `matrix-admission-${admissionDigest.slice(0, 48)}`,
  });
  const leased = admitted.binding || typeof store.leaseMessageAdmission !== "function"
    ? null
    : await store.leaseMessageAdmission({ roomId: normalizedEvent.roomId, eventId: normalizedEvent.eventId, consumerId: leaderMember.memberId });
  return Object.freeze({
    replayed: admitted.replayed && leased?.replayed !== false,
    admission: Object.freeze(leased?.admission ?? admitted.admission),
    binding: admitted.binding ? Object.freeze(admitted.binding) : null,
    source: normalizedSource,
    event: Object.freeze({
      eventId: normalizedEvent.eventId,
      roomId: normalizedEvent.roomId,
      sender: normalizedEvent.sender,
    }),
  });
}

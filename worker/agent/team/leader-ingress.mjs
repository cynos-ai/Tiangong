import { admitHumanMatrixEvent } from "./leader-admission.mjs";

const MATRIX_EVENT_ID = /^\$[^\s]{1,255}$/u;
const MATRIX_ROOM_ID = /^![^\s]{1,255}$/u;
function required(value, name, pattern) { if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) throw new TypeError(`${name} is missing or invalid`); return value; }

/**
 * Re-read one authenticated Matrix event and durably enqueue its reference for
 * room-level Leader routing. The Human message remains ordinary Matrix content;
 * no Work is guessed and no acknowledgement event is required before routing.
 */
export async function admitLeaderMatrixIngress({ channel, store, source, roomId, eventId, team, route, profile, leaderMember, members = [], now } = {}) {
  if (!channel || typeof channel.readHumanEvent !== "function") throw new TypeError("Leader ingress requires a bound Matrix channel");
  required(roomId, "roomId", MATRIX_ROOM_ID); required(eventId, "eventId", MATRIX_EVENT_ID);
  const event = await channel.readHumanEvent(roomId, eventId);
  return admitHumanMatrixEvent({ store, source, event, team, route, profile, leaderMember, members, now });
}

export function createOpenClawLeaderAdmissionHook(bindings = {}) {
  const { channel, store, team, route, profile, leaderMember, members, now } = bindings;
  if (!channel || !store || !team || !route || !profile || !leaderMember) throw new TypeError("Leader admission hook requires current Team bindings and channel");
  return async (context) => admitLeaderMatrixIngress({ channel, store, source: context?.source, roomId: context?.roomId, eventId: context?.eventId, team, route, profile, leaderMember, members, now });
}

const MATRIX_USER_ID = /^@[A-Za-z0-9._=+\/-]+:[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u;
const MATRIX_ROOM_ID = /^![^\s]{1,255}$/u;
const MATRIX_EVENT_ID = /^\$[^\s]{1,255}$/u;
const HANDOFF_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HANDOFF_FIELD = "com.tiangong.handoff";
const MAX_BODY_BYTES = 8192;

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} has an unexpected shape`);
  }
}

function required(value, name, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function referenceFromEvent(event) {
  const reference = event?.content?.[HANDOFF_FIELD];
  exactKeys(reference, ["intent_id", "recipient", "sender", "source", "version", "work_id"], "handoff reference");
  if (reference.version !== 1) throw new Error("handoff reference version is unsupported");
  required(reference.work_id, "handoff work_id", HANDOFF_ID);
  required(reference.intent_id, "handoff intent_id", HANDOFF_ID);
  required(reference.sender, "handoff sender", MATRIX_USER_ID);
  required(reference.recipient, "handoff recipient", MATRIX_USER_ID);
  exactKeys(reference.source, ["event_id", "room_id", "sender"], "handoff source");
  required(reference.source.event_id, "handoff source event_id", MATRIX_EVENT_ID);
  required(reference.source.room_id, "handoff source room_id", MATRIX_ROOM_ID);
  required(reference.source.sender, "handoff source sender", MATRIX_USER_ID);
  return reference;
}

export function validateHumanSourceEvent(event, { roomId, eventId, senderId, specialistId, leaderId }) {
  if (event?.room_id !== roomId || event?.event_id !== eventId || event?.type !== "m.room.message" ||
      event?.sender !== senderId) throw new Error("Human source event envelope is not bound");
  const mentions = event.content?.["m.mentions"]?.user_ids;
  if (!Array.isArray(mentions) || mentions.length !== 1 || mentions[0] !== specialistId) {
    throw new Error("Human source event must mention exactly the Specialist");
  }
  const body = event.content?.body;
  const formatted = event.content?.formatted_body;
  if (typeof body !== "string" || Buffer.byteLength(body) > MAX_BODY_BYTES ||
      (formatted !== undefined && (typeof formatted !== "string" || Buffer.byteLength(formatted) > MAX_BODY_BYTES)) ||
      body.includes(leaderId) || (typeof formatted === "string" && formatted.includes(leaderId))) {
    throw new Error("Human source event leaks or exceeds the Leader boundary");
  }
  return Object.freeze({ roomId, eventId, senderId });
}

export function validateSpecialistHandoffEvent(event, {
  roomId,
  eventId,
  sourceEventId,
  sourceSender,
  specialistId,
  leaderId,
  workId,
  intentId,
}) {
  if (event?.room_id !== roomId || event?.event_id !== eventId || event?.type !== "m.room.message" ||
      event?.sender !== specialistId) throw new Error("Specialist handoff envelope is not bound");
  const body = event.content?.body;
  if (typeof body !== "string" || Buffer.byteLength(body) > MAX_BODY_BYTES || !body.includes(leaderId)) {
    throw new Error("Specialist handoff body is missing the bounded visible Leader mention");
  }
  const mentions = event.content?.["m.mentions"]?.user_ids;
  if (!Array.isArray(mentions) || mentions.length !== 1 || mentions[0] !== leaderId) {
    throw new Error("Specialist handoff must mention exactly the current Leader");
  }
  const formatted = event.content?.formatted_body;
  if (typeof formatted !== "string" || Buffer.byteLength(formatted) > MAX_BODY_BYTES ||
      !formatted.includes(`https://matrix.to/#/${leaderId}`)) {
    throw new Error("Specialist handoff formatted mention is missing or exceeds its bound");
  }
  const reference = referenceFromEvent(event);
  if (reference.work_id !== workId || reference.intent_id !== intentId ||
      reference.sender !== specialistId || reference.recipient !== leaderId ||
      reference.source.event_id !== sourceEventId || reference.source.sender !== sourceSender ||
      reference.source.room_id !== roomId) {
    throw new Error("Specialist handoff structured reference is not bound to current IDs");
  }
  return Object.freeze({ eventId, transactionId: event.unsigned?.transaction_id ?? null, reference });
}

export function assertReplay(first, replay) {
  if (!first || !replay || first.transactionId !== replay.transactionId || first.eventId !== replay.eventId) {
    throw new Error("Matrix transaction replay did not preserve one event");
  }
  return true;
}

export function assertInvalidReferenceRejected(event, expected) {
  let rejected = false;
  try {
    validateSpecialistHandoffEvent(event, expected);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("invalid handoff reference was accepted");
  return true;
}

export { HANDOFF_FIELD };

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertInvalidReferenceRejected,
  assertReplay,
  HANDOFF_FIELD,
  validateHumanSourceEvent,
  validateSpecialistHandoffEvent,
} from "./matrix-specialist-handoff.mjs";

const ROOM_ID = "!team:example.test";
const HUMAN_ID = "@admin:example.test";
const SPECIALIST_ID = "@specialist:example.test";
const LEADER_ID = "@leader:example.test";
const SOURCE_EVENT_ID = "$human-source";
const HANDOFF_EVENT_ID = "$specialist-handoff";
const WORK_ID = "work-11111111";
const INTENT_ID = "intent-11111111";

function sourceEvent(overrides = {}) {
  return {
    room_id: ROOM_ID,
    event_id: SOURCE_EVENT_ID,
    type: "m.room.message",
    sender: HUMAN_ID,
    content: {
      msgtype: "m.text",
      body: `@specialist:example.test TG_HANDOFF_START work=${WORK_ID} intent=${INTENT_ID}`,
      "m.mentions": { user_ids: [SPECIALIST_ID] },
    },
    ...overrides,
  };
}

function handoffEvent(overrides = {}) {
  const reference = {
    version: 1,
    work_id: WORK_ID,
    intent_id: INTENT_ID,
    source: { room_id: ROOM_ID, event_id: SOURCE_EVENT_ID, sender: HUMAN_ID },
    sender: SPECIALIST_ID,
    recipient: LEADER_ID,
  };
  return {
    room_id: ROOM_ID,
    event_id: HANDOFF_EVENT_ID,
    type: "m.room.message",
    sender: SPECIALIST_ID,
    content: {
      msgtype: "m.text",
      body: `${LEADER_ID} Tiangong specialist handoff ref=${JSON.stringify(reference)}`,
      format: "org.matrix.custom.html",
      formatted_body: `<a href="https://matrix.to/#/${LEADER_ID}">${LEADER_ID}</a> Tiangong specialist handoff`,
      "m.mentions": { user_ids: [LEADER_ID] },
      [HANDOFF_FIELD]: reference,
    },
    ...overrides,
  };
}

const expected = {
  roomId: ROOM_ID,
  eventId: HANDOFF_EVENT_ID,
  sourceEventId: SOURCE_EVENT_ID,
  sourceSender: HUMAN_ID,
  specialistId: SPECIALIST_ID,
  leaderId: LEADER_ID,
  workId: WORK_ID,
  intentId: INTENT_ID,
};

test("accepts only the Human source and Specialist-authored structured handoff", () => {
  assert.deepEqual(
    validateHumanSourceEvent(sourceEvent(), {
      roomId: ROOM_ID,
      eventId: SOURCE_EVENT_ID,
      senderId: HUMAN_ID,
      specialistId: SPECIALIST_ID,
      leaderId: LEADER_ID,
    }),
    { roomId: ROOM_ID, eventId: SOURCE_EVENT_ID, senderId: HUMAN_ID },
  );
  const result = validateSpecialistHandoffEvent(handoffEvent(), expected);
  assert.equal(result.eventId, HANDOFF_EVENT_ID);
  assert.equal(result.reference.source.event_id, SOURCE_EVENT_ID);
});

test("rejects hidden Leader selection in the Human source event", () => {
  for (const content of [
    {
      ...sourceEvent().content,
      body: `@specialist:example.test ${LEADER_ID} TG_HANDOFF_START work=${WORK_ID} intent=${INTENT_ID}`,
    },
    {
      ...sourceEvent().content,
      formatted_body: `<a href="https://matrix.to/#/${LEADER_ID}">${LEADER_ID}</a>`,
    },
  ]) {
    assert.throws(
      () => validateHumanSourceEvent(sourceEvent({ content }), {
        roomId: ROOM_ID,
        eventId: SOURCE_EVENT_ID,
        senderId: HUMAN_ID,
        specialistId: SPECIALIST_ID,
        leaderId: LEADER_ID,
      }),
      /Leader boundary/u,
    );
  }
});

test("rejects wrong room, sender, source, recipient, and extra fields", () => {
  for (const mutation of [
    { room_id: "!other:example.test" },
    { sender: HUMAN_ID },
    { content: { ...handoffEvent().content, [HANDOFF_FIELD]: {
      ...handoffEvent().content[HANDOFF_FIELD],
      source: { ...handoffEvent().content[HANDOFF_FIELD].source, event_id: "$other" },
    } } },
    { content: { ...handoffEvent().content, [HANDOFF_FIELD]: {
      ...handoffEvent().content[HANDOFF_FIELD], recipient: SPECIALIST_ID,
    } } },
    { content: { ...handoffEvent().content, [HANDOFF_FIELD]: {
      ...handoffEvent().content[HANDOFF_FIELD], extra: "not-allowed",
    } } },
  ]) {
    assertInvalidReferenceRejected(handoffEvent(mutation), expected);
  }
});

test("requires one stable sender acknowledgement for transaction replay", () => {
  assert.doesNotThrow(() => assertReplay(
    { transactionId: "tiangong_abc", eventId: HANDOFF_EVENT_ID },
    { transactionId: "tiangong_abc", eventId: HANDOFF_EVENT_ID },
  ));
  assert.throws(
    () => assertReplay(
      { transactionId: "tiangong_abc", eventId: HANDOFF_EVENT_ID },
      { transactionId: "tiangong_other", eventId: "$second" },
    ),
    /one event/u,
  );
});

test("structured reference, not body prose, binds the Work and source", () => {
  const event = handoffEvent({
    content: {
      ...handoffEvent().content,
      body: `${LEADER_ID} explanatory prose names a different work-id`,
    },
  });
  assert.doesNotThrow(() => validateSpecialistHandoffEvent(event, expected));
});

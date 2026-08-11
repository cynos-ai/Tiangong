import assert from "node:assert/strict";
import test from "node:test";

import { createTeamChannel } from "../agent/team/channel-adapter.mjs";

const ENV = Object.freeze({
  AGENTTEAMS_MATRIX_URL: "https://matrix.example.test",
  AGENTTEAMS_MATRIX_DOMAIN: "example.test",
  AGENTTEAMS_WORKER_MATRIX_TOKEN: "secret-token",
  AGENTTEAMS_CONTROLLER_URL: "https://controller.example.test",
  AGENTTEAMS_AUTH_TOKEN: "controller-token",
  AGENTTEAMS_WORKER_NAME: "tiangong-specialist",
  AGENTTEAMS_WORKER_ROOM_ID: "!personal:example.test",
});

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } };
}

function matrixFetch(calls) {
  const members = {
    "@tiangong-specialist:example.test": {},
    "@tiangong-leader:example.test": {},
    "@admin:example.test": {},
  };
  return async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/joined_rooms")) return response({ joined_rooms: ["!personal:example.test", "!team:example.test"] });
    if (url.includes(encodeURIComponent("!team:example.test")) && url.endsWith("/joined_members")) {
      return response({ joined: members });
    }
    if (options.method === "PUT") return response({ event_id: "$handoff-event" });
    return response({ errcode: "M_NOT_FOUND" }, 404);
  };
}

const input = {
  workId: "work-11111111",
  intentId: "intent-11111111",
  sourceEventId: "$human-source",
  sourceSender: "@admin:example.test",
};

test("specialist handoff uses authenticated sender, raw reference, and stable replay", async () => {
  const calls = [];
  const evidence = [];
  const channel = createTeamChannel({
    evidence: { async append(event) { evidence.push(event); } },
    env: ENV,
    fetchImpl: matrixFetch(calls),
  });
  const first = await channel.sendSpecialistHandoff("@tiangong-leader:example.test", input);
  const replay = await channel.sendSpecialistHandoff("@tiangong-leader:example.test", input);
  const puts = calls.filter((call) => call.options.method === "PUT");
  assert.equal(puts.length, 2);
  assert.equal(puts[0].url, puts[1].url);
  assert.equal(first.transactionId, replay.transactionId);
  assert.equal(first.eventId, replay.eventId);
  const body = JSON.parse(puts[0].options.body);
  assert.deepEqual(body["m.mentions"], { user_ids: ["@tiangong-leader:example.test"] });
  assert.deepEqual(body["com.tiangong.handoff"], {
    version: 1,
    work_id: input.workId,
    intent_id: input.intentId,
    source: {
      room_id: "!team:example.test",
      event_id: input.sourceEventId,
      sender: input.sourceSender,
    },
    sender: "@tiangong-specialist:example.test",
    recipient: "@tiangong-leader:example.test",
  });
  assert.equal(evidence.length, 2);
  assert.deepEqual(evidence.map((event) => event.type), [
    "team.specialist.handoff.delivered",
    "team.specialist.handoff.delivered",
  ]);
  assert.ok(!JSON.stringify(evidence).includes("secret-token"));
});

test("specialist handoff rejects malformed source references before Matrix send", async () => {
  const calls = [];
  const events = [];
  const channel = createTeamChannel({
    evidence: { async append(event) { events.push(event); } },
    env: ENV,
    fetchImpl: matrixFetch(calls),
  });
  await assert.rejects(
    () => channel.sendSpecialistHandoff("@tiangong-leader:example.test", {
      ...input,
      sourceEventId: "not-an-event",
    }),
    /source event ID is missing or invalid/u,
  );
  assert.equal(calls.filter((call) => call.options.method === "PUT").length, 0);
  assert.deepEqual(events, []);
});

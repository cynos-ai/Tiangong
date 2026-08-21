import assert from "node:assert/strict";
import test from "node:test";

import { createTeamChannel } from "../agent/team/channel-adapter.mjs";

const ENV = Object.freeze({
  AGENTTEAMS_MATRIX_URL: "https://matrix.example.test",
  AGENTTEAMS_MATRIX_DOMAIN: "example.test",
  AGENTTEAMS_WORKER_MATRIX_TOKEN: "secret-token",
  AGENTTEAMS_CONTROLLER_URL: "https://controller.example.test",
  AGENTTEAMS_AUTH_TOKEN: "controller-token",
  AGENTTEAMS_WORKER_NAME: "tiangong-leader",
  AGENTTEAMS_WORKER_ROOM_ID: "!personal:example.test",
});

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } };
}

function fetchMatrix(calls) {
  const members = {
    "@tiangong-leader:example.test": {},
    "@alice:example.test": {},
  };
  return async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/joined_rooms")) {
      return response({ joined_rooms: ["!personal:example.test", "!team:example.test"] });
    }
    if (url.includes(encodeURIComponent("!team:example.test")) && url.endsWith("/joined_members")) {
      return response({ joined: members });
    }
    if (url.includes(encodeURIComponent("!personal:example.test")) && url.endsWith("/joined_members")) {
      return response({ joined: members });
    }
    if (options.method === "GET" && url.includes("/event/")) {
      return response({
        event_id: "$human-event",
        room_id: "!team:example.test",
        sender: "@alice:example.test",
        type: "m.room.message",
        content: { msgtype: "m.text", body: "Inspect the native Leader runtime" },
      });
    }
    if (options.method === "PUT") return response({ event_id: "$reply-event" });
    return response({ errcode: "M_NOT_FOUND" }, 404);
  };
}

test("B2 channel reads a bound Human event and emits an idempotent Work admission reply", async () => {
  const calls = [];
  const channel = createTeamChannel({
    env: ENV,
    fetchImpl: fetchMatrix(calls),
  });

  const human = await channel.readHumanEvent("!team:example.test", "$human-event");
  assert.deepEqual(human, {
    eventId: "$human-event",
    roomId: "!team:example.test",
    sender: "@alice:example.test",
    type: "m.room.message",
    content: { msgtype: "m.text", body: "Inspect the native Leader runtime" },
  });

  const first = await channel.notifyWorkAdmitted("@alice:example.test", {
    roomId: "!team:example.test",
    workId: "work-admission-1",
    sourceEventId: "$human-event",
    bindingDigest: "a".repeat(64),
  });
  const replay = await channel.notifyWorkAdmitted("@alice:example.test", {
    roomId: "!team:example.test",
    workId: "work-admission-1",
    sourceEventId: "$human-event",
    bindingDigest: "a".repeat(64),
  });

  assert.equal(first.transactionId, replay.transactionId);
  assert.ok(!JSON.stringify({ first, replay }).includes("secret-token"));

  const puts = calls.filter((call) => call.options.method === "PUT");
  assert.equal(puts.length, 2);
  assert.equal(puts[0].url, puts[1].url);
  const body = JSON.parse(puts[0].options.body);
  assert.deepEqual(body["m.mentions"], { user_ids: ["@alice:example.test"] });
  assert.equal(body["com.tiangong.work"].work_id, "work-admission-1");
  assert.match(body.body, /Work admitted: work=work-admission-1/u);
});

test("B2 channel rejects an unjoined or malformed Work admission target before sending", async () => {
  const calls = [];
  const channel = createTeamChannel({
    env: ENV,
    fetchImpl: fetchMatrix(calls),
  });
  await assert.rejects(
    () => channel.readHumanEvent("!unknown:example.test", "$human-event"),
    /not joined/u,
  );
  await assert.rejects(
    () => channel.notifyWorkAdmitted("@alice:example.test", {
      roomId: "!team:example.test",
      workId: "work-admission-1",
      sourceEventId: "$human-event",
      bindingDigest: "not-a-digest",
    }),
    /bindingDigest is missing or invalid/u,
  );
  assert.equal(calls.filter((call) => call.options.method === "PUT").length, 0);
});

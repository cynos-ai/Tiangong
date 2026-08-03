import assert from "node:assert/strict";
import test from "node:test";

import { createTeamChannel } from "../agent/team/channel-adapter.mjs";
import { createTeamSync } from "../agent/team/sync-adapter.mjs";

const CHANNEL_ENV = Object.freeze({
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

function matrixFetch(calls) {
  const members = {
    "@tiangong-leader:example.test": {},
    "@tiangong-designer:example.test": {},
    "@tiangong-implementor:example.test": {},
    "@tiangong-assessor:example.test": {},
    "@tiangong-operator:example.test": {},
    "@manager:example.test": {},
  };
  return async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/v1/workers/tiangong-leader")) {
      return response({ name: "tiangong-leader", role: "team_leader", team: "team-1", matrixUserID: "@tiangong-leader:example.test", phase: "Running" });
    }
    if (url.endsWith("/joined_rooms")) {
      return response({ joined_rooms: ["!personal:example.test", "!team:example.test"] });
    }
    if (url.includes(encodeURIComponent("!team:example.test")) && url.endsWith("/joined_members")) {
      return response({ joined: members });
    }
    if (url.includes(encodeURIComponent("!personal:example.test")) && url.endsWith("/joined_members")) {
      return response({ joined: members });
    }
    if (options.method === "PUT") return response({ event_id: "$event" });
    return response({ errcode: "M_NOT_FOUND" }, 404);
  };
}

test("createTeamChannel delivers idempotent authenticated Matrix mentions and records Evidence", async () => {
  const events = [];
  const calls = [];
  const evidence = { async append(e) { events.push(e); } };
  const channel = createTeamChannel({ evidence, env: CHANNEL_ENV, fetchImpl: matrixFetch(calls) });

  const identity = await channel.assertTeamIdentity("team_leader");
  const roster = await channel.assertTeamRoster([
    "tiangong-leader",
    "tiangong-designer",
    "tiangong-implementor",
    "tiangong-assessor",
    "tiangong-operator",
  ]);
  const assignee = await channel.notifyAssignee("tiangong-designer", "proj-1", "task-1", "a".repeat(64));
  const replay = await channel.notifyAssignee("tiangong-designer", "proj-1", "task-1", "a".repeat(64));
  const leader = await channel.notifyLeader("tiangong-leader", "proj-1", "task-1", "b".repeat(64));
  const report = await channel.reportRequester(
    "@manager:example.test",
    "proj-1",
    "DELIVERED",
    "c".repeat(64),
    "Delivery completed safely.",
  );

  assert.equal(identity.team, "team-1");
  assert.equal(roster.roomIdDigest.length, 64);
  assert.deepEqual(
    events.map((e) => e.type),
    ["team.mention.delivered", "team.mention.delivered", "team.result.notice.delivered", "team.requester.report.delivered"],
  );
  assert.equal(events[0].recipientDigest.length, 64);
  assert.equal(events[3].disposition, "DELIVERED");
  assert.deepEqual([assignee.delivered, leader.delivered, report.delivered], [true, true, true]);
  assert.equal(assignee.transactionId, replay.transactionId);
  const puts = calls.filter((call) => call.options.method === "PUT");
  assert.equal(puts.length, 4);
  assert.equal(puts[0].url, puts[1].url);
  assert.ok(!JSON.stringify(events).includes("secret-token"));
});

test("waitForTeamIdentity gates task access until a transient AgentTeams phase is ready", async () => {
  let attempts = 0;
  const channel = createTeamChannel({
    evidence: { async append() {} },
    env: CHANNEL_ENV,
    fetchImpl: async (url) => {
      if (url.endsWith("/api/v1/workers/tiangong-leader")) {
        attempts += 1;
        return response({
          name: "tiangong-leader",
          role: "worker",
          team: "team-1",
          matrixUserID: "@tiangong-leader:example.test",
          phase: attempts === 1 ? "Starting" : "Running",
        });
      }
      throw new Error("unexpected readiness request");
    },
  });
  const identity = await channel.waitForTeamIdentity("worker", { timeoutMs: 100, pollMs: 0 });
  assert.equal(identity.role, "worker");
  assert.equal(attempts, 2);
});

test("createTeamChannel fails closed when no unique authenticated Team room exists", async () => {
  const evidence = { async append() { throw new Error("must not record"); } };
  const fetchImpl = async (url) => {
    if (url.endsWith("/joined_rooms")) return response({ joined_rooms: ["!personal:example.test"] });
    throw new Error("unexpected request");
  };
  const channel = createTeamChannel({ evidence, env: CHANNEL_ENV, fetchImpl });
  await assert.rejects(
    () => channel.notifyAssignee("tiangong-designer", "proj-1", "task-1", "a".repeat(64)),
    /Exactly one authenticated AgentTeams Team room/u,
  );
});

test("Matrix replay uses the same transaction after an Evidence interruption", async () => {
  const calls = [];
  let fail = true;
  const evidence = { async append() { if (fail) { fail = false; throw new Error("evidence unavailable"); } } };
  const channel = createTeamChannel({ evidence, env: CHANNEL_ENV, fetchImpl: matrixFetch(calls) });
  await assert.rejects(
    () => channel.notifyAssignee("tiangong-designer", "proj-1", "task-1", "a".repeat(64)),
    /evidence unavailable/u,
  );
  await channel.notifyAssignee("tiangong-designer", "proj-1", "task-1", "a".repeat(64));
  const puts = calls.filter((call) => call.options.method === "PUT");
  assert.equal(puts.length, 2);
  assert.equal(puts[0].url, puts[1].url);
});

test("createTeamChannel fails closed without durable Evidence", () => {
  assert.throws(
    () => createTeamChannel({ now: () => "2026-08-01T12:00:00Z" }),
    /requires durable Evidence/u,
  );
});

test("createTeamSync beforeRead pulls and afterWrite pushes via the injected runner", async () => {
  const calls = [];
  const run = async (cmd) => { calls.push(cmd); return { stdout: "", stderr: "" }; };
  const sync = createTeamSync({ run, now: () => "2026-08-01T12:00:00Z" });
  await sync.beforeRead();
  await sync.afterWrite({ projectIds: ["project-1"], taskIds: ["task-1"] });
  assert.equal(calls.length, 3);
  assert.match(calls[0], /mc mirror .*\$\{AGENTTEAMS_STORAGE_PREFIX\}\/shared\/.*\/root\/agentteams-fs\/shared\/.*--overwrite/u);
  assert.doesNotMatch(calls[0], /agentteams-sync/u);
  assert.match(calls[1], /mc mirror .*shared\/projects\/project-1\/.*--overwrite/u);
  assert.match(calls[2], /mc mirror .*shared\/tasks\/task-1\/.*--overwrite/u);
});

test("createTeamSync surfaces runner failures", async () => {
  const run = async () => { throw new Error("mc unavailable"); };
  const sync = createTeamSync({ run });
  await assert.rejects(() => sync.beforeRead(), /mc unavailable/);
});

test("createTeamSync refuses a broad or input-shaped push scope", async () => {
  const sync = createTeamSync({ run: async () => ({ stdout: "", stderr: "" }) });
  await assert.rejects(() => sync.afterWrite(), /exact Project\/Task scope/u);
  await assert.rejects(
    () => sync.afterWrite({ taskIds: ["../escape"] }),
    /invalid id/u,
  );
});

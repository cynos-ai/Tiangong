import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CoordinationStore,
  createControlProfile,
  createMemberConfig,
  createTeamConfig,
  createTeamRouteBinding,
} from "../agent/team/coordination-store.mjs";
import { createTeamChannel } from "../agent/team/channel-adapter.mjs";
import {
  createOpenClawLeaderAdmissionHook,
} from "../agent/team/leader-ingress.mjs";
import { createLeaderOutboxHandlers, drainLeaderOutbox } from "../agent/team/leader-outbox.mjs";
import { createTiangongPiHarness } from "../plugin/openclaw-adapter.mjs";

const NOW = "2026-08-15T01:00:00.000Z";
const ENV = Object.freeze({
  AGENTTEAMS_MATRIX_URL: "https://matrix.example.test",
  AGENTTEAMS_MATRIX_DOMAIN: "example.test",
  AGENTTEAMS_WORKER_MATRIX_TOKEN: "worker-token",
  AGENTTEAMS_CONTROLLER_URL: "https://controller.example.test",
  AGENTTEAMS_AUTH_TOKEN: "controller-token",
  AGENTTEAMS_WORKER_NAME: "tiangong-leader",
  AGENTTEAMS_WORKER_ROOM_ID: "!personal:example.test",
});

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } };
}

function bindings() {
  const profile = createControlProfile({ profileId: "profile-default", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-alpha", revision: 1, leaderMemberId: "leader-1", memberIds: ["leader-1"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route-alpha", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!team:example.test", createdAt: NOW });
  const leaderMember = createMemberConfig({ memberId: "leader-1", teamId: team.teamId, workerName: "tiangong-leader", matrixUserId: "@tiangong-leader:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  return { profile, team, route, leaderMember, members: [leaderMember] };
}

function matrixFetch(calls) {
  const members = {
    "@tiangong-leader:example.test": {},
    "@alice:example.test": {},
  };
  return async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/joined_rooms")) return response({ joined_rooms: ["!personal:example.test", "!team:example.test"] });
    if (url.includes(encodeURIComponent("!team:example.test")) && url.endsWith("/joined_members")) return response({ joined: members });
    if (url.includes(encodeURIComponent("!personal:example.test")) && url.endsWith("/joined_members")) return response({ joined: members });
    if (options.method === "GET" && url.includes("/event/")) {
      return response({
        event_id: "$human-event-1",
        room_id: "!team:example.test",
        sender: "@alice:example.test",
        type: "m.room.message",
        content: { msgtype: "m.text", body: "Inspect the native Leader runtime" },
      });
    }
    if (options.method === "PUT") return response({ event_id: "$reply-event-1" });
    return response({ errcode: "M_NOT_FOUND" }, 404);
  };
}

test("B2 Basic disposable smoke composes OpenClaw ingress, Work, Matrix reply, outbox ack, and restart projection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-phase-b2-basic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CoordinationStore({ filePath: join(root, "coordination.jsonl"), now: () => NOW });
  const config = bindings();
  const calls = [];
  const evidence = [];
  const channel = createTeamChannel({ evidence: { async append(value) { evidence.push(value); } }, env: ENV, fetchImpl: matrixFetch(calls) });
  const order = [];
  const harness = createTiangongPiHarness({
    evidencePath: join(root, "harness.last-run"),
    leaderIngress: createOpenClawLeaderAdmissionHook({ channel, store, ...config, now: () => NOW }),
    runtime: {
      async runTurn() { order.push("runtime"); return { text: "Leader runtime completed", usage: { input: 1, output: 1, totalTokens: 2 } }; },
      async reset() {},
      async dispose() {},
    },
  });
  t.after(() => harness.dispose());
  const result = await harness.runAttempt({
    abortSignal: new AbortController().signal,
    config: { channels: { matrix: { dm: { policy: "allowlist", allowFrom: ["@alice:example.test"] }, groupPolicy: "allowlist", groupAllowFrom: ["@alice:example.test"] } } },
    currentMessageId: "$human-event-1",
    matrixIngress: { authenticated: true, route: "team-room", roomId: "!team:example.test" },
    messageChannel: "matrix",
    model: { api: "openai-responses" },
    modelId: "deepseek-v4-pro",
    prompt: "Inspect the native Leader runtime",
    provider: "agentteams-gateway",
    resolvedApiKey: "worker-consumer-token",
    runId: "attempt-b2-1",
    senderId: "@alice:example.test",
    senderName: "Alice",
    sessionId: "session-b2-1",
    thinkLevel: "medium",
    timeoutMs: 5_000,
    workspaceDir: root,
  });
  assert.equal(result.promptError, null);
  assert.deepEqual(order, ["runtime"]);
  assert.equal((await store.health()).workCount, 1);
  assert.equal((await store.listOutbox({ status: "pending" })).length, 2);
  assert.equal(evidence[0].type, "team.work.admitted");
  assert.ok(!JSON.stringify(evidence).includes("Inspect the native Leader runtime"));
  assert.ok(!JSON.stringify(evidence).includes("worker-token"));

  const resumed = [];
  const handlers = createLeaderOutboxHandlers({
    store,
    channel,
    async resolveWorkRoute() { return { roomId: "!team:example.test", bindingDigest: evidence[0].bindingDigest }; },
    async resumeLeader(wake) { resumed.push(wake.wakeId); return { sessionId: "leader-session-b2" }; },
  });
  const drained = await drainLeaderOutbox({ store, handlers, consumerId: "tiangong-leader" });
  assert.equal(drained.results.length, 2);
  assert.equal((await store.listOutbox({ status: "acked" })).length, 2);
  assert.equal(resumed.length, 1);
  const puts = calls.filter((call) => call.options.method === "PUT");
  assert.equal(puts.length, 2);
  assert.equal(puts[0].url, puts[1].url);

  const reopened = new CoordinationStore({ filePath: join(root, "coordination.jsonl"), now: () => NOW });
  assert.equal((await reopened.health()).workCount, 1);
  assert.equal((await reopened.listOutbox({ status: "acked" })).length, 2);
});

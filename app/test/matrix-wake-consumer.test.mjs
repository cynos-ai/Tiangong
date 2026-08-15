import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { CoordinationStore, createControlProfile, createMemberConfig, createTeamConfig, createTeamRouteBinding, createWorkSpec } from "../../worker/agent/team/coordination-store.mjs";
import { createMatrixWakeConsumer } from "../coordination/matrix-wake-consumer.mjs";

const NOW = "2026-08-15T03:00:00.000Z";
const TOKEN = "matrix-deployment-token";

function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(value); } };
}

test("Matrix wake consumer delivers deterministic leader and human wakes, then acknowledges PG outbox", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-matrix-consumer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = createControlProfile({ profileId: "profile-consumer", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-consumer", revision: 1, leaderMemberId: "leader-consumer", memberIds: ["leader-consumer"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route-consumer", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room-consumer:example.test", createdAt: NOW });
  const leaderMember = createMemberConfig({ memberId: "leader-consumer", teamId: team.teamId, workerName: "leader-consumer", matrixUserId: "@leader-consumer:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const store = new CoordinationStore({ filePath: join(root, "coordination.jsonl"), now: () => NOW });
  await store.createWork({
    workId: "work-consumer",
    team,
    route,
    profile,
    spec: createWorkSpec({ workId: "work-consumer", revision: 1, objective: "consumer", scope: "test", completionContract: "evidence", createdAt: NOW }),
    actorId: "@human-consumer:example.test",
    sourceEventId: "$human-consumer",
    requestId: "request-consumer",
    wakes: [
      { kind: "leader-resume", targetMemberId: leaderMember.memberId },
      { kind: "human-reply", targetMemberId: "@human-consumer:example.test" },
    ],
  });
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/_matrix/client/v3/account/whoami")) return response({ user_id: leaderMember.matrixUserId });
    if (url.includes("/joined_members")) return response({ joined: { [leaderMember.matrixUserId]: {} } });
    if (url.includes("/send/m.room.message/")) return response({ event_id: "$sent-" + calls.length });
    throw new Error("unexpected matrix request");
  };
  const consumer = createMatrixWakeConsumer({ store, binding: { team, route, profile, leaderMember, members: [leaderMember] }, matrixUrl: "https://matrix.example.test", matrixToken: TOKEN, fetchImpl: fakeFetch, intervalMs: 1000 });
  await consumer.start();
  await consumer.stop();
  const deliveries = calls.filter((call) => call.url.includes("/send/m.room.message/"));
  assert.equal(deliveries.length, 2);
  assert.ok(deliveries.every((call) => call.options.headers.Authorization === `Bearer ${TOKEN}`));
  assert.ok(deliveries.some((call) => JSON.parse(call.options.body)["com.tiangong.leader-resume"]));
  assert.ok(deliveries.some((call) => JSON.parse(call.options.body)["com.tiangong.work"]));
  assert.equal((await store.listOutbox({ status: "pending" })).length, 0);
  assert.equal((await store.listOutbox({ status: "acked" })).length, 2);
});

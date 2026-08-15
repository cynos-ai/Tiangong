import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createRuntimeConsoleServer } from "../server.mjs";
import {
  CoordinationStore,
  createControlProfile,
  createMemberConfig,
  createTeamConfig,
  createTeamRouteBinding,
} from "../../worker/agent/team/coordination-store.mjs";
import { leaderResumeEventBody } from "../../worker/agent/team/leader-resume.mjs";

const NOW = "2026-08-15T03:00:00.000Z";
const TOKEN = "control-token-for-test";

test("Coordination Control API keeps Team bindings server-side and replays one Matrix ingress", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-control-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = createControlProfile({ profileId: "profile-api", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-api", revision: 1, leaderMemberId: "leader-api", memberIds: ["leader-api"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route-api", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room-api:example.test", createdAt: NOW });
  const leaderMember = createMemberConfig({ memberId: "leader-api", teamId: team.teamId, workerName: "leader-api", matrixUserId: "@leader-api:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const store = new CoordinationStore({ filePath: join(root, "coordination.jsonl"), now: () => NOW });
  const server = createRuntimeConsoleServer({
    coordinationControl: { store, bearerToken: TOKEN, team, route, profile, leaderMember, members: [leaderMember], now: () => NOW },
  }).listen(0);
  t.after(() => server.close());
  const address = server.address();
  const request = {
    source: { channel: "matrix", authenticated: true, actorId: "@human-api:example.test", messageId: "$event-api-1", route: "team-room" },
    event: { eventId: "$event-api-1", roomId: route.roomId, sender: "@human-api:example.test", type: "m.room.message", content: { msgtype: "m.text", body: "Open the API slice" } },
  };
  const first = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/admit`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(request) });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.replayed, false);
  assert.equal(firstBody.work.work.teamId, team.teamId);
  assert.equal(firstBody.wakes.length, 2);
  const listedWork = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/works/${encodeURIComponent(firstBody.work.work.workId)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(listedWork.status, 200);
  assert.equal((await listedWork.json()).work.work.workId, firstBody.work.work.workId);
  const listedWakes = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/wakes?status=pending`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(listedWakes.status, 200);
  assert.equal((await listedWakes.json()).wakes.length, 2);
  const replay = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/admit`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(request) });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  const wakeId = firstBody.wakes[0].wakeId;
  const claim = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/wakes/claim`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ wakeId, consumerId: "leader-api", requestId: "claim-api-1" }) });
  assert.equal(claim.status, 200);
  assert.equal((await claim.json()).wake.status, "claimed");
  const ack = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/wakes/ack`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ wakeId, consumerId: "leader-api", receiptId: "receipt-api-1", requestId: "ack-api-1" }) });
  assert.equal(ack.status, 200);
  assert.equal((await ack.json()).wake.status, "acked");
  const unauthorized = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/admit`, { method: "POST", body: JSON.stringify(request) });
  assert.equal(unauthorized.status, 401);
  assert.equal(JSON.stringify(firstBody).includes(TOKEN), false);
});

test("Coordination Control API validates a deployment-authored Leader resume event without creating Work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-control-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = createControlProfile({ profileId: "profile-resume-api", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-resume-api", revision: 1, leaderMemberId: "leader-resume-api", memberIds: ["leader-resume-api"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route-resume-api", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room-resume-api:example.test", createdAt: NOW });
  const leaderMember = createMemberConfig({ memberId: "leader-resume-api", teamId: team.teamId, workerName: "leader-resume-api", matrixUserId: "@leader-resume-api:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const store = new CoordinationStore({ filePath: join(root, "coordination.jsonl"), now: () => NOW });
  const server = createRuntimeConsoleServer({ coordinationControl: { store, bearerToken: TOKEN, team, route, profile, leaderMember, members: [leaderMember], now: () => NOW } }).listen(0);
  t.after(() => server.close());
  const address = server.address();
  const admission = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/admit`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ source: { channel: "matrix", authenticated: true, actorId: "@human-resume-api:example.test", messageId: "$human-resume-api", route: "team-room" }, event: { eventId: "$human-resume-api", roomId: route.roomId, sender: "@human-resume-api:example.test", type: "m.room.message", content: { msgtype: "m.text", body: "resume" } } }) });
  const admitted = await admission.json();
  const wake = admitted.wakes.find((entry) => entry.kind === "leader-resume");
  const event = { eventId: "$leader-resume-api", roomId: route.roomId, sender: leaderMember.matrixUserId, type: "m.room.message", content: leaderResumeEventBody({ wakeId: wake.wakeId, workId: wake.workId, targetMemberId: leaderMember.memberId, targetMatrixUserId: leaderMember.matrixUserId }) };
  const resumed = await fetch(`http://127.0.0.1:${address.port}/v1/coordination/resume`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ source: { channel: "matrix", authenticated: true, actorId: leaderMember.matrixUserId, messageId: event.eventId, route: "team-room" }, event }) });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).resumed, true);
  assert.equal((await store.listWorks()).length, 1);
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { createLeaderRuntimeBinding, readLeaderRuntimeBinding } from "../agent/team/leader-runtime-config.mjs";
import {
  createControlProfile,
  createMemberConfig,
  createTeamConfig,
  createTeamRouteBinding,
} from "../agent/team/coordination-store.mjs";

const NOW = "2026-08-15T05:00:00.000Z";

function records() {
  const profile = createControlProfile({ profileId: "profile-binding", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-binding", revision: 1, leaderMemberId: "leader-binding", memberIds: ["leader-binding"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route-binding", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room-binding:example.test", createdAt: NOW });
  const leaderMember = createMemberConfig({ memberId: "leader-binding", teamId: team.teamId, workerName: "leader-binding", matrixUserId: "@leader-binding:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  return { team, route, profile, leaderMember, members: [leaderMember] };
}

test("Leader runtime binding loader validates a credential-free binding and composes remote pieces", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-leader-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "binding.json");
  const value = records();
  await writeFile(filePath, JSON.stringify(value), { mode: 0o600 });
  assert.deepEqual(await readLeaderRuntimeBinding(filePath), value);
  const binding = await createLeaderRuntimeBinding({
    filePath,
    controlEndpoint: "http://control.example.test/v1/coordination/admit",
    controlToken: "binding-secret-token",
    channel: { readHumanEvent: async () => ({}) },
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  assert.equal(typeof binding.leaderIngress, "function");
  assert.equal(typeof binding.coordinationStore.listOutbox, "function");
  assert.equal(JSON.stringify(binding).includes("binding-secret-token"), false);
});

test("Leader runtime binding loader rejects a stale member/profile relationship", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-leader-binding-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, "binding.json");
  const value = records();
  value.leaderMember = { ...value.leaderMember, controlProfileId: "profile-other" };
  await writeFile(filePath, JSON.stringify(value), { mode: 0o600 });
  await assert.rejects(() => readLeaderRuntimeBinding(filePath), /binding records are invalid|binding references disagree/u);
});

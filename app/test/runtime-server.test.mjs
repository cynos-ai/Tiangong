import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { startCoordinationRuntime } from "../coordination/runtime-server.mjs";
import { CoordinationStore, createControlProfile, createMemberConfig, createTeamConfig, createTeamRouteBinding } from "../../worker/agent/team/coordination-store.mjs";

const NOW = "2026-08-15T03:00:00.000Z";

test("deployment coordination runtime starts with PG health readiness and closes cleanly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-runtime-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = createControlProfile({ profileId: "profile-runtime", revision: 1, maxTimelineEntries: 64, maxOutboxEntries: 32, maxTasksPerWork: 8, toolResultRetentionMs: 60_000 });
  const team = createTeamConfig({ teamId: "team-runtime", revision: 1, leaderMemberId: "leader-runtime", memberIds: ["leader-runtime"], controlProfileId: profile.profileId, createdAt: NOW });
  const route = createTeamRouteBinding({ routeId: "route-runtime", teamId: team.teamId, revision: 1, channel: "matrix", roomId: "!room-runtime:example.test", createdAt: NOW });
  const leaderMember = createMemberConfig({ memberId: "leader-runtime", teamId: team.teamId, workerName: "leader-runtime", matrixUserId: "@leader-runtime:example.test", role: "leader", controlProfileId: profile.profileId, enabled: true, createdAt: NOW });
  const store = new CoordinationStore({ filePath: join(root, "coordination.jsonl"), now: () => NOW });
  store.migrate = async () => ({ version: "test" });
  const runtime = await startCoordinationRuntime({
    binding: { team, route, profile, leaderMember, members: [leaderMember] },
    controlToken: "runtime-control-token",
    store,
    pool: { async end() {} },
    port: 0,
  });
  t.after(() => runtime.close());
  const address = runtime.server.address();
  const ready = await fetch(`http://127.0.0.1:${address.port}/readyz`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).source, "postgres");
  const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
  assert.equal(health.status, 200);
});

import assert from "node:assert/strict";
import test from "node:test";

import { createTeamChannel } from "../agent/team/channel-adapter.mjs";
import { createLeaderSync } from "../agent/team/sync-adapter.mjs";

test("createTeamChannel records queued mentions and report as Evidence (no false delivery)", () => {
  const events = [];
  const evidence = { append: (e) => events.push(e) };
  const channel = createTeamChannel({ evidence, now: () => "2026-08-01T12:00:00Z" });

  channel.notifyAssignee("tiangong-designer", "task-1", "a".repeat(64));
  channel.notifyLeader("task-1", "b".repeat(64));
  channel.reportToRequester("proj-1", "done", "delivered");

  assert.equal(channel.queued.length, 3);
  assert.deepEqual(
    events.map((e) => e.type),
    ["team.mention.queued", "team.mention.queued", "team.report.queued"],
  );
  assert.equal(events[0].target, "tiangong-designer");
  assert.equal(events[2].disposition, "delivered");
});

test("createTeamChannel tolerates a missing evidence recorder", () => {
  const channel = createTeamChannel({ now: () => "2026-08-01T12:00:00Z" });
  assert.doesNotThrow(() => channel.notifyAssignee("w", "t", "d"));
  assert.equal(channel.queued.length, 1);
});

test("createLeaderSync.beforeRead is a tolerant no-op on the Leader write path", async () => {
  const sync = createLeaderSync();
  await assert.doesNotReject(() => sync.beforeRead());
});

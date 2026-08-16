import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyWorkRunRecovery } from "../agent/work/work-run-recovery.mjs";
import { WorkRunStore } from "../agent/work/work-run-store.mjs";

const NOW = [
  "2026-08-16T00:00:00Z",
  "2026-08-16T00:00:01Z",
  "2026-08-16T00:00:02Z",
  "2026-08-16T00:00:03Z",
  "2026-08-16T00:00:04Z",
];
const INPUT = {
  runId: "run-b5-recovery",
  taskId: "task-b5-recovery",
  role: "implementor",
  skillId: "implementor-controlled-implementation-v1",
  skillDigest: "d".repeat(64),
  objective: "prepare a bounded local change",
  scope: "src/change.mjs",
  completionContractDigest: "c".repeat(64),
  createdAt: NOW[0],
};

test("B5 classifies a restarted started WorkRun as recovery-required", () => {
  assert.deepEqual(classifyWorkRunRecovery({ phase: "executing", terminal: false }), {
    status: "recovery_required",
    action: "privileged-reconcile",
    phase: "executing",
    reasonCode: "WORK_RUN_OWNER_LOST",
  });
  assert.equal(classifyWorkRunRecovery({ phase: "executing", terminal: false }, { ownerPresent: true }).status, "owned");
  assert.equal(classifyWorkRunRecovery({ phase: "finalized", terminal: true }).action, "replay");
});

test("B5 persists one execution owner and refuses a second Worker after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-b5-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tick = 1;
  const first = new WorkRunStore({ directory: root, ownerId: "owner-first", now: () => NOW[tick++ % NOW.length] });
  await first.open(INPUT);
  await first.claim(INPUT.runId);
  await first.transition(INPUT.runId, "executing");

  const restarted = new WorkRunStore({ directory: root, ownerId: "owner-restarted", now: () => NOW[tick++ % NOW.length] });
  await assert.rejects(() => restarted.claim(INPUT.runId), (error) => error.code === "TIANGONG_WORK_RUN_OWNER_CONFLICT");
  const state = await restarted.read(INPUT.runId);
  assert.equal(classifyWorkRunRecovery(state).status, "recovery_required");
  await assert.rejects(() => restarted.reconcile(INPUT.runId), (error) => error.code === "TIANGONG_WORK_RUN_RECOVERY_UNAUTHORIZED");
});

test("B5 treats a started phase without a lease as unresolved instead of claiming it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-b5-owner-gap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new WorkRunStore({ directory: root, ownerId: "owner-first" });
  await first.open(INPUT);
  await first.transition(INPUT.runId, "executing");
  const restarted = new WorkRunStore({ directory: root, ownerId: "owner-restarted" });
  await assert.rejects(() => restarted.claim(INPUT.runId), (error) => error.code === "TIANGONG_WORK_RUN_RECOVERY_REQUIRED");
});

test("B5 privileged recovery records reconciliation before resuming and releases on finalization", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-b5-reconcile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tick = 1;
  const first = new WorkRunStore({ directory: root, ownerId: "owner-first", now: () => NOW[tick++ % NOW.length] });
  await first.open(INPUT);
  await first.claim(INPUT.runId);
  await first.transition(INPUT.runId, "executing");
  const restarted = new WorkRunStore({
    directory: root,
    ownerId: "owner-restarted",
    now: () => NOW[tick++ % NOW.length],
    authorizeRecovery: async () => true,
  });
  const resumed = await restarted.reconcile(INPUT.runId, { action: "resume" });
  assert.equal(resumed.phase, "executing");
  assert.equal(resumed.events.at(-2).toPhase, "blocked");
  assert.equal(resumed.events.at(-1).toPhase, "executing");
  await restarted.transition(INPUT.runId, "verifying");
  const finalized = await restarted.transition(INPUT.runId, "finalized");
  assert.equal(finalized.terminal, true);
  await restarted.release(INPUT.runId);
  const after = new WorkRunStore({ directory: root, ownerId: "owner-after" });
  await after.claim(INPUT.runId);
  assert.equal((await after.read(INPUT.runId)).phase, "finalized");
});

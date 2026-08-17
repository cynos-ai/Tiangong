import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkRunStore } from "../agent/work/work-run-store.mjs";
import {
  authorizeWorkRunRecovery,
  parseWorkRunRecoveryArguments,
  runWorkRunRecoveryCommand,
} from "../agent/work/work-run-recovery-cli.mjs";

const INPUT = {
  runId: "run-cli-recovery",
  taskId: "task-cli-recovery",
  role: "implementor",
  skillId: "implementor-controlled-implementation-v1",
  skillDigest: "d".repeat(64),
  objective: "recover a bounded local task",
  scope: "src/change.mjs",
  completionContractDigest: "c".repeat(64),
  createdAt: "2026-08-16T00:00:00Z",
};

function outputBuffer() {
  const chunks = [];
  return { chunks, write(value) { chunks.push(value); } };
}

test("B5 recovery CLI parses bounded operator commands and rejects unknown options", () => {
  assert.deepEqual(parseWorkRunRecoveryArguments([
    "reconcile", "run-1", "--action", "resume", "--actor", "ops@example.test", "--reason-code", "WORKER_RESTART",
  ]), {
    command: "reconcile", runId: "run-1", action: "resume", actor: "ops@example.test", reasonCode: "WORKER_RESTART",
  });
  assert.equal(parseWorkRunRecoveryArguments(["--help"]).help, true);
  assert.throws(() => parseWorkRunRecoveryArguments(["inspect", "run-1", "--actor", "ops"]), /Unsupported option/);
  assert.throws(() => parseWorkRunRecoveryArguments([
    "reconcile", "run-1", "--action", "resume", "--actor", "ops", "--reason-code", "bad code",
  ]), /reason-code is invalid/);
});
test("B5 recovery authorization requires deployment-owned operator mode and actor allowlist", () => {
  assert.throws(
    () => authorizeWorkRunRecovery({ env: {}, actor: "ops", reasonCode: "WORKER_RESTART" }),
    (error) => error.code === "TIANGONG_WORK_RUN_RECOVERY_UNAUTHORIZED",
  );
  assert.throws(
    () => authorizeWorkRunRecovery({
      env: { TIANGONG_WORK_RUN_RECOVERY_MODE: "operator", TIANGONG_WORK_RUN_RECOVERY_ACTORS: "other" },
      actor: "ops", reasonCode: "WORKER_RESTART",
    }),
    (error) => error.code === "TIANGONG_WORK_RUN_RECOVERY_UNAUTHORIZED",
  );
  assert.deepEqual(authorizeWorkRunRecovery({
    env: { TIANGONG_WORK_RUN_RECOVERY_MODE: "operator", TIANGONG_WORK_RUN_RECOVERY_ACTORS: "ops,backup" },
    actor: "ops", reasonCode: "WORKER_RESTART",
  }), { actor: "ops", reasonCode: "WORKER_RESTART" });
});

test("B5 recovery CLI performs an authorized resume and leaves the new owner lease", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-b5-recovery-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = new WorkRunStore({ directory, ownerId: "owner-before-restart" });
  await first.open(INPUT);
  await first.transition(INPUT.runId, "executing");

  const stdout = outputBuffer();
  await runWorkRunRecoveryCommand([
    "reconcile", INPUT.runId, "--action", "resume", "--actor", "ops", "--reason-code", "WORKER_RESTART",
  ], {
    env: {
      TIANGONG_WORK_RUN_DIR: directory,
      TIANGONG_WORK_RUN_RECOVERY_MODE: "operator",
      TIANGONG_WORK_RUN_RECOVERY_ACTORS: "ops",
      TIANGONG_WORK_RUN_RECOVERY_OWNER_ID: "owner-after-restart",
    },
    stdout,
  });
  const result = JSON.parse(stdout.chunks.join(""));
  assert.deepEqual({ action: result.action, actor: result.actor, phase: result.phase, terminal: result.terminal }, {
    action: "resume", actor: "ops", phase: "executing", terminal: false,
  });
  const after = new WorkRunStore({ directory, ownerId: "owner-after-restart" });
  const inspection = await after.inspect(INPUT.runId);
  assert.equal(inspection.ownerId, "owner-after-restart");
  assert.equal(inspection.state.events.at(-2).reason, "WORKER_RESTART");
  await after.transition(INPUT.runId, "verifying");
  await after.transition(INPUT.runId, "finalized");
  assert.equal((await after.inspect(INPUT.runId)).ownerPresent, true);
  await after.claim(INPUT.runId);
  assert.equal((await after.inspect(INPUT.runId)).ownerPresent, false);
});

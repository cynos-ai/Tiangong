import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RunnerJournal } from "../agent/runner/journal.mjs";
import { runCommand } from "../agent/runner/runner-port.mjs";

const request = {
  runId: "run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  command: ["node", "-e", "1+1"],
  cwd: "fixture",
  timeoutMs: 1000,
};

test("serializes one owner and replays a durable completed result after reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-openclaw-recovery-"));
  const filePath = join(directory, "runner.jsonl");
  let calls = 0;
  let release;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const executor = async () => {
    calls += 1;
    entered();
    await releasePromise;
    return { status: "completed", exitCode: 0, stdout: "bounded\n", stderr: "", durationMs: 1 };
  };

  try {
    const firstJournal = new RunnerJournal({ filePath });
    const first = runCommand(request, { executor, journal: firstJournal, env: {} });
    await enteredPromise;
    const concurrent = await runCommand(request, {
      executor: async () => {
        calls += 1;
        return { status: "completed", exitCode: 99, stdout: "must-not-run", stderr: "" };
      },
      journal: new RunnerJournal({ filePath }),
      env: {},
    });
    assert.equal(concurrent.outcome, "outcome_uncertain");
    assert.equal(concurrent.replayed, true);
    assert.equal(calls, 1);

    release();
    const completed = await first;
    assert.equal(completed.outcome, "completed");
    assert.equal(completed.replayed, false);
    assert.equal(calls, 1);

    const reopened = await runCommand(request, {
      executor: async () => {
        calls += 1;
        throw new Error("durable replay must not execute");
      },
      journal: new RunnerJournal({ filePath }),
      env: {},
    });
    assert.equal(reopened.outcome, "completed");
    assert.equal(reopened.replayed, true);
    assert.equal(reopened.stdout, "bounded\n");
    assert.equal(calls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

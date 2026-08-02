import assert from "node:assert/strict";
import { appendFile, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RunnerJournal } from "../agent/runner/journal.mjs";

const KEY = "a".repeat(64);
const REQUEST = "b".repeat(64);
const RESULT = Object.freeze({
  outcome: "completed",
  invocationKey: KEY,
  exitCode: 0,
  stdout: "ok\n",
  stderr: "",
  durationMs: 4,
});

async function withJournal(run) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-runner-journal-"));
  const filePath = join(root, "runner.jsonl");
  try {
    await run({ root, filePath, journal: new RunnerJournal({ filePath }) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("runner journal durably records executing before completion and replays terminal result", async () => {
  await withJournal(async ({ filePath, journal }) => {
    const begun = await journal.begin(KEY, REQUEST);
    assert.equal(begun.execute, true);
    assert.equal((await journal.lookup(KEY)).status, "executing");

    await journal.complete(KEY, REQUEST, RESULT);
    const reopened = new RunnerJournal({ filePath });
    const saved = await reopened.lookup(KEY);
    assert.equal(saved.status, "completed");
    assert.deepEqual(saved.result, RESULT);
    assert.equal((await reopened.begin(KEY, REQUEST)).execute, false);
    assert.equal((await reopened.begin("c".repeat(64), "d".repeat(64))).execute, true);

    const records = (await readFile(filePath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 3);
    assert.equal(records[1].previousHash, records[0].hash);
    assert.equal(records[1].sequence, 2);
  });
});

test("runner journal preserves outcome uncertainty and rejects conflicting transitions", async () => {
  await withJournal(async ({ journal }) => {
    await journal.begin(KEY, REQUEST);
    await journal.recordUncertain(KEY, REQUEST, "RUNNER_COMMAND_INTERRUPTED");
    const replay = await journal.begin(KEY, REQUEST);
    assert.equal(replay.execute, false);
    assert.equal(replay.entry.status, "outcome_uncertain");
    assert.equal(replay.entry.reason, "RUNNER_COMMAND_INTERRUPTED");
    await assert.rejects(
      () => journal.complete(KEY, REQUEST, RESULT),
      /outcome uncertain/u,
    );
    await assert.rejects(
      () => journal.begin(KEY, "c".repeat(64)),
      /request digest conflict/u,
    );
    await assert.rejects(
      () => journal.begin("c".repeat(64), "d".repeat(64)),
      /unresolved invocation/u,
    );
  });
});

test("runner journal serializes concurrent begin calls to one executor owner", async () => {
  await withJournal(async ({ filePath }) => {
    const left = new RunnerJournal({ filePath });
    const right = new RunnerJournal({ filePath });
    const results = await Promise.all([left.begin(KEY, REQUEST), right.begin(KEY, REQUEST)]);
    assert.equal(results.filter((result) => result.execute).length, 1);
    assert.equal(results.filter((result) => !result.execute).length, 1);
    assert.equal((await left.lookup(KEY)).status, "executing");
  });
});

test("runner journal fails closed on tampering, partial records, and unsafe permissions", async () => {
  await withJournal(async ({ filePath, journal }) => {
    await journal.begin(KEY, REQUEST);
    await appendFile(filePath, "{\"partial\":true}");
    await assert.rejects(() => journal.lookup(KEY), /partial record/u);
  });

  await withJournal(async ({ filePath, journal }) => {
    await journal.begin(KEY, REQUEST);
    const text = await readFile(filePath, "utf8");
    await writeFile(filePath, text.replace(`\"requestDigest\":\"${REQUEST}\"`, `\"requestDigest\":\"${"c".repeat(64)}\"`));
    await assert.rejects(() => journal.lookup(KEY), /Invalid runner journal/u);
  });

  await withJournal(async ({ filePath, journal }) => {
    await journal.begin(KEY, REQUEST);
    await chmod(filePath, 0o644);
    await journal.lookup(KEY);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  });
});

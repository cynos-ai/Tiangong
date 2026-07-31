import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { withFileLock } from "../agent/persistence/file-lock.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "tiangong-file-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "state.json");
}

const FAST_OPTIONS = {
  staleMilliseconds: 20,
  waitMilliseconds: 200,
  retryMilliseconds: 2,
};

test("file lock serializes independent callers", async (t) => {
  const filePath = await fixture(t);
  const events = [];
  let markEntered;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const first = withFileLock(filePath, async () => {
    events.push("first:start");
    markEntered();
    await delay(20);
    events.push("first:end");
  }, FAST_OPTIONS);
  await entered;
  const second = withFileLock(filePath, async () => {
    events.push("second:start");
    events.push("second:end");
  }, FAST_OPTIONS);
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("stale file lock from a crashed writer is reclaimed", async (t) => {
  const filePath = await fixture(t);
  const lockPath = `${filePath}.lock`;
  await mkdir(lockPath);
  const old = new Date(Date.now() - 1_000);
  await utimes(lockPath, old, old);

  let entered = false;
  await withFileLock(filePath, () => { entered = true; }, FAST_OPTIONS);
  assert.equal(entered, true);
});

import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";

import { canonicalJson, sha256 } from "../agent/canonical-json.mjs";
import {
  GENESIS_HASH,
  canTransition,
  createPhaseEvent,
  createWorkRun,
  isTerminalPhase,
  replayWorkRun,
} from "../agent/work/work-run.mjs";
import { WorkRunStore } from "../agent/work/work-run-store.mjs";

const CONTRACT = "c".repeat(64);
const NOW = ["2026-08-01T00:00:00Z", "2026-08-01T00:00:01Z", "2026-08-01T00:00:02Z", "2026-08-01T00:00:03Z"];

function baseRunInput(over = {}) {
  return {
    runId: "run-1",
    taskId: "task-1",
    role: "implementor",
    skillId: "implementor-controlled-implementation-v1",
    skillDigest: "d".repeat(64),
    objective: "implement the change in scope",
    scope: "src/change.mjs",
    completionContractDigest: CONTRACT,
    createdAt: NOW[0],
    ...over,
  };
}

// Minimal in-memory filesystem honoring wx/a flags for the store contract.
class MemFs {
  constructor() {
    this.files = new Map();
  }
  async mkdir() {}
  async readFile(p) {
    if (!this.files.has(p)) {
      const e = new Error("ENOENT");
      e.code = "ENOENT";
      throw e;
    }
    return this.files.get(p);
  }
  async writeFile(p, data, opts = {}) {
    if (opts.flag === "wx" && this.files.has(p)) {
      const e = new Error("EEXIST");
      e.code = "EEXIST";
      throw e;
    }
    if (opts.flag === "a") {
      this.files.set(p, (this.files.get(p) ?? "") + data);
      return;
    }
    this.files.set(p, data);
  }
  async appendFile(p, data) {
    this.files.set(p, (this.files.get(p) ?? "") + data);
  }
  async readdir(p) {
    const names = [];
    for (const key of this.files.keys()) {
      if (path.dirname(key) === p) names.push(path.basename(key));
    }
    return names;
  }
}

test("createWorkRun validates, freezes, and digests the binding", () => {
  const run = createWorkRun(baseRunInput({ inputRefs: ["input-1"] }));
  assert.equal(run.kind, "tiangong.work-run");
  assert.equal(run.phase, "planned");
  assert.equal(Object.isFrozen(run), true);
  assert.deepEqual(run.inputRefs, ["input-1"]);
  assert.match(run.contentDigest, /^[0-9a-f]{64}$/);
});

test("createWorkRun rejects an unsupported role and unsafe identifiers", () => {
  assert.throws(() => createWorkRun(baseRunInput({ role: "wizard" })), /Unsupported role/);
  assert.throws(() => createWorkRun(baseRunInput({ runId: "../escape" })), /runId has an invalid format/);
  assert.throws(() => createWorkRun(baseRunInput({ skillId: "../escape" })), /skillId has an invalid format/);
});

test("the phase machine allows the linear path and rejects illegal jumps", () => {
  assert.equal(canTransition("planned", "executing"), true);
  assert.equal(canTransition("executing", "waiting_approval"), true);
  assert.equal(canTransition("waiting_approval", "verifying"), true);
  assert.equal(canTransition("verifying", "finalized"), true);
  // blocked can resume or be abandoned
  assert.equal(canTransition("blocked", "executing"), true);
  assert.equal(canTransition("blocked", "abandoned"), true);
  // illegal: planned cannot jump to finalized
  assert.equal(canTransition("planned", "finalized"), false);
  // terminal phases admit nothing
  assert.equal(isTerminalPhase("finalized"), true);
  assert.equal(canTransition("finalized", "executing"), false);
});

test("createPhaseEvent accepts a legal transition and rejects an illegal one", () => {
  const event = createPhaseEvent({
    runId: "run-1",
    sequence: 1,
    fromPhase: "planned",
    toPhase: "executing",
    previousHash: GENESIS_HASH,
    at: NOW[1],
  });
  assert.equal(event.toPhase, "executing");
  assert.throws(
    () => createPhaseEvent({ runId: "run-1", sequence: 1, fromPhase: "planned", toPhase: "finalized", previousHash: GENESIS_HASH, at: NOW[1] }),
    /Illegal phase transition/,
  );
});

test("WorkRunStore.open is idempotent and rejects a conflicting binding", async () => {
  const fs = new MemFs();
  const store = new WorkRunStore({ directory: "/work", fs, now: () => NOW[1] });
  const first = await store.open(baseRunInput());
  assert.equal(first.phase, "planned");
  const again = await store.open(baseRunInput());
  assert.equal(again.binding.contentDigest, first.binding.contentDigest);
  // a different objective for the same runId is a conflict
  await assert.rejects(() => store.open(baseRunInput({ objective: "different" })), /different binding/);
});

test("WorkRunStore walks planned -> executing -> verifying -> finalized", async () => {
  const fs = new MemFs();
  let i = 1;
  const store = new WorkRunStore({ directory: "/work", fs, now: () => NOW[i++ % NOW.length] });
  await store.open(baseRunInput());
  let state = await store.transition("run-1", "executing");
  assert.equal(state.phase, "executing");
  state = await store.transition("run-1", "verifying");
  assert.equal(state.phase, "verifying");
  state = await store.transition("run-1", "finalized");
  assert.equal(state.phase, "finalized");
  assert.equal(state.terminal, true);
  // terminal run rejects further transition
  await assert.rejects(() => store.transition("run-1", "executing"), /terminal/);
});

test("WorkRunStore rejects an illegal transition", async () => {
  const fs = new MemFs();
  let i = 1;
  const store = new WorkRunStore({ directory: "/work", fs, now: () => NOW[i++ % NOW.length] });
  await store.open(baseRunInput());
  await assert.rejects(() => store.transition("run-1", "finalized"), /Illegal phase transition/);
});

test("a blocked run can resume to executing then finalize", async () => {
  const fs = new MemFs();
  let i = 1;
  const store = new WorkRunStore({ directory: "/work", fs, now: () => NOW[i++ % NOW.length] });
  await store.open(baseRunInput());
  await store.transition("run-1", "executing");
  await store.transition("run-1", "blocked", { reason: "awaiting-input" });
  let state = await store.transition("run-1", "executing");
  assert.equal(state.phase, "executing");
  state = await store.transition("run-1", "verifying");
  state = await store.transition("run-1", "finalized");
  assert.equal(state.phase, "finalized");
});

test("replay detects a broken hash chain and a tampered event digest", () => {
  const binding = createWorkRun(baseRunInput());
  const event = createPhaseEvent({
    runId: "run-1",
    sequence: 1,
    fromPhase: "planned",
    toPhase: "executing",
    previousHash: binding.contentDigest,
    at: NOW[1],
  });
  // well-formed replay
  assert.equal(replayWorkRun(binding, [event]).phase, "executing");
  assert.throws(
    () => replayWorkRun({ ...binding, objective: "tampered" }, []),
    /binding digest is invalid/,
  );
  // tampered event: change toPhase after digest computed
  const tampered = { ...event, toPhase: "finalized" };
  assert.throws(() => replayWorkRun(binding, [tampered]), /digest is invalid/);
  // broken chain: wrong previousHash
  const broken = { ...event, previousHash: "f".repeat(64), contentDigest: recompute(event, { previousHash: "f".repeat(64) }) };
  assert.throws(() => replayWorkRun(binding, [broken]), /breaks the hash chain/);
  // sequence gap
  const gapped = { ...event, sequence: 2 };
  assert.throws(() => replayWorkRun(binding, [gapped]), /sequence gap/);
  // A forged event with a fresh digest still cannot bypass the phase machine.
  const forgedTransition = { ...event, toPhase: "finalized" };
  forgedTransition.contentDigest = recompute(forgedTransition, {});
  assert.throws(() => replayWorkRun(binding, [forgedTransition]), /digest is invalid/);
});

test("WorkRunStore rejects unsafe run paths", async () => {
  const fs = new MemFs();
  const store = new WorkRunStore({ directory: "/work", fs });
  await assert.rejects(() => store.read("../escape"), /bounded WorkRun identifier/);
  await assert.rejects(() => store.latestForTask("../escape"), /bounded WorkRun identifier/);
});

test("latestForTask returns the most recent run for a task", async () => {
  const fs = new MemFs();
  const store = new WorkRunStore({ directory: "/work", fs, now: () => NOW[1] });
  await store.open(baseRunInput({ runId: "run-a", createdAt: NOW[0] }));
  await store.open(baseRunInput({ runId: "run-b", createdAt: NOW[3] }));
  const latest = await store.latestForTask("task-1");
  assert.equal(latest.binding.runId, "run-b");
  assert.equal(await store.latestForTask("nope"), undefined);
});

test("latestForTask rejects symlinked and misnamed binding files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-work-run-"));
  try {
    const store = new WorkRunStore({ directory });
    const binding = await store.open(baseRunInput());
    await symlink(join(directory, "run-1.binding.json"), join(directory, "foreign.binding.json"));
    await assert.rejects(() => store.latestForTask("task-1"), /regular file/);
    await rm(join(directory, "foreign.binding.json"));
    await writeFile(join(directory, "foreign.binding.json"), `${JSON.stringify(binding.binding)}\n`, { mode: 0o600 });
    await assert.rejects(() => store.latestForTask("task-1"), /file name does not match runId/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("WorkRunStore serializes concurrent transitions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-work-run-lock-"));
  try {
    const first = new WorkRunStore({ directory });
    const second = new WorkRunStore({ directory });
    await first.open(baseRunInput());
    const outcomes = await Promise.allSettled([
      first.transition("run-1", "executing"),
      second.transition("run-1", "executing"),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    assert.equal((await first.read("run-1")).events.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function recompute(event, over) {
  const { contentDigest, ...rest } = { ...event, ...over };
  return sha256(canonicalJson(rest));
}

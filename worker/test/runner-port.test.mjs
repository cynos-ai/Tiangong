import assert from "node:assert/strict";
import test from "node:test";

import { runCommand, runnerRunIdForTask } from "../agent/runner/runner-port.mjs";
import {
  FORBIDDEN_ENV_KEYS,
  assertNoForbiddenEnv,
  validateCommandRequest,
} from "../agent/runner/runner-policy.mjs";

const RUN_ID = "run-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function validRequest(overrides = {}) {
  return { runId: RUN_ID, command: ["node", "-e", "1+1"], cwd: "fixture", timeoutMs: 1000, ...overrides };
}

function memoryJournal() {
  const entries = new Map();
  return {
    entries,
    async begin(key, requestDigest) {
      const entry = entries.get(key);
      if (entry) {
        if (entry.requestDigest !== requestDigest) throw new Error("request conflict");
        return { execute: false, entry };
      }
      const started = { status: "executing", invocationKey: key, requestDigest };
      entries.set(key, started);
      return { execute: true, entry: started };
    },
    async complete(key, requestDigest, result) {
      const entry = entries.get(key);
      if (entry?.status !== "executing" || entry.requestDigest !== requestDigest) throw new Error("not executing");
      entries.set(key, { ...entry, status: "completed", result });
    },
    async recordUncertain(key, requestDigest, reason) {
      const entry = entries.get(key);
      if (entry?.status !== "executing" || entry.requestDigest !== requestDigest) throw new Error("not executing");
      entries.set(key, { ...entry, status: "outcome_uncertain", reason });
    },
  };
}

test("runner run identity is derived from the immutable Task binding digest", () => {
  assert.equal(
    runnerRunIdForTask({ contentDigest: "0123456789abcdef0123456789abcdef".repeat(2) }),
    "run-01234567-89ab-4def-8123-456789abcdef",
  );
  assert.throws(() => runnerRunIdForTask({ contentDigest: "mutable" }), /immutable content digest/u);
});

test("validateCommandRequest accepts a bounded command and rejects unsafe shapes", () => {
  assert.equal(validateCommandRequest(validRequest()).command.join(" "), "node -e 1+1");
  assert.throws(() => validateCommandRequest(validRequest({ command: [] })), /non-empty/u);
  assert.throws(() => validateCommandRequest(validRequest({ command: ["", "x"] })), /non-empty/u);
  assert.throws(() => validateCommandRequest(validRequest({ command: "node" })), /non-empty/u);
  assert.throws(() => validateCommandRequest(validRequest({ cwd: "/etc" })), /relative path/u);
  assert.throws(() => validateCommandRequest(validRequest({ cwd: "../escape" })), /relative path/u);
  assert.throws(() => validateCommandRequest(validRequest({ runId: "not-a-run" })), /run-scoped uuid/u);
  assert.throws(() => validateCommandRequest(validRequest({ timeoutMs: 0 })), /positive integer/u);
  assert.throws(() => validateCommandRequest(validRequest({ timeoutMs: 10 * 60 * 1000 })), /positive integer/u);
});

test("the isolation policy declares the control-plane and credential boundaries", () => {
  assert.ok(FORBIDDEN_ENV_KEYS.includes("AGENTTEAMS_LLM_API_KEY"));
  assert.ok(FORBIDDEN_ENV_KEYS.includes("AGENTTEAMS_AUTH_TOKEN"));
});

test("assertNoForbiddenEnv rejects credential keys and secret-looking values", () => {
  assert.throws(
    () => assertNoForbiddenEnv({ AGENTTEAMS_LLM_API_KEY: "x" }),
    /Forbidden credential key/u,
  );
  assert.throws(
    () => assertNoForbiddenEnv({ CUSTOM_TOKEN: "X".repeat(48) }),
    /looks like a secret/u,
  );
  assert.throws(
    () => assertNoForbiddenEnv({ lower: "value" }),
    /bounded strings/u,
  );
  assert.throws(
    () => assertNoForbiddenEnv(Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`KEY_${index}`, "x"]))),
    /too many keys/u,
  );
  assert.throws(
    () => assertNoForbiddenEnv({ TOO_LARGE: "x".repeat(4097) }),
    /exceeds its bound/u,
  );
  assertNoForbiddenEnv({ PATH: "/usr/bin", NODE_ENV: "test" });
});

test("a completed command is recorded and replayed without re-execution", async () => {
  let calls = 0;
  const executor = async () => {
    calls += 1;
    return { status: "completed", exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 12 };
  };
  const journal = memoryJournal();
  const first = await runCommand(validRequest(), { executor, journal, env: {} });
  assert.equal(first.outcome, "completed");
  assert.equal(first.replayed, false);
  assert.equal(calls, 1);
  const replay = await runCommand(validRequest(), { executor, journal, env: {} });
  assert.equal(replay.outcome, "completed");
  assert.equal(replay.replayed, true);
  assert.equal(calls, 1);
  assert.equal(replay.exitCode, first.exitCode);
});

test("an interrupted command is outcome_uncertain and is never retried", async () => {
  let calls = 0;
  const executor = async () => {
    calls += 1;
    return { status: "interrupted", exitCode: null };
  };
  const journal = memoryJournal();
  const result = await runCommand(validRequest(), { executor, journal, env: {} });
  assert.equal(result.outcome, "outcome_uncertain");
  assert.equal(calls, 1);
  // replay of an uncertain command must NOT replay a saved success and must NOT retry
  const again = await runCommand(validRequest(), { executor, journal, env: {} });
  assert.equal(again.outcome, "outcome_uncertain");
  assert.equal(calls, 1);
  assert.equal([...journal.entries.values()].filter((entry) => entry.status === "outcome_uncertain").length, 1);
});

test("an executing journal record blocks automatic retry after interruption", async () => {
  let calls = 0;
  const journal = memoryJournal();
  const request = validRequest();
  const first = await runCommand(request, {
    executor: async () => {
      calls += 1;
      throw new Error("simulated process death");
    },
    journal,
    env: {},
  });
  assert.equal(first.reason, "RUNNER_EXECUTOR_FAILED");
  // Simulate a process that died after begin but before it could record uncertainty.
  const entry = [...journal.entries.values()][0];
  entry.status = "executing";
  delete entry.reason;
  const replay = await runCommand(request, {
    executor: async () => { calls += 1; },
    journal,
    env: {},
  });
  assert.equal(replay.reason, "RUNNER_EXECUTION_IN_PROGRESS_OR_INTERRUPTED");
  assert.equal(calls, 1);
});

test("timeout and output bounds participate in invocation identity", async () => {
  let calls = 0;
  const journal = memoryJournal();
  const executor = async () => ({ status: "completed", exitCode: calls++, stdout: "", stderr: "" });
  const first = await runCommand(validRequest(), { executor, journal, env: {} });
  const second = await runCommand(validRequest({ timeoutMs: 2000 }), { executor, journal, env: {} });
  const third = await runCommand(validRequest({ outputLimitBytes: 1000 }), { executor, journal, env: {} });
  assert.notEqual(first.invocationKey, second.invocationKey);
  assert.notEqual(first.invocationKey, third.invocationKey);
  assert.equal(calls, 3);
});

test("an executor throw is treated as outcome_uncertain", async () => {
  const executor = async () => {
    throw new Error("runner vanished");
  };
  const journal = memoryJournal();
  const result = await runCommand(validRequest(), { executor, journal, env: {} });
  assert.equal(result.outcome, "outcome_uncertain");
  assert.equal(result.reason, "RUNNER_EXECUTOR_FAILED");
});

test("runCommand stays unavailable without a validated disposable executor and explicit env", async () => {
  await assert.rejects(
    () => runCommand(validRequest(), { env: {} }),
    (error) => error?.code === "TIANGONG_RUNNER_UNAVAILABLE",
  );
  await assert.rejects(
    () => runCommand(validRequest(), { executor: async () => ({ status: "completed", exitCode: 0 }) }),
    /explicit sanitized environment/u,
  );
});

test("runCommand refuses to execute when a forbidden credential is injected", async () => {
  let calls = 0;
  const executor = async () => {
    calls += 1;
    return { status: "completed", exitCode: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(
    () => runCommand(validRequest(), { executor, env: { AGENTTEAMS_LLM_API_KEY: "leaked" } }),
    /Forbidden credential key/u,
  );
  assert.equal(calls, 0);
});

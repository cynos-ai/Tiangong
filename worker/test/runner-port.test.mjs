import assert from "node:assert/strict";
import test from "node:test";

import { runCommand } from "../agent/runner/runner-port.mjs";
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
  const records = new Map();
  const uncertain = new Map();
  return {
    records,
    uncertain,
    lookup: async (key) => {
      if (records.has(key)) return { status: "completed", result: records.get(key) };
      if (uncertain.has(key)) return { status: "outcome_uncertain", reason: uncertain.get(key).reason };
      return undefined;
    },
    record: async (key, result) => {
      records.set(key, result);
    },
    recordUncertain: async (key, reason) => {
      uncertain.set(key, { reason });
    },
  };
}

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
  assertNoForbiddenEnv({ PATH: "/usr/bin", NODE_ENV: "test" });
});

test("a completed command is recorded and replayed without re-execution", async () => {
  let calls = 0;
  const executor = async () => {
    calls += 1;
    return { status: "completed", exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 12 };
  };
  const journal = memoryJournal();
  const first = await runCommand(validRequest(), { executor, journal });
  assert.equal(first.outcome, "completed");
  assert.equal(first.replayed, false);
  assert.equal(calls, 1);
  const replay = await runCommand(validRequest(), { executor, journal });
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
  const result = await runCommand(validRequest(), { executor, journal });
  assert.equal(result.outcome, "outcome_uncertain");
  assert.equal(calls, 1);
  // replay of an uncertain command must NOT replay a saved success and must NOT retry
  const again = await runCommand(validRequest(), { executor, journal });
  assert.equal(again.outcome, "outcome_uncertain");
  assert.equal(calls, 1);
  assert.equal(journal.uncertain.size, 1);
});

test("an executor throw is treated as outcome_uncertain", async () => {
  const executor = async () => {
    throw new Error("runner vanished");
  };
  const journal = memoryJournal();
  const result = await runCommand(validRequest(), { executor, journal });
  assert.equal(result.outcome, "outcome_uncertain");
  assert.match(result.reason, /runner vanished/u);
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

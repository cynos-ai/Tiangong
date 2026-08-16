import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalJson, sha256 } from "../agent/canonical-json.mjs";
import { createNativeRunnerBinding, createNativeRunnerExecDenyHook, createNativeRunnerTool, registerNativeRunnerTool, validateNativeRunnerBinding } from "../agent/team/native-runner-tool.mjs";

const MEMBER_ID = "member-native-runner";
const binding = createNativeRunnerBinding({
  taskId: "task-native-runner",
  workId: "work-native-runner",
  assigneeMemberId: MEMBER_ID,
  role: "implementor",
  runId: "run-12345678-1234-4123-8123-123456789abc",
});

function fakeFetch(calls) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const parsed = JSON.parse(init.body);
    if (String(url).endsWith("/v1/plan")) {
      const plan = {
        schemaVersion: 1,
        taskId: binding.taskId,
        runId: binding.runId,
        command: ["node", "probe.mjs"],
        cwd: "scratch/revision",
        timeoutMs: 30_000,
        outputLimitBytes: 65_536,
      };
      return new Response(JSON.stringify({ ...plan, contentDigest: sha256(canonicalJson(plan)) }), { status: 200 });
    }
    assert.equal(parsed.taskId, binding.taskId);
    return new Response(JSON.stringify({
      status: "completed",
      exitCode: 0,
      stdout: "native runner ok",
      stderr: "",
      durationMs: 12,
      runnerEvidence: {
        schemaVersion: 1,
        runId: binding.runId,
        invocationKey: parsed.invocationKey,
        imageId: `sha256:${"b".repeat(64)}`,
        policyDigest: "c".repeat(64),
        containerConfigDigest: "d".repeat(64),
        fixtureDigest: "e".repeat(64),
        executionPlanDigest: sha256(canonicalJson({
          schemaVersion: 1,
          taskId: binding.taskId,
          runId: binding.runId,
          command: ["node", "probe.mjs"],
          cwd: "scratch/revision",
          timeoutMs: 30_000,
          outputLimitBytes: 65_536,
        })),
      },
    }), { status: 200 });
  };
}

test("native Runner binding is digest-bound and rejects tampering", () => {
  assert.deepEqual(validateNativeRunnerBinding(binding), binding);
  assert.throws(() => validateNativeRunnerBinding({ ...binding, workId: "other-work" }), /digest mismatch/u);
  assert.throws(() => validateNativeRunnerBinding({ ...binding, assigneeMemberId: "other-member" }), /digest mismatch/u);
});

test("native Runner tool accepts only the assigned Task and broker-authored plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-native-runner-"));
  const bindingFile = join(root, "binding.json");
  await writeFile(bindingFile, `${JSON.stringify(binding)}\n`, { mode: 0o600 });
  const calls = [];
  const tool = createNativeRunnerTool({
    bindingFile,
    journalFile: join(root, "journal.jsonl"),
    endpoint: "http://runner-broker:8787/v1/execute",
    memberId: MEMBER_ID,
    fetchImpl: fakeFetch(calls),
  });
  const result = await tool.execute("call-1", { taskId: binding.taskId });
  assert.match(result.content[0].text, /native runner ok/u);
  assert.equal(result.details.taskId, binding.taskId);
  assert.equal(result.details.workId, binding.workId);
  assert.equal(calls.length, 2);
  await assert.rejects(() => tool.execute("call-2", { taskId: "other-task" }), /not assigned/u);
});

test("native Runner registration is opt-in and exposes one bounded tool", () => {
  const registrations = [];
  assert.deepEqual(registerNativeRunnerTool({ registerTool: (...args) => registrations.push(args) }, { env: {} }), { enabled: false });
  assert.throws(() => registerNativeRunnerTool({ registerTool: () => {}, on: () => {} }, {
    env: { TIANGONG_NATIVE_RUNNER_ENABLED: "1", AGENTTEAMS_WORKER_NAME: "worker-native-runner" },
  }), /generic host-side exec to be denied/u);
  assert.throws(() => registerNativeRunnerTool({ registerTool: () => {}, on: () => {} }, {
    env: {
      TIANGONG_NATIVE_RUNNER_ENABLED: "1",
      AGENTTEAMS_WORKER_NAME: "worker-native-runner",
      TIANGONG_NATIVE_RUNNER_EXEC_POLICY: "deny",
      TIANGONG_RUNNER_BINDING_FILE: "binding.json",
      TIANGONG_NATIVE_RUNNER_JOURNAL_FILE: join(tmpdir(), "journal.jsonl"),
      TIANGONG_MEMBER_ID: MEMBER_ID,
    },
  }), /binding file, journal file/u);
  const hooks = [];
  const enabled = registerNativeRunnerTool({ registerTool: (...args) => registrations.push(args), on: (...args) => hooks.push(args) }, {
    env: {
      TIANGONG_NATIVE_RUNNER_ENABLED: "1",
      AGENTTEAMS_WORKER_NAME: "worker-native-runner",
      TIANGONG_RUNNER_BINDING_FILE: join(tmpdir(), "binding.json"),
      TIANGONG_NATIVE_RUNNER_JOURNAL_FILE: join(tmpdir(), "journal.jsonl"),
      TIANGONG_NATIVE_RUNNER_EXEC_POLICY: "deny",
      TIANGONG_MEMBER_ID: MEMBER_ID,
    },
  });
  assert.deepEqual(enabled, { enabled: true, tool: "tiangong_run_command", hooks: ["before_tool_call"] });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0][1].name, "tiangong_run_command");
  assert.equal(hooks[0][0], "before_tool_call");
});

test("native Runner deny hook blocks generic host execution but keeps the bounded tool", async () => {
  const hook = createNativeRunnerExecDenyHook();
  assert.deepEqual(await hook({ toolName: "exec" }), { block: true, blockReason: "TIANGONG_NATIVE_RUNNER_EXEC_DENIED: use tiangong_run_command for the assigned Task" });
  assert.deepEqual(await hook({ toolName: "process_start" }), { block: true, blockReason: "TIANGONG_NATIVE_RUNNER_EXEC_DENIED: use tiangong_run_command for the assigned Task" });
  assert.equal(await hook({ toolName: "tiangong_run_command" }), undefined);
});

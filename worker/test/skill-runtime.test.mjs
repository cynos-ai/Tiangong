import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createToolResultCaptureHook } from "../agent/gates/tool-result-capture.mjs";
import { createAgentPackageRuntime, registerAgentPackageRuntime } from "../agent/skills/runtime.mjs";

function env(overrides = {}) {
  return { TIANGONG_MEMBER_ID: "developer-1", TIANGONG_MEMBER_RESPONSIBILITY: "developer", TIANGONG_MEMBER_RUNTIME: "openclaw-built-in", TIANGONG_MEMBER_MODEL: "glm-5", TIANGONG_MEMBER_REVISION: "1", TIANGONG_SELECTED_MODEL: "glm-5", OPENCLAW_AGENT_HARNESS_FALLBACK: "none", TIANGONG_MEMBER_AGENT_PACKAGE_ID: "tiangong-developer", TIANGONG_MEMBER_AGENT_PACKAGE_VERSION: "1.0.0", TIANGONG_MEMBER_ALLOWED_SKILLS: "test-driven-development", ...overrides };
}

test("M2 prompt exposes only effective Skill descriptions and Agent selects an allowed Skill", async () => {
  const runtime = createAgentPackageRuntime({ env: env() });
  const prompt = await runtime.beforePromptBuild({}, { sessionKey: "session-task-1" });
  assert.match(prompt.prependContext, /tiangong-developer@1\.0\.0/u);
  assert.match(prompt.prependContext, /test-driven-development@1\.0\.0/u);
  assert.doesNotMatch(prompt.prependContext, /scenario-testing@1\.0\.0/u);
  const used = await runtime.skillTool.execute("call-1", { skillId: "test-driven-development", trigger: "The assigned Task requires a reproduced failure and local code change." });
  assert.equal(used.details.skillUse.skillId, "test-driven-development");
  assert.match(used.details.skillUse.contentDigest, /^[a-f0-9]{64}$/u);
  assert.match(used.content[0].text, /Reproduce the failure/u);
  await assert.rejects(() => runtime.skillTool.execute("call-2", { skillId: "scenario-testing", trigger: "test" }), (error) => error.code === "SKILL_NOT_ALLOWED");
  assert.equal(await runtime.beforeToolCall({ toolName: "tiangong_use_skill" }), undefined);
  for (const toolName of ["read", "write", "edit", "exec", "process"]) assert.equal(await runtime.beforeToolCall({ toolName }), undefined);
  for (const toolName of ["bash", "tiangong_run_command", "web_search"]) assert.match((await runtime.beforeToolCall({ toolName })).blockReason, /TOOL_DENIED/u);
  for (const role of ["architect", "challenger", "reviewer", "tester"]) {
    const professional = createAgentPackageRuntime({ env: env({ TIANGONG_MEMBER_ID: `${role}-1`, TIANGONG_MEMBER_RESPONSIBILITY: role, TIANGONG_MEMBER_AGENT_PACKAGE_ID: `tiangong-${role}`, TIANGONG_MEMBER_ALLOWED_SKILLS: role === "architect" ? "work-planning" : role === "challenger" ? "plan-challenge" : role === "reviewer" ? "independent-code-review" : "scenario-testing" }) });
    for (const toolName of ["read", "write", "edit", "exec", "process"]) assert.equal(await professional.beforeToolCall({ toolName }), undefined);
    assert.match((await professional.beforeToolCall({ toolName: "web_fetch" })).blockReason, /TOOL_DENIED/u);
  }
  const leader = createAgentPackageRuntime({ env: env({ TIANGONG_MEMBER_ID: "leader-1", TIANGONG_MEMBER_RESPONSIBILITY: "leader", TIANGONG_MEMBER_AGENT_PACKAGE_ID: "tiangong-leader", TIANGONG_MEMBER_ALLOWED_SKILLS: "work-coordination" }) });
  assert.match((await leader.beforeToolCall({ toolName: "read" })).blockReason, /TOOL_DENIED/u);
  assert.equal(await leader.beforeToolCall({ toolName: "tiangong_read_work" }), undefined);
});

test("every prompt and tool call fails closed when the current Worker model drifts", async () => {
  const runtime = createAgentPackageRuntime({ env: env({ TIANGONG_SELECTED_MODEL: "other-model" }) });
  await assert.rejects(() => runtime.beforePromptBuild({}, { sessionKey: "session-model-drift" }), (error) => error.reasonCode === "MODEL_CONFIG_MISMATCH");
  await assert.rejects(() => runtime.beforeToolCall({ toolName: "read" }), (error) => error.reasonCode === "MODEL_CONFIG_MISMATCH");
});

test("Skill selection is captured as bounded ToolResult execution metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tiangong-skill-runtime-")); t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(root, { recursive: true, force: true }); });
  const runtime = createAgentPackageRuntime({ env: env() });
  const result = await runtime.skillTool.execute("call-skill", { skillId: "test-driven-development", trigger: "Implement the assigned change with a failing test." });
  const capture = createToolResultCaptureHook({ filePath: join(root, "tool-results.json"), now: () => new Date("2026-08-19T00:00:01.000Z") });
  await capture({ toolName: "tiangong_use_skill", toolCallId: "call-skill", result, message: { role: "toolResult", content: result.content } }, { actorId: "developer-1", sessionKey: "session-task-1", workId: "work-1", taskId: "task-1" });
  const state = JSON.parse(await readFile(join(root, "tool-results.json"), "utf8")); const record = state.results[0];
  assert.equal(record.tool, "tiangong_use_skill");
  assert.equal(record.resultSummary.skillId, "test-driven-development");
  assert.equal(record.resultSummary.skillVersion, "1.0.0");
  assert.equal(record.resultSummary.skillContentDigest, result.details.skillUse.contentDigest);
  assert.equal(JSON.stringify(record).includes(result.content[0].text), false);
});

test("OpenClaw registration adds one Agent hook and one autonomous Skill tool", () => {
  const hooks = []; const tools = [];
  const result = registerAgentPackageRuntime({ on(name) { hooks.push(name); }, registerTool(factory, options) { tools.push({ tool: factory(), options }); } }, { env: env() });
  assert.deepEqual(result, { enabled: true, hooks: ["before_prompt_build", "before_tool_call"], tools: ["tiangong_use_skill"] });
  assert.deepEqual(hooks, ["before_prompt_build", "before_tool_call"]); assert.equal(tools[0].tool.name, "tiangong_use_skill");
});

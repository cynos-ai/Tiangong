import assert from "node:assert/strict";
import test from "node:test";
import { assertMemberRuntimeRoute, RESPONSIBILITY_RUNTIME_MATRIX, runtimeRouteFromEnvironment } from "../agent/runtime-routing.mjs";

test("M0 non-coding responsibilities use built-in runtime with fixed MemberConfig model", () => {
  for (const responsibility of ["leader", "architect", "challenger", "reviewer", "tester"]) {
    const route = assertMemberRuntimeRoute({ responsibility, configuredRuntime: "openclaw-built-in", configuredModel: "deepseek-chat", selectedRuntime: "openclaw-built-in", selectedModel: "deepseek-chat" });
    assert.equal(route.coding, false); assert.equal(RESPONSIBILITY_RUNTIME_MATRIX[responsibility].runtime, "openclaw-built-in");
  }
});

test("M0 Developer uses Codex app-server and DeepSeek Flash with no fallback", () => {
  const route = runtimeRouteFromEnvironment({ TIANGONG_MEMBER_RESPONSIBILITY: "developer", TIANGONG_MEMBER_RUNTIME: "codex-app-server", TIANGONG_MEMBER_MODEL: "deepseek-v4-flash", TIANGONG_CODEX_RUNTIME: "1", TIANGONG_CODEX_MODEL: "deepseek-v4-flash", OPENCLAW_AGENT_HARNESS_FALLBACK: "none" });
  assert.equal(route.runtime, "codex-app-server"); assert.equal(route.model, "deepseek-v4-flash"); assert.equal(route.coding, true);
});

test("runtime, model, fallback, and unsupported responsibility fail closed", () => {
  assert.throws(() => assertMemberRuntimeRoute({ responsibility: "leader", configuredRuntime: "openclaw-built-in", configuredModel: "deepseek-chat", selectedRuntime: "codex-app-server", selectedModel: "deepseek-chat" }), (error) => error.reasonCode === "RUNTIME_CONFIG_MISMATCH");
  assert.throws(() => assertMemberRuntimeRoute({ responsibility: "developer", configuredRuntime: "codex-app-server", configuredModel: "deepseek-v4-flash", selectedRuntime: "codex-app-server", selectedModel: "deepseek-v4-pro" }), (error) => error.reasonCode === "MODEL_CONFIG_MISMATCH");
  assert.throws(() => assertMemberRuntimeRoute({ responsibility: "developer", configuredRuntime: "codex-app-server", configuredModel: "deepseek-v4-flash", selectedRuntime: "codex-app-server", selectedModel: "deepseek-v4-flash", fallback: "automatic" }), (error) => error.reasonCode === "FALLBACK_FORBIDDEN");
  assert.throws(() => assertMemberRuntimeRoute({ responsibility: "operator", configuredRuntime: "openclaw-built-in", configuredModel: "deepseek-chat", selectedRuntime: "openclaw-built-in", selectedModel: "deepseek-chat" }), (error) => error.reasonCode === "RESPONSIBILITY_UNSUPPORTED");
});

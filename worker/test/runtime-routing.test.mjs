import assert from "node:assert/strict";
import test from "node:test";
import { assertMemberRuntimeRoute, RESPONSIBILITY_RUNTIME_MATRIX, runtimeRouteFromEnvironment } from "../agent/runtime-routing.mjs";

test("all initial responsibilities use OpenClaw built-in with the current GLM-5 Worker model", () => {
  for (const responsibility of ["leader", "architect", "challenger", "developer", "reviewer", "tester"]) {
    const route = assertMemberRuntimeRoute({ responsibility, configuredRuntime: "openclaw-built-in", configuredModel: "glm-5", selectedRuntime: "openclaw-built-in", selectedModel: "glm-5" });
    assert.equal(route.coding, responsibility === "developer");
    assert.equal(RESPONSIBILITY_RUNTIME_MATRIX[responsibility].runtime, "openclaw-built-in");
  }
});

test("Developer resolves the built-in GLM-5 route with no fallback", () => {
  const route = runtimeRouteFromEnvironment({ TIANGONG_MEMBER_RESPONSIBILITY: "developer", TIANGONG_MEMBER_RUNTIME: "openclaw-built-in", TIANGONG_MEMBER_MODEL: "glm-5", AGENTTEAMS_MODEL: "glm-5", OPENCLAW_AGENT_HARNESS_FALLBACK: "none" });
  assert.equal(route.runtime, "openclaw-built-in");
  assert.equal(route.model, "glm-5");
  assert.equal(route.coding, true);
});

test("runtime, model, fallback, and unsupported responsibility fail closed", () => {
  assert.throws(() => assertMemberRuntimeRoute({ responsibility: "leader", configuredRuntime: "openclaw-built-in", configuredModel: "glm-5", selectedRuntime: "codex-app-server", selectedModel: "glm-5" }), (error) => error.reasonCode === "RUNTIME_CONFIG_MISMATCH");
  assert.throws(() => assertMemberRuntimeRoute({ responsibility: "developer", configuredRuntime: "openclaw-built-in", configuredModel: "glm-5", selectedRuntime: "openclaw-built-in", selectedModel: "other-model" }), (error) => error.reasonCode === "MODEL_CONFIG_MISMATCH");
  assert.throws(() => assertMemberRuntimeRoute({ responsibility: "developer", configuredRuntime: "openclaw-built-in", configuredModel: "glm-5", selectedRuntime: "openclaw-built-in", selectedModel: "glm-5", fallback: "automatic" }), (error) => error.reasonCode === "FALLBACK_FORBIDDEN");
  assert.throws(() => assertMemberRuntimeRoute({ responsibility: "operator", configuredRuntime: "openclaw-built-in", configuredModel: "glm-5", selectedRuntime: "openclaw-built-in", selectedModel: "glm-5" }), (error) => error.reasonCode === "RESPONSIBILITY_UNSUPPORTED");
});

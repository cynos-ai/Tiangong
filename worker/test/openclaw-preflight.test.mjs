import test from "node:test";
import assert from "node:assert/strict";

import {
  assertPluginApi,
  assertPluginConfig,
  checkControlApi,
  runOpenClawPreflight,
  PreflightError,
} from "../agent/preflight/openclaw-preflight.mjs";

const config = {
  plugins: {
    load: { paths: ["/opt/tiangong-worker/plugin"] },
    entries: { "tiangong-pi": { enabled: true } },
  },
};

test("requires the OpenClaw harness registration API", () => {
  assert.deepEqual(assertPluginApi({ registerAgentHarness() {} }), {
    pluginId: "tiangong-pi",
    harnessRegistration: "available",
  });
  assert.deepEqual(assertPluginApi({ on() {} }, { nativeRuntime: true }), {
    pluginId: "tiangong-pi",
    harnessRegistration: "not-required",
  });
  assert.throws(() => assertPluginApi({}), (error) =>
    error instanceof PreflightError && error.code === "plugin-api-unavailable");
});

test("requires the Tiangong plugin to be loaded and enabled", () => {
  assert.deepEqual(assertPluginConfig(config), {
    pluginId: "tiangong-pi",
    pluginPath: "/opt/tiangong-worker/plugin",
    pluginEnabled: true,
    runtimeLane: "legacy-v0.2",
    conversationHooks: false,
  });
  assert.throws(() => assertPluginConfig({}), (error) =>
    error instanceof PreflightError && error.code === "required-plugin-not-loaded");
  assert.throws(() => assertPluginConfig({ plugins: { load: { paths: ["/opt/tiangong-worker/plugin"] }, entries: { "tiangong-pi": { enabled: false } } } }), (error) =>
    error instanceof PreflightError && error.code === "required-plugin-disabled");
});

test("binds the canary lane explicitly and rejects cross-lane configuration", () => {
  const canary = {
    plugins: {
      load: { paths: ["/opt/tiangong-worker/plugin"] },
      entries: { "tiangong-pi": { enabled: true, config: { runtimeLane: "openclaw-canary" } } },
    },
  };
  assert.equal(assertPluginConfig(canary, { env: { TIANGONG_CANARY_REQUIRED: "1" } }).runtimeLane, "openclaw-canary");
  assert.throws(
    () => assertPluginConfig(config, { env: { TIANGONG_CANARY_REQUIRED: "1" } }),
    (error) => error instanceof PreflightError && error.code === "canary-lane-required",
  );
  assert.throws(
    () => assertPluginConfig(canary, { env: { TIANGONG_RUNTIME_LANE: "legacy-v0.2" } }),
    (error) => error instanceof PreflightError && error.code === "runtime-lane-mismatch",
  );
  assert.throws(
    () => assertPluginConfig({ plugins: { load: { paths: ["/opt/tiangong-worker/plugin"] }, entries: { "tiangong-pi": { enabled: true, config: { runtimeLane: "unknown" } } } } }),
    (error) => error instanceof PreflightError && error.code === "runtime-lane-invalid",
  );
});

test("keeps the control API optional for the legacy lane", async () => {
  assert.deepEqual(await checkControlApi({ env: {} }), { controlApi: "disabled" });
});

test("fails closed when a required control API is missing, late, or unhealthy", async () => {
  await assert.rejects(
    checkControlApi({ env: { TIANGONG_CONTROL_API_REQUIRED: "1" } }),
    (error) => error instanceof PreflightError && error.code === "control-api-url-missing",
  );
  await assert.rejects(
    checkControlApi({
      env: { TIANGONG_CONTROL_API_REQUIRED: "1", TIANGONG_CONTROL_API_URL: "http://control.test/health" },
      fetchImpl: async (_url, { signal }) => {
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      },
      timeoutMs: 5,
    }),
    (error) => error instanceof PreflightError && error.code === "control-api-timeout",
  );
  await assert.rejects(
    checkControlApi({
      env: { TIANGONG_CONTROL_API_REQUIRED: "1", TIANGONG_CONTROL_API_URL: "http://control.test/health" },
      fetchImpl: async () => ({ status: 503 }),
    }),
    (error) => error instanceof PreflightError && error.code === "control-api-unready",
  );
});

test("accepts only a bounded 2xx control API readiness response", async () => {
  const result = await runOpenClawPreflight({
    config,
    env: { TIANGONG_CONTROL_API_REQUIRED: "1", TIANGONG_CONTROL_API_URL: "http://control.test/health" },
    fetchImpl: async (url, options) => {
      assert.equal(url.href, "http://control.test/health");
      assert.equal(options.method, "GET");
      return { status: 204 };
    },
  });
  assert.deepEqual(result, {
    pluginId: "tiangong-pi",
    pluginPath: "/opt/tiangong-worker/plugin",
    pluginEnabled: true,
    runtimeLane: "legacy-v0.2",
    conversationHooks: false,
    controlApi: "healthy",
  });
});

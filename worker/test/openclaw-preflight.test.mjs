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
    entries: { "tiangong-control": { enabled: true } },
  },
};

test("requires native OpenClaw hooks/tools and never exposes a Tiangong harness", () => {
  assert.deepEqual(assertPluginApi({ registerTool() {} }), {
    pluginId: "tiangong-control",
    nativeRegistration: "not-supported",
  });
  assert.deepEqual(assertPluginApi({ on() {} }), {
    pluginId: "tiangong-control",
    nativeRegistration: "not-supported",
  });
  assert.throws(() => assertPluginApi({}), (error) =>
    error instanceof PreflightError && error.code === "plugin-api-unavailable");
});

test("requires the Tiangong control plugin to be loaded and enabled", () => {
  assert.deepEqual(assertPluginConfig(config), {
    pluginId: "tiangong-control",
    pluginPath: "/opt/tiangong-worker/plugin",
    pluginEnabled: true,
    runtimeLane: "openclaw-native",
    conversationHooks: false,
  });
  assert.throws(() => assertPluginConfig({}), (error) =>
    error instanceof PreflightError && error.code === "required-plugin-not-loaded");
  assert.throws(() => assertPluginConfig({ plugins: { load: { paths: ["/opt/tiangong-worker/plugin"] }, entries: { "tiangong-control": { enabled: false } } } }), (error) =>
    error instanceof PreflightError && error.code === "required-plugin-disabled");
});

test("does not select a legacy runtime lane even when stale config is present", () => {
  const stale = {
    plugins: {
      load: { paths: ["/opt/tiangong-worker/plugin"] },
      entries: { "tiangong-control": { enabled: true, config: { runtimeLane: "legacy-v0.2" } } },
    },
  };
  assert.equal(assertPluginConfig(stale, { env: { TIANGONG_RUNTIME_LANE: "legacy-v0.2" } }).runtimeLane, "openclaw-native");
});

test("keeps the control API optional", async () => {
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
    pluginId: "tiangong-control",
    pluginPath: "/opt/tiangong-worker/plugin",
    pluginEnabled: true,
    runtimeLane: "openclaw-native",
    conversationHooks: false,
    controlApi: "healthy",
  });
});

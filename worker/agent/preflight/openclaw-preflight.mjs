import { readFile } from "node:fs/promises";

export const TIANGONG_PLUGIN_ID = "tiangong-pi";
export const DEFAULT_PLUGIN_PATH = "/opt/tiangong-worker/plugin";
export const LEGACY_RUNTIME_LANE = "legacy-v0.2";
export const CANARY_RUNTIME_LANE = "openclaw-canary";
const RUNTIME_LANES = new Set([LEGACY_RUNTIME_LANE, CANARY_RUNTIME_LANE]);

export class PreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreflightError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PreflightError(code, message);
}

function isRequired(value) {
  return value === "1" || value === "true";
}

export function assertPluginApi(api) {
  if (!api || typeof api.registerAgentHarness !== "function") {
    fail("plugin-api-unavailable", "OpenClaw plugin API does not expose registerAgentHarness.");
  }
  return { pluginId: TIANGONG_PLUGIN_ID, harnessRegistration: "available" };
}

export function assertPluginConfig(config, {
  pluginId = TIANGONG_PLUGIN_ID,
  pluginPath = DEFAULT_PLUGIN_PATH,
  env = process.env,
} = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail("config-invalid", "OpenClaw config must be a JSON object.");
  }

  const paths = config.plugins?.load?.paths;
  if (!Array.isArray(paths) || !paths.includes(pluginPath)) {
    fail("required-plugin-not-loaded", "The required Tiangong plugin path is not loaded.");
  }

  const entry = config.plugins?.entries?.[pluginId];
  if (!entry || entry.enabled !== true) {
    fail("required-plugin-disabled", "The required Tiangong plugin is not enabled.");
  }

  const configuredLane = entry.config?.runtimeLane ?? LEGACY_RUNTIME_LANE;
  const requestedLane = typeof env.TIANGONG_RUNTIME_LANE === "string" && env.TIANGONG_RUNTIME_LANE !== ""
    ? env.TIANGONG_RUNTIME_LANE
    : configuredLane;
  if (!RUNTIME_LANES.has(configuredLane) || !RUNTIME_LANES.has(requestedLane)) {
    fail("runtime-lane-invalid", "The Tiangong runtime lane is not recognized.");
  }
  if (configuredLane !== requestedLane) {
    fail("runtime-lane-mismatch", "The requested runtime lane does not match the Worker configuration.");
  }
  if (env.TIANGONG_CANARY_REQUIRED === "1" && requestedLane !== CANARY_RUNTIME_LANE) {
    fail("canary-lane-required", "The canary probe requires an explicitly configured OpenClaw lane.");
  }

  return { pluginId, pluginPath, pluginEnabled: true, runtimeLane: requestedLane };
}

export async function checkControlApi({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = Number(env.TIANGONG_CONTROL_API_TIMEOUT_MS || 1500),
} = {}) {
  const required = isRequired(env.TIANGONG_CONTROL_API_REQUIRED);
  const rawUrl = typeof env.TIANGONG_CONTROL_API_URL === "string"
    ? env.TIANGONG_CONTROL_API_URL.trim()
    : "";
  if (!rawUrl) {
    if (required) fail("control-api-url-missing", "The required control API URL is missing.");
    return { controlApi: "disabled" };
  }
  if (typeof fetchImpl !== "function") {
    fail("control-api-client-missing", "No fetch implementation is available for the control API preflight.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    fail("control-api-timeout-invalid", "The control API timeout is outside the bounded range.");
  }

  let url;
  try {
    url = new URL(rawUrl);
    if (url.username || url.password || url.search || url.hash) {
      fail("control-api-url-unsafe", "The control API URL must not contain credentials or query data.");
    }
  } catch {
    fail("control-api-url-invalid", "The control API URL is invalid.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      fail("control-api-unready", "The control API did not return a 2xx readiness response.");
    }
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    fail(error?.name === "AbortError" ? "control-api-timeout" : "control-api-unreachable", "The control API readiness check failed.");
  } finally {
    clearTimeout(timer);
  }
  return { controlApi: "healthy" };
}

export async function runOpenClawPreflight({
  config,
  env = process.env,
  fetchImpl = globalThis.fetch,
  pluginPath = env.TIANGONG_PLUGIN_PATH || DEFAULT_PLUGIN_PATH,
} = {}) {
  const plugin = assertPluginConfig(config, { pluginPath, env });
  const control = await checkControlApi({ env, fetchImpl });
  return { ...plugin, ...control };
}

export async function runOpenClawPreflightFromFile({
  configPath = process.env.OPENCLAW_CONFIG_PATH || `${process.env.HOME || ""}/openclaw.json`,
  ...options
} = {}) {
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    fail("config-unreadable", "OpenClaw config could not be read.");
  }
  return runOpenClawPreflight({ config, ...options });
}

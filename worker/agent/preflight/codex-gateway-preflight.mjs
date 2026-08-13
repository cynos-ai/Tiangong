import { readFile } from "node:fs/promises";

export const CODEX_GATEWAY_PROVIDER = "agentteams-gateway";
export const CODEX_GATEWAY_MODEL = "deepseek-v4-pro";
export const DEFAULT_CODEX_GATEWAY_HOST = "agentteams-controller";
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export class CodexGatewayPreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CodexGatewayPreflightError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CodexGatewayPreflightError(code, message);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function allowedHosts(env) {
  const configured = nonEmptyString(env.TIANGONG_CODEX_GATEWAY_HOSTS);
  return new Set((configured || DEFAULT_CODEX_GATEWAY_HOST).split(",").map((value) => value.trim()).filter(Boolean));
}

export function assertCodexGatewayConfiguration(config, {
  env = process.env,
  providerId = nonEmptyString(env.TIANGONG_CODEX_PROVIDER) || CODEX_GATEWAY_PROVIDER,
  modelId = nonEmptyString(env.TIANGONG_CODEX_MODEL) || CODEX_GATEWAY_MODEL,
} = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail("config-invalid", "OpenClaw config must be a JSON object.");
  }
  const provider = config.models?.providers?.[providerId];
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    fail("gateway-provider-missing", "The AgentTeams gateway provider is missing.");
  }
  if (provider.api !== "openai-completions") {
    fail("gateway-provider-api-invalid", "The AgentTeams gateway provider must use the OpenAI-compatible API.");
  }
  if (!nonEmptyString(provider.apiKey)) {
    fail("gateway-consumer-token-missing", "The Worker consumer token is missing from the AgentTeams provider.");
  }

  const rawBaseUrl = nonEmptyString(provider.baseUrl);
  if (!rawBaseUrl) fail("gateway-base-url-missing", "The AgentTeams gateway base URL is missing.");
  let baseUrl;
  try {
    baseUrl = new URL(rawBaseUrl);
    if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
      fail("gateway-base-url-unsafe", "The AgentTeams gateway base URL must be an HTTP(S) URL without credentials or query data.");
    }
  } catch (error) {
    if (error instanceof CodexGatewayPreflightError) throw error;
    fail("gateway-base-url-invalid", "The AgentTeams gateway base URL is invalid.");
  }
  if (!allowedHosts(env).has(baseUrl.hostname)) {
    fail("gateway-host-not-allowed", "The Codex gateway host is outside the AgentTeams allowlist.");
  }
  return {
    provider: providerId,
    model: modelId,
    baseUrl: baseUrl.toString().replace(/\/$/, ""),
    credentialSource: "agentteams-consumer-token",
  };
}

export async function probeCodexGatewayModel({
  baseUrl,
  consumerToken,
  modelId = CODEX_GATEWAY_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") fail("gateway-probe-client-missing", "No fetch implementation is available for the AgentTeams gateway probe.");
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    fail("gateway-probe-timeout-invalid", "The AgentTeams gateway probe timeout is outside the bounded range.");
  }
  if (!nonEmptyString(baseUrl) || !nonEmptyString(consumerToken)) fail("gateway-probe-input-missing", "The AgentTeams gateway probe requires a base URL and consumer token.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new URL("models", `${baseUrl.replace(/\/$/, "")}/`), {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${consumerToken}` },
      signal: controller.signal,
    });
    if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      fail("gateway-model-probe-unready", "The AgentTeams gateway model probe did not return a 2xx response.");
    }
    const text = await response.text();
    if (text.length > 1_000_000) fail("gateway-model-probe-unbounded", "The AgentTeams gateway model response exceeded the bounded probe limit.");
    let body;
    try { body = JSON.parse(text); } catch { fail("gateway-model-probe-invalid", "The AgentTeams gateway model response was not valid JSON."); }
    const models = Array.isArray(body?.data) ? body.data : [];
    if (!models.some((model) => model && typeof model === "object" && model.id === modelId)) {
      fail("gateway-model-missing", `The AgentTeams gateway does not advertise ${modelId}.`);
    }
    return { model: modelId, gatewayModelProbe: "pass" };
  } catch (error) {
    if (error instanceof CodexGatewayPreflightError) throw error;
    fail(error?.name === "AbortError" ? "gateway-model-probe-timeout" : "gateway-model-probe-unreachable", "The AgentTeams gateway model probe failed.");
  } finally {
    clearTimeout(timer);
  }
}

export async function runCodexGatewayPreflightFromFile({
  configPath,
  ...options
} = {}) {
  if (typeof configPath !== "string" || !configPath) {
    fail("config-path-missing", "A Codex gateway preflight config path is required.");
  }
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    fail("config-unreadable", "OpenClaw config could not be read for Codex gateway preflight.");
  }
  const result = assertCodexGatewayConfiguration(config, options);
  const provider = config.models?.providers?.[result.provider];
  return {
    ...result,
    ...(await probeCodexGatewayModel({
      baseUrl: result.baseUrl,
      consumerToken: provider.apiKey,
      modelId: result.model,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    })),
  };
}

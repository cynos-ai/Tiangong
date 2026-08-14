const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-pro";
const RESPONSES_API = "openai-responses";
const CHAT_API = "openai-completions";
const OPEN_CODEX_BRIDGE = "opencodex";

function normalizedBaseUrl(value) {
  if (typeof value !== "string" || value === "") return null;
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/u, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

/**
 * Describes the configuration-only compatibility target for coding models.
 * This does not enable an OpenClaw runtime or prove a live model call.
 */
export function codingModelProfile({ provider, model }) {
  const compat = {
    ...(provider?.compat && typeof provider.compat === "object" ? provider.compat : {}),
    ...(model?.compat && typeof model.compat === "object" ? model.compat : {}),
  };
  const api = compat.codexWireApi ?? model?.api ?? provider?.api;
  const bridge = compat.codexBridge ?? null;
  const baseUrl = normalizedBaseUrl(model?.baseUrl ?? provider?.baseUrl);
  const modelId = typeof model?.id === "string" ? model.id : "";
  if (modelId === "") {
    return { supported: false, reason: "coding model id is missing" };
  }
  if (!baseUrl) {
    return { supported: false, reason: `${modelId} requires a valid provider base URL` };
  }
  if (bridge && bridge !== OPEN_CODEX_BRIDGE && bridge !== "none") {
    return {
      supported: false,
      reason: `${modelId} uses an unsupported Codex bridge: ${String(bridge)}`,
    };
  }
  if (api === RESPONSES_API && bridge && bridge !== "none") {
    return {
      supported: false,
      reason: `${modelId} uses native Responses and must not select a Chat bridge`,
    };
  }
  if (api === CHAT_API && bridge !== OPEN_CODEX_BRIDGE) {
    return {
      supported: false,
      reason: `${modelId} is Chat/Completions-only and requires compat.codexBridge=opencodex`,
    };
  }
  if (api !== RESPONSES_API && api !== CHAT_API) {
    return {
      supported: false,
      reason: `${modelId} uses an unsupported Codex wire API: ${String(api)}`,
    };
  }
  if (modelId === DEEPSEEK_MODEL && (api !== RESPONSES_API || baseUrl !== DEEPSEEK_BASE_URL)) {
    return {
      supported: false,
      reason: "deepseek-v4-pro requires the official DeepSeek Responses API base URL",
    };
  }
  const transport = api === RESPONSES_API ? "native-responses" : "responses-via-chat-bridge";
  const selectedBridge = bridge === "none" ? null : bridge;
  return {
    supported: true,
    profile: api === RESPONSES_API ? `${modelId}-codex` : `${modelId}-codex-via-${selectedBridge}`,
    runtime: "codex-app-server",
    provider: model?.provider ?? provider?.provider ?? (modelId === DEEPSEEK_MODEL ? "deepseek" : "custom"),
    model: modelId,
    api,
    baseUrl,
    transport,
    ...(selectedBridge ? { bridge: selectedBridge } : {}),
    customTool: "apply_patch",
    toolChoice: "auto",
    thinkingToolChoice: "do-not-force-required",
    stateless: model?.stateless ?? provider?.stateless ?? modelId === DEEPSEEK_MODEL,
  };
}

export function validateCodingModelConfiguration(configuration) {
  const providerEntries = Object.entries(configuration?.providers ?? {});
  for (const [, provider] of providerEntries) {
    for (const model of provider.models ?? []) {
      const profile = codingModelProfile({ provider, model });
      if (!profile.supported && (model.id === DEEPSEEK_MODEL || model.compat?.codexWireApi || model.compat?.codexBridge)) {
        throw new Error(`Invalid coding model configuration for ${model.id}: ${profile.reason}`);
      }
    }
  }
  return configuration;
}

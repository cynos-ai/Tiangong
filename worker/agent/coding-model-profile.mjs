const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-pro";

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
  const api = model?.api ?? provider?.api;
  const baseUrl = normalizedBaseUrl(model?.baseUrl ?? provider?.baseUrl);
  if (model?.id !== DEEPSEEK_MODEL) {
    return { supported: false, reason: "model is not the DeepSeek V4 Pro target" };
  }
  if (api !== "openai-responses") {
    return {
      supported: false,
      reason: "deepseek-v4-pro requires the OpenAI Responses wire API",
    };
  }
  if (baseUrl !== DEEPSEEK_BASE_URL) {
    return {
      supported: false,
      reason: "deepseek-v4-pro requires the official DeepSeek API base URL",
    };
  }
  return {
    supported: true,
    profile: "deepseek-v4-pro-codex",
    runtime: "codex-app-server",
    provider: "deepseek",
    model: DEEPSEEK_MODEL,
    api: "openai-responses",
    baseUrl: DEEPSEEK_BASE_URL,
    customTool: "apply_patch",
    toolChoice: "auto",
    thinkingToolChoice: "do-not-force-required",
    stateless: true,
  };
}

export function validateCodingModelConfiguration(configuration) {
  const providerEntries = Object.entries(configuration?.providers ?? {});
  for (const [, provider] of providerEntries) {
    for (const model of provider.models ?? []) {
      const profile = codingModelProfile({ provider, model });
      if (model.id === DEEPSEEK_MODEL && !profile.supported) {
        throw new Error(`Invalid coding model configuration for ${model.id}: ${profile.reason}`);
      }
    }
  }
  return configuration;
}

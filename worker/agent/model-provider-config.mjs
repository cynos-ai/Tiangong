import { validateCodingModelConfiguration } from "./coding-model-profile.mjs";

const PROVIDER_FIELDS = ["api", "baseUrl"];
const MODEL_FIELDS = [
  "api",
  "baseUrl",
  "contextWindow",
  "cost",
  "id",
  "input",
  "maxTokens",
  "name",
  "reasoning",
];

const COMPAT_FIELDS = [
  "codexBridge",
  "codexWireApi",
  "sessionAffinityFormat",
  "supportsDeveloperRole",
  "supportsStrictMode",
  "supportsOpenAIGrammarTools",
  "supportsToolSearch",
];

function pickCompat(source) {
  if (!source || typeof source !== "object") return undefined;
  const compat = pick(source, COMPAT_FIELDS);
  return Object.keys(compat).length === 0 ? undefined : compat;
}

function pick(source, fields) {
  return Object.fromEntries(fields
    .filter((field) => source[field] !== undefined)
    .map((field) => [field, structuredClone(source[field])]));
}

export function sanitizedProviderConfiguration(workerConfig, providerName) {
  const source = workerConfig?.models?.providers?.[providerName];
  if (!source || typeof source !== "object") {
    throw new Error(`Worker configuration does not contain provider ${providerName}`);
  }
  if (!Array.isArray(source.models) || source.models.length === 0) {
    throw new Error(`Provider ${providerName} does not contain models`);
  }
  const provider = {
    ...pick(source, PROVIDER_FIELDS),
    ...(pickCompat(source.compat) ? { compat: pickCompat(source.compat) } : {}),
    models: source.models.map((model) => ({
      ...pick(model, MODEL_FIELDS),
      ...(pickCompat(model.compat) ? { compat: pickCompat(model.compat) } : {}),
    })),
  };
  if (typeof provider.api !== "string" || typeof provider.baseUrl !== "string") {
    throw new Error(`Provider ${providerName} is missing api or baseUrl`);
  }
  for (const model of provider.models) {
    if (typeof model.id !== "string" || model.id === "") {
      throw new Error(`Provider ${providerName} contains a model without an id`);
    }
  }
  return validateCodingModelConfiguration({ providers: { [providerName]: provider } });
}

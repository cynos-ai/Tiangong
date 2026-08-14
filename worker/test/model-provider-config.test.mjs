import assert from "node:assert/strict";
import test from "node:test";

import { sanitizedProviderConfiguration } from "../agent/model-provider-config.mjs";

test("provider configuration excludes credentials and arbitrary headers", () => {
  const result = sanitizedProviderConfiguration({
    models: {
      providers: {
        "agentteams-gateway": {
          api: "openai-completions",
          apiKey: "must-not-be-written",
          baseUrl: "http://gateway.example/v1",
          headers: { Authorization: "must-not-be-written" },
          models: [{
            id: "model-one",
            name: "Model One",
            contextWindow: 1000,
            maxTokens: 100,
            reasoning: false,
            input: ["text"],
            headers: { "X-Secret": "must-not-be-written" },
          }],
        },
      },
    },
  }, "agentteams-gateway");

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("must-not-be-written"), false);
  assert.deepEqual(Object.keys(result.providers["agentteams-gateway"]).sort(), ["api", "baseUrl", "models"]);
  assert.deepEqual(result.providers["agentteams-gateway"].models[0], {
    contextWindow: 1000,
    id: "model-one",
    input: ["text"],
    maxTokens: 100,
    name: "Model One",
    reasoning: false,
  });
});

test("preserves only bounded Responses compatibility metadata", () => {
  const result = sanitizedProviderConfiguration({
    models: {
      providers: {
        "agentteams-gateway": {
          api: "openai-responses",
          baseUrl: "https://api.deepseek.com/",
          compat: {
            sessionAffinityFormat: "openai-nosession",
            supportsDeveloperRole: false,
            arbitrary: "must-not-be-written",
          },
          models: [{
            id: "deepseek-v4-pro",
            api: "openai-responses",
            compat: { supportsStrictMode: false, arbitrary: "drop" },
          }],
        },
      },
    },
  }, "agentteams-gateway");

  assert.deepEqual(result.providers["agentteams-gateway"].compat, {
    sessionAffinityFormat: "openai-nosession",
    supportsDeveloperRole: false,
  });
  assert.deepEqual(result.providers["agentteams-gateway"].models[0], {
    api: "openai-responses",
    compat: { supportsStrictMode: false },
    id: "deepseek-v4-pro",
  });
  assert.equal(JSON.stringify(result).includes("must-not-be-written"), false);
  assert.equal(JSON.stringify(result).includes('"apiKey"'), false);
});

test("preserves the bounded Codex bridge declaration without credentials", () => {
  const result = sanitizedProviderConfiguration({
    models: {
      providers: {
        "qwen-coding": {
          api: "openai-completions",
          baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
          compat: { codexBridge: "opencodex", arbitrary: "drop" },
          models: [{
            id: "qwen3.7-plus",
            compat: { codexWireApi: "openai-completions", codexBridge: "opencodex" },
          }],
        },
      },
    },
  }, "qwen-coding");

  assert.deepEqual(result.providers["qwen-coding"].compat, { codexBridge: "opencodex" });
  assert.deepEqual(result.providers["qwen-coding"].models[0], {
    compat: { codexBridge: "opencodex", codexWireApi: "openai-completions" },
    id: "qwen3.7-plus",
  });
  assert.equal(JSON.stringify(result).includes("arbitrary"), false);
});

test("rejects DeepSeek V4 Pro on the wrong wire API or endpoint", () => {
  assert.throws(() => sanitizedProviderConfiguration({
    models: { providers: {
      gateway: {
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com",
        models: [{ id: "deepseek-v4-pro" }],
      },
    } },
  }, "gateway"), /requires compat\.codexBridge=opencodex/);

  assert.throws(() => sanitizedProviderConfiguration({
    models: { providers: {
      gateway: {
        api: "openai-responses",
        baseUrl: "https://proxy.example.test/v1",
        models: [{ id: "deepseek-v4-pro" }],
      },
    } },
  }, "gateway"), /requires the official DeepSeek Responses API base URL/);
});

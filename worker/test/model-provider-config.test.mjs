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

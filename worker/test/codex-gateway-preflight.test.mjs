import test from "node:test";
import assert from "node:assert/strict";

import {
  assertCodexGatewayConfiguration,
  CodexGatewayPreflightError,
  probeCodexGateway,
} from "../agent/preflight/codex-gateway-preflight.mjs";

const config = {
  models: {
    providers: {
      "agentteams-gateway": {
        api: "openai-completions",
        apiKey: "worker-consumer-token",
        baseUrl: "http://agentteams-controller:8080/v1",
        models: [{ id: "deepseek-v4-pro" }],
      },
    },
  },
};

test("accepts the scoped AgentTeams gateway consumer-token route", () => {
  assert.deepEqual(assertCodexGatewayConfiguration(config), {
    provider: "agentteams-gateway",
    model: "deepseek-v4-pro",
    baseUrl: "http://agentteams-controller:8080/v1",
    credentialSource: "agentteams-consumer-token",
  });
});

test("fails closed when the local provider omits the selected model", () => {
  assert.throws(
    () => assertCodexGatewayConfiguration({
      models: { providers: { "agentteams-gateway": { ...config.models.providers["agentteams-gateway"], models: [{ id: "other-model" }] } } },
    }),
    (error) => error instanceof CodexGatewayPreflightError && error.code === "gateway-model-config-missing",
  );
});

test("rejects a provider that would send a real key directly from the Worker", () => {
  assert.throws(
    () => assertCodexGatewayConfiguration({
      models: { providers: { "agentteams-gateway": { ...config.models.providers["agentteams-gateway"], api: "openai-responses" } } },
    }),
    (error) => error instanceof CodexGatewayPreflightError && error.code === "gateway-provider-api-invalid",
  );
});

test("rejects gateway URLs outside the explicit AgentTeams host allowlist", () => {
  assert.throws(
    () => assertCodexGatewayConfiguration({
      models: { providers: { "agentteams-gateway": { ...config.models.providers["agentteams-gateway"], baseUrl: "https://api.deepseek.com/v1" } } },
    }),
    (error) => error instanceof CodexGatewayPreflightError && error.code === "gateway-host-not-allowed",
  );
});

test("allows an explicitly deployed internal gateway hostname without exposing a credential field", () => {
  const result = assertCodexGatewayConfiguration({
    models: { providers: { "agentteams-gateway": { ...config.models.providers["agentteams-gateway"], baseUrl: "https://higress-gateway/v1" } } },
  }, { env: { TIANGONG_CODEX_GATEWAY_HOSTS: "agentteams-controller,higress-gateway" } });
  assert.equal(result.credentialSource, "agentteams-consumer-token");
  assert.equal(Object.hasOwn(result, "apiKey"), false);
});

test("probes the AgentTeams gateway auth/connectivity endpoint with the consumer token", async () => {
  let observed;
  const result = await probeCodexGateway({
    baseUrl: "http://agentteams-controller:8080/v1",
    consumerToken: "worker-consumer-token",
    fetchImpl: async (url, options) => {
      observed = { url: url.href, method: options.method, authorization: options.headers.authorization };
      return { status: 200, text: async () => JSON.stringify({ data: [{ id: "deepseek-v4-pro" }] }) };
    },
  });
  assert.deepEqual(result, { model: "deepseek-v4-pro", gatewayProbe: "pass", gatewayProbeContract: "auth-connectivity" });
  assert.deepEqual(observed, {
    url: "http://agentteams-controller:8080/v1/models",
    method: "GET",
    authorization: "Bearer worker-consumer-token",
  });
});

test("accepts a valid gateway probe response without requiring a model catalog", async () => {
  const result = await probeCodexGateway({
    baseUrl: "http://agentteams-controller:8080/v1",
    consumerToken: "worker-consumer-token",
    fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify({ status: "ok" }) }),
  });
  assert.equal(result.gatewayProbeContract, "auth-connectivity");
});

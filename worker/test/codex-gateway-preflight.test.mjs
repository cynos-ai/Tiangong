import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertCodexGatewayConfiguration,
  CodexGatewayPreflightError,
  probeCodexGateway,
  runCodexGatewayPreflightFromFile,
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
    transport: "native-responses",
  });
});

test("accepts the OpenClaw codex-prefixed alias for the selected coding model", () => {
  const aliasedConfig = structuredClone(config);
  aliasedConfig.models.providers["agentteams-gateway"].models = [{ id: "codex/deepseek-v4-pro" }];
  assert.equal(assertCodexGatewayConfiguration(aliasedConfig).model, "deepseek-v4-pro");
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
  assert.deepEqual(result, {
    model: "deepseek-v4-pro",
    gatewayProbe: "pass",
    gatewayProbeContract: "auth-connectivity",
    transport: "native-responses",
  });
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

test("requires the explicit OpenCodex bridge for a Chat-only route", () => {
  const bridgeConfig = structuredClone(config);
  bridgeConfig.models.providers["agentteams-gateway"].models = [{ id: "qwen3.7-plus" }];
  const env = {
    TIANGONG_CODEX_MODEL: "qwen3.7-plus",
    TIANGONG_CODEX_TRANSPORT: "responses-via-chat-bridge",
    TIANGONG_CODEX_BRIDGE: "opencodex",
  };
  assert.deepEqual(assertCodexGatewayConfiguration(bridgeConfig, { env }), {
    provider: "agentteams-gateway",
    model: "qwen3.7-plus",
    baseUrl: "http://agentteams-controller:8080/v1",
    credentialSource: "agentteams-consumer-token",
    transport: "responses-via-chat-bridge",
    bridge: "opencodex",
  });
});

test("requires and validates an AgentTeams-owned sidecar readiness receipt for Chat-only routes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-opencodex-receipt-"));
  const configPath = join(directory, "openclaw.json");
  const receiptPath = join(directory, "ready.json");
  const bridgeConfig = structuredClone(config);
  bridgeConfig.models.providers["agentteams-gateway"].models = [{ id: "qwen3.7-plus" }];
  await writeFile(configPath, JSON.stringify(bridgeConfig), "utf8");
  await writeFile(receiptPath, JSON.stringify({
    schemaVersion: 1,
    sidecarId: "sidecar-qwen-member",
    phase: "ready",
    generation: 1,
    endpoint: "http://agentteams-controller:8080/v1",
    provider: "agentteams-gateway",
    model: "qwen3.7-plus",
    transport: "responses-via-chat-bridge",
    bridge: "opencodex",
    credentialSource: "agentteams-secret-projection",
    routeDigest: "a".repeat(64),
  }), "utf8");
  const env = {
    TIANGONG_CODEX_MODEL: "qwen3.7-plus",
    TIANGONG_CODEX_TRANSPORT: "responses-via-chat-bridge",
    TIANGONG_CODEX_BRIDGE: "opencodex",
  };
  try {
    await assert.rejects(
      runCodexGatewayPreflightFromFile({ configPath, env, consumerToken: "worker-consumer-token", fetchImpl: async () => ({ status: 200, text: async () => "{}" }) }),
      (error) => error instanceof CodexGatewayPreflightError && error.code === "codex-sidecar-receipt-missing",
    );
    const result = await runCodexGatewayPreflightFromFile({
      configPath,
      env: { ...env, TIANGONG_CODEX_SIDECAR_RECEIPT_PATH: receiptPath },
      consumerToken: "worker-consumer-token",
      fetchImpl: async () => ({ status: 200, text: async () => "{}" }),
    });
    assert.deepEqual({ sidecarReadiness: result.sidecarReadiness, sidecarId: result.sidecarId, sidecarGeneration: result.sidecarGeneration }, {
      sidecarReadiness: "pass",
      sidecarId: "sidecar-qwen-member",
      sidecarGeneration: 1,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when a Chat-only route names an unknown bridge", () => {
  assert.throws(
    () => assertCodexGatewayConfiguration(config, {
      env: {
        TIANGONG_CODEX_TRANSPORT: "responses-via-chat-bridge",
        TIANGONG_CODEX_BRIDGE: "custom-adapter",
      },
    }),
    (error) => error instanceof CodexGatewayPreflightError && error.code === "codex-bridge-invalid",
  );
});

test("uses an ephemeral Worker token and endpoint override without persisting either", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tiangong-codex-preflight-"));
  const configPath = join(directory, "openclaw.json");
  const configWithoutToken = structuredClone(config);
  delete configWithoutToken.models.providers["agentteams-gateway"].apiKey;
  await writeFile(configPath, JSON.stringify(configWithoutToken), "utf8");
  let observed;
  try {
    const result = await runCodexGatewayPreflightFromFile({
      configPath,
      consumerToken: "ephemeral-worker-consumer-token",
      baseUrlOverride: "http://agentteams-controller:18080/v1",
      fetchImpl: async (url, options) => {
        observed = { url: url.href, authorization: options.headers.authorization };
        return { status: 200, text: async () => JSON.stringify({ data: [] }) };
      },
    });
    assert.equal(result.baseUrl, "http://agentteams-controller:18080/v1");
    assert.equal(result.credentialSource, "agentteams-consumer-token");
    assert.deepEqual(observed, {
      url: "http://agentteams-controller:18080/v1/models",
      authorization: "Bearer ephemeral-worker-consumer-token",
    });
    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(Object.hasOwn(persisted.models.providers["agentteams-gateway"], "apiKey"), false);
    assert.equal(persisted.models.providers["agentteams-gateway"].baseUrl, "http://agentteams-controller:8080/v1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { codingModelProfile } from "../agent/coding-model-profile.mjs";

test("describes the DeepSeek V4 Pro Codex target without credentials", () => {
  assert.deepEqual(codingModelProfile({
    provider: { api: "openai-responses", baseUrl: "https://api.deepseek.com/" },
    model: { id: "deepseek-v4-pro" },
  }), {
    supported: true,
    profile: "deepseek-v4-pro-codex",
    runtime: "codex-app-server",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    api: "openai-responses",
    baseUrl: "https://api.deepseek.com",
    transport: "native-responses",
    customTool: "apply_patch",
    toolChoice: "auto",
    thinkingToolChoice: "do-not-force-required",
    stateless: true,
  });
});

test("does not treat the existing completions path as Codex-compatible", () => {
  const profile = codingModelProfile({
    provider: { api: "openai-completions", baseUrl: "https://api.deepseek.com" },
    model: { id: "deepseek-v4-pro" },
  });
  assert.deepEqual(profile, {
    supported: false,
    reason: "deepseek-v4-pro is Chat/Completions-only and requires compat.codexBridge=opencodex",
  });
});

test("accepts a Chat/Completions model only with the explicit OpenCodex bridge", () => {
  assert.deepEqual(codingModelProfile({
    provider: {
      api: "openai-completions",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      compat: { codexBridge: "opencodex" },
    },
    model: { id: "qwen3.7-plus" },
  }), {
    supported: true,
    profile: "qwen3.7-plus-codex-via-opencodex",
    runtime: "codex-app-server",
    provider: "custom",
    model: "qwen3.7-plus",
    api: "openai-completions",
    baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
    transport: "responses-via-chat-bridge",
    bridge: "opencodex",
    customTool: "apply_patch",
    toolChoice: "auto",
    thinkingToolChoice: "do-not-force-required",
    stateless: false,
  });
});

test("keeps a Responses-capable Qwen endpoint on the native Codex path", () => {
  const profile = codingModelProfile({
    provider: {
      api: "openai-responses",
      baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    },
    model: { id: "qwen3.8-max" },
  });
  assert.equal(profile.supported, true);
  assert.equal(profile.transport, "native-responses");
  assert.equal(profile.bridge, undefined);
  assert.equal(profile.model, "qwen3.8-max");
});

test("fails closed for an unknown bridge", () => {
  assert.deepEqual(codingModelProfile({
    provider: {
      api: "openai-completions",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      compat: { codexBridge: "unknown" },
    },
    model: { id: "qwen3.7-plus" },
  }), {
    supported: false,
    reason: "qwen3.7-plus uses an unsupported Codex bridge: unknown",
  });
});

test("fails closed when native Responses selects a Chat bridge", () => {
  assert.deepEqual(codingModelProfile({
    provider: {
      api: "openai-responses",
      baseUrl: "https://api.example.test/v1",
      compat: { codexBridge: "opencodex" },
    },
    model: { id: "qwen3.8-max" },
  }), {
    supported: false,
    reason: "qwen3.8-max uses native Responses and must not select a Chat bridge",
  });
});

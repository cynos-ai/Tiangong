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
    customTool: "apply_patch",
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
    reason: "deepseek-v4-pro requires the OpenAI Responses wire API",
  });
});

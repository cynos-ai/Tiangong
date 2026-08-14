# Codex 原生 Responses 与 Chat-only 模型桥接方案

> 验证日期：2026-08-14
>
> 结论：当前 Codex 不回退；Responses-capable 模型直连，Chat/Completions-only 模型通过显式 OpenCodex canary 路由验证。Qwen Coding Plan 的真实 Worker bridge 已通过。

## 结论

当前 Codex 版本只接受 `wire_api = "responses"`。阿里云 Coding Plan 仍只提供 Chat/Completions，因此不能在 Codex 配置里把它伪装成原生 Responses provider。官方文档仍把 Codex 0.80.0 作为 Coding Plan 的旧版接入方式；这条路径不作为 Tiangong 的运行时回退。

采用两类模型路由：

| 模型能力 | Codex 路由 | 例子 |
|---|---|---|
| 原生 Responses | AgentTeams gateway 暴露 Responses，Codex 直接调用 | DeepSeek V4 Pro、Qwen Token Plan 的 Responses 模型 |
| 仅 Chat/Completions | AgentTeams gateway 后端选择 OpenCodex，OpenCodex 做 Responses ↔ Chat 转换 | Qwen Coding Plan |

Chat-only provider 必须在受控配置的 `compat` 中显式声明：

```json
{
  "api": "openai-completions",
  "baseUrl": "https://coding-intl.dashscope.aliyuncs.com/v1",
  "compat": { "codexBridge": "opencodex" },
  "models": [
    {
      "id": "qwen3.7-plus",
      "compat": { "codexWireApi": "openai-completions", "codexBridge": "opencodex" }
    }
  ]
}
```

没有显式 bridge 的 Chat provider 会被 Tiangong 的 coding profile 拒绝；这样不会因为普通 OpenAI-compatible 配置看起来“能返回文本”就误判为 Codex 编程运行时可用。

## 候选方案判断

### OpenCodex：首选 canary

[OpenCodex](https://github.com/lidge-jun/opencodex) 是独立社区项目，本次实测版本为 `2.15.0`。它专门接收 Codex Responses 请求并转换到 OpenAI-compatible Chat provider，文档和源码覆盖流式文本、reasoning、function call、`custom_tool_call`、MCP 命名空间以及 `apply_patch` freeform tool。

它适合先做真实编程链路的 canary，但不应成为 AgentTeams 的第二套权威密钥或状态系统。部署时只启用内部 sidecar：

```text
OpenClaw + Codex app-server
        │ Responses
AgentTeams gateway（认证、路由、审计）
        │ internal only
OpenCodex sidecar（协议转换）
        │ Chat/Completions
Coding Plan
```

Coding Plan key 由 AgentTeams secret 机制持有并在运行时注入 gateway；Worker、OpenClaw、Codex 和 OpenCodex sidecar 只接触 Worker-scoped consumer token。非 loopback sidecar 必须使用 `OPENCODEX_API_AUTH_TOKEN`，并以 `x-opencodex-api-key` 专用 header 做数据面认证；OpenCodex 的 dashboard、账号池和持久化 provider key 管理不作为 Tiangong 的权威控制面。

### LiteLLM：通用网关备选

[LiteLLM Responses bridge](https://docs.litellm.ai/docs/response_api) 已支持 `/v1/responses` 到 `/v1/chat/completions`，网关、限流和路由成熟度更高。但 Codex 的 `custom`、`local_shell`、MCP 等工具存在公开转换问题（见 [#27276](https://github.com/BerriAI/litellm/issues/27276) 和 [#27655](https://github.com/BerriAI/litellm/issues/27655)）。因此它可以作为第二候选或长期网关基座，不能只凭普通文本请求通过就认定 `apply_patch` 已可用。

Higress、OpenClaw 原生 provider 和 OpenAI 官方 `responses-api-proxy` 都没有提供当前 Codex 所需的完整 Responses→Chat 工具桥接；它们不能替代本 canary。

## 已完成的机器验证

验证分为两层。协议 canary 固定到公开 npm 包 `@bitkyc08/opencodex@2.15.0` 和本地假 Chat/Completions 服务；随后使用 AgentTeams gateway 的真实 Qwen Coding Plan credential 完成端到端验证：

1. OpenCodex `/v1/responses` 收到 Codex custom `apply_patch` 工具声明。
2. 假 Chat 上游只收到 `function` 工具，并返回分片的 `tool_calls`。
3. OpenCodex 将其恢复为 Responses `response.custom_tool_call_input.*` 和 `custom_tool_call` 完成事件。
4. 第二轮携带 `custom_tool_call_output`，上游收到 `tool` 消息并返回文本。
5. Responses 端收到 `bridge-ok` 和 `response.completed`。

真实 Qwen 结果：

1. `qwen3.7-plus` 直连 Coding Plan endpoint 返回 2xx。
2. stock AgentTeams OpenClaw Worker 与官方 Team Leader 均以 `provider=agentteams-gateway` 完成真实文本调用。
3. OpenCodex 2.15.0 经 AgentTeams gateway 完成 Responses 文本、`apply_patch` function call 和第二轮 replay。
4. 自定义 Tiangong `canary-chat-bridge` Worker 通过 `host.docker.internal` sidecar 返回 `QWEN_CODEX_WORKER_BRIDGE_OK`，运行元数据显示 `provider=codex`、`model=qwen3.7-plus`、`fallbackUsed=false`。
5. Qwen 在 thinking 模式拒绝对象型 `tool_choice`；必须使用 `auto`。无状态 gateway 的第二轮必须重新声明 `tools`，否则 bridge 明确报 undeclared tool。

> 这证明的是协议和工具回环，不证明阿里云 Coding Plan 的账号、额度或特定模型质量。真实 key 只能由 AgentTeams secret 注入到隔离 canary，不能写入仓库、Codex 配置、命令参数或诊断日志。

## Tiangong 实现边界

- `coding-model-profile.mjs` 区分 `native-responses` 与 `responses-via-chat-bridge`。
- `model-provider-config.mjs` 只保留 bounded 的 `codexWireApi`、`codexBridge` 元数据，不保留任何 credential/header。
- `codex-gateway-preflight.mjs` 要求 bridge 路由显式选择 `opencodex`，未知 bridge、错误 transport 均 fail-closed。
- `worker/bin/openclaw` 已将 provider、model、model alias、endpoint、credential source、transport 和 bridge 参数化；默认 Docker canary 仍是 DeepSeek 原生 Responses，Qwen bridge 是显式 opt-in target。
- AgentTeams 仍是模型 key、网关路由和内部 sidecar 生命周期的 owner；Tiangong 不新增第二套密钥仓库。
- WebUI/Matrix/Element Web 路径不变，bridge 只是模型数据面的一段内部路由。

## 后续验收门槛

生产纳入前，bridge canary 还必须逐项验证：普通流式文本、shell/function tool、`apply_patch`、多轮 tool replay、取消/超时、重试/恢复、错误映射、sidecar 生命周期和凭证隔离。当前真实验证已覆盖文本、function call、replay、Worker runtime 与 dedicated header；任何新增门槛失败，都保留原生 Responses 路线，不把 bridge 自动升级为默认路径。

## 公开依据

- [Qwen Codex 接入文档](https://docs.qwencloud.com/developer-guides/clients-and-developer-tools/codex)
- [Qwen Coding Plan 概览](https://docs.qwencloud.com/coding-plan/overview)
- [OpenAI Codex wire API 实现](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs)
- [Codex Chat/Completions deprecation discussion](https://github.com/openai/codex/discussions/7782)
- [OpenCodex architecture](https://opencodex.me/reference/architecture/)
- [LiteLLM Responses bridge](https://docs.litellm.ai/docs/response_api)

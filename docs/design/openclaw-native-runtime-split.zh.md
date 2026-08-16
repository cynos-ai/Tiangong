# OpenClaw 官方 Runtime 分工

## 结论

Tiangong 不实现自己的模型 runtime，也不再使用旧的 `tiangong-pi` harness。
AgentTeams 只负责 Worker、Team、Matrix、凭证和存储；OpenClaw 负责模型回路、工具调用、会话和消息投递；Tiangong 只作为 OpenClaw 插件提供角色工具、协调控制、权限门和机器事实记录。

每个 Worker 仍然使用 AgentTeams 的：

```yaml
spec:
  runtime: openclaw
```

但这只是选择 OpenClaw Worker 容器。容器内的模型回路由 OpenClaw 的
`agentRuntime.id` 选择，不能把这两个字段混为一谈。

## OpenClaw 官方 runtime

| OpenClaw runtime | 归属 | 用途 | 本项目策略 |
|---|---|---|---|
| `openclaw` | OpenClaw 内置 embedded harness | 普通对话、协调、分析、非编程任务 | Leader、Designer、Assessor、Operator 默认使用 |
| `codex` | OpenClaw 官方 `codex` 插件，底层 Codex app-server | 编程、代码修改、需要 Codex 原生工具/上下文的任务 | Implementor 默认使用；仅在模型路由兼容时启用 |
| `acp` | OpenClaw 官方 ACPX 插件和外部 CLI backend | 明确要求外部 Claude/Gemini/Codex ACP 会话 | 当前不作为 AgentTeams Worker 默认路径 |

官方 OpenClaw 文档把 provider、model、agent runtime 和 channel 分成四层。
`openai/<model>` 只是模型引用，不能单独推断 runtime；应在 provider/model 条目上设置
`agentRuntime.id`。`agentRuntime.id: "openclaw"` 明确选择内置回路，
`agentRuntime.id: "codex"` 明确要求 Codex，缺少兼容路由时必须失败，不能静默回退。

## 初始角色映射

第一版先按职责而不是按“所有 Worker 都用 Codex”来分配：

| Tiangong 角色 | 默认 runtime | 原因 |
|---|---|---|
| `leader` | `openclaw` | 负责 Work/Task 协调、收集结果和 Team room 交互，不需要 Codex 原生代码回路 |
| `designer` | `openclaw` | 设计和方案分析优先保持普通 OpenClaw 回路 |
| `implementor` | `codex` | 代码读取、修改、构建和测试优先使用 Codex app-server |
| `assessor` | `openclaw` | 结果审查和验收默认不需要 Codex；若任务明确要求代码实验，可单独绑定 Codex 模型 |
| `operator` | `openclaw` | 发布/运维动作由 Tiangong Adapter、审批和 Runner broker 控制，模型回路不授予额外权限 |

这不是新的角色状态机。它只是每个 Worker 的当前模型/runtime 配置；真正的授权仍由
AgentTeams 身份、MemberConfig、ControlProfile 和 Tiangong Gate 在每次 turn/tool/Adapter 调用时校验。

## 配置形状

内置 runtime 的目标配置应由 OpenClaw 生成或加载，不能通过 Tiangong 自定义 harness
接管模型循环。示意：

```json5
{
  "agents": {
    "defaults": {
      "model": { "primary": "agentteams-gateway/deepseek-v4-flash" },
      "models": {
        "agentteams-gateway/deepseek-v4-flash": {
          "agentRuntime": { "id": "openclaw" }
        },
        "agentteams-gateway/deepseek-v4-pro": {
          "agentRuntime": { "id": "codex" }
        }
      }
    }
  },
  "plugins": {
    "entries": { "codex": { "enabled": true } }
  }
}
```

`deepseek-v4-pro` 只有在 AgentTeams gateway 暴露 Responses/Codex 兼容路由时才能绑定
`codex`；Chat/Completions-only 模型必须先经过已经验证的 OpenCodex bridge，再把
Responses 外部请求交给官方 Codex runtime。bridge 是兼容层，不是新的 Tiangong runtime。

凭证仍只使用 AgentTeams Worker-scoped consumer token。上游 provider key 留在
AgentTeams credential/provider 层，不写入镜像、Team manifest、OpenClaw session、ToolResult
或日志。

## 迁移边界

当前仓库的 `worker/plugin/openclaw-adapter.mjs` 和 `worker/agent/runtime.mjs` 仍注册并执行
`tiangong-pi` 自定义 harness。这是当前实现与目标架构之间的明确缺口。迁移时：

1. 删除 `registerAgentHarness(createTiangongPiHarness(...))` 以及 `OPENCLAW_AGENT_RUNTIME=tiangong-pi`。
2. 保留 Tiangong 的 admission hooks、ToolResult capture、角色工具和协调 Control API，改为
   OpenClaw 官方 `registerTool`/hook 接口；这些模块不再拥有模型循环、session compaction 或
   provider wire protocol。
3. 让 OpenClaw 内置 `openclaw`/`codex` runtime 处理模型 turn，并把 runtime 选择绑定到
   provider/model 配置，而不是全局镜像环境变量。
4. 保留 `OPENCLAW_AGENT_HARNESS_FALLBACK=none`，确保 `codex` 要求失败时不会偷偷切回
   `openclaw`。

## 验收标准

- Leader 的 `/status` 或等价机器状态为 `Runtime: OpenClaw`，且真实 Matrix Team room 回包可在 Element WebUI 看到。
- Implementor 的 `/status` 为 `Runtime: OpenAI Codex`，Codex app-server 真实完成一次代码读取/修改/测试回路，`fallbackUsed=false`。
- 两个 Worker 都仍由 AgentTeams Team 管理，Team 为 `Active`，Worker 为 `Ready`，不绕过 Matrix/WebUI。
- Leader 的 Work/Task/Result/CoordinationStore 记录仍然存在；这些是 Tiangong 业务层事实，不是 runtime 实现。
- 删除或禁用 `tiangong-pi` 后，Leader 和 Implementor 都能启动；任何缺失的 Codex plugin、模型兼容性、凭证或 bridge readiness 都 fail-closed。


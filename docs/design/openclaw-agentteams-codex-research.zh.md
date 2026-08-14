# OpenClaw × AgentTeams × Codex/DeepSeek 可行性调查

> 调查日期：2026-08-14
>
> 状态：已验证 AgentTeams v1.2.2 的原生 Codex HTTP Responses 路径，以及 Qwen Coding Plan 的 OpenCodex bridge Worker 路径；不把 WebSocket 当作必要前提

## 结论

整体方案可继续推进：AgentTeams 适合作为 OpenClaw 的 Matrix、WebUI、Worker
生命周期、存储和模型网关基础设施；Tiangong 继续负责 Worker 内的控制、工具、
Gate、Evidence、审批和恢复。

当前不能宣称“AgentTeams 已经把 Codex 注册成 Controller-managed runtime”；但在 Tiangong 显式 canary 中，原生 Codex app-server 已经可以通过 AgentTeams gateway 的 HTTP Responses 路径调用 DeepSeek，Chat-only 的 Qwen Coding Plan 也可以经 OpenCodex sidecar 调用：

```text
OpenClaw 2026.4.14 native Codex harness
  -> http://agentteams-controller:8080/v1/responses
  -> DeepSeek V4 Pro: pass (fallbackUsed=false)
  -> Qwen Coding Plan: OpenCodex 2.15.0 sidecar -> pass (provider=codex)
```

因此当前阻塞不是 DeepSeek key、模型名称或 Worker token 本身无效，而是 AgentTeams 官方没有把 Codex app-server 作为稳定 Controller runtime 暴露，以及 OpenCodex sidecar 仍需要 AgentTeams-owned 的部署生命周期。Codex 配置显式关闭 WebSocket 后，HTTP/SSE 路径足以完成当前 canary；不需要为了 WebSocket 先写协议适配层。

## AgentTeams 当前能力

截至调查日，官方稳定版本为 v1.2.2。公开文档确认：

- 支持 OpenAI-compatible provider，并可通过 `llmBaseUrl`、`defaultModel` 配置非
  OpenAI 模型服务；
- Worker 只持有 scoped consumer token，真实 LLM key 留在 Higress/AgentTeams
  网关；
- OpenClaw、QwenPaw、Hermes 可通过 Matrix 房间协作，Element Web 继续提供可见的
  WebUI；
- 当前稳定 runtime 列表没有把 Codex 作为 Controller-managed runtime。

官方入口：[AgentTeams README](https://github.com/agentscope-ai/AgentTeams)、
[v1.2.2 release](https://github.com/agentscope-ai/AgentTeams/releases/tag/v1.2.2)。

### Codex 相关 Issue/PR

| 事项 | 状态 | 判断 |
|---|---|---|
| [Issue #399](https://github.com/agentscope-ai/AgentTeams/issues/399) 直接启动 Codex/Claude Code | Open | 需求仍属于生态/路线能力，不是稳定默认能力 |
| [PR #1139](https://github.com/agentscope-ai/AgentTeams/pull/1139) shared Codex execution adapter | Draft | 有 host-local `codex app-server`、TeamHarness、credential isolation；不新增 Controller runtime，验证的是 ChatGPT OAuth，不是 DeepSeek-through-Higress |
| [PR #569](https://github.com/agentscope-ai/AgentTeams/pull/569) Codex runtime | Closed | 历史尝试，不能作为当前稳定支持 |
| [PR #828](https://github.com/agentscope-ai/AgentTeams/pull/828) external CLI harness | Closed | 历史 external CLI 方案，不能作为当前稳定支持 |
| [PR #1125](https://github.com/agentscope-ai/AgentTeams/pull/1125) Higress external API reference | Open | 明确 `/v1/chat/completions`、`/v1/embeddings` 契约，并将 `/v1/models` 定位为 auth/connectivity probe |
| [PR #1171](https://github.com/agentscope-ai/AgentTeams/pull/1171) IP:port OpenAI-compatible 修复 | Open | 我们使用内部 DNS 名称，暂时不依赖此修复 |

没有找到已经合并、明确支持 Codex Responses WebSocket 的 AgentTeams PR。因而
不能把 AgentTeams 当前的 OpenAI-compatible HTTP 支持等同于 Codex 原生
WebSocket 支持。

## 已验证事实与未完成事项

### 已验证

1. Worker 配置只携带 AgentTeams consumer token，DeepSeek real key 不进入镜像、
   Codex 配置、命令行、会话或诊断输出。
2. 本地 provider 配置包含 `deepseek-v4-pro`，HTTP(S) base URL 经过 host allowlist
   和 URL 安全检查。
3. `/v1/models` 可以作为有界的认证/连通性探针，但不再要求其返回完整模型目录。
4. 直接 HTTP `/v1/responses` 使用同一 token 和模型返回 200。
5. 官方 Matrix/Element Web 面仍然可用，原有 legacy Worker lane 未改变。

### 尚未完成

1. AgentTeams upstream 尚未把 Codex app-server 变成稳定的 Controller-managed runtime；当前使用 Tiangong canary image 和显式 runtime contract。
2. OpenCodex sidecar 的生产生命周期、滚动升级、取消/超时和跨 Worker token 轮换还要由 AgentTeams-owned deployment 完成。
3. 真实 Team task 基础链路已通过；仍需在 AgentTeams-owned deployment 中补齐多轮 tool replay、重启/恢复和 Evidence 关联证明。
4. 首次数据结构迁移。迁移应等基础链路、WebUI、ToolResult、重启/恢复都通过后再做。

## 推荐实施顺序

### Phase 0：保持现状并修正 preflight

- provider 本地配置必须包含目标模型；
- `/v1/models` 只做 bounded auth/connectivity probe，不把它当完整 catalog；
- 继续只使用 Worker-scoped consumer token；
- 失败时保留稳定错误码，不自动切换到直连 DeepSeek key。

### Phase 1：HTTP/SSE 原生 Codex canary（已通过）

OpenClaw/Codex 已显式关闭 WebSocket，使用网关支持的 HTTP Responses 路径；原生 Codex、Matrix、Element Web 和 AgentTeams key boundary 均保留，不先做数据迁移。

### Phase 2：Chat-only 模型的显式 bridge canary（已通过，仍需生产化）

在 AgentTeams/Higress 或独立 sidecar 中实现：

1. 接受 Codex Responses HTTP 请求；
2. 用 `x-opencodex-api-key` 验证 Worker consumer token；
3. 将 Responses 转换到 Coding Plan 的 Chat/Completions；
4. 保持 session/turn 关联、tool call、错误和取消语义；
5. 不把真实 Coding Plan key 下发到 Worker、Codex child 或 sidecar。

OpenCodex 2.15.0 已通过真实 Qwen 文本、function call、多轮 replay 和基础 Team task；生产化还必须补齐 sidecar 生命周期，不能因为 canary 通过就自动升级为默认路径。

### Phase 3：Tiangong 控制面与数据结构迁移

只有 Phase 1 或 Phase 2 的原生 Codex canary 通过后，才迁移 Work/Task/Result/
ToolResult/Operation 等数据结构，并继续保留 Element Web 作为实时观察面。迁移
本身必须是独立分支、可回滚、逐步切流，不修改 legacy lane 的默认行为。

## 安全边界

- AgentTeams 负责 Team、Worker/container、Matrix、存储和 scoped gateway token；
- Tiangong 负责控制 runtime、专业任务、工具 Gate、Evidence、Approval、recovery；
- 不能因为 AgentTeams 网关返回 HTTP 200，就推断任意 Worker 子进程都已完成凭据
  隔离；必须检查实际 process tree、环境、挂载和 egress；
- 调查 key 只允许短时注入测试进程，禁止写入仓库、日志、Evidence、prompt、session
  或命令参数。

## Go / No-Go

当前判断：

- **Go**：继续 OpenClaw + AgentTeams + DeepSeek 原生 canary；Qwen Coding Plan 走显式 OpenCodex bridge canary；保留 WebUI/Matrix；
- **No-Go（暂时）**：把 Codex 宣称为 AgentTeams 官方 Controller runtime，或开始大规模数据迁移；
- **下一决策点**：把 sidecar 生命周期、重启/恢复和 Evidence 关联纳入 AgentTeams-owned deployment，完成后再评估数据结构迁移。

## 2026-08-14 真实 Team task 复验

此前“尚未完成真实 Team task”这一项已完成复验：临时 Qwen Team 为 `Active`，Leader 为 stock OpenClaw builtin，bridge Worker 为 Tiangong `canary-chat-bridge`。Leader 在 Team room 发出任务，Worker 返回 `QWEN_TEAM_MEMBER_TASK_OK`，Leader 再返回 `TEAM_LEADER_RELAY_OK`；bridge Worker 的 execution trace 为 `winnerProvider=codex`、`winnerModel=qwen3.7-plus`、`fallbackUsed=false`。验证完成后已删除 Team、Workers、sidecar，并将 Higress route 恢复为 DeepSeek。

因此当前结论是：AgentTeams + OpenClaw + Codex + Qwen Coding Plan 的 Team 任务路径可行；尚未完成的是把 OpenCodex sidecar 的生命周期正式交给 AgentTeams 部署层，而不是继续使用临时主机进程。下一步应先实现并验证 sidecar 的 provision/ready/rotate/drain/remove 合同，再考虑数据结构迁移。

2026-08-14 已在 Tiangong Worker 侧落地该边界的第一版：
`worker/agent/deployment/opencodex-sidecar.mjs` 提供无密钥的生命周期状态机、
generation 轮换、`reconcile` 恢复、脱敏 snapshot/receipt 和 fail-closed 状态；
`codex-gateway-preflight.mjs` 对 Chat-only 路由强制读取匹配的 `ready` receipt。
这解决了 Worker 侧“没有 readiness 就启动”的缺口，但不等于 AgentTeams 已有
真实 Controller adapter。真实的容器 provision、secret projection、状态探针、
drain/remove 和跨重启持久化仍必须在 AgentTeams deployment 层实现并用真实
smoke 证明。

## 2026-08-15 AgentTeams 凭证提供器边界修正

补充核对 AgentTeams v1.2.2 上游源码后，需要修正“AgentTeams 完全没有官方 sidecar 能力”的表述：v1.2.2 的 CRD `WorkerSpec` 已包含 `accessEntries`，并定义了 `CredentialProvider`/`AccessEntry` 相关控制器路径；当前 embedded 控制器二进制也包含这些实现。但同一 tag 的 `agt apply -f` REST DTO 没有透传 `accessEntries` 字段。我们用一个 `containerManaged: false` 的临时 Worker 做了真实反例：带有明显非法 `accessEntries.service` 的声明仍被创建，说明当前 embedded CLI 入口会接受 YAML 但在 REST DTO 边界丢弃该字段；资源随后已清理。

这项官方能力的范围是网关、对象存储、AI registry 等云资源的 STS/访问策略投影；它不是 OpenCodex 的专用进程管理器，也不提供 `provision/ready/rotate/drain/remove` 的 OpenCodex 生命周期 API。换句话说：可以复用 AgentTeams 的 `accessEntries`/credential-provider 作为凭证和访问范围的权威来源，但 OpenCodex sidecar 的进程、端口、就绪、轮换、drain 和回收仍需由 AgentTeams deployment-owned adapter 实现。

因此当前结论从“没有官方 sidecar”收窄为“有通用 credential-provider，但没有 OpenCodex-specific lifecycle manager，且 embedded `agt` 透传仍有缺口”：DeepSeek 等原生 Responses 模型继续直连；Chat-only 模型继续走显式 OpenCodex bridge canary；生产化适配层只补生命周期与 receipt，不再另造第二套 AgentTeams 凭证仓库。若使用 Helm/Kubernetes 原生 CR 路径，优先把 provider credential 绑定到官方 `accessEntries`；若继续使用 embedded `agt`，需等待上游 REST DTO 修复或由部署层直接提交 CR，并保留本文既有的密钥不落盘、跨 Worker 隔离和 fail-closed 门槛。

源码锚点：[v1.2.2 WorkerSpec](https://raw.githubusercontent.com/agentscope-ai/AgentTeams/v1.2.2/agentteams-controller/api/v1beta1/types.go)、[v1.2.2 REST DTO](https://raw.githubusercontent.com/agentscope-ai/AgentTeams/v1.2.2/agentteams-controller/internal/server/types.go)、[Helm credentialProvider 配置](https://raw.githubusercontent.com/agentscope-ai/AgentTeams/v1.2.2/helm/agentteams/values.yaml)。

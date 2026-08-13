# OpenClaw × AgentTeams × Codex/DeepSeek 可行性调查

> 调查日期：2026-08-13
>
> 状态：已验证基础网关链路；原生 Codex Responses WebSocket 仍需适配

## 结论

整体方案可继续推进：AgentTeams 适合作为 OpenClaw 的 Matrix、WebUI、Worker
生命周期、存储和模型网关基础设施；Tiangong 继续负责 Worker 内的控制、工具、
Gate、Evidence、审批和恢复。

当前不能宣称“原生 OpenClaw Codex 已经可以直接通过 AgentTeams 调用
DeepSeek”。我们在隔离 canary 中观察到：

```text
OpenClaw 2026.4.14 native Codex harness
  -> ws://agentteams-controller:8080/v1/responses
  -> HTTP 401
```

而使用同一个 Worker consumer token、同一个模型和同一个网关，直接发送 HTTP
`POST /v1/responses` 返回 200。因此当前阻塞是 Responses WebSocket 协议适配，
不是 DeepSeek key、模型名称或 Worker token 本身无效。

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

1. 原生 OpenClaw Codex turn 通过网关完成一次完整 Responses WebSocket 对话。
2. WebSocket streaming、重连、tool call 和多轮 `previous_response_id` 的端到端证明。
3. Codex child process 的最终环境隔离证明；当前 OpenClaw 版本对自定义 app-server
   launcher 的实际采用仍需单独确认。
4. 首次数据结构迁移。迁移应等基础链路、WebUI、ToolResult、重启/恢复都通过后再做。

## 推荐实施顺序

### Phase 0：保持现状并修正 preflight

- provider 本地配置必须包含目标模型；
- `/v1/models` 只做 bounded auth/connectivity probe，不把它当完整 catalog；
- 继续只使用 Worker-scoped consumer token；
- 失败时保留稳定错误码，不自动切换到直连 DeepSeek key。

### Phase 1：先完成 HTTP/SSE 可用的 OpenClaw canary

优先确认 OpenClaw/Codex 是否能显式关闭 WebSocket、使用网关支持的 HTTP/SSE
Responses 路径。如果能配置，则保留原生 Codex、Matrix、Element Web 和
AgentTeams key boundary，不先做数据迁移。

### Phase 2：若 HTTP/SSE 不可用，增加协议适配层

在 AgentTeams/Higress 或独立 canary adapter 中实现：

1. 接受 Codex Responses WebSocket upgrade；
2. 验证 Worker consumer token；
3. 将 `response.create` 与事件流转换到网关后端支持的 HTTP/SSE 或上游协议；
4. 保持 session/turn 关联、tool call、错误和取消语义；
5. 不把真实 DeepSeek key 下发到 Worker 或 Codex child。

协议适配层必须先做最小握手/单轮/streaming/错误/重连测试，再接入真实 Matrix
turn。不能用“HTTP `/responses` 返回 200”替代 WebSocket 端到端证据。

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

- **Go**：继续 OpenClaw + AgentTeams + DeepSeek 的 canary 开发；保留 WebUI/Matrix；
- **No-Go（暂时）**：把原生 Codex WebSocket 当成已受支持能力，或开始大规模数据迁移；
- **下一决策点**：HTTP/SSE 显式路由验证；若失败，转协议 adapter 分支。

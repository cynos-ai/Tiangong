# OpenClaw × AgentTeams × Codex/DeepSeek 可行性调查

> 调查日期：2026-08-15
>
> 状态：原生 Responses、Qwen bridge、deployment-owned sidecar 生命周期均已完成验证；不把 WebSocket 当作必要前提

## 结论

整体方案可继续推进：AgentTeams 适合作为 OpenClaw 的 Matrix、WebUI、Worker
生命周期、存储和模型网关基础设施；Tiangong 继续负责 Worker 内的控制、工具、
Gate、Evidence、审批和恢复。

当前不能宣称“AgentTeams 已经把 Codex 注册成 Controller-managed runtime”；但在 Tiangong 显式 canary 中，原生 Codex app-server 已经可以通过 AgentTeams gateway 的 HTTP Responses 路径调用 DeepSeek，Chat-only 的 Qwen Coding Plan 也已经在独立 provider 配置和 Team canary 中经 OpenCodex sidecar 调用：

```text
OpenClaw 2026.4.14 native Codex harness
  -> http://agentteams-controller:8080/v1/responses
  -> DeepSeek V4 Pro: pass (fallbackUsed=false)
  -> Qwen Coding Plan: OpenCodex 2.15.0 sidecar -> pass (provider=codex)
```

因此当前剩余边界不是 DeepSeek key、模型名称或 Worker token 本身无效：当前本地 stack 选择的是 `openai-compat + api.deepseek.com + deepseek-v4-*`，把 Qwen 请求发给该上游自然会被拒绝；切换 Qwen 需要用 AgentTeams 的 provider/base URL/default model 配置重建或升级网关。OpenCodex sidecar 的 deployment-owned 生命周期已经补齐。Codex 配置显式关闭 WebSocket 后，HTTP/SSE 路径足以完成当前 canary；不需要为了 WebSocket 先写协议适配层。

## AgentTeams 当前能力

截至调查日，官方稳定版本为 v1.2.2。公开文档确认：

- 支持 OpenAI-compatible provider，并可通过 `llmBaseUrl`、`defaultModel` 配置非
  OpenAI 模型服务；
- 官方安装/Helm 配置也支持 `llmProvider=qwen`、Qwen API key 和
  `defaultModel`；当前本地 v1.2.2 运行实例没有选择该配置，而是使用
  `openai-compat` 的 DeepSeek 上游；
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
2. 当前本地 stack 尚未切换到 Qwen provider；需要通过 AgentTeams 安装/升级配置选择
   `qwen`、Qwen Coding Plan endpoint 和 `qwen3.7-plus`，再重跑当前 sidecar Team smoke。
3. v1.2.2 embedded `agt` REST DTO 仍不透传 `accessEntries`；官方 credential-provider
   要么走原生 Kubernetes CR，要么等待上游 DTO 修复。当前 adapter 使用受限的
   deployment-owned compatibility lookup，不把该缺口伪装成官方 projection。
4. 首次数据结构迁移。迁移应等 provider 配置、WebUI、ToolResult、重启/恢复和
   Qwen Team smoke 都通过后再做。

## 推荐实施顺序

### Phase 0：保持现状并修正 preflight

- provider 本地配置必须包含目标模型；
- `/v1/models` 只做 bounded auth/connectivity probe，不把它当完整 catalog；
- 继续只使用 Worker-scoped consumer token；
- 失败时保留稳定错误码，不自动切换到直连 DeepSeek key。

### Phase 1：HTTP/SSE 原生 Codex canary（已通过）

OpenClaw/Codex 已显式关闭 WebSocket，使用网关支持的 HTTP Responses 路径；原生 Codex、Matrix、Element Web 和 AgentTeams key boundary 均保留，不先做数据迁移。

### Phase 2：Chat-only 模型的显式 bridge 与 sidecar 生命周期（已通过）

在 AgentTeams/Higress 或独立 sidecar 中实现：

1. 接受 Codex Responses HTTP 请求；
2. 用 `x-opencodex-api-key` 验证 Worker consumer token；
3. 将 Responses 转换到 Coding Plan 的 Chat/Completions；
4. 保持 session/turn 关联、tool call、错误和取消语义；
5. 不把真实 Coding Plan key 下发到 Worker、Codex child 或 sidecar。

OpenCodex 2.15.0 已通过真实 Qwen 文本、function call、多轮 replay 和基础 Team task；
deployment-owned adapter 进一步通过了 DeepSeek sidecar 的 provision、ready、
reconcile、generation rotate、真实 HTTP 200、drain、receipt 失效和 remove。当前
默认仍是原生 Responses 直连；Chat-only 只有拿到 matching ready receipt 才能进入 bridge。

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

- **Go**：继续 OpenClaw + AgentTeams + DeepSeek 原生路径；启用 Qwen provider 后复用同一 OpenCodex bridge 和 WebUI/Matrix；
- **No-Go（暂时）**：把 Codex 宣称为 AgentTeams 官方 Controller runtime，或在 Qwen provider 尚未切换前把当前拒绝误报为 sidecar 故障；
- **下一决策点**：先切换一次隔离的 AgentTeams Qwen provider 配置并重跑 Team Full smoke，再评估数据结构迁移；sidecar 生命周期本身不再是阻塞项。

## 2026-08-14 真实 Team task 复验

此前“尚未完成真实 Team task”这一项已完成复验：临时 Qwen Team 为 `Active`，Leader 为 stock OpenClaw builtin，bridge Worker 为 Tiangong `canary-chat-bridge`。Leader 在 Team room 发出任务，Worker 返回 `QWEN_TEAM_MEMBER_TASK_OK`，Leader 再返回 `TEAM_LEADER_RELAY_OK`；bridge Worker 的 execution trace 为 `winnerProvider=codex`、`winnerModel=qwen3.7-plus`、`fallbackUsed=false`。验证完成后已删除 Team、Workers、sidecar，并将 Higress route 恢复为 DeepSeek。

因此当前结论是：AgentTeams + OpenClaw + Codex + Qwen Coding Plan 的 Team 任务路径可行；
sidecar 生命周期已经由 deployment-owned adapter 接管，不再依赖临时主机进程。下一步
是切换当前网关的 Qwen provider 配置并重跑同一套 Full smoke，然后再考虑数据结构迁移。

2026-08-14 已在 Tiangong Worker 侧落地该边界的第一版：
`worker/agent/deployment/opencodex-sidecar.mjs` 提供无密钥的生命周期状态机、
generation 轮换、`reconcile` 恢复、脱敏 snapshot/receipt 和 fail-closed 状态；
`codex-gateway-preflight.mjs` 对 Chat-only 路由强制读取匹配的 `ready` receipt。
这解决了 Worker 侧“没有 readiness 就启动”的缺口；随后已在独立 manager 容器中
实现真实容器 provision、secret projection、状态探针、drain/remove 和跨重启
持久化，并用 DeepSeek sidecar Full smoke 证明。它仍然不是 AgentTeams 官方内置
Controller runtime，而是 Tiangong deployment-owned adapter。

## 2026-08-15 AgentTeams 凭证提供器边界修正

补充核对 AgentTeams v1.2.2 上游源码后，需要修正“AgentTeams 完全没有官方 sidecar 能力”的表述：v1.2.2 的 CRD `WorkerSpec` 已包含 `accessEntries`，并定义了 `CredentialProvider`/`AccessEntry` 相关控制器路径；当前 embedded 控制器二进制也包含这些实现。但同一 tag 的 `agt apply -f` REST DTO 没有透传 `accessEntries` 字段。我们用一个 `containerManaged: false` 的临时 Worker 做了真实反例：带有明显非法 `accessEntries.service` 的声明仍被创建，说明当前 embedded CLI 入口会接受 YAML 但在 REST DTO 边界丢弃该字段；资源随后已清理。

这项官方能力的范围是网关、对象存储、AI registry 等云资源的 STS/访问策略投影；它不是 OpenCodex 的专用进程管理器，也不提供 `provision/ready/rotate/drain/remove` 的 OpenCodex 生命周期 API。换句话说：可以复用 AgentTeams 的 `accessEntries`/credential-provider 作为凭证和访问范围的权威来源，但 OpenCodex sidecar 的进程、端口、就绪、轮换、drain 和回收仍需由 AgentTeams deployment-owned adapter 实现。

因此当前结论从“没有官方 sidecar”收窄为“有通用 credential-provider，但没有 OpenCodex-specific lifecycle manager，且 embedded `agt` 透传仍有缺口”：DeepSeek 等原生 Responses 模型继续直连；Chat-only 模型继续走显式 OpenCodex bridge canary；生产化适配层只补生命周期与 receipt，不再另造第二套 AgentTeams 凭证仓库。若使用 Helm/Kubernetes 原生 CR 路径，优先把 provider credential 绑定到官方 `accessEntries`；若继续使用 embedded `agt`，需等待上游 REST DTO 修复或由部署层直接提交 CR，并保留本文既有的密钥不落盘、跨 Worker 隔离和 fail-closed 门槛。

源码锚点：[v1.2.2 WorkerSpec](https://raw.githubusercontent.com/agentscope-ai/AgentTeams/v1.2.2/agentteams-controller/api/v1beta1/types.go)、[v1.2.2 REST DTO](https://raw.githubusercontent.com/agentscope-ai/AgentTeams/v1.2.2/agentteams-controller/internal/server/types.go)、[Helm credentialProvider 配置](https://raw.githubusercontent.com/agentscope-ai/AgentTeams/v1.2.2/helm/agentteams/values.yaml)。

## 2026-08-15 REST DTO 补丁与凭证轮换验证

我们在 `%TEMP%\\agentteams-v1.2.2-src` 的官方 tag 副本中准备了一个最小上游补丁：
`Create/UpdateWorker`、`Create/UpdateManager` 的 REST request/response DTO
显式传递 `accessEntries`，handler 在 create/update 时写入 CR spec，并补上四个
create/update 回归测试。该补丁没有复制进 Tiangong，也没有改动当前运行的
AgentTeams 镜像；它应先以 AgentTeams issue/PR 的形式合入，再构建新镜像。

隔离验证已通过：`internal/server`、`internal/accessresolver`、
`internal/credentials` 和 `internal/credprovider` package tests 全部 PASS。
额外的 `httptest` 凭证提供器测试验证了首个 STS 响应、有效期内缓存，以及
`Invalidate()` 后重新签发新响应；测试只使用合成凭证，不写入文件、日志或命令行。
随后重试的 `go build ./cmd/controller` 也已 PASS；此前一次 Go proxy 依赖下载 EOF
在缓存补齐后未再复现。

因此新的上线顺序是：先使用原生 Kubernetes CR 或合入该 DTO 补丁的 AgentTeams
镜像，确认 `agt apply` 后 `agt get` 能回显合法 `accessEntries` 且非法 service
在 resolver/provider 阶段 fail closed；随后再执行 credential-provider mock、
OpenCodex generation rotation/drain 和真实 Qwen Team Full smoke。在此之前，
DeepSeek 原生 Responses 继续作为默认路径，Qwen bridge 继续保持 canary。

## 2026-08-15 全局能力缓存

为避免每个 Worker 启动都做一次模型探测，canary 的 `auto` 路径现在使用部署
层拥有的共享能力缓存（默认 `/var/lib/tiangong-capabilities/codex.json`）。缓存
键由 provider、model、无凭证 endpoint 和探测器版本组成；同一指纹命中缓存时，
Worker 只读取 route，不再调用模型。缓存未命中时用精确 lock 目录串行化，只有
第一个 Worker 探测，其他 Worker 重新读取结果。

共享缓存是脱敏的基础设施状态，不是第二套凭证仓库：不写入 key、token、header、
prompt 或模型原文。它可以由共享卷承载；将来若 AgentTeams/Tiangong 的
CoordinationStore 已提供稳定 PG 适配器，只替换存储实现即可。Worker 不直接连接
PG。bridge 结果仍需要每个 Worker 自己的 OpenCodex ready receipt，缓存只决定
协议路线，不代替 sidecar 生命周期或 endpoint admission。完整合同见
[Codex 能力探测的全局缓存合同](codex-capability-global-cache.zh.md)。

## 2026-08-15 当前网关配置与下一步

当前本地 `agentteams-controller` 的事实配置是：Higress `openai-compat` route
指向 DeepSeek 上游，默认模型为 DeepSeek；因此把 Worker 的模型名改成
`qwen3.7-plus` 会得到上游“不支持该模型”的 400，而不是进入 Qwen Coding Plan。
这不是 OpenCodex 的 route 或生命周期错误。

AgentTeams 官方当前的安装/Helm 文档提供了 Qwen 配置入口：选择
`llmProvider=qwen`，注入 Qwen Coding Plan key，并设置对应 `defaultModel`；也可
用 `llmBaseUrl` 配置其他 OpenAI-compatible 服务。切换时应在隔离的 AgentTeams
配置/数据卷中完成，保留现有 DeepSeek stack 可回滚，然后重复同一套 Team Full
smoke。真实 key 仍只进入 AgentTeams/Higress credential，不进入 Worker、Codex
或 sidecar 配置。

依据：[AgentTeams README 的 Qwen/LLM 配置](https://github.com/agentscope-ai/AgentTeams/blob/main/README.md)、
[AgentTeams Manager Guide](https://github.com/agentscope-ai/AgentTeams/blob/main/docs/manager-guide.md)、
[AgentTeams Quickstart](https://github.com/agentscope-ai/AgentTeams/blob/main/docs/quickstart.md)。

仓库现在提供只读的 `make provider-check`：它在启动或升级前校验 provider、model 和
endpoint 的组合，输出 `codex-native-responses`、`codex-opencodex-chat-bridge` 或
`agentteams-qwen-native`。它只报告 `AGENTTEAMS_LLM_API_KEY` 是否存在，不输出 key，
也不修改容器、数据卷或网关路由。

这道门把“provider/catalog 配置不匹配”与“OpenCodex sidecar 运行失败”分开。实际切换
Qwen 前先执行它，再在隔离的 AgentTeams 配置/数据卷中重跑 Team Full smoke；当前
DeepSeek stack 继续作为默认可回滚路径。

## 2026-08-15 Admission Control API 实现切片

Tiangong Worker 现在提供了一个可部署的、无凭证的 admission Control API
实现切片：`worker/agent/gates/admission-control-server.mjs`。它把 AgentTeams
投影的 Worker/lane binding 和有界 replay journal 分开保存；模型阶段先创建
耐久 turn 记录，tool 阶段只能复用该记录并重新核对来源、路由和当前 binding。

服务只保存 bounded metadata 和 SHA-256 digest，不保存 prompt、tool payload、模型
原文或 key；状态文件拒绝 symlink/过宽权限，并使用锁和原子替换。`/healthz` 可供
部署层做 readiness，`worker/Dockerfile` 新增 `admission-control` 目标用于独立进程
托管。当前测试覆盖重启 replay、改请求、错误 actor、tool-before-model、binding
revision 变化和 readiness 失效。

这仍然不是 AgentTeams 官方 sidecar manager，也不宣称 Gate A 已通过：部署层还必须
负责投影 binding、启动/回收该服务、接通 canary Worker 并证明清理。只有这段 live smoke
和 A5/A6 的耐久 ownership/recovery 证据完成后，才进入 Phase B 数据结构工作。

## 2026-08-15 Phase A live closeout

当前 Gate A canary 已在本地 AgentTeams 栈完成一次完整、可清理的真实运行；真实运行入口为 `smoke-testing/support/run-openclaw-admission-control-smoke.mjs`，并要求显式设置 `TIANGONG_RUN_REAL=1`。

- pinned OpenClaw `2026.4.14 (2f35b6f)`、`tiangong-pi` plugin、Matrix/storage/entrypoint/readiness 均通过；
- deployment-owned admission Control API 的 model admission、tool admission、服务重启 replay、Worker 重启 replay 和 revoke deny 均通过，失败发生在模型或工具执行前；
- Worker-owned ToolResult store 使用稳定 `toolResultId`/`callKey`、有界 JSON state、owner-checked retention mark、重启可读、重复调用去重和冲突拒绝；原始 probe/error/credential-like 文本不会被写入；
- 在真实 canary Worker 内实际调用 OpenClaw 内置 `read` tool，capture hook 产出 bounded ToolResult record；Web console 通过 bounded projection 测试；
- RunnerJournal/RunnerPort 的 concurrent owner、outcome uncertainty、terminal replay 和 duplicate recovery focused tests 全部通过；canary service/Worker restart/readiness 与精确 Worker、service、storage、mirror、state cleanup 通过；
- runtime 默认仍锁定原生 Responses/Codex 路径；未验证的其他 Harness 仍保持 disabled，不把 AgentTeams v1.2.2 credential-provider 当成 OpenCodex sidecar lifecycle manager。

Phase A 的实现和 canary 证据已闭合，可以进入 Phase B 的最小 Work/Task/Result 设计；仍不删除 legacy pi lane、不迁移权威数据、不把 key 写入 Worker/image/log/evidence，也不把未经验证的 Qwen Chat-only route 切成默认路径。完整 app/PG 逐点重启和生产部署 rollback 属于后续部署演练，不作为本次 canary 的成功假设。

## 2026-08-15 Phase B B1 协调基础切片

Phase B 已从独立分支 `codex/openclaw-phase-b-foundation` 开始。第一条纵切先实现可重启、可重放的 Tiangong `CoordinationStore`，不改变当前 legacy pi/Project-Task 默认入口：

- `TeamConfig`、`TeamRouteBinding`、`MemberConfig`、`ControlProfile`、`WorkSpec`、`TaskSpec` 和 `Result` 都是严格字段、长度受限、SHA-256 绑定的记录；
- Work 使用 append-only journal，并从 journal 重建 current WorkSpec、epoch、Task 和 Result projection；
- WorkSpec 更新、Task 创建、Task 取消和 Result 提交使用 actor + command-scoped `requestId`，重复命令只 replay 原结果，内容冲突拒绝；
- Task 创建可在同一 durable transaction 里写入 assignment wake；wake 的 claim/ack 也有重启可恢复的 outbox 状态；
- Result 只能提交一次，取消与 Result 是确定性的竞争关系；引用 ToolResult 时核对 `workId`/`taskId` owner 并写 retention mark，不保存原始 tool payload；
- journal 拒绝 partial record、错误 hash chain、非法 digest、symlink 和过宽权限。

这一步的 focused contract 位于 `worker/test/coordination-store.test.mjs`，覆盖 epoch/replay、取消竞争、wake、ToolResult retention、重启重建和篡改拒绝。当前仍明确未完成：

1. 尚未把新 store 接到 AgentTeams 的共享存储同步、Matrix ingress/outbox 或 Web projection；
2. 尚未替换现有 legacy Project/Task TeamTaskPort，也不允许因此删除 pi；
3. 尚未实现 B2 的 Human Matrix → Work → native Leader session 真实纵切。

下一步是给该 store 接入受当前 TeamConfig/MemberConfig/ControlProfile 约束的 Leader admission，并用真实 Matrix room 做 B2 Basic smoke；只有 B2/B3/B4/B5 证据闭合后才讨论 clean-cut。

## 2026-08-15 Phase B B2 Leader admission seam

B2 已完成第一条可测试的 admission seam，但尚未宣称完整运行时接通：

- `worker/agent/team/leader-admission.mjs` 只接受已认证的 Matrix `m.room.message`，要求事件 ID、发送者、绑定 Team room、当前 TeamConfig/TeamRouteBinding/ControlProfile/Leader MemberConfig 一致；普通房间、Worker 身份、控制事件、改写后的 replay 都 fail closed。
- 一次 admission 原子地产出一个确定性的 Work、一个 native Leader session 绑定，以及 `leader-resume` 和 `human-reply` 两个 durable wake。相同 Matrix event 重放只返回原 Work/wake 投影，不重复创建。
- `worker/agent/team/channel-adapter.mjs` 新增了受加入房间约束的 Human event 读取，以及带稳定 Matrix transaction ID 的 `team.work.admitted` 可见回执；Evidence 只保留 bounded ID/digest，不保存 Human 原文或凭证。
- `CoordinationStore.listWorks()` 和 App Runtime Console 的只读 projection 现在能展示 Work card、current WorkSpec 摘要、timeline 事件类型、Leader session 和 durable wake 状态；未配置共享 journal 时仍诚实显示 unknown，不把 Web UI 当授权源。
- focused contract（CoordinationStore、Leader admission、ingress、Matrix channel）共 22 Worker tests 全部通过，App projection 3 tests 全部通过；这证明的是纯 Worker seam 和 replay/idempotency，不是 AgentTeams 真实部署 smoke。

当前明确缺口：OpenClaw `toTurnRequest` 仍没有把原始 Matrix room/event/content 传入 Worker，因此生产入口还不能自动调用此 admission seam；AgentTeams shared-storage sync、真实 Matrix Basic smoke、native Leader runtime wiring 和 durable visible outbox consumer 仍属于后续 B2/B3 工作。不要把这组 focused tests 误报成 B2 Go 或完整 Team runtime 已上线。

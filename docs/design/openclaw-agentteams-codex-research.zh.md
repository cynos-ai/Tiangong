# OpenClaw × AgentTeams × Codex/DeepSeek 可行性调查

> **历史调查记录**：本文记录迁移期间的研究和验证，不是当前 runtime 合同。当前主线已完成 DeepSeek-only clean-cut：非编程角色走 OpenClaw 内置 runtime，Implementor 走官方 Codex app-server，Tiangong 只提供 `tiangong-control` 插件；旧 Pi harness/fallback 不得按本文早期段落部署。现行决策见 [`deepseek-only-clean-cut.zh.md`](deepseek-only-clean-cut.zh.md)。

## 当前状态（2026-08-16）

Phase B 的真实 AgentTeams 部署纵切已闭合：Human Matrix → 原生 OpenClaw Leader →
PG Work/Timeline/Wake → Matrix outbox ack → MinIO Task/Result → 成员 Worker →
Coordination WebUI 均已在 disposable v1.2.2 Team 中验证。Leader binding、Control
endpoint 和短 token 由 `scripts/inject-leader-runtime-docker.sh` 以部署层适配器注入，
并由 `verify-leader-runtime-injection.sh` 在容器内 fail-closed 验证；适配器会保留
Worker hardening，无法精确复现的资源边界直接拒绝重建。

这证明的是 Tiangong 的生产部署合同和真实纵切，不是 AgentTeams 官方已经提供了
OpenCodex sidecar manager。v1.2.2 的 `agt` 管理面仍缺少这些原生字段，因此生产环境
必须由受控 deployment layer 拥有注入、轮换、审计和 rollback。默认模型路径继续使用
DeepSeek 原生 Responses；Qwen bridge 只在显式 provider 配置和 matching receipt 下启用，
权威数据结构迁移尚未开始。

## 2026-08-15 Phase B B3 Task/Result Gateway

Phase B 继续推进到 B3：PG CoordinationStore 现在与 file-backed store 对齐 Task/Result 的直接事实边界。新增 `002_task_result` migration、Task/Result 查询 API、不可变 TaskSpec/单次 Result、Work epoch/timeline 原子更新、request replay，以及 Result 与取消的行锁竞争；Web `/api/runtime` 同步投影 bounded Task/Result/ToolResult metadata，Worker 只能通过窄 HTTP facade 读取，不接触 PG。

验证已在一次性 PostgreSQL 容器中完成：`npm --prefix app test` 12/12 通过（含真实 migration、重复 ingress、Task/Result 提交、取消冲突、Control API、Web projection 和 runtime readiness）；容器随后已清理。B3 仍不等于 Gate B Go：AgentTeams v1.2.2 的 `agt apply worker` 仍没有原生 sidecar/mount/secret 生命周期字段，Leader binding、endpoint、短 token 仍由部署层注入并由 `verify-leader-runtime-injection.sh` fail-closed 校验。

下一步是 B4 prepared local coding：把 Task/Result 的成员 wake 接到真实 AgentTeams Worker，加入 credential-free prepared workspace、单 Task 单执行 owner、进程树取消和 ToolResult-backed coding smoke；在这条证据链闭合前继续保留 legacy pi lane，不做 clean-cut。
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
2. Qwen Coding Plan 已在隔离 Team canary 中通过，但当前本地 stack 的默认 provider
   仍是 DeepSeek；要切换默认路由，仍需通过 AgentTeams 配置选择 `qwen`、Qwen
   Coding Plan endpoint 和 `qwen3.7-plus`，再重跑当前 sidecar Team Full smoke。
3. v1.2.2 embedded `agt` REST DTO 仍不透传 `accessEntries`；官方 credential-provider
   要么走原生 Kubernetes CR，要么等待上游 DTO 修复。当前 adapter 使用受限的
   deployment-owned compatibility lookup，不把该缺口伪装成官方 projection。
4. 首次权威数据结构迁移尚未开始。迁移应等 provider 配置变更、WebUI、ToolResult、
   重启/恢复和 Qwen Team Full smoke 都通过后再做。

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
- **下一决策点**：在受控窗口切换一次 AgentTeams Qwen provider 配置并重跑 Team Full
  smoke，再评估权威数据结构迁移；sidecar 生命周期本身不再是阻塞项。

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

本分支已把“字段是否真正穿过管理面”固化为
`scripts/verify-agentteams-worker-admission.sh`。它只创建停止状态的
`containerManaged: false` 合成 Worker，并在清理前读取 `agt get` 的回显；
字段缺失、资源冲突、apply/read/cleanup 任一失败都返回非零。默认只运行
`make test-agentteams-worker-admission-contract` 的无外部资源合同测试；真实
部署需显式设置 `TIANGONG_AGENTTEAMS_MANAGER_CONTAINER`，不会自动改动当前栈。

当前栈实测结果：对 `agentteams-manager` 使用唯一临时 Worker 名称运行该预检，
返回 `ACCESS_ENTRIES_DROPPED`，随后 `agt get workers` 确认资源为空。也就是说，
embedded Docker 管理面当前确实会丢弃该字段；脚本在 Worker 启动前阻断，且不把
这个反例当成 OpenCodex sidecar 生命周期故障。

上游源码核对链接：[v1.2.2 WorkerSpec](https://raw.githubusercontent.com/agentscope-ai/AgentTeams/v1.2.2/agentteams-controller/api/v1beta1/types.go)、
[v1.2.2 REST DTO](https://raw.githubusercontent.com/agentscope-ai/AgentTeams/v1.2.2/agentteams-controller/internal/server/types.go)、
[v1.2.2 REST handler](https://raw.githubusercontent.com/agentscope-ai/AgentTeams/v1.2.2/agentteams-controller/internal/server/resource_handler.go)。

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
- OpenClaw adapter 现在有显式 `matrixIngress` 输入契约和可选 Leader admission hook：只有上游明确提供 authenticated、`team-room`、room ID 时才调用 admission；缺 hook 时 fail closed，原始 event content 不进入 TurnRequest。
- `leader-outbox.mjs` 提供 at-least-once wake consumer 和显式 handler factory：先解析当前 Work route，再执行幂等 handler，成功后才 claim/ack；handler 失败保持 pending，崩溃发生在 side effect 后也可安全重放。
- `worker/agent/team/channel-adapter.mjs` 新增了受加入房间约束的 Human event 读取，以及带稳定 Matrix transaction ID 的 `team.work.admitted` 可见回执；Evidence 只保留 bounded ID/digest，不保存 Human 原文或凭证。
- `CoordinationStore.listWorks()` 和 App Runtime Console 的只读 projection 现在能展示 Work card、current WorkSpec 摘要、timeline 事件类型、Leader session 和 durable wake 状态；未配置共享 journal 时仍诚实显示 unknown，不把 Web UI 当授权源。
- focused B2 command（CoordinationStore、Leader admission、ingress、OpenClaw hook、outbox、Matrix channel、adapter）33/33 Worker tests 通过，另有 1 条 B2 Basic disposable smoke 和 App projection 3 tests 通过；smoke 覆盖一次真实模块组合、原生 OpenClaw Matrix envelope、幂等回执、wake ack 和重启投影，但不是 AgentTeams 真实部署 smoke。

当前明确缺口：OpenClaw 的 `EmbeddedRunAttemptParams` 已能提供受限的 `groupId`、
`messageTo`、`senderId` 和 `currentMessageId`，adapter 现在只在四者严格一致时派生
Matrix ingress；真正的 sender/event 真实性仍由 Matrix channel 用 Worker token 重读并
验证，它不把原始 event content 放进 `TurnRequest`。AgentTeams shared-storage sync、真实 Matrix Basic smoke、native
Leader runtime wiring 和 outbox handler 的真实部署绑定仍属于后续 B2/B3 工作。不要
把这组 focused tests 误报成 B2 Go 或完整 Team runtime 已上线。

## 2026-08-15 B2 共享存储边界复核

对当前 AgentTeams 适配代码和内部目标计划复核后，暂不把本地 journal 复制到一个
新的 `shared/tiangong/coordination` 目录：

- `sync-adapter.mjs` 目前只同步 AgentTeams 已拥有的 `shared/projects/{id}` 和
  `shared/tasks/{id}`；它没有一个可供 Tiangong 读写 Work/Task/Result 的 canonical
  CoordinationStore API；
- 内部目标计划把 PostgreSQL CoordinationStore 列为 P1.4，明确要求
  `room_id + event_id` 唯一约束、epoch/replay/conflict 事务和 durable outbox；当前
  file-backed journal 只能作为 disposable B2 的实现替身，不能被宣传为共享权威；
- 历史上曾出现过第二套 Tiangong Project/Task 命名空间，已被架构规则撤销。重新造
  一个 MinIO 路径会把平台存储权威和 Tiangong 业务权威混在一起，也无法证明跨 Worker
  的事务语义。

当前本地 v1.2.2 栈的 controller、manager、Matrix、Web、MinIO readiness 已通过
只读检查；但真实 B2 仍不能晋级，因为生产 Worker 还没有启动时绑定的
`leaderIngress`/CoordinationStore，且 outbox handler 尚未绑定 native Leader session。
下一步应由 AgentTeams/部署层提供 canonical CoordinationStore/PG 连接和 ingress
DTO，再把本分支的 admission/outbox seam 接入 disposable Team smoke；在此之前不做
权威数据迁移、不删除 legacy pi，也不把本地 journal 当成跨 Worker 共享状态。

上述段落是 B2 部署接通前的历史记录。2026-08-16 已完成一次新的真实 disposable
AgentTeams v1.2.2 B2 Basic 复核：部署层注入并验证 Leader binding，Manager 在真实
Team Matrix room 发出带 Leader mention 的单行消息，OpenClaw 记录为
`peer=channel:<team-room>`，PG 创建 Work/Timeline 和 `leader-resume`、`human-reply`
wakes，Matrix consumer 完成两类 wake 的 claim/send/ack，Coordination runtime 的
`/readyz`、根页面和 `/api/runtime` 均返回 200，Web projection 能读到 acked state。
此外，outbox consumer 已能在同一 consumer 重启时恢复遗留的 `claimed` wake，并用
同一个确定性 Matrix transaction pathname 重放；独立 F1 contract test 已通过。真实
容器级 crash-after-send-before-ack 也已在隔离 Coordination runtime 上复核：真实
Matrix PUT 已落地后杀掉 runtime，重启后同一 transaction pathname 重放并 ACK，原
runtime 最终恢复 ready。B2 Basic/Full/F1 seam 已通过，但 B3/B4/B5 仍未完成，不能
把这次结果当成 Gate B clean-cut，也不能提前删除 `tiangong-pi`；B3 的部署 gateway
和真实 Team Matrix delivery seam 已在下一切片通过，剩余的是 member native session
调用的 Full smoke，然后才进入 B4。

## 2026-08-16 Phase B4 Work/Task/Runner/Result 纵切

`make test-runner-broker-linux` 现在不再只验证 Runner broker 客户端。Linux
控制容器中的 Worker 先通过 Tiangong TeamTaskPort 创建 Project/Task，再依次调用
`team_resolve_task`、`run_command` 和 `team_submit_result`：实际命令修改 fixture，
Runner broker 封存 ChangeRevision，ResultEnvelope 写入 AgentTeams shared-fs 形状的
`projects/{id}` / `tasks/{id}` 记录，WorkRun 进入 `finalized`，随后 durable journal
重放相同 invocation。`b4_work_task_runner=pass` 和 `b4_result_persisted=pass` 是
直接机器事实。

该 smoke 同时验证了重启后未决 Runner invocation 不会自动重跑
（`b4_restart_unresolved=pass`），以及 ToolResult 经过重启读取和 retention mark 后
作为 Result 的 bounded evidence ref（`b4_toolresult_retention=pass`）。

这条 smoke 的 Channel adapter 仍是有界测试适配器，因此它闭合的是 Tiangong 本地
Work/Task/Runner/Result 纵切，不等于真实 AgentTeams Matrix/Worker 投递已经完成。
下一步仍需把同一调用接到真实 Worker、Matrix 和 WebUI，并补齐取消、重启后
unresolved execution、ToolResult retention 及 cleanup 证据；在此之前保留 legacy pi
路径，不做 clean-cut。

## 2026-08-16 真实 Worker 探针的新增结论

真实五角色 Team 的第一轮探针发现，仅写 `workerMembers` 不会让 OpenClaw
`groupAllowFrom` 自动包含 Team 同伴；按 AgentTeams 公开字段补上每个 Worker 的
`channelPolicy.groupAllowExtra`/`dmAllowExtra` 后，allowlist 和 Matrix Team Room
均收敛。Designer 以真实 Worker 身份 mention Leader，Leader 已进入 OpenClaw 原生
turn，说明 Matrix sender/mention/Leader session 这一层可达。

该 turn 随后在 Tiangong Leader tool gate 处明确拒绝：`Leader Coordination Control
binding is unavailable`。也就是说当前阻塞不是模型、Matrix 或 Project/Task 文件
格式，而是 AgentTeams v1.2.2 的 Worker 生命周期没有注入 Tiangong 所需的
`leader-binding.json`、Coordination Control endpoint 和短 token。我们同时补了启动
适配：只读消费 AgentTeams 的 `AGENTTEAMS_AUTH_TOKEN_FILE`，向 OpenClaw 原生工具
提供同一进程内的 `AGENTTEAMS_AUTH_TOKEN`，凭证不进配置、不进日志。

## 2026-08-16 Phase B4 真实部署纵切收口

上述部署边界已在 disposable AgentTeams v1.2.2 Team 上完成真实验证。由于 `agt`
仍不透传 env/mount/sidecar 字段，部署层新增 Docker recreation adapter：它只接受
固定的 AgentTeams Worker 拓扑，复用原有 auth volume，注入只读 `leader-binding.json`、
Coordination endpoint 和短期 Control token，并在重建后立即执行 fail-closed verifier。
Linux 直接使用 owner-only bind；Docker Desktop/WSL 使用 deployment-owned named volume，
凭证轮换必须显式设置 `TIANGONG_LEADER_INJECTION_ROTATE=1`。不满足网络、权限、挂载、
入口点或已有注入检查的容器会拒绝重建，失败时恢复原容器。

真实纵切已覆盖：

- Human Matrix room → native OpenClaw Leader session → `team_create_project` /
  `team_dispatch_task`；
- PG `Work`/timeline/wake 与 Matrix outbox 的 durable 写入和 ack；
- MinIO task/result envelope（Designer claim、taskId、revision、digest）；
- 成员 Worker 的普通 Matrix turn 不再误走 Leader admission seam；
- Coordination runtime `/readyz` 的 `postgres-and-matrix` readiness，以及 `/`、
  `/api/runtime` WebUI 投影。

真实验证结束后，Team、Worker、runtime、PG、named volume 和 MinIO 临时对象均按 owner
精确回收；没有把 key 写入仓库、镜像、日志或 Evidence。Linux 容器中的 Worker 全量
回归为 380/380；Windows 主机全量测试仍受 symlink、`fsync` 和受限部署 fixture 的
平台差异影响，不能用来替代 Linux 证据。

因此 B4 的 Tiangong Work/Task/Runner/Result 与真实 AgentTeams Matrix/WebUI 纵切已闭合，
可以进入下一阶段的数据结构迁移与 Qwen provider canary。仍保留两个生产前边界：
AgentTeams v1.2.2 尚无官方 OpenCodex sidecar lifecycle manager，且 Docker recreation
adapter 尚未成为 AgentTeams Controller 原生资源；生产部署必须由受控 deployment layer
拥有该适配器的生命周期、审计和 rollback，不能把本地 smoke 误报成官方能力。

## 2026-08-16 Phase B5 provider 与迁移合同

B5 在独立分支 `codex/phase-b5-provider-migration` 收口了两条生产前门槛：

1. provider、model、endpoint、transport、bridge 和 credential source 继续由部署层
   参数化；`make provider-check` 只读校验并 fail closed，默认 DeepSeek 路由不变，
   Qwen Coding Plan 仍是显式候选路由。上游 key 只留在 AgentTeams secret/credential
   provider，Worker/OpenClaw/Codex/OpenCodex 只拿 scoped consumer token。
2. `app/coordination/migration-contract.mjs` 把 legacy-pi 保留、PG
   `001_coordination`/`002_task_result`、Work/Task/Result/ToolResult retention、六个
   provider/Matrix/WebUI/recovery/rollback/cleanup gates、digest 绑定和状态跳转变成
   可执行合同；篡改、越级 cutover 和未验证 rollback 均拒绝。测试入口为
   `make test-coordination-migration-contract`。

当前 Qwen Coding Plan 已完成真实上游 HTTP 200 探测，历史受控 AgentTeams Team canary
也已证明 Leader → Matrix → OpenCodex bridge Worker → Qwen 路径可行；但本分支没有把
Qwen 切成默认，也没有执行权威数据 cutover。真正切换前仍需在隔离 Team/数据卷重跑
完整六门 canary，并在失败时恢复 DeepSeek 与 legacy-pi。具体合同和验收表见
[`phase-b5-provider-migration.zh.md`](phase-b5-provider-migration.zh.md)。

## 2026-08-16 当前执行指针（以 internal 计划为准）

上面的 B4/B5 段落保留为此前的设计与验证记录；当前公开分支的执行指针以
`tiangong-internal/plans/openclaw-first-web-and-runtime-development-plan.md` 的
最新附录为准。B2 Basic/Full/F1 和 B3 Gateway seam 已闭合，B3 的真实非 Leader
成员 Full smoke 也已闭合：成员 Worker 使用 `OPENCLAW_AGENT_RUNTIME=pi` 选择
OpenClaw 上游内置 embedded harness，Tiangong 只通过官方
`before_prompt_build`/`agent_end` hook 读取 TaskSpec、提交一个 bounded Result。
这不是 Tiangong 自有 runtime，也不是 Codex harness；Leader/Designer/Assessor/
Operator 等非编程角色的目标仍是 OpenClaw 内置 runtime；当前角色 A/B 尚未全部
切换，后续 B4 再为编程 Worker 验证 OpenClaw Codex runtime，B5 再证明 Leader 与
各专业角色的最终路由。

本次真实 smoke 使用部署层注入的 member identity/token、真实 AgentTeams Team/Matrix
和 PG Coordination runtime；Task reporting、Result projection 及 assignment/
notification wakes 均成功 ack。Matrix wake payload 同时带 `formatted_body` 的
`matrix.to` mention，避免 OpenClaw 丢弃只有 `m.mentions` 的事件。`tiangong-pi`
仍是 Gate B 前的 legacy 回滚/对照路径，只有 B4/B5 和 Gate B 证据闭合后才允许进入
B6 clean-cut 删除。

## 2026-08-16 B4 原生 Codex 真实成员验证

在 disposable AgentTeams Team 上，Implementor 以 OpenClaw 内置 `codex`
runtime、`native-responses`、无 bridge、DeepSeek V4 Pro 完成了一次真实
Matrix Task。OpenClaw Codex app-server 执行了 bounded fixture read/write 和
本地断言；Tiangong hook 通过 Control API 读取 immutable TaskSpec 并提交一个
Result，Task/Result、WebUI 投影及四个 Matrix wake ack 均可观察。

因此目前可以确认：编码 Worker 不需要退回 Tiangong 自有 runtime，也不需要
OpenCodex bridge；非编程角色继续使用 OpenClaw 内置 embedded runtime，编程角色
可以使用 OpenClaw 官方 Codex runtime。当前仍未把原生 Codex 工具调用纳入
Runner broker 的唯一执行权和恢复闭环，B4/B5 尚未整体 Go。

本次使用的是 pinned OpenClaw 版本稳定的生命周期兼容 hook（`api.on`）。对同一
版本试用 `registerHook` 时出现 Codex app-server 动态工具目录重建且未产出
Result，因此暂不升级该注册方式；这不改变“runtime 由 OpenClaw 提供、Tiangong
只做控制插件”的架构结论。
# 迁移期研究记录（历史）

> 本文保留迁移期的验证证据。关于当前运行时结论，以
> `deepseek-only-clean-cut.zh.md` 和 `openclaw-native-runtime-split.zh.md` 为准：
> `tiangong-pi` 已删除，Qwen B6 是后续可选 canary。

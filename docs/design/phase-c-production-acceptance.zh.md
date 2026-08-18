# Phase C 生产边界验收

## 目标

Phase C 验收的是部署边界，而不是模型回答：

- Coordination runtime 只持有 PG、Matrix outbox 和部署凭证；
- Leader Worker 只获得 credential-free binding、Control API endpoint 和
  Worker-scoped 短 token；
- 普通 Worker 不获得 Leader admission 或 PG/Matrix secret；
- Native Responses 模型直连 Codex；Chat-only 模型必须有匹配的
  OpenCodex ready receipt；
- sidecar 的 provision、ready、reconcile、rotate、drain、remove 都绑定
  Team/Worker 身份，并且失败时保持 fail-closed；
- WebUI 和 Matrix 始终读取同一份 Coordination 投影，不能用模型文本代替
  Task、Result、ToolResult 或 delivery fact。

## 可重复入口

默认只运行不改变外部资源的确定性合同：

```sh
make test-phase-c-contract
```

它覆盖 Coordination runtime、Leader binding 注入、五角色 runtime 注入、
Codex capability/cache/preflight、Leader/成员 hook、sidecar receipt 和
sidecar 生命周期，以及 PostgreSQL/Matrix runtime 的确定性测试。

真实 AgentTeams 烟囱必须显式选择：

```sh
make phase-c-real
```

需要保留本次失败的脱敏状态时，再显式设置
`TIANGONG_GATEB_KEEP_FAILURE=1`；默认路径在成功或失败后都清理本次资源。

真实入口只使用脚本内生成的唯一 Team、Worker、PG、binding volume 和
Coordination runtime；正常结束会逐项删除，任何清理失败都使运行失败。这个
入口不接受外部 Team/Worker 名称，也不打印 key、token、prompt、ToolResult
正文或模型 transcript。

## Go / No-Go

只有以下事实全部成立才是 Phase C Go：

1. `verify-leader-runtime-injection.sh` 在实际 Leader 容器内通过；
2. Worker 环境没有 PG URL 或部署级 Matrix token，binding 挂载只读且能被
   Tiangong loader 校验；
3. 当前角色镜像完成一次 `Leader dispatch → member ToolResult → Leader
   result notification → WebUI/Matrix`，并在重启后从 PG 恢复；
4. native Codex 和 OpenCodex bridge 的 route/provider/model/generation
   与 capability cache、ready receipt 完全匹配；
5. sidecar 轮换、drain、remove 和精确清理均有直接机器事实；
6. 任意 endpoint、token、generation、role 或资源归属不匹配都会在模型调用
   前拒绝。

Qwen provider/catalog 未放行时，只能把 Qwen 记录为独立的
`blocked-at-provider/catalog` canary；不能用它替代 DeepSeek 的 Phase C
验收，也不能因此开放数据迁移或 external write。

## 当前边界

Tiangong 已实现部署适配器、binding loader、Coordination API、sidecar
adapter、receipt 和确定性合同。AgentTeams v1.2.2 的 `agt` 管理面仍没有
原生的 Leader-session、Coordination 或 OpenCodex sidecar 字段，因此真实
生产部署必须显式调用部署适配器；把路径写进 SOUL、prompt 或普通 Worker
环境不算注入成功。

### 2026-08-17 共享栈复核

对当前共享 AgentTeams v1.2.2 容器做了只读、脱敏的直接探测：

- Controller 当前 provider 为 `openai-compat`、DeepSeek endpoint，带容器内
  配置凭证请求 `/v1/models` 返回 HTTP 401；Controller gateway 同样返回
  HTTP 401。
- Manager 容器中的 Matrix token 请求 `/_matrix/client/v3/account/whoami`
  返回 HTTP 401。Manager 日志同时记录了历史 SQLite b-tree 损坏并隔离重建，
  以及 `M_UNKNOWN_TOKEN`。
- 因此 `agt get managers` 的 `welcomeSent=true` 不能作为 Phase C readiness；
  `scripts/agentteams.sh verify` 现在还会检查 provider authentication 和
  Manager Matrix authentication，失败时保持 No-Go，不输出凭证。

这些是共享部署凭证/状态问题，不是 Tiangong native OpenClaw 代码已通过的
证据。修复有效 provider credential、Matrix token 和 Manager 状态后，必须
重新运行 `make phase-c-real`，不能复用这次失败结果。

### 2026-08-17 Qwen 复测状态

在隔离 canary 窗口中，部署侧临时把 `openai-compat` service source 和 provider
切到 Qwen Coding Plan；`/v1/models`、`/v1/chat/completions`、OpenCodex
`/v1/models` 和 Worker Codex preflight 均通过。Qwen 真实 Gate B 仍未完成：
分步 Leader 的 Team/Matrix/设计 Result/accept/恢复报告可通过，但 dispatch 回合存在
模型无工具响应超时，且共享 Runner broker 的旧 image-pinned binding 曾造成错误拒绝。
这些问题已分别在 smoke 入口增加模型分步恢复、broker image/orphan binding 检查和超时边界，
但尚未形成 Phase C Go 证据。

当前共享部署的 provider 变更属于外部 canary 状态，不是仓库配置；发布前必须由部署操作恢复
到经过认证的默认路由或明确批准的 Qwen 路由，并重新执行 `make phase-c-real`。在此之前，
不得把 Qwen canary 当作 DeepSeek Phase C 通过，也不得创建 release 或合入 `main`。

### 2026-08-17 DeepSeek 真实 Phase C 失败定位

`phasec-final-20260817b` 已启动真实 AgentTeams v1.2.2、Coordination runtime、
OpenCodex sidecar 和五角色 Gate B 流程。gateway provider/auth preflight、sidecar
provision/ready、Codex Worker `responses-via-chat-bridge` preflight 均通过，说明
凭证和 sidecar 生命周期不是失败原因。

失败发生在 Leader OpenClaw builtin runtime 使用 `deepseek-v4-flash` 时：AgentTeams
gateway 返回 HTTP 400，明确提示 `model deepseek-v4-flash is not supported`。因此
`LEADER_MATRIX_VERTICAL` 失败属于 gateway model catalog 不匹配，不是 OpenClaw/Codex
适配层或凭证安全问题；本次资源清理仍通过 `leader_smoke_cleanup=pass`。

共享 AgentTeams v1.2.2 的官方 OpenClaw Worker 模型目录实际登记的是
`deepseek-chat`/`deepseek-reasoner`，而不是 `deepseek-v4-*`。因此 Leader/Gate B
builtin runtime 默认切换到已登记的 `deepseek-chat`；Codex member 的模型通过独立的
`TIANGONG_B5_CODEX_MODEL` 参数保持为 `deepseek-v4-pro`，避免把 Leader 的模型目录限制
错误地套到 Codex sidecar。新的真实 Gate B 仍需重新通过后，才可解除 No-Go、创建 release
或合入 `main`。

### 2026-08-18 AgentTeams 本地网关注入复核（最终 No-Go）

本轮用全新、临时 Worker 做了三层复核，并在结束后删除了所有临时资源：

- 上游 DeepSeek `GET /v1/models` 和带工具的 Chat 请求直接返回 200，说明测试密钥和上游模型本身可用。
- AgentTeams v1.2.2 生成的 Worker `AGENTTEAMS_AI_GATEWAY_URL` 仍为
  `http://agentteams-controller:8080`；带 Worker consumer key 的 `/v1/models`、
  `/v1/chat/completions` 和 `/v1/responses` 均返回 404。无凭证请求返回 401，说明
  凭证校验层存在，但实际 AI route 没有完成可用的转发闭环。
- 按官方脚本把 Manager 临时重建为 `AGENTTEAMS_RUNTIME=docker` 并注入
  `http://aigw-local.agentteams.io:8080` 后，新建 Worker 仍被嵌入式 Controller
  覆盖回 `agentteams-controller:8080`。这不是 Tiangong Worker 代码能够单独修复的
  配置项，而是 AgentTeams v1.2.2 的 Controller→Manager→Worker 部署注入边界。
- 真实 `phasec-final-20260818e` 已完成 Team/Worker 创建、Leader 注入和 Designer
  注入，但在 Leader builtin runtime 的首个模型回合等待超时；随后按精确名称清理了
  Worker 和运行目录。该结果不能算 Phase C Go。

上游公开的 [AgentTeams issue #908](https://github.com/agentscope-ai/AgentTeams/issues/908)
也记录了 K8s 模式下 Higress Provider/`modelMapping` 不同步、Worker 模型不可用和
`aigw-local` 解析问题；截至本次复核仍是 Open，页面没有关联修复 PR。这与本地 v1.2.2
的“部署层注入成功但 Worker 实际路由不可用”现象属于同一类上游边界风险。
因此当前发布门禁仍是 **No-Go**。要解除它，部署层必须提供并实际传递一个可验证的
AI gateway endpoint（或 AgentTeams 上游修复 Controller 的本地 URL 注入），并在同一
个全新 Worker 内证明 `/v1/models` 和一次真实 Chat/Responses 回合成功；在此之前不做
Qwen 数据迁移、不创建 release、不合并 `main`。

### Tiangong 侧显式绕过（等待上游修复期间）

等待 AgentTeams Controller 修复 embedded 模式地址覆盖期间，Tiangong canary
镜像支持一个部署层的、非密钥的 endpoint override。它只影响 Tiangong
Codex/OpenClaw Worker 的模型目标，不绕过 AgentTeams Consumer 鉴权，也不把
DeepSeek Key 写入镜像、Worker 配置或日志。

构建 canary/profile 镜像时显式传入：

```bash
TIANGONG_CODEX_GATEWAY_HOSTS=agentteams-controller,aigw-local.agentteams.io \\
TIANGONG_CODEX_BASE_URL=http://aigw-local.agentteams.io:8080/v1 \\
make build-worker-image
```

`TIANGONG_CODEX_BASE_URL` 仅接受无凭证、无 query/fragment 的 HTTP(S) URL；
`TIANGONG_CODEX_GATEWAY_HOSTS` 是 Worker preflight 的显式 host allowlist。
没有传入这些变量时，镜像保持原有默认行为。运行时仍必须通过
`/v1/models` 认证探测和真实模型 smoke；探测失败会 fail closed。

AgentTeams v1.2.2 的 B5/Phase C 部署注入还会对每个被重建的 Worker
重新写入 `AGENTTEAMS_AI_GATEWAY_URL` 和 `AGENTTEAMS_AI_GATEWAY_DOMAIN`，默认指向
`http://aigw-local.agentteams.io:8080`；Leader 仍使用 OpenClaw 内置 runtime，
所以这个修正同样覆盖 Leader 的内置模型请求。Implementor 的 Codex 路由同时
重写 `TIANGONG_CODEX_BASE_URL` 和 host allowlist。两条注入路径都拒绝带凭证的
URL，并从 env-file 中排除旧值，避免 AgentTeams 错误的 `agentteams-controller`
地址在重建时再次生效。

### AgentTeams v1.2.2 网关路由的第二个绕过点

仅修正 Worker endpoint 仍不够。当前 v1.2.2 的 embedded Higress 初始化会把
`AGENTTEAMS_OPENAI_BASE_URL=https://api.deepseek.com/v1` 原样写入 AI Proxy，
而 AI Proxy 还会为请求追加 `/v1`。真实请求因此变成 `/v1/v1/...`，上游返回
404；这不是 DeepSeek Key 或 OpenClaw/Codex transport 失败。

部署侧现在提供 `scripts/normalize-agentteams-gateway-provider.sh`：

```bash
TIANGONG_GATEWAY_PROVIDER_SNAPSHOT_ID=phasec-<run-id> \\
bash scripts/normalize-agentteams-gateway-provider.sh normalize
```

脚本在 `agentteams-controller` 容器内用已有的 Higress 管理凭证读取并更新
`openai-compat` provider 和对应 service source，把精确的 `/v1` 后缀改成服务
根地址；凭证只在 Controller 进程边界内使用，不写入宿主机参数、日志或镜像。
它会在 Controller 的临时目录建立回滚快照，失败或 smoke 结束时执行：

```bash
TIANGONG_GATEWAY_PROVIDER_SNAPSHOT_ID=phasec-<run-id> \\
bash scripts/normalize-agentteams-gateway-provider.sh restore
```

B5 驱动会在创建 Worker 前自动执行 normalize，并在清理阶段无条件 restore。
Provider、Manager 或 Controller 被重新初始化后必须再次执行 normalize；不能把
一次 smoke 的结果当作永久配置。另一个部署侧动作是通过 Controller 的
`POST /api/v1/gateway/consumers/{worker-<name>}/bind` 为本次 run 的五个精确
Worker consumer 授权 AI route，未绑定或绑定失败即 fail closed。

这两个动作共同绕过 v1.2.2 的“地址覆盖 + provider 路径 + consumer route”
缺口，但仍不等于 Phase C Go：必须在同一全新 run 内看到 `/v1/models`、Leader
builtin Chat、Implementor Codex ToolResult、重启恢复和精确清理全部通过。

### 真实 B5 验证记录（2026-08-18）

在全新 `codex-bypass-verified-*` run 中，绕过链路和业务闭环均通过：

- `agentteams_gateway_provider=skip ... reason=already_normalized`：Provider
  已处于服务根地址，normalize/restore 生命周期正常；
- `gateb=ai_gateway_consumer_binding=pass consumers=5`：五个精确 Worker
  Consumer 均完成授权；
- `gateb=opencodex_sidecar_provisioned`、`role_runtime_reinjected_after_manager=pass`、
  `coordination_runtime_deployment=ready`：Codex sidecar、Manager 重启后的
  角色投影和协调服务均就绪；
- `leader_smoke_real_team=pass`、`leader_smoke_design_roundtrip=pass`、
  `leader_smoke_matrix_handoff=pass`、`leader_smoke_implementor_blocker_result=pass`、
  `leader_smoke_requester_report=pass`：Leader 内置 runtime、设计交接、
  Implementor Codex ToolResult/阻断结果以及 Matrix requester report 均通过；
- `gateb_matrix_work_task_result_closure=pass`、`gateb_cleanup=pass`：任务闭环和
  精确清理通过。`leader_smoke_gate3=partial_blocked_terminal_only` 是当前
  smoke 的预期边界：环境没有真实终端执行器，Leader 正确生成
  `RECOVERY_REQUIRED`，不代表网关或 Codex 路由失败。

因此这条部署侧绕过路径已经有真实可重复的 B5 证据；上游 AgentTeams 修复
合并前仍需由部署层保留 normalize、consumer bind 和 endpoint 注入三项动作。

### 2026-08-18 Alpha.1 合并后的最新门禁状态

Alpha.1 控制面已经合并到 `develop`（合并提交 `dbcafaa`）。合并后的
`test-phase-c-production-boundary.sh`、Worker 协调回归和 App 回归仍全部通过；
这只能证明代码和部署合同的确定性边界，没有把真实模型请求变成通过证据。

同日用全新、唯一 run-id 重跑真实 Gate B：Team、五个 Worker、Coordination/PG、
OpenCodex sidecar、角色注入和精确 cleanup 均按合同执行。Implementor 的真实
OpenCodex `/v1/responses` 请求返回 HTTP 402 `Insufficient Balance`，随后按
provider billing/credential 外部阻断处理；没有伪造 Task/Result/Leader 成功，
本次资源已全部清理。因此当前 Phase C 仍为 **No-Go**，不是 Tiangong 控制面
或 sidecar 生命周期失败。

解除 No-Go 的唯一下一步是由部署层通过 AgentTeams secret/credential 注入一个
有余额的、scope 正确的 provider credential，然后在同一类全新 run 中重新执行
`make phase-c-real`，收集 `/v1/models`、真实 Chat/Responses、ToolResult、
重启恢复和 cleanup 的机器事实。凭证不得写入仓库、镜像、命令行、Worker 状态
或 Evidence；在该证据闭合前不创建新的 release、不迁移数据、不合入 `main`。

### 2026-08-18 临时 credential 复测补充

部署层使用一次性临时 DeepSeek credential 做了可回滚轮换：provider 快照、
`apiTokens` 替换和恢复均在 Controller 内完成，临时值没有进入仓库、命令输出
或 Worker 状态。替换后的 `/v1/models` 认证探测返回 HTTP 200，说明 key 的
认证链路可达；但同一全新 Gate B 的 Leader 首轮真实 Chat 仍返回 HTTP 402
`Insufficient Balance`。Codex gateway preflight、OpenCodex sidecar ready、
五角色注入和 cleanup 均通过，不能把这次结果归因于 runtime 或 adapter。

测试超时后已验证精确 Team/Worker/Coordination/PG/sidecar 资源不存在，原
provider 配置也已恢复。当前 Phase C 仍保持 No-Go，下一次必须使用确实有余额
的 provider credential，不能只满足 `/v1/models` 的认证探测。

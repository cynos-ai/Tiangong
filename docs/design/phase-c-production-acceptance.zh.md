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

因此当前发布门禁仍是 **No-Go**。要解除它，部署层必须提供并实际传递一个可验证的
AI gateway endpoint（或 AgentTeams 上游修复 Controller 的本地 URL 注入），并在同一
个全新 Worker 内证明 `/v1/models` 和一次真实 Chat/Responses 回合成功；在此之前不做
Qwen 数据迁移、不创建 release、不合并 `main`。

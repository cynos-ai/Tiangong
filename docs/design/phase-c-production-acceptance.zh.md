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

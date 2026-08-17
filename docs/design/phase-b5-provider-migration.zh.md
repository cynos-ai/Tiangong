# Phase B5：provider 路由与 Coordination 迁移合同

> 状态：实现了可执行的迁移合同、路由 fail-closed 校验和回归测试；默认 DeepSeek 路由没有改变。当前分支不把 Qwen 切成默认，也不执行权威数据 cutover。

## 这次收口了什么

AgentTeams 的 provider 选择仍由部署层 `.env` 控制，Worker 不保存上游 provider key：

| 路由 | provider / endpoint / model | 传输 | 适用场景 |
| --- | --- | --- | --- |
| DeepSeek 原生 | `openai-compat` / `https://api.deepseek.com/v1` / `deepseek-v4-*` | Responses | 默认编程路径 |
| Qwen 原生 | `qwen` / `https://dashscope.aliyuncs.com/compatible-mode/v1` / `qwen*` | provider-managed | Qwen 原生 Responses 能力 |
| Qwen Coding Plan | `openai-compat` / `https://coding.dashscope.aliyuncs.com/v1` / `qwen*` | Responses → OpenCodex → Chat | Chat-only Coding Plan |

`make provider-check` 是只读门：它会校验 provider、endpoint、模型模式和凭证是否存在，只输出凭证状态，不输出 key。endpoint 禁止 query、fragment 和内嵌账号密码；未知路由直接失败。当前 `.env` 的实际值优先于示例文件，因此切换 Qwen 需要在受控部署配置中同时替换 provider、endpoint、default model 和 AgentTeams credential，然后先跑 provider-check，再做 Team canary。

## 凭证边界

- Coding Plan 或 DeepSeek 的上游 key 只由 AgentTeams secret/credential-provider 持有。
- Worker、OpenClaw、Codex、OpenCodex sidecar 只接触 Worker-scoped consumer token；该 token 通过内存或受限 secret projection 使用。
- key、consumer token、Authorization header 不进入仓库、镜像 `ENV`、命令参数、Session、ToolResult、Evidence 或日志。
- AgentTeams v1.2.2 的 `agt` 仍没有 OpenCodex-specific sidecar lifecycle 字段，所以 sidecar 的 provision/ready/reconcile/rotate/drain/remove 由 deployment-owned adapter 管理；这不改变 AgentTeams 作为 provider credential 和 Team/Matrix/WebUI 控制面的职责。

## Coordination 迁移合同

`app/coordination/migration-contract.mjs` 把“能不能迁移”变成机器可验证的计划，而不是依赖 Leader 或模型口头判断：

- source 必须是保留且只读的 `legacy-pi`，并绑定精确 snapshot SHA-256；
- target 固定为 `tiangong_coordination` 的 `001_coordination`、`002_task_result`，采用 `shadow-read-then-cutover`；
- default route 和 candidate route 必须显式包含 provider、model、endpoint、transport、bridge、credentialSource；凭证来源只能是 `agentteams-secret`；
- rollback 同时绑定原默认 route digest、源 snapshot digest、owner 和有限恢复窗口；
- `providerCanary`、`matrixWeb`、`toolResultRetention`、`restartRecovery`、`rollback`、`cleanup` 六个门必须全部 pass；
- plan 自带 digest，篡改、越级状态跳转、未验证 cutover、未验证 rollback 都 fail closed。

迁移状态只能按 `planned → prepared → canary → cutover → completed` 前进，任意已准备阶段可进入 `rolled-back`；终态不能伪造继续迁移。该合同覆盖 Work、Task、Result、ToolResult 的数据保留和回滚前提，但不替代真正的 PG schema migration 或部署切换。

## 已有验证与下一道门

- 当前默认 DeepSeek 运行路径保持不变。
- Qwen Coding Plan endpoint 已完成真实 HTTP 200 直连探测；这证明上游凭证和 endpoint 可达，不等价于当前本地栈的新一轮 Team smoke。
- 历史受控 AgentTeams v1.2.2 Team canary 已验证 Leader → Matrix Team room → Codex/OpenCodex bridge Worker → Qwen Coding Plan，并确认 `provider=codex`、`fallbackUsed=false`；测试资源已清理并恢复 DeepSeek 路由。
- 本分支新增 `make test-coordination-migration-contract`，与 `npm --prefix app test` 一起验证迁移合同和 Web/Coordination 投影。

真正切换前仍需在隔离的 AgentTeams 配置/数据卷执行一次完整 Qwen Team canary：记录 provider canary、Matrix/WebUI 可见性、ToolResult retention、重启恢复、回滚恢复和 cleanup 六项机器事实；任何一项失败都保留 legacy-pi 和 DeepSeek，不做 cutover。

# Phase B6：2026-08-17 Qwen Team 真实 canary 复测

> 发布范围更新（2026-08-17）：后续补丁已关闭 Leader 角色推导和固定
> professional image 的部署注入缺口，并通过了确定性注册、镜像和 CI
> 边界。本文仍保留 Qwen provider/catalog 的真实阻断事实；v0.3.0 不把
> Qwen Team ToolResult 写成绿色能力，Qwen 仍是后续 provider enablement
> 后的独立 canary。

本记录对应 `phase-b6-qwen-team-canary.zh.md` 的最新复测。使用的资源均为 disposable `phaseb6-qwen-20260817-*`，结束时已逐项清理；没有把任何上游 key 写入仓库、镜像、receipt、ToolResult 或日志。

## 已证明

- AgentTeams/Higress 的 Coding Plan 路由在同时更新 `openai-compat` service source 和 provider 后可用：管理面 `/v1/models` 与 `/v1/chat/completions` 均返回 HTTP 200。只更新 provider 而不更新已有 service source 会继续得到 HTTP 418；根因是 v1.2.2 初始化器对已有 service source 只读不 reconcile。
- `qwen3.7-plus` Bridge Worker 启动 preflight 通过：`provider=agentteams-gateway`、`transport=responses-via-chat-bridge`、`bridge=opencodex`、gateway auth/connectivity pass。Worker 通过 OpenCodex sidecar 的 `/healthz`、`/readyz` 和 `/v1/models`。
- `agt get team` 达到 `phase=Active`，Leader 与 Bridge Worker 都 ready；Dashboard 返回 HTTP 200。
- Qwen Leader 经真实 Matrix Team Room 回复成功；从 Leader 身份直接 mention Bridge 后，回复 sender 确实是 Bridge Worker，而不是 Leader 自己伪造的消息。
- Bridge Worker 重启后重新通过 Codex preflight，Matrix 回复仍来自 Bridge；sidecar `reconcile` 保持 `ready`。
- sidecar generation 1→2 rotate 后 `reconcile` 返回 `ready`，随后 Worker 再次重启并通过 preflight。
- 清理阶段执行 sidecar `drain → remove`、删除 Team/Workers，并确认 disposable Docker 资源不存在；最后恢复 DeepSeek service source/provider，管理面 `/v1/models` 返回 HTTP 200。

## 尚未闭环的生产门槛

本轮没有把“Leader 正式 Tiangong coordination ToolResult”标成通过，原因是可复现的 AgentTeams v1.2.2 部署边界：

1. Team CR 的 `leader`/`worker` 角色会出现在 Team 状态和 Matrix 房间成员中，但托管 OpenClaw Worker 的环境仍是 `AGENTTEAMS_WORKER_ROLE=standalone`，没有注入 Tiangong plugin 所需的 `TIANGONG_ROLE_ID`、`TIANGONG_MEMBER_COORDINATION_ENABLED`、协调控制 endpoint/token 等字段。
2. v1.2.2 的公开 REST `CreateWorker`/`UpdateWorker` 处理器没有把 `WorkerSpec.env` 写入 Worker 容器；因此不能用标准 `agt` API 安全地补齐这些运行时绑定。将协调 token 烘焙进临时镜像也不符合凭证只在内存/Adapter 边界存在的规则，本轮没有这么做。
3. 因此本轮验证的是“Qwen + OpenClaw 内置 Leader/Matrix + Codex/OpenCodex Bridge 的真实消息链路”和 sidecar 生命周期；正式 Tiangong `team_dispatch_task → team_submit_result → ToolResult retention` 仍需部署层注入或 AgentTeams 上游支持后重跑。

## Gate 判定

Qwen canary 当前为 **partial / blocked-at-deployment-injection**，不是 green。Phase C sidecar 合同本身已通过，但 Phase C 的生产部署注入和正式 Team ToolResult 验收仍未闭环；在该门槛关闭前不创建 `release/v0.3.0`，也不合入 `main`。

## 2026-08-17 Gate B 真实复测补充

本轮把 provider 路由切到隔离的 Qwen Coding Plan canary，并使用 `qwen3.7-plus` 运行完整的 B5/Gate B 入口。结果需要拆开看：

- `qwen-canary-20260817-12`、`qwen-canary-20260817-16` 证明了 Qwen 下 stock OpenClaw Leader 的真实 Matrix 回合：Team 建立、设计任务派发、设计 ResultEnvelope 检查、Leader accept 决策、实现任务派发，以及阻塞后的 `RECOVERY_REQUIRED` requester report 都能进入 Tiangong smoke oracle；`20260817-16` 的 `leader_smoke_*` 全部通过。
- `qwen-canary-20260817-12/16` 的 Implementor 也通过了 `runtime=codex-app-server`、`codex_gateway_preflight=pass`、`model=qwen3.7-plus`、`transport=responses-via-chat-bridge`、`bridge=opencodex`，sidecar `/v1/models` 和 ready receipt 均通过。没有把 key 写入 binding、receipt 或日志。
- 复测暴露了两个部署/测试边界：共享 Runner broker 会保留旧的 image-pinned binding；Docker Desktop 慢操作会让基于 `--since 10m` 的 readiness 观察失效。代码已改为按当前 Worker image digest 检查 broker，自动回收仅指向已消失容器的 orphan binding；readiness 改为检查本次重建容器的完整生命周期日志，PostgreSQL probe 和 broker ensure 也有超时边界。
- 分步 Leader resume 已替代一次性长 prompt（check → decide → dispatch/report），显著减少 Qwen 在恢复回合中不返回 marker 的情况。但 `qwen-canary-20260817-18` 仍在 dispatch 回合出现模型无工具回合响应超时，说明 Qwen Coding Plan 的模型行为/延迟仍不是稳定的 Gate B 生产证据；这不是 sidecar receipt 或 AgentTeams credential 失败。

因此当前结论是：**Qwen + OpenClaw builtin Leader/Matrix + OpenCodex bridge 的协议和大部分真实路径可行，但 Qwen Team Full/Gate B 仍未 green。** 该结果足以继续做参数化和隔离 canary，不足以切默认 provider、迁移权威数据、删除 legacy lane、创建 `release/v0.3.0` 或合入 `main`。下一次验收必须在稳定的 AgentTeams credential/Matrix/Runner broker 部署上重复，并把 Qwen dispatch 的稳定成功、ToolResult retention、重启恢复、回滚和 cleanup 全部记录为机器证据。

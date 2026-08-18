# Phase Alpha.1：最小控制面纵切

状态：实现中，基线为 `develop` 合并提交 `488ce63`；本分支补齐最小
Work/Task/Result/Decision/WebUI 纵切。

## 目标

Alpha.1 不是另起一套 runtime，也不是让 WebUI 或模型文本成为权限源。它
复用现有 file-backed/PG CoordinationStore，把 Leader 的语义判断落成受
认证、幂等、Work epoch 和当前 Team binding 约束的机器事实：

```text
Human Matrix ingress
        ↓
Work → Task → Result → Leader Task Decision
        ↓                    ↓
   durable wake        Work complete/stop
        ↓                    ↓
      Matrix              WebUI / SSE projection
```

Leader 仍然是 AgentTeams 管理的一个 Worker；它可以使用 OpenClaw 内置
runtime。Codex/OpenCodex 只属于需要编程模型的成员路径，不能替代
CoordinationStore 或 Team/Matrix 控制面。

## Decision 边界

`CoordinationDecision` 是带版本和 `contentDigest` 的 typed source fact，
不是第二个可编辑 Task 状态机，也不是泛化的 decision ledger：

- `accept` 只能由当前 Team Leader 对一个已有 Result 作出，并且必须绑定
  Result 的精确 `contentDigest`；
- `blocked` 记录 Leader 对一个 assigned/reported Task 的阻塞判断；
- `complete`/`stop` 是 Work closure fact，写入 Work timeline 和 terminal
  projection；`complete` 要求所有 Task 已 accept 或 cancelled，`stop` 要求
  所有 Task 已进入 terminal projection；
- 同一 requestId 同一内容重放成功，内容冲突返回
  `COMMAND_REQUEST_CONFLICT`；Work terminal 后拒绝后续写入。

Task Decision 通过 `task-decided` timeline event 与 Task projection 原子
提交；Work closure 通过 `work-closed` event 与 Work status/epoch 原子
提交。file-backed journal 和 PostgreSQL 适配器保持同一语义，PG 使用
`003_decision_closure` 增加决策列和 terminal Task status 约束。

## API

- `POST /v1/coordination/decisions`：当前绑定 Leader 接受或阻塞 Task；
- `GET /v1/coordination/decisions/:decisionId`：只读决策事实；
- `POST /v1/coordination/works/:workId/close`：当前绑定 Leader 完成或停止
  Work；
- `GET /api/runtime`：投影 Works、Tasks、Results、Decisions、wakes 和
  bounded ToolResult metadata；
- `GET /api/runtime/events`：同一投影的 Server-Sent Events，只读，不接受
  UI 写入。

WebUI 使用 SSE 实时刷新；SSE 不可用时退回一次性 `/api/runtime`，仍然诚实
显示 `unknown`，不会把界面文字当作完成证明。

## 验收门槛

1. file-backed store：schema/digest、Leader actor、Result digest、epoch、
   replay、journal reopen 和 terminal rejection；
2. PG store：migration 003、同一事务边界、行锁和 replay；
3. Control API：Bearer、server-side Team binding、accept/blocked/close 和
   最近的错误路径；
4. WebUI：Work/Task/Result/Decision bounded projection 与 SSE 首帧；
5. 真实 DeepSeek Codex 成功路径、OpenClaw built-in Leader 路径和真实
   AgentTeams/Matrix/WebUI smoke 仍按 Phase C 的部署注入与 cleanup 门槛
   验证，不能用本地单测替代。

## 当前真实验证结果（2026-08-18）

- file-backed 与 PG 的 Decision/closure 回归通过；PG 使用 disposable
  PostgreSQL 容器实际执行 `003_decision_closure` migration、事务、行锁和
  replay 测试；Control API、remote facade、WebUI SSE 回归通过。
- Phase C deterministic boundary 全绿。真实 Gate B 已按唯一 run-id 启动五个
  Worker、Coordination/PG、OpenCodex sidecar 和 Matrix Team，并完成了资源
  注入；实现路径在 OpenCodex `/v1/responses` 处收到上游 HTTP 402
  `Insufficient Balance`，因此没有伪造 Leader/Task 成功或 WebUI 通过结论。
  该结果归类为外部 provider credential/billing 环境阻断，不是
  CoordinationDecision 或 SSE 代码失败。此次 run-owned Team、Worker、sidecar、
  PG、volume 和临时状态均已精确清理。
- 要解除该阻断，需要部署层为 AgentTeams/Codex sidecar 注入一个有余额且具备
  DeepSeek V4 Pro 额度的 scoped credential，然后重跑同一 Gate B；不应把 key
  写入仓库、镜像、日志或 WebUI。

凭证、PG URL、Matrix token、provider key 和真实 Team 证据只由部署层注入，
不进入本仓库或 WebUI 投影。

# Phase B3：Task/Result Gateway

状态：已实现确定性 PG / file-backed 双后端，并完成 disposable PostgreSQL 回归；真实 AgentTeams Worker 的生产注入仍由部署层负责。

## 目标

让 Leader 创建不可变 TaskSpec，成员只提交一次 Result，并把这两个事实与 Work epoch、timeline、request replay、durable wake 放在同一个 CoordinationStore 事务边界内。Task/Result 是直接事实，不由 Web UI 或模型文本另建状态机。

## 已实现边界

- PostgreSQL migration `002_task_result` 增加 `task` 与 `result` 表；Result 通过 `task_id` 唯一约束保证一个 Task 至多一个 Result。
- `PostgresCoordinationStore.createTask`：校验 Team、Member、ControlProfile、assignee 和 Work epoch；原子写 Task、timeline、epoch 和可选 `task-assignment` wake。
- `PostgresCoordinationStore.submitResult`：校验 producer、ToolResult ownership/retention、Task 绑定和 epoch；锁定 Work/Task 后原子写 Result、Task 状态、timeline 和 epoch。
- `cancelTask` 与 `submitResult` 竞争同一行 Task；先提交者获胜，已报告或已取消的 Task 不能被另一条路径覆盖。
- `/v1/coordination/tasks/:taskId` 与 `/v1/coordination/results/:resultId` 是带部署 bearer 的只读 Gateway；Worker 只获得窄 HTTP facade，不接触 PG。
- `/api/runtime` 投影 bounded Task/Result/ToolResult metadata；不输出 ControlProfile、数据库 URL、Matrix token 或原始 ToolResult payload。
- file-backed `CoordinationStore` 同样提供 `listTasks`/`listResults`，因此本地 Web 与 PG Web 使用同一投影形状。

## 验证标准

1. schema、digest、binding、replay 和未知字段拒绝通过确定性测试。
2. Task create、Result submit、取消竞争、重复请求和重启读取均通过。
3. disposable PostgreSQL 真实迁移与 `npm --prefix app test` 全量通过，且测试容器清理后不存在。
4. Web 只作为直接事实的投影；不能通过 UI 标签完成 Task、接受 Result 或关闭 Work。

## 尚未宣称完成的部分

此 B3 slice 还没有把 AgentTeams v1.2.2 的管理面扩展成原生 sidecar/secret/mount API。Leader Worker 的 binding、Control API endpoint 和短 token 仍必须由部署层注入；缺失时 `verify-leader-runtime-injection.sh` 应 fail-closed。B4 的 prepared workspace、Runner 进程树隔离和真实 coding smoke 仍是下一阶段。

## 2026-08-16 Task/Result Gateway slice

The deployment Control API now exposes two write paths in addition to the
existing bounded reads:

- `POST /v1/coordination/tasks` accepts a schema-valid TaskSpec plus the
  Leader actor, resolves the assignee from the server-side Team binding, and
  atomically emits a `task-assignment` wake.
- `POST /v1/coordination/results` accepts a schema-valid Result plus the bound
  producer actor, performs the existing epoch/one-result checks, and emits a
  replay-safe `result-notification` wake for the Leader.

The Worker-side facade routes both writes through the same bearer gateway and
never receives a PG handle or Team authority. Contract tests cover server-side
assignee/producer binding, replay, task/result projection, and bounded HTTP
request shapes. The remaining B3 evidence is a real disposable Team with a
non-Leader member Worker consuming `task-assignment` and submitting one Result;
this is deployment smoke, not a reason to reintroduce the Tiangong-owned Pi
runtime.
## 2026-08-16 native member session hook

`worker/agent/team/member-coordination-hooks.mjs` is the B3 member-side slice.
It registers only OpenClaw's official `before_prompt_build` and `agent_end`
hooks: the first hook fetches the immutable TaskSpec through the bearer gateway
and prepends a bounded read-only context; the second creates one bounded Result
from the completed native session and submits it through the same gateway. The
module has no PG handle, Team binding authority, Matrix credential, or model
loop. `TIANGONG_MEMBER_COORDINATION_ENABLED=1` is an explicit deployment opt-in
and `TIANGONG_MEMBER_ID` is injected by the deployment owner.

This is the intended B3 Full path for a non-Leader Worker. The Leader remains an
ordinary OpenClaw built-in runtime session; the existing `tiangong-pi` harness is
still a retained legacy lane until the internal plan's Gate B review and B6
clean-cut PR. A contract test now proves Task binding, one Result submission,
and the absence of the bearer token from the request body. Live member-session
smoke still needs a rebuilt Worker image plus deployment-owned member env/token
injection; until that run, B3 is not marked complete.

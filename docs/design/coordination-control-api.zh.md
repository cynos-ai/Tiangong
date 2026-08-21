# Leader Worker 与 CoordinationStore 控制边界

状态：M7 PostgreSQL 单一产品权威已完成；生产上线仍需部署系统注入 binding/secret。

## 先说结论

Leader 确实也是 AgentTeams 的一个 Worker，但它不是“自己记总账”。更准确的比喻是：

```text
Leader Worker = 前台接待员：读 Matrix、把请求递交出去、继续执行
Control API   = 出纳柜台：核验绑定、写入 Work 总账、生成可重试的唤醒单
PostgreSQL   = 总账本：Work、Timeline、Matrix 事件绑定、请求重放、Outbox
Web 工作台    = Matrix 对话 + 只读产品事实；不参与 Work 路由或裁决
```

因此 Worker 永远不拿数据库连接，也不能把 Team/Route/Profile 从请求体带进来。Team 绑定由 Control API 在启动时注入并固定；Worker 只提交自己通过认证 Matrix channel 重读过的 `source + event` 证明。

## 当前实现

- `app/coordination/postgres-store.mjs`：PostgreSQL CoordinationStore。迁移脚本在 `app/coordination/migrations/001_coordination.sql`。
- `app/coordination/control-api.mjs`：受控 HTTP 边界。
  - `POST /v1/coordination/admit`：一次人类 Matrix 事件只创建一个 Work。
  - `POST /v1/coordination/resume`：只接受部署消费者发出的 Leader resume 控制事件，不创建 Work，只返回绑定的 durable Work facts。
  - `POST /v1/coordination/wakes/claim`：原子领取 Outbox 唤醒。
  - `POST /v1/coordination/wakes/ack`：投递成功后确认唤醒。
- `worker/agent/team/coordination-control-client.mjs`：Worker 端 remote hook。它先调用本地认证 Matrix channel 的 `readHumanEvent(roomId, eventId)`，再调用 Control API；响应不会包含数据库句柄。
- `worker/agent/team/leader-runtime-config.mjs`：部署层启动绑定加载器。绑定文件只放 Team/Route/Profile/Leader/member 的无凭证快照；文件必须是绝对路径、普通文件、限长且（非 Windows）权限收紧。Control API token 另由 secret manager 注入。
- `app/coordination/bootstrap.mjs`：从部署层的 `TIANGONG_COORDINATION_DATABASE_URL` 创建 PG store。连接串只在内存中交给 `pg`，不会写日志或 Evidence。
- `app/server.mjs`：通过注入的 PostgreSQL store 接入 Web 只读事实，通过 `matrix-web-gateway.mjs` 接入 Human Matrix chat；未注入时只显示 `postgres-not-configured`，不存在文件产品后端。

## 生产运行时已经补齐的启动路径

部署层现在可以直接启动 `app/coordination/runtime-server.mjs`。它会读取无凭证的 Leader binding，执行 PG migration，启动 Control API 和 M3 Web。提供 Matrix URL 即启用 Human chat；再提供 deployment Matrix token 才启动唯一的 PG Outbox → Matrix 消费者。

```powershell
$env:TIANGONG_LEADER_RUNTIME_BINDING_FILE = "C:\\etc\\tiangong\\leader-binding.json"
$env:TIANGONG_COORDINATION_DATABASE_URL = "postgres://..."       # 由 secret manager 注入
$env:TIANGONG_COORDINATION_CONTROL_TOKEN = "..."                 # 只进部署进程
$env:AGENTTEAMS_MATRIX_URL = "https://matrix.example.test"      # Human Web login
$env:TIANGONG_COORDINATION_MATRIX_TOKEN = "..."                  # 可选，只进 outbox sender
npm --prefix app run start-coordination
```

Worker 只需要得到 `TIANGONG_LEADER_RUNTIME_BINDING_FILE`、`TIANGONG_COORDINATION_CONTROL_ENDPOINT`（必须是 `/v1/coordination/admit`）和对应的短期 Control token。Worker 启动时自动加载 binding；OpenClaw Matrix 入口会先重读事件，再自动选择 `/admit` 或 `/resume`。Worker 永远不拿 PG URL 或 Matrix 部署 token。

Matrix 入站归单 backlog 与内部 wake outbox 是两套不同事务合同：前者按 Room 顺序 lease Human event 引用并完成 Work 关联/纠正，后者 claim/ack 已形成的内部 Agent 唤醒。它们不会因为都属于队列而合并。

Outbox 的事件包括：

- `leader-resume`：部署消费者发一个带 `com.tiangong.leader-resume` 的确定性 Matrix 事件。Leader Worker 先读取 PG Work，再进入下一次模型 turn。
- `human-reply`：部署消费者发一个带 `com.tiangong.work` 的确定性 Work admitted 事件，提醒 Leader 读取同一份 durable Work。

发送成功后才 claim/ack；发送进程在两步之间崩溃会留下 pending，下一轮使用相同 transaction id 重放，不会产生新的逻辑事件。`/readyz` 只有在 PG 健康（以及启用 Matrix 时身份校验通过）才返回 ready。

## 为什么不能把 MinIO 当实时总账

AgentTeams 的共享对象空间用于 Plan、报告和其他 ContentRef 交付物。它是对象/文件层，不是并发事务总账：同步或对象通知不能代替 PostgreSQL 的原子 Work、Task、Result、admission 和 wake 状态。

PG 负责 Work、Timeline、事件唯一绑定、请求重放和 Outbox 的事务状态；Matrix 负责 chat/history/sync/send 和低延迟唤醒，MinIO 只保存大对象和附件。Web 从 Matrix 读取对话、从 PG/ToolResult source 读取受限事实，不复制聊天正文。

## 生产上线的唯一外部前置

代码已经证明“Leader Worker → Control API → PG 总账”和“PG Outbox → Matrix → Leader resume”可以工作。AgentTeams v1.2.2 的 `agt apply worker` 仍未提供独立的 Coordination API/Store/Leader session 字段，因此生产上仍需部署层把 binding 文件、Control API 和 `runtime-server` 作为显式组件部署；这不再是 Tiangong 代码缺口，而是 AgentTeams 管理面字段缺口。

1. 由 AgentTeams/部署系统生成并保护当前 binding 文件。
2. 启动 `npm --prefix app run start-coordination`，注入 PG、Control token 和可选 Matrix token。
3. 给 Leader Worker 注入 binding 路径、Control endpoint/token 与现有 AgentTeams Matrix Worker 凭证。
4. 以 `/readyz`、outbox pending→acked、Leader resume 和 `/api/runtime` 投影作为上线证据。

部署层也可以用 `createLeaderRuntimeBinding({ filePath, controlEndpoint, controlToken, channel })` 一次得到 `leaderIngress` 和远程 outbox facade；当前 Worker runtime 已经自动完成同样的绑定，不需要 OpenClaw 配置再维护一份 hook。这一步是启动绑定，不是把凭证写进 OpenClaw 配置或 Worker image。

如果其中任何一项缺失，OpenClaw 的 Matrix 原生入口仍 fail-closed，不会假装已经有总账。

## 验证标准

- 同一 `roomId + eventId` 只能绑定一个 Work；并发重复请求最多一个成功。
- 相同 `requestId` 与相同请求摘要可重放；相同 ID 但请求变更返回 `COMMAND_REQUEST_CONFLICT`。
- Work 创建、WorkSpec epoch 更新、wake claim/ack 都在事务中完成。
- Worker 只发送经过 Matrix channel 重读的事件证明，密钥只放在部署注入的 Bearer/secret manager 中。
- `/api/runtime` 只返回 Work/Timeline/Outbox 的受限投影，不返回 profile、token 或原始控制配置。

真实 disposable PostgreSQL 验证命令：

```powershell
$env:TIANGONG_TEST_POSTGRES_URL = "postgres://postgres:test@127.0.0.1:55432/tiangong"
$env:TIANGONG_TEST_POSTGRES_DISPOSABLE = "1"
npm test -- --test-name-pattern="Postgres CoordinationStore"
```

## 2026-08-16 B3 Gateway 补充

部署层现在还提供 `POST /v1/coordination/tasks` 和
`POST /v1/coordination/results`：前者只接受当前绑定 Leader 创建的
TaskSpec，并在同一事务内写入 `task-assignment` wake；后者只接受当前绑定
producer 的 Result，并在同一事务内写入 Leader 的 `result-notification` wake。
两条路径都复用现有 request replay、Work epoch、Task/Result binding 和 Web
projection，不把 PG 或 Team authority 暴露给 Worker；Worker facade 只发送
受限 HTTP 请求。
成员 Worker 的 OpenClaw built-in 路径由
`worker/agent/team/member-coordination-hooks.mjs` 接入：`before_prompt_build`
读取 TaskSpec，`agent_end` 提交一次 Result。它不是 Tiangong 自己的 runtime，
也不把数据库、Team binding 或 Matrix token 放进 Worker；部署层只注入
`TIANGONG_COORDINATION_CONTROL_ENDPOINT`、Worker-scoped token 和
`TIANGONG_MEMBER_ID`。Leader 和全部专业成员均使用 OpenClaw built-in；不存在 Tiangong model runtime、Codex/OpenCodex 或 legacy 回滚 lane。

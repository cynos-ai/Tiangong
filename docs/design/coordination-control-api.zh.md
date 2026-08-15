# Leader Worker 与 CoordinationStore 控制边界

状态：Phase B 实现中的可运行最小切片（2026-08-15）。

## 先说结论

Leader 确实也是 AgentTeams 的一个 Worker，但它不是“自己记总账”。更准确的比喻是：

```text
Leader Worker = 前台接待员：读 Matrix、把请求递交出去、继续执行
Control API   = 出纳柜台：核验绑定、写入 Work 总账、生成可重试的唤醒单
PostgreSQL   = 总账本：Work、Timeline、Matrix 事件绑定、请求重放、Outbox
Web UI        = 玻璃橱窗：只读投影，不参与裁决
```

因此 Worker 永远不拿数据库连接，也不能把 Team/Route/Profile 从请求体带进来。Team 绑定由 Control API 在启动时注入并固定；Worker 只提交自己通过认证 Matrix channel 重读过的 `source + event` 证明。

## 当前实现

- `app/coordination/postgres-store.mjs`：PostgreSQL CoordinationStore。迁移脚本在 `app/coordination/migrations/001_coordination.sql`。
- `app/coordination/control-api.mjs`：受控 HTTP 边界。
  - `POST /v1/coordination/admit`：一次人类 Matrix 事件只创建一个 Work。
  - `POST /v1/coordination/wakes/claim`：原子领取 Outbox 唤醒。
  - `POST /v1/coordination/wakes/ack`：投递成功后确认唤醒。
- `worker/agent/team/coordination-control-client.mjs`：Worker 端 remote hook。它先调用本地认证 Matrix channel 的 `readHumanEvent(roomId, eventId)`，再调用 Control API；响应不会包含数据库句柄。
- `app/coordination/bootstrap.mjs`：从部署层的 `TIANGONG_COORDINATION_DATABASE_URL` 创建 PG store。连接串只在内存中交给 `pg`，不会写日志或 Evidence。
- `app/server.mjs`：可以通过 `coordinationStore` 接入 Web 只读投影；没有注入时仍保留本地文件后端，便于开发和现有 smoke。

## 为什么还不能称为生产部署完成

代码已经证明“Leader Worker → Control API → PG 总账”的接口和事务可以工作，但 AgentTeams v1.2.2 的 `agt apply worker` 尚未提供独立的 Coordination API/Store/Leader session 字段。生产部署还需要由部署层完成一次显式绑定：

1. 创建 PG store 并执行 `store.migrate()`。
2. 用可信的当前 TeamConfig、TeamRouteBinding、ControlProfile、Leader MemberConfig 创建 `createCoordinationAdmissionHandler(...)`。
3. 将 `createRemoteOpenClawLeaderAdmissionHook(...)` 注入 Leader Worker 的 `createTiangongPiHarness({ leaderIngress })`。
4. 将 Web 进程只读连接到同一个 store，并由一个受控的 outbox delivery worker 领取/确认唤醒。

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


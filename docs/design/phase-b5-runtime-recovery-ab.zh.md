# Phase B5：角色 runtime 路由、重启恢复与 coding A/B 合同

> 状态：B5 的确定性合同已实现。它不替换 OpenClaw、Codex app-server 或
> AgentTeams，也不引入 Tiangong 自有的第二套模型循环。真实 Team 纵切和
> coding A/B 仍需在部署层按 Gate B 运行。

## 1. 角色路由

角色路由由 Worker 启动时的代码门决定，不能由 Matrix 文本、Skill 或模型回复改变：

| Tiangong role | runtime | 说明 |
| --- | --- | --- |
| `leader` | `openclaw-built-in` | Leader 使用 OpenClaw 官方内置 runtime，负责总账和 Work closure |
| `designer` | `openclaw-built-in` | 非编程专业任务 |
| `implementor` | `codex-app-server` | 编程任务，模型仍从 AgentTeams provider route 注入 |
| `assessor` | `openclaw-built-in` | 独立评估与测试任务 |
| `operator` | `openclaw-built-in` | 发布/运维任务 |

所有 B5 路由都强制 `fallback=none`。Implementor 误走 OpenClaw 内置 runtime，或
Leader/其他角色误启 Codex，都会在启动门失败；不会静默切换到另一套 Harness。
路由只保存角色、runtime、coding 标记和 `routeDigest`，不含 provider key、Matrix
token 或上游凭证。

部署要启用这一门时设置 `TIANGONG_RUNTIME_ROLE_ROUTING_REQUIRED=1`，并为非 Leader
Worker 提供部署拥有的 `TIANGONG_ROLE_ID`；Leader 可由 AgentTeams 的
`AGENTTEAMS_WORKER_ROLE=team_leader` 推导。旧的 Gate A 通用 canary 不带 role
绑定，继续作为兼容性探针，不被误报为 B5 Team 路由证明。

当前 pinned OpenClaw 镜像对官方内置 runtime 使用历史标识 `pi`；启动包装器只在
B5 路由门通过后把抽象的 `openclaw-built-in` 映射为这个上游标识。它与仓库自有的
`tiangong-pi` plugin harness 不是同一个 runtime，后者仍只作为 Gate B 前的 legacy
rollback。

## 2. WorkRun 重启恢复

每个 Task 只有一个持久化执行 owner。Worker 在开始 `executing` 前创建 owner lease；
lease 在进程崩溃后仍存在，因此新 Worker 看到 `executing`、`waiting_approval` 或
`verifying` 时返回 `recovery-required`，不能直接重新调用 Runner、重复提交 Result
或关闭 Work。

恢复路径只由部署/恢复控制器调用，模型工具面不暴露该接口：

1. 重新读取并校验 WorkRun binding 和 hash-chained phase journal；
2. 通过受控、只读的恢复授权确认外部执行状态；
3. `resume` 会先记录 `blocked(reason=worker-restart-reconciled)`，再记录
   `executing(reason=recovery-resume)`，最后接管新的 owner；
4. 终结 Result 后释放 owner lease；`abandon` 或未知/冲突状态不会伪造成功。

`worker/test/phase-b5-recovery.test.mjs` 覆盖 owner 冲突、重启不确定、未授权恢复、
恢复事件顺序以及终结后的 lease 清理。

## 3. coding A/B 证据边界

B5 的 A/B 必须固定相同 repo/commit、Task、模型、预算、环境和 capability，再分别
记录 runtime 路由、ToolResult/Result、测试与 local commit 事实。单次模型成功、模型
自评或“看起来完成”不构成通过条件。当前代码先提供可重复的角色路由和恢复合同；
真实 OpenClaw built-in 与受限 Codex 的质量/安全 A/B 要在独立 canary Team 中执行，
并保留 WebUI、Matrix、重启、取消和 cleanup 直接事实。

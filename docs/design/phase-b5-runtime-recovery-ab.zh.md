# Phase B5：角色 runtime 路由、重启恢复与 coding A/B 合同

> 状态：B5 的确定性合同、运维恢复入口、部署注入器、真实 Gate B 纵向切片和 coding A/B 已完成；Qwen Team canary 仍被当前 AgentTeams provider catalog 阻断，不能冒充通过。

## 1. 角色路由

角色路由由 Worker 启动时的代码门决定，不能由 Matrix 文本、Skill 或模型回复改变：

| Tiangong role | runtime | coding |
| --- | --- | --- |
| `leader` | `openclaw-built-in` | no |
| `designer` | `openclaw-built-in` | no |
| `implementor` | `codex-app-server` | yes |
| `assessor` | `openclaw-built-in` | no |
| `operator` | `openclaw-built-in` | no |

所有 B5 路由都要求 `fallback=none`。Implementor 误走 OpenClaw 内置 runtime，或 Leader/其他角色误启 Codex，启动门都会失败，不会静默切换到另一个 Harness。路由只保存角色、runtime、coding 标记和 `routeDigest`，不包含 provider key、Matrix token 或上游凭证。

部署启用路由门时设置 `TIANGONG_RUNTIME_ROLE_ROUTING_REQUIRED=1`。Leader 可由 AgentTeams 的 `AGENTTEAMS_WORKER_ROLE=team_leader` 推导；其他 Worker 必须由部署层注入 `TIANGONG_ROLE_ID`。当前 pinned OpenClaw 镜像的官方内置 runtime 历史标识是 `pi`，这不是仓库里的 `tiangong-pi` plugin harness；启动包装器只在路由通过后做这个标识映射。

Leader 的 OpenClaw plugin 注册也接受同一个 AgentTeams `team_leader` 身份断言，因此 v1.2.2 不必额外注入 `TIANGONG_ROLE_ID=leader` 才能出现 Leader 工具面。这个推导只适用于唯一的 Leader；普通 `worker` 不能因此获得任何 Tiangong 专业角色。Designer/Implementor/Assessor/Operator 仍必须由部署层绑定明确的 `TIANGONG_ROLE_ID`，并注入成员协调 endpoint、短期 token 和 `TIANGONG_MEMBER_ID`；这部分仍是 Phase C 的部署前置。

## 2. WorkRun 重启恢复

每个 Task 只有一个持久化执行 owner。Worker 在进入 `executing` 时取得 owner lease；进程崩溃后 lease 仍在，因此新 Worker 看到 `executing`、`waiting_approval` 或 `verifying` 时会返回 recovery-required，不能直接重调 Runner、重复提交 Result 或关闭 Work。

恢复只能由部署/恢复控制器调用，模型 tool surface 不暴露该接口：

1. 重新读取并校验 WorkRun binding 和 hash-chained phase journal；
2. 通过受控、只读的授权确认外部执行状态；
3. `resume` 先追加 `blocked(reason=worker-restart-reconciled)`，再追加 `executing(reason=recovery-resume)`，最后取得新的 owner；
4. Result 终结后释放 owner lease；`abandon` 或未确认冲突都不能伪造成功。

底层 `WorkRunStore.transition()` 同样强制 owner：进入 `executing` 时自动取得 lease；已启动阶段没有 lease 或 lease 属于其他进程时分别返回 `TIANGONG_WORK_RUN_RECOVERY_REQUIRED` 或 `TIANGONG_WORK_RUN_OWNER_CONFLICT`。绕过 `member-tools` 直接调用 store 也不能静默重放。

## 3. 运维恢复入口

`tiangong-work-run` 是 Worker 镜像内的非模型入口：

```text
tiangong-work-run inspect <run-id>
tiangong-work-run reconcile <run-id> --action resume|abandon \
  --actor <operator> --reason-code <CODE>
```

`inspect` 只读取 WorkRun binding、phase journal 和 owner lease。`reconcile` 只有在部署层显式设置 `TIANGONG_WORK_RUN_RECOVERY_MODE=operator`，且 `--actor` 出现在 `TIANGONG_WORK_RUN_RECOVERY_ACTORS`（逗号分隔）时才可用；它不注册到任何模型 tool surface。`reason-code` 是有界的大写代码，不接受自由文本授权。

`resume` 会把新的 owner lease 写入恢复后的 run。部署层必须把输出中的 owner identity 注入下一次 Worker 的 `TIANGONG_WORK_RUN_OWNER_ID`，或者在同一个受控恢复进程内继续执行；不能让普通聊天或模型自行生成 owner。`abandon` 只追加终态事实，不会伪造 Result 或外部执行成功。

## 4. coding A/B 证据边界

B5 A/B 必须固定同一 repo/commit、Task、模型、预算、环境和 capability，然后分别记录 runtime 路由、ToolResult/Result、测试和 local commit 事实。单次模型成功、模型自评或“看起来完成”不构成通过条件。真实 OpenClaw built-in 与受限 Codex 的质量/安全 A/B 必须在独立 canary Team 中执行，并保留 WebUI、Matrix、重启、取消和 cleanup 的直接机器事实。

当前公开代码已提供可重复的角色路由、owner/recovery 合同、B4 Codex/Runner/Coordination/WebUI/Matrix seam，以及 `scripts/inject-b5-role-runtime-docker.sh` 部署注入器。注入器只接受显式角色、只重建受支持的单 auth-volume Worker 拓扑、保留安全边界，并在新容器内校验路由。2026-08-16 的 fresh Team 启动验证真实通过五个角色的路由门和 `readyWorkers=4/4`；2026-08-17 的 Gate B `ab23` 又完成了同一 Team 的 Task/ToolResult/Leader relay、重启恢复、Matrix/WebUI seam 和精确 cleanup。

## 5. Gate B 与真实 coding A/B 结果（2026-08-17）

本轮使用 disposable Team/Worker，不把 prompt、模型原文、凭证或内部日志写入仓库。机器事实如下：

- Gate B `ab23`：`runner_broker_reused`、协调 runtime ready、Team/Matrix/Leader 路径、Task Result closure、重启恢复和 cleanup 全部通过。
- Codex 成功路径：真实 Codex app-server `initialize → thread/start → turn` 通过 AgentTeams gateway，`deepseek-v4-pro` 返回成功；没有 fallback。
- coding A/B：同一个 `Reply with exactly OK and nothing else.` 输入分别交给 OpenClaw built-in runtime（`deepseek-v4-flash`）和 Codex Server（`deepseek-v4-pro`），两边都得到机器可验证的 `OK`；执行轨迹分别标记 `runner=embedded`、`winnerProvider=agentteams-gateway`、`fallbackUsed=false`。
- 两条路径都保留 AgentTeams 的 WebUI/Matrix 边界；本轮没有把 Codex 当作 Team 控制面，也没有引入 Tiangong 自有 runtime。

因此 B5 的剩余工作不再是“能不能跑 Codex”，而是继续守住 provider 变化时的 fail-closed、Qwen 路由启用和 Phase C 生产部署注入门槛。

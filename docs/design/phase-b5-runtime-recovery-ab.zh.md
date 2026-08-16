# Phase B5：角色 runtime 路由、重启恢复与 coding A/B 合同

> 状态：B5 的确定性合同和运维恢复入口已实现；真实 Team 纵向切片与 coding A/B 仍需要部署层运行 Gate B smoke。

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

当前公开代码已提供可重复的角色路由、owner/recovery 合同和 B4 Codex/Runner/Coordination/WebUI/Matrix seam；真实 role-specific Team 纵向切片和 coding A/B 是剩余 Gate B 证据，不在确定性测试中冒充完成。

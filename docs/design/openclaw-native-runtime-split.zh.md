# OpenClaw 原生 Runtime 分工

## 分工

| 角色 | 运行时 | 责任边界 |
| --- | --- | --- |
| Leader | OpenClaw built-in | Work/Task 协调、结果汇总、Team room 交互 |
| Designer | OpenClaw built-in | 设计与方案分析 |
| Implementor | OpenClaw Codex app-server | 代码读取、修改、构建和测试 |
| Assessor | OpenClaw built-in | 结果审查与验收 |
| Operator | OpenClaw built-in | 经过 Adapter、审批和 Runner broker 的发布运维 |

Tiangong 不实现模型循环、provider wire protocol、session compaction 或自定义 runtime。Tiangong control plugin 只注册原生 OpenClaw hooks/tools，并在每个 turn/tool/Adapter 边界执行身份、路由、Gate、ToolResult、Evidence 和恢复检查。

## Clean-cut

本分支已删除 `registerAgentHarness`、`worker/plugin/openclaw-adapter.mjs`、`worker/agent/runtime.mjs`、Pi session store 和 Pi 依赖。OpenClaw 负责会话与模型上下文；Tiangong 状态保存在 Worker 固定状态根下独立的 WorkRun、Evidence、idempotency、pending-operation、rollback 目录中。

OpenClaw 配置中的 `OPENCLAW_AGENT_RUNTIME=pi` 仅对应当前 pinned 镜像的上游内置标识；源码中不再存在 `tiangong-pi`。Codex 路由仍显式设置 `OPENCLAW_AGENT_RUNTIME=codex`，且 fallback 永远为 `none`。

## 生产验收

1. `tiangong-control` plugin 能通过原生 `registerTool`/hook API preflight。
2. Leader 和 Implementor 都能启动；缺失原生 API、Codex plugin、凭证或 capability/sidecar readiness 时 fail-closed。
3. DeepSeek Flash 真实 Gate B 经过 AgentTeams Team、Matrix、WebUI、ToolResult、重启恢复、回滚和清理门禁。
4. 回滚通过上一份 Worker 镜像/配置重建完成，不依赖 Tiangong 自定义 runtime。

Qwen B6 和 Chat-only bridge 仍是后续独立 canary，不作为本次 clean-cut 的阻塞项。

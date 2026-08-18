# DeepSeek-only Runtime Clean-cut

## 决策

Tiangong 当前版本只支持 DeepSeek 的原生 Responses/Codex 路径。OpenClaw 内置 runtime 负责非编程角色，OpenClaw Codex app-server 负责 Implementor。仓库不再维护自有 Pi runtime 或 legacy harness。

## 为什么现在切

此前的真实 DeepSeek Flash Gate B 已经验证了 AgentTeams Worker、Coordination、Matrix、WebUI、ToolResult、重启恢复、sidecar/capability cache、回滚和清理边界。本次 clean-cut 运行又确认了原生 Responses 路由、native Codex app-server、ToolResult 和精确清理；两次完整重跑分别被远端 AgentTeams 任务绑定同步的 STS/MinIO 故障和宿主 WSL 控制面超时打断，不能把这两次外部故障写成产品失败。继续保留第二套 runtime 只会增加启动、状态、凭证和验收分叉。

## 门槛

- 静态：不存在 `tiangong-pi` harness 注册、Pi session store、旧 Pi package 或 runtime fallback。
- 路由：Leader 等非编程角色固定 `openclaw-built-in`，Implementor 固定 `codex-app-server`，fallback 为 `none`。
- 凭证：只使用 AgentTeams Worker-scoped consumer token；provider key 不进入镜像、配置持久化、会话、ToolResult 或诊断输出。
- 真实：DeepSeek Flash 的 native preflight、Worker 注入、Matrix/ToolResult 路径已通过；完整 Gate B 的历史证据可复用，当前重跑仍受 AgentTeams/WSL 外部控制面影响，失败时必须恢复上一 Worker，且精确清理本次资源。

## 后续可选项

Qwen B6、阿里云 Coding Plan 和 Chat-only bridge 后续可在隔离 Team 做 canary。只有在同样的 WebUI/Matrix、ToolResult、重启恢复、回滚和清理门槛全部通过后，才加入支持矩阵；不会回退本版本的 DeepSeek-only 设计。

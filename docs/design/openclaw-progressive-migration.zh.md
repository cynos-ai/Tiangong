# Pi 到 OpenClaw 的迁移结论

## 当前结论

当前主线采用 OpenClaw 原生运行时，不再保留 Tiangong 自定义 `tiangong-pi` harness，也不保留运行时回退开关。Leader、Designer、Assessor、Operator 使用 OpenClaw 内置运行时；Implementor 使用 OpenClaw 官方 Codex app-server。Tiangong 只提供控制插件、角色工具、Coordination、Gate、ToolResult、Evidence 和审批边界。

AgentTeams 的 `spec.runtime: openclaw` 选择 Worker 容器。当前 pinned OpenClaw 镜像内部仍可能把内置运行时历史标识写成 `pi`；这只是上游内部标识，不是仓库里的 Tiangong harness。

## 模型范围

当前版本只承诺 DeepSeek Responses/Codex 路径，首要 canary 为 `deepseek-v4-flash`。Provider、模型名和 Worker-scoped 凭证仍由部署层注入，凭证不会写入镜像、Team manifest、会话、ToolResult 或日志。

Qwen/Coding Plan/Chat-only bridge 是后续可选能力，不是本次 clean-cut 的前置条件。它们必须在独立 Team 做 canary，并具备完整的 WebUI/Matrix、ToolResult、重启恢复、回滚和清理证据后才能进入支持矩阵。

## 部署与回滚

`inject-member-runtime-docker.sh` 只做 MemberConfig 责任、runtime/model 路由、Coordination endpoint/token 和 Codex canary 参数的原子重建。失败会恢复旧容器；成功后旧容器才清理。运行时选择只有 `openclaw-built-in` 和 `codex-app-server`，两者均使用 `OPENCLAW_AGENT_HARNESS_FALLBACK=none`。

生产回滚是恢复上一份 Worker 镜像/配置并重新创建 Worker，不是切回 Tiangong 私有 harness。任何缺失的原生插件 API、Codex plugin、模型兼容性、凭证、sidecar 或 Coordination readiness 都必须 fail-closed。

## 已完成与后续

- 已完成：Native Leader/成员工具、AgentTeams Coordination/Matrix/WebUI 边界、Codex capability cache、sidecar 生命周期和 DeepSeek Flash Gate B。
- 本次：删除自定义 runtime、Pi session store、旧 Pi 依赖和 legacy harness 测试，改用 OpenClaw 会话与 Tiangong 独立状态根。
- 后续可选：Qwen B6 Team canary，以及更多 Chat-only provider bridge；它们不改变本版本 DeepSeek-only 的主线。

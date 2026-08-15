# Phase B4：prepared local coding

状态：确定性 Runner / preparation 合同已实现；真实 Docker smoke 需要 Linux Docker socket 环境，Windows 主机上的脚本默认使用 `/usr/bin/docker`，本地只完成了静态和 Worker 合同验证。

当前边界：

- Task wake 由 CoordinationStore 与 Matrix consumer 投递给准确的启用成员；成员 native session 仍由 AgentTeams/OpenClaw Worker 接收。
- Runner broker 是唯一 Docker authority；Worker 不拿 Docker socket，执行请求绑定 immutable Task、run、invocation、route 和 Worker identity。
- prepared workspace、单 Task 单 execution owner、命令取消/超时、credential/env/network/path 限制和 ToolResult/ChangeRevision 绑定已有 deterministic contracts。
- `runner-preparation`、`runner-preparation-server`、`runner-broker`、`runner-port`、`work-run-store` 相关回归通过；Leader/Member 工具链也通过，除 Windows 既有 `fsync` 环境问题外没有本次改动引入的失败。

下一步是 Linux Docker 环境的真实 B4 smoke：构建 immutable Worker/Runner image，启动 deployment-owned broker，执行一次编辑/构建/测试/本地 commit，验证进程树取消、重启后的 unresolved execution、ToolResult retention 和精确 cleanup。未完成这条证据链前，不删除 legacy pi lane，也不把 AgentTeams v1.2.2 宣称为 sidecar lifecycle manager。

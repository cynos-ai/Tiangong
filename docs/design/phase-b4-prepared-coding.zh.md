# Phase B4：prepared local coding

状态：确定性 Runner / preparation 合同已实现；真实 Docker smoke 需要 Linux Docker socket 环境，Windows 主机上的脚本默认使用 `/usr/bin/docker`，已通过 Linux 控制容器完成第一条 Runner 基础 smoke。

当前边界：

- Task wake 由 CoordinationStore 与 Matrix consumer 投递给准确的启用成员；成员 native session 仍由 AgentTeams/OpenClaw Worker 接收。
- Runner broker 是唯一 Docker authority；Worker 不拿 Docker socket，执行请求绑定 immutable Task、run、invocation、route 和 Worker identity。
- prepared workspace、单 Task 单 execution owner、命令取消/超时、credential/env/network/path 限制和 ToolResult/ChangeRevision 绑定已有 deterministic contracts。
- `runner-preparation`、`runner-preparation-server`、`runner-broker`、`runner-port`、`work-run-store` 相关回归通过；Leader/Member 工具链也通过，除 Windows 既有 `fsync` 环境问题外没有本次改动引入的失败。

Linux Docker 环境的第一条真实 B4 Runner smoke 已完成：使用本分支构建的 immutable
`tiangong-worker-implementor:dev`，在带 Docker socket 的 Linux 控制容器中执行
`run-runner-executor-smoke.mjs`，隔离策略、fixture/镜像绑定、只读根、无网络、
进程树超时、durable journal replay、outcome-uncertain 和精确 cleanup 全部通过。
Windows 主机直接运行仍会因默认 `/usr/bin/docker` 不存在而 fail closed；可用
`tiangong-runner-broker:dev` 作为 Linux 控制容器，并设置
`TIANGONG_DOCKER_PATH=/usr/local/bin/docker` 重跑同一脚本。为避免 Windows
checkout 把 smoke fixture 的 LF 改成 CRLF，仓库新增 `.gitattributes` 的 `eol=lf`
约束；对应的一键入口是 `make test-runner-executor-linux`。

同一 Linux 控制容器中 `worker/test/member-tools.test.mjs` 也已 11/11 通过；
Windows 主机上的单个 `EPERM: fsync` 是测试临时目录的既有平台限制，不作为
B4 逻辑成功或失败的证据。

这只闭合了 Runner 基础边界，下一步仍是把一次真实编辑/构建/测试/本地 commit
接入 B4 Work/Task/Result，并验证取消、重启后的 unresolved execution、ToolResult
retention 和精确 cleanup。未完成这条证据链前，不删除 legacy pi lane，也不把
AgentTeams v1.2.2 宣称为 sidecar lifecycle manager。

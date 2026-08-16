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
随后同一控制容器执行 `run-runner-broker-smoke.mjs`，通过了 broker readiness、
固定计划、Implementor 编辑变更、Assessor 只读复核、计划篡改拒绝、未授权 Worker
拒绝、Worker socket 隔离、单次执行/重放和精确 cleanup；一键入口是
`make test-runner-broker-linux`。
该 smoke 现在还走过了完整的 Tiangong 纵切：控制面先创建 Project/Task，Worker
侧依次调用 `team_resolve_task`、`run_command`、`team_submit_result`，真实 Runner
封存 ChangeRevision，ResultEnvelope 写入共享文件，WorkRun 进入 `finalized`，再
从 durable journal 重放同一 Runner invocation。输出中的
`b4_work_task_runner=pass` 与 `b4_result_persisted=pass` 是这两条直接机器事实。
同一条 smoke 还在实际 Worker 镜像内验证了重启后未决 Runner invocation 不会自动
重跑（`b4_restart_unresolved=pass`），并让 ToolResult 经过重启读取和 retention mark
后再作为 Result 的 bounded evidence ref（`b4_toolresult_retention=pass`）。
这条 smoke 的 Channel adapter 仍是 bounded test adapter，不是外部 AgentTeams
Matrix；因此它证明的是 Tiangong Work/Task/Runner/Result 纵切，而不是生产 Matrix
投递已经闭合。
Windows 主机直接运行仍会因默认 `/usr/bin/docker` 不存在而 fail closed；可用
`tiangong-runner-broker:dev` 作为 Linux 控制容器，并设置
`TIANGONG_DOCKER_PATH=/usr/local/bin/docker` 重跑同一脚本。为避免 Windows
checkout 把 smoke fixture 的 LF 改成 CRLF，仓库新增 `.gitattributes` 的 `eol=lf`
约束；对应的一键入口是 `make test-runner-executor-linux`。

同一 Linux 控制容器中 `worker/test/member-tools.test.mjs` 也已 11/11 通过；
Windows 主机上的单个 `EPERM: fsync` 是测试临时目录的既有平台限制，不作为
B4 逻辑成功或失败的证据。

这闭合了 Runner、broker 和 Tiangong Work/Task/Result 的真实本地纵切；下一步仍是
把同一条调用接到真实 AgentTeams Worker/Matrix，并完成一次真实构建/测试/本地
commit，随后验证取消、重启后的 unresolved execution、ToolResult retention 和
精确 cleanup。未完成这条生产证据链前，不删除 legacy pi lane，也不把 AgentTeams
v1.2.2 宣称为 sidecar lifecycle manager。

## 2026-08-16 真实 AgentTeams Worker/Matrix 边界

本次把五个真实 OpenClaw Worker 重新绑定到一次性 Team，并用 Designer Worker
的真实 Matrix 身份向 Team Room mention Leader。起初 Team 只写了
`workerMembers`，Worker 的 `groupAllowFrom` 仍只有 Manager/Admin；补上官方公开的
每个 Worker `channelPolicy.groupAllowExtra`/`dmAllowExtra` 后，五个 Worker 的
allowlist 收敛，Leader 真实收到了 Matrix 事件并进入 OpenClaw turn。

探针随后暴露了下一个真实部署边界：Leader 的 `team_create_project` 在没有
`TIANGONG_LEADER_RUNTIME_BINDING_FILE`、Coordination Control endpoint 和短 token
时 fail closed，日志为 `Leader Coordination Control binding is unavailable`。
这证明 Matrix/Leader wake 已经打通，但还没有把 Leader ingress 与 PG Coordination
runtime 注入到 AgentTeams 管理出来的 Worker；当前不能把这次探针记为 Project/Task
成功。另一个已修复的启动适配是把 AgentTeams v1.2.2 投影的
`AGENTTEAMS_AUTH_TOKEN_FILE` 只读加载为 OpenClaw 原生工具所需的
`AGENTTEAMS_AUTH_TOKEN`，不打印也不写回配置。

因此 B4 的下一条生产门槛已经收窄为部署层注入 binding/endpoint/token，并在该边界
闭合后重跑同一条真实 Project/Task/Result smoke；在此之前保留 fail-closed 行为和
legacy pi lane。

## 2026-08-16 当前执行指针（以 internal 计划为准）

internal 计划的当前 B4 入口不是重新实现 Runner：本分支已有的 Linux 控制容器
smoke 已通过 broker readiness、固定计划、实现变更、Assessor 只读、单次执行/重放、
ToolResult retention、WorkRun finalized 和精确 cleanup。刚刚复核的机器事实为
`runner_broker_ready`、`b4_work_task_runner`、`b4_result_persisted`、
`b4_toolresult_retention`、`runner_broker_replay` 和 `runner_broker_cleanup` 全部
通过。

下一步只补 B4 缺口：把同一个受 immutable Task/Runner 约束的执行入口接到真实
AgentTeams Implementor Worker 的 native coding session，并证明本地修改、构建/测试、
ChangeRevision 和 Result 能经 Matrix/WebUI 回到 Leader。非编程 Leader 仍以 OpenClaw
内置 runtime 为目标；Implementor 才在该真实纵切中验证 OpenClaw Codex runtime。
在 B4/B5、Gate B 证据闭合前，`tiangong-pi` 继续保留，不做 clean-cut。

## 2026-08-16 B4 原生 Codex Worker smoke

真实 disposable AgentTeams Team 上，Implementor 使用
`OPENCLAW_AGENT_RUNTIME=codex`、`OPENCLAW_AGENT_HARNESS_FALLBACK=none`、
`TIANGONG_CODEX_TRANSPORT=native-responses` 和
`TIANGONG_CODEX_BRIDGE=none`，通过 AgentTeams scoped provider 路由调用
DeepSeek V4 Pro。OpenClaw 自带 Codex app-server 接收 Matrix Task；Tiangong
只通过现有生命周期 hook 读取 immutable TaskSpec 并提交 bounded Result。

本次真实任务已读 fixture、写入精确 marker、完成本地断言，Task 变为
`reported`，Result 出现在 PostgreSQL/WebUI 投影，相关 Matrix wakes 全部
`acked`。这证明了“OpenClaw 内置 Codex + AgentTeams Task/Result gateway”
这一条路可行；没有使用 OpenCodex bridge，也没有 Tiangong 自己的模型循环。

但这还不是 B4 完成：本次原生工具调用尚未纳入 Runner broker 的唯一执行权、
ChangeRevision、WorkRun、ToolResult retention、重启恢复和 cleanup 闭环。下一步
是把同一条 Codex session 接到已通过的 Runner broker，再做 B5 role/recovery
证据。`OPENCLAW_AGENT_RUNTIME=pi` 是当前 pinned OpenClaw 内置 runtime 的历史
标识，不等于仓库的 `tiangong-pi`；后者仍只作为 Gate B 前的 legacy rollback
保留，不能提前删除。

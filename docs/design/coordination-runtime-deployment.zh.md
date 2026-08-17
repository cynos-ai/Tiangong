# Coordination Runtime 生产部署合同

状态：Phase C-1 已实现（部署镜像、生命周期脚本和本地合同测试）。真实生产验收仍必须在部署系统注入 binding、PG 和 Matrix secret 后执行。

## 组件边界

- tiangong-coordination-runtime 是部署层组件，运行 app/coordination/runtime-server.mjs。
- PostgreSQL 是 Work、Timeline、Matrix 事件绑定、请求重放和 Outbox 的权威总账。
- Matrix 只负责低延迟唤醒；MinIO/AgentTeams 共享空间只保存大对象、Result 和 Evidence 附件。
- Leader Worker 只拿 credential-free binding、Control API endpoint 和 Worker 范围的短期 Control token；它不拿 PG URL 或部署 Matrix token。
- Web UI 仍由同一 Coordination runtime 提供 /readyz、/healthz 和 /api/runtime。

## 镜像

从仓库根目录构建：

    make build-coordination-image

镜像默认使用 node:22.23.2-bookworm-slim，生产发布应通过 TIANGONG_COORDINATION_NODE_IMAGE 覆盖为组织批准的 digest。镜像不包含任何密钥、binding 内容、Worker state 或 AgentTeams 私有依赖。

## Secret 与 binding 注入

部署系统创建两个 owner-only 文件：

1. leader-binding.json：只包含 Team、Route、ControlProfile、Leader 和 members 的带 digest 快照；必须是普通文件，权限 0400 或 0600。
2. coordination.env：只给 runtime 容器使用，权限 0400 或 0600，至少包含：

    TIANGONG_COORDINATION_DATABASE_URL=postgres://...
    TIANGONG_COORDINATION_CONTROL_TOKEN=<deployment-generated-token>

启用 Matrix outbox 时再加入：

    AGENTTEAMS_MATRIX_URL=https://matrix.example.test
    TIANGONG_COORDINATION_MATRIX_TOKEN=<leader-scoped-deployment-token>

脚本拒绝 symlink、过大的文件、缺少数据库/Control token、只配置 Matrix URL 或 token 的半配置，以及把未允许的变量（包括 TIANGONG_LEADER_RUNTIME_BINDING_FILE、NODE_ENV）塞进 env 文件。

## 生命周期

    export TIANGONG_LEADER_RUNTIME_BINDING_FILE=/etc/tiangong/leader-binding.json
    export TIANGONG_COORDINATION_ENV_FILE=/etc/tiangong/coordination.env

    make coordination-runtime-start
    make coordination-runtime-status
    make coordination-runtime-stop

脚本只管理带有 io.tiangong.owner=tiangong-deployment 和
io.tiangong.component=coordination-runtime 标签的容器。它不会停止、替换或删除 AgentTeams 容器、PG、MinIO 或 Worker。容器使用 AgentTeams 内网、只读根文件系统、只在启动时为读取、整理并降权 credential-free binding 保留 CHOWN、DAC_OVERRIDE、SETUID 和 SETGID，随后以 node 用户运行，并启用 no-new-privileges 和临时 noexec /tmp。

由于 binding 文件需要由 Tiangong loader 以严格权限读取，镜像入口先把 credential-free binding 复制到 tmpfs，并以 node 用户运行真正的 runtime；PG/Matrix secret 只存在进程环境和内存中。

## AgentTeams v1.2.2 的现实边界

v1.2.2 的 agt apply worker 仍没有原生的 Coordination API、Leader session 或 sidecar 生命周期字段。因此部署系统仍需显式完成：

1. 启动本 runtime 容器；
2. 把 Worker 的 binding 路径、Control endpoint 和 Worker token 注入 Leader；
3. 把 binding 以只读文件挂载到 Leader；
4. 用 /readyz、PG outbox ack 和 Leader resume 事件做验收。

这条路径绕过了管理面字段缺失，但没有把 PG/Matrix 权限下放给 Worker，也没有改变 AgentTeams 官方的 Matrix/OpenClaw 通道。

部署后必须对实际 Leader 容器运行 verify-leader-runtime-injection.sh。它检查：

- Worker 正在运行且容器名精确匹配；
- Control endpoint、binding 目标路径和短期 Control token 恰好各注入一次；
- binding 挂载为只读；
- Worker 环境不存在 PG URL 或部署 Matrix token；
- Worker 内的 Tiangong loader 能读取并验证 binding。

检查失败就不能进入 Matrix/模型 smoke。v1.2.2 的 agt apply worker 帮助面没有 env/mount 参数，所以部署系统必须通过它自己的 Worker 模板/注入机制完成这些字段；仅在 Worker SOUL 或 prompt 中写入路径不算注入成功。

## 2026-08-16 真实 Worker 注入补充

真实 AgentTeams v1.2.2 Worker 的默认 HostConfig 只有 AgentTeams auth volume，没有 Tiangong binding、Coordination endpoint 或 token。`scripts/inject-leader-runtime-docker.sh` 是部署层的显式适配器：它只接受已校验的单 Worker 拓扑，保留原有 entrypoint、工作目录、端口、extra-host、共享网络、auth volume、cap-drop、security-opt、init 和 restart policy，重建同名容器，然后强制执行 `verify-leader-runtime-injection.sh`。任何不支持的挂载、资源限制、特权、RootFS、PG/Matrix secret 或重复注入都会 fail-closed，避免重建时静默放宽 Worker 的安全边界。

Docker Desktop/WSL 的 Windows bind mount 会把文件权限呈现为过宽，Tiangong loader 会拒绝它。生产部署应将 binding 放入一个专用 Docker volume（文件名为 `leader-binding.json`），以只读 volume 目录挂载到 `/run/tiangong-leader`；适配器通过 `TIANGONG_DOCKER_BINDING_VOLUME` 启用这条路径。Linux 原生 Docker 可以直接使用 owner-only bind file。已有注入需要轮换 endpoint/token 时，必须显式设置 `TIANGONG_LEADER_INJECTION_ROTATE=1`，否则重复注入仍然拒绝。

本次真实验证结果：Leader 容器重建后保持 AgentTeams `Running`，只读 binding volume、短 bearer token 和 `/v1/coordination/admit` 均通过验证；人类 Matrix 单行请求进入原生 Leader 会话后，PG 产生 Work/Timeline/Wake，MinIO 写入 Project/Task binding。启用 Matrix outbox consumer 后，PG 中的 `leader-resume` 与 `human-reply` wakes 均被发送并 ack，`/readyz` 返回 `postgres-and-matrix`，runtime 根页面和 `/api/runtime` 均返回 200。

如需让操作者从宿主机直接查看 runtime 页面，可设置 `TIANGONG_COORDINATION_HOST_PORT=18780`；脚本只绑定 `127.0.0.1`，不会默认暴露到公网。AgentTeams Dashboard 仍由 AgentTeams 自己管理。

成员 Worker 不应调用 Leader admission。OpenClaw harness 现在读取固定 RoleProfile：只有 Leader runtime 执行 admission，Designer/Implementor/Assessor/Operator 的 Matrix 任务直接进入自己的成员运行时；对应回归测试覆盖该边界。人类 admission smoke 必须发送单行 Matrix body（换行会被 `HUMAN_EVENT_CONTENT_INVALID` 拒绝），成员 Worker mention 则走任务分发链路而不是人类 Work admission。

## 2026-08-16 B2 Basic 闭环复核

在同一套 disposable AgentTeams v1.2.2 Team 上重新复核了完整链路：

- 部署层创建独立 PG、Coordination runtime 和 Leader binding volume；Leader 通过注入适配器重建后保持 `Running`，Worker 只看到 credential-free binding、Control endpoint 和短期 Control token；PG URL、Matrix deployment token 不出现在 Worker 环境。
- 由非 Team member 的 AgentTeams Manager 身份在真实 Team Matrix room 发出带 Leader mention 的单行消息；OpenClaw 日志观察到 `peer=channel:<team-room>`，不是 DM 路由。
- Control API 在 PG 中创建 Work、Timeline 和两个 durable wake；`matrix_message_binding` 的 `room_id + event_id` 约束生效。
- Matrix outbox consumer 对 `leader-resume` 和 `human-reply` 各自完成 claim/send/ack；`/readyz` 返回 `source=postgres-and-matrix`，runtime 根页面和 `/api/runtime` 返回 200，并能读出 Work projection 与 acked delivery state。
- outbox 现在会在同一 consumer 重启时恢复自己遗留的 `claimed` wake；Matrix transaction pathname 由 wake 事实确定性生成。独立测试已模拟 send 成功后 ACK 崩溃，再次启动完成同一逻辑事务的重放和 ACK。

这证明 B2 Basic 的真实 AgentTeams/Matrix/PG/Leader/Web projection seam 已经可以走通，并且 F1 的确定性重放合同已具备；真实容器级故障注入仍单独记录在下一节。

## 2026-08-16 B2 Full/F1 容器级重启复核

为避免旧 consumer 抢消费，临时停掉已有 Coordination runtime，另起一个隔离 runtime，复用同一套 PG、Leader binding volume 和真实 AgentTeams Matrix。测试代理把第一次 `PUT /send/m.room.message/<transaction>` 的上游响应延迟；确认 Matrix 已接受事件后强制杀掉该 runtime，再启动同一容器。

重启后的 runtime 重新 ready，扫描并重放遗留 wake；第一次发送和重放使用同一个 transaction pathname，两个 Work wake 最终均为 `acked`，`/api/runtime` 能看到 durable delivery state，测试资源随后精确清理，原 runtime 已恢复到 `source=postgres-and-matrix` ready。

因此 B2 Basic/Full/F1 的 disposable deployment seam 现在通过；B3/B4、B5 runtime A/B 与 Gate B 仍未完成，所以仍不能删除 `tiangong-pi`。按 internal 计划，下一切片是 B3 跨 Gateway Task/Result，不是提前做 B6 clean-cut。
## 2026-08-16 B3 native member hook boundary

The member-side implementation now uses OpenClaw's native lifecycle hooks
(`before_prompt_build` and `agent_end`) rather than a Tiangong model/runtime
loop. The hook fetches TaskSpec and submits one Result through the deployment
gateway; it has no PG/Team authority. Deployment injects a member-scoped
Control API token and `TIANGONG_MEMBER_ID`. A rebuilt real Worker has now
completed the member-session Full smoke with `OPENCLAW_AGENT_RUNTIME=pi`
(OpenClaw's upstream embedded harness), Task/Result projection, and acked
assignment/notification wakes. This closes the B3 member seam; B4 prepared
local coding, B5 recovery/coding A/B, Gate B, and the B6 `tiangong-pi`
clean-cut remain future work.

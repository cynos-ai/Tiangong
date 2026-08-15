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

# Tiangong

[English](README.md) | **简体中文**

Tiangong 是一个基于 [AgentTeams](https://github.com/agentscope-ai/AgentTeams) 构建、以事实为依据的 AI 软件工程团队。

> [!NOTE]
> `v0.5.0` 是最新源码版本，并在各里程碑公开验收范围内完成了 M0–M8 产品底座：PostgreSQL 协调底座、六个长期 Agent 包、可移植 Skills、对话优先的 Matrix 工作台、单一通用 OpenClaw Worker 镜像、带 clean rerun 的一次性本地交付验证、M7 产品权威 clean-cut，以及默认关闭且完成隔离云端验收的 M8 AgentLoop 诊断。这不代表已经达到生产部署：Push、CI dispatch、部署、生产凭据和外部写 Adapter 仍然关闭。参见 [`v0.5.0` 发布说明](docs/releases/v0.5.0.md)、[产品 MVP](docs/design/product-mvp.zh.md)和[变更日志](CHANGELOG.md)。
>
> 与实现无关的目标合同见[团队控制设计](docs/design/evidence-backed-team-control.md)（[中文](docs/design/evidence-backed-team-control.zh.md)）。第一条公开产品纵切见[产品 MVP 设计](docs/design/product-mvp.zh.md)，当前持久化与 runtime 边界见 [M7 产品权威 clean-cut](docs/design/m7-product-authority-clean-cut.md)。

## 愿景

Tiangong 旨在协调专业软件工程 Agent，并把完成声明、模型文字、机器状态和机器采集观察区分开。高风险外部写入目前是目标合同，不是 `v0.5.0` 已启用能力。

## 项目亮点

- **对话优先协作：** Matrix 始终是对话来源；Web 工作台在对话旁投影 Work、Plan、Task、Result、ToolResult、Skill 使用和交付物事实。
- **六个专业 Agent：** Leader、Architect、Challenger、Developer、Reviewer、Tester 共用一个通用 `tg-worker` 镜像，通过版本化 Agent 包区分职责，而不是按角色拆镜像。
- **有边界的交付事实：** 已记录的 M6 验收覆盖自有的一次性项目、签名本地 Commit、独立 Review 与测试、CloseGuard 完成、清理和 clean rerun。
- **Fail-closed 边界：** Provider/模型状态由 AgentTeams 管理；PostgreSQL 是产品事实权威；Worker 不获得数据库 URL、部署 Matrix token 或 AgentLoop 凭据。
- **可选诊断：** M8 AgentLoop/OpenTelemetry 默认关闭，不参与完成与恢复判断。

## 架构分层

```text
Human / Matrix 客户端
        │
        ▼
AgentTeams + Matrix ─────── 对话、身份、Provider/模型控制
        │
        ▼
Coordination runtime ────── Web 工作台、有界 Control API、Matrix gateway
        │
        ▼
PostgreSQL ──────────────── Work/Task/Result、admission、replay、wake 权威
        │
        ▼
通用 OpenClaw Workers ──── Agent 包、产品 Skills、工作区工具
        │
        └─ 可选无凭据 OTLP → 隔离 Collector / AgentLoop
```

AgentTeams 负责 Team、容器、Matrix 和存储集成；Tiangong 负责 Worker runtime 增量、专业 Agent 包、产品事实、完成检查和工作台体验。

## 比赛场景对应

| 场景 | `v0.5.0` 可展示内容 | 边界 |
|---|---|---|
| 多 Agent 软件交付 | 动态专业职责、共享 Plan 事实、本地代码变更、独立 Review/Test Result | 公开端到端证明是一次性本地验证 |
| Human-Agent 协作 | 三栏工作台中并列展示一条 Matrix 对话和 Work 事实 | 首版 Web 拒绝 E2EE Room |
| 可信完成 | Result、ToolResult、Commit/测试引用和 CloseGuard 事实与模型文字分开展示 | 不声称生产部署或自主外部写入 |
| Agent 可观测性 | 可选的 Work/Task 关联 AgentLoop 元数据和有界诊断面板 | 遥测可能采样或缺失，永不授权或完成 Work |

## 本地 AgentTeams 快速开始

> 第一次运行本地栈？建议先阅读[本地开发指南](docs/local-development-guide.md)。其中整理了 npm/Docker 镜像网络问题、版本 pin、Dashboard 对话限制和经过验证的 Worker 消息格式。

Bootstrap 固定使用公开 AgentTeams `v1.2.2`，执行前会校验上游安装脚本 checksum。容器镜像仍按上游 tag 解析，而不是全部使用不可变 digest，因此这不是完全可复现或供应链 hermetic 的部署。

### 前置条件

- Linux 或 macOS
- Bash
- Docker daemon 正在运行
- `curl`、`jq`、`make`、OpenSSL，以及 Node.js 22 或更高版本
- 阿里云 Coding Plan 或其他 OpenAI 兼容 LLM Provider 的 API Key
- Manager 加小型团队建议至少 4 核 CPU、8 GiB 内存

### 配置

```bash
make init
```

编辑生成的 `.env`，至少设置：

```dotenv
AGENTTEAMS_LLM_API_KEY=your-api-key
```

默认配置使用阿里云 Coding Plan 和 `glm-5`。Provider 凭据与路由由 AgentTeams 管理。使用其他 AgentTeams 官方 Provider 或模型时，更新 `AGENTTEAMS_OPENAI_BASE_URL` 和 `AGENTTEAMS_DEFAULT_MODEL`，再通过 AgentTeams 修订对应 Worker，使 Tiangong 能把新模型绑定为新的 MemberConfig revision。

配置解析器每行只接受一个 `KEY=VALUE`，不会执行 shell 语法。切勿提交 `.env`。

生成的凭据、Manager 工作区、host-share 和已校验安装器缓存固定存放在已忽略的 `.runtime/agentteams/` 下。AgentTeams 还会在仓库外创建 `tiangong-agentteams-data` Docker volume、`agentteams-*` 容器、`agentteams-net` 网络和带 tag 的容器镜像。

### 启动并验证就绪

```bash
make up
make verify
make login
```

打开 `make login` 打印的 Element URL。该命令会给出本地生成凭据文件的位置，但不会打印密码本身。

常用操作：

```bash
make status
make logs                         # Manager 日志
make logs SERVICE=controller      # Controller 日志
make stop                         # 保留数据并停止
make start
CONFIRM=delete-tiangong-agentteams-data make uninstall  # 删除本地栈和生成数据
```

运行 `make help` 查看完整命令。`make uninstall` 在校验固定目标后删除 Tiangong 管理的 AgentTeams 容器、网络、Docker volume 和 `.runtime/agentteams/`，但保留 `.env` 与已下载镜像。

### 运行完整本地栈

下面的本地开发路径已在 `v0.5.0` 源码上逐条执行验证。它会启动 AgentTeams、六成员 Demo Team、自有 PostgreSQL 16 容器和 Coordination runtime，并只在 loopback 暴露 Web 工作台。它**不**证明生产部署，也不会自动向六个 Worker 注入 Tiangong MemberConfig；AgentTeams `v1.2.2` 的公开 manifest 没有这些 binding 字段。在部署 Adapter 完成注入并验证之前，这条路径适合查看真实 Team Room 和工作台，不应据此声称完成了一次受 Tiangong 控制的模型交付。

1. 创建 AgentTeams 私有配置、设置 Provider Key，并启动固定版本的栈：

   ```bash
   make init
   # 编辑 .env，设置 AGENTTEAMS_LLM_API_KEY；切勿提交 .env。
   make up
   make verify
   make login
   ```

2. 构建通用 Worker 与 Coordination 镜像，再创建自有六成员 Demo Team：

   ```bash
   make build-worker-image
   make build-coordination-image
   ./scripts/tiangong-demo.sh start
   ```

3. 创建 owner-only runtime 文件和只接入 Docker 内网的 PostgreSQL 容器。数据库密码和 Control token 在本地生成，通过 `0600` 文件注入，不写入命令参数：

   ```bash
   if [[ -e .runtime/coordination ]] || \
      docker container inspect tiangong-coordination-postgres >/dev/null 2>&1 || \
      docker volume inspect tiangong-coordination-postgres-data >/dev/null 2>&1; then
     printf '拒绝复用已有 Coordination runtime 资源。\n' >&2
     exit 1
   fi

   mkdir -p .runtime/coordination
   chmod 700 .runtime/coordination
   umask 077

   DB_PASSWORD="$(openssl rand -hex 24)"
   CONTROL_TOKEN="$(openssl rand -hex 32)"

   cat >.runtime/coordination/postgres.env <<EOF
   POSTGRES_USER=tiangong
   POSTGRES_PASSWORD=${DB_PASSWORD}
   POSTGRES_DB=tiangong
   EOF

   cat >.runtime/coordination/coordination.env <<EOF
   TIANGONG_COORDINATION_DATABASE_URL=postgres://tiangong:${DB_PASSWORD}@tiangong-coordination-postgres:5432/tiangong
   TIANGONG_COORDINATION_CONTROL_TOKEN=${CONTROL_TOKEN}
   AGENTTEAMS_MATRIX_URL=http://agentteams-controller:6167
   TIANGONG_WEB_SECURE_COOKIES=0
   EOF
   unset DB_PASSWORD CONTROL_TOKEN

   docker volume create tiangong-coordination-postgres-data >/dev/null
   docker run --detach --name tiangong-coordination-postgres \
     --label io.tiangong.owner=local-development \
     --network agentteams-net \
     --env-file "$PWD/.runtime/coordination/postgres.env" \
     --mount type=volume,source=tiangong-coordination-postgres-data,destination=/var/lib/postgresql/data \
     postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777

   until docker exec tiangong-coordination-postgres \
     pg_isready -U tiangong -d tiangong >/dev/null 2>&1; do sleep 1; done
   ```

4. 把在线 Demo Team 和 Worker 身份投影成不含凭据的 binding。该文件属于 runtime 配置，保存在已忽略的 `.runtime/` 下，不包含 Provider、PostgreSQL、Matrix 或 AgentLoop 凭据：

   ```bash
   docker exec agentteams-manager agt get teams tiangong-demo-team -o json \
     >.runtime/coordination/team.json
   for ROLE in leader architect challenger developer reviewer tester; do
     docker exec agentteams-manager agt get workers "tiangong-demo-${ROLE}" -o json \
       >".runtime/coordination/${ROLE}.json"
   done

   node --input-type=module <<'EOF'
   import { readFile, writeFile } from "node:fs/promises";
   import {
     createControlProfile, createMemberConfig,
     createTeamConfig, createTeamRouteBinding,
   } from "./worker/agent/team/coordination-contracts.mjs";

   const dir = ".runtime/coordination";
   const roles = ["leader", "architect", "challenger", "developer", "reviewer", "tester"];
   const now = new Date().toISOString();
   const liveTeam = JSON.parse(await readFile(`${dir}/team.json`, "utf8"));
   const liveWorkers = Object.fromEntries(await Promise.all(roles.map(async (role) => [
     role, JSON.parse(await readFile(`${dir}/${role}.json`, "utf8")),
   ])));
   const profile = createControlProfile({
     profileId: "tiangong-demo-local", revision: 1,
     maxTimelineEntries: 4096, maxOutboxEntries: 1024,
     maxTasksPerWork: 256, toolResultRetentionMs: 2_592_000_000,
   });
   const members = await Promise.all(roles.map(async (role) => {
     const pkg = JSON.parse(await readFile(`worker/agent-packages/${role}/agent.json`, "utf8"));
     const worker = liveWorkers[role];
     return createMemberConfig({
       memberId: worker.name, teamId: liveTeam.name, revision: 1,
       workerName: worker.name, matrixUserId: worker.matrixUserID, role,
       controlProfileId: profile.profileId, enabled: true,
       runtime: "openclaw-built-in", model: worker.model,
       agentPackageId: pkg.packageId, agentPackageVersion: pkg.version,
       allowedSkills: pkg.installedSkills.map(({ skillId }) => skillId), createdAt: now,
     });
   }));
   const team = createTeamConfig({
     teamId: liveTeam.name, revision: 1,
     leaderMemberId: liveWorkers.leader.name,
     memberIds: members.map(({ memberId }) => memberId),
     controlProfileId: profile.profileId, createdAt: now,
   });
   const route = createTeamRouteBinding({
     routeId: "tiangong-demo-matrix", teamId: team.teamId, revision: 1,
     channel: "matrix", roomId: liveTeam.teamRoomID, createdAt: now,
   });
   await writeFile(`${dir}/leader-binding.json`,
     `${JSON.stringify({ team, route, profile, leaderMember: members[0], members }, null, 2)}\n`,
     { mode: 0o600 });
   EOF
   chmod 600 .runtime/coordination/*.env .runtime/coordination/leader-binding.json
   ```

5. 启动 Coordination runtime 并打开工作台：

   ```bash
   export TIANGONG_LEADER_RUNTIME_BINDING_FILE="$PWD/.runtime/coordination/leader-binding.json"
   export TIANGONG_COORDINATION_ENV_FILE="$PWD/.runtime/coordination/coordination.env"
   export TIANGONG_COORDINATION_HOST_PORT=18780

   make coordination-runtime-start
   make coordination-runtime-status
   curl --fail --silent --show-error http://127.0.0.1:18780/readyz
   ```

   打开 <http://127.0.0.1:18780/>。默认配置使用完整 Matrix 用户 ID `@admin:matrix-local.agentteams.io:18080`，密码在 `make login` 所报告的凭据文件中。只有当前身份属于未加密的 Demo Team Room 时，登录才会成功。

Coordination runtime 的最小环境清单是 `TIANGONG_COORDINATION_DATABASE_URL` 和 `TIANGONG_COORDINATION_CONTROL_TOKEN`。`AGENTTEAMS_MATRIX_URL` 用于启用 Web 登录；只有本 loopback HTTP 配置需要 `TIANGONG_WEB_SECURE_COOKIES=0`。`TIANGONG_COORDINATION_MATRIX_TOKEN` 可选，仅用于部署侧 wake-outbox sender。宿主侧的 `TIANGONG_LEADER_RUNTIME_BINDING_FILE`、`TIANGONG_COORDINATION_ENV_FILE` 和 `TIANGONG_COORDINATION_HOST_PORT` 用来选择两个私有文件和 loopback 映射，不写入 `coordination.env`。

| 端点 | 端口 | 本路径中的暴露范围 |
|---|---:|---|
| AgentTeams Gateway / Matrix Client API | `18080` | `127.0.0.1` |
| Element Web | `18088` | `127.0.0.1` |
| AgentTeams Dashboard | `13000` | `127.0.0.1` |
| Higress Console | `18001` | `127.0.0.1` |
| Manager Console | `18888` | `127.0.0.1` |
| Coordination runtime / 工作台 | `18780` → 容器 `8780` | `127.0.0.1` |
| PostgreSQL | 容器 `5432` | 仅 `agentteams-net`；无宿主端口 |

只删除本节创建的资源：

```bash
make coordination-runtime-stop
./scripts/tiangong-demo.sh stop
docker rm --force tiangong-coordination-postgres
docker volume rm tiangong-coordination-postgres-data
rm -rf .runtime/coordination
```

### OpenClaw 原生 Worker 镜像

本地 Worker 镜像基于不可变 digest 的公开 AgentTeams `v1.2.2` Worker 镜像，并保留其固定 Node.js `22.23.2` runtime。六个专业 Agent 都使用 OpenClaw built-in。Tiangong 提供 control plugin、Agent 包、可移植 Skills、coordination 工具和有界 ToolResult。

```bash
make build-worker-image
npm --prefix worker test
```

active build 只生成 `tg-worker:dev`。其中没有 Codex/OpenCodex、native Runner、deployment service、pending Operation、Approval command 或 hash-chain Evidence runtime。外部写 Operation 和精确 Human Approval 将在后续阶段与真实 Adapter 同时引入，而不是保留不可用占位实现。

可选 AgentLoop/OpenTelemetry 诊断见 [`docs/observability.md`](./docs/observability.md) 和 [M8 设计](./docs/design/m8-agentloop-diagnostic-integration.md)。它们默认关闭。Worker 不持有 AgentLoop 凭据：独立管理的 Collector 注入云端写 header，Trace 仍是非权威诊断遥测。

### 对话优先的 Matrix 工作台

部署侧 Coordination runtime 在根 URL 提供 M3 工作台。Human 使用当前 Matrix 身份登录；Tiangong 只在有界内存 session 中保存 access token，并返回 HttpOnly、SameSite cookie。每次对话、runtime 事实请求和 SSE 更新都会重新检查 Matrix 身份及其在指定未加密 Team Room 中的成员关系。撤销 session 会关闭事实流，进程重启会清空所有 Web session。

工作台通过 Matrix history/sync/send 展示中间对话，不在 PostgreSQL 保存消息正文。左栏显示 Team/Room 和 Leader admission backlog；右栏投影 Room Work 历史、可空 WorkSpec、Plan 引用/历史、Challenger 等 Result、Agent/模型/实际 Skill 使用、Task、ToolResult、交付物和 timeline 事实。选择 Work 只改变右栏视图；发送合同拒绝任何 Work 路由字段。

在 Coordination runtime 环境中设置 `AGENTTEAMS_MATRIX_URL` 即可启用 Human Web 登录。`TIANGONG_COORDINATION_MATRIX_TOKEN` 可选，只启用部署侧 outbox sender。HTTPS 默认保留 Secure cookie；loopback HTTP 开发环境必须显式设置 `TIANGONG_WEB_SECURE_COOKIES=0`。首版对加密 Room fail closed。

运行确定性的聚焦合同：

```bash
make test-chat-first-web
```

当前 runtime 有意保持以下限制：

- AgentTeams 控制 Provider 凭据和每个 Worker 的当前模型；Tiangong 只接受当前已认证投影，没有 fallback runtime；
- 一个通用 `tg-worker` 镜像由 AgentTeams 身份、MemberConfig、ControlProfile、Agent 包和部署 binding 配置；
- Leader 获得 coordination 与 Skill 工具；五个专业成员获得 Skill 工具和固定 OpenClaw 工作区工具集；
- 有效 Skill 是 digest 锁定的包安装集合与 `MemberConfig.allowedSkills` 的交集；
- PostgreSQL 是 Work/Task/Result、Matrix admission、request replay 和 wake outbox 的唯一权威；Worker 只能通过有界 Control API 访问；
- Matrix admission backlog 和内部 wake outbox 保持独立表与处理合同；
- 当前没有启用 Push、CI dispatch、部署、生产凭据或外部写 Adapter。

### 本地安全模型

> [!WARNING]
> 该 bootstrap 不是宿主机安全边界。AgentTeams `v1.2.2` 会把容器 runtime socket 挂载到内嵌 Controller，以便创建 Manager 和 Worker。控制该 socket 基本等于控制宿主机：被入侵的 Controller、Agent、工具调用或 prompt injection 路径可能创建特权容器或挂载任意宿主路径。`host-share` 只限制普通 Manager mount，不能降低容器 socket 权限。

- Web 与管理端口强制绑定 localhost。
- 本地 Agent 协作流程关闭 Matrix 端到端加密。
- 配置和生成的凭据文件使用 `600` 权限。
- 仓库内生成路径固定在 `.runtime/agentteams/`；卸载会拒绝被篡改的目标。
- 不可信工作负载应运行在一次性 VM 或专用 rootless/隔离容器 daemon 上，不要放在敏感工作站或共享生产宿主机。

不要把此配置暴露到单机之外。多用户部署需要另外设计身份、TLS、存储、网络、secret 管理和容器隔离模型。

## Agent 与维护者 Skills

[`worker/skills/`](./worker/skills/) 中的六个产品 Skill 会进入 `tg-worker`：`work-coordination`、`work-planning`、`plan-challenge`、`test-driven-development`、`independent-code-review`、`scenario-testing`。每个包都包含触发 truth table 和确定性的 success/blocked/cleanup 用例。[`worker/agent-packages/`](./worker/agent-packages/) 中的 Agent 包锁定 Skill 版本和内容 digest；MemberConfig 只能启用其子集。

[`.agents/skills/`](./.agents/skills/) 下的可移植维护者 Skills 只在信任仓库后作为维护工作流加载，不属于 Worker 产品 Skills。

验证产品与维护者 Skill 结构、公开安全检查、触发用例、Agent 包锁和行为用例形状：

```bash
make check-skills
make test-product-agent-skills
```

## 开发

仓库采用受保护的 Git Flow–lite：

- `main` 只包含可发布历史；
- `develop` 是集成分支；
- 功能开发在短期分支完成，并通过 Pull Request 合并；
- 发布遵循语义化版本。

仓库规则见 [`AGENTS.md`](./AGENTS.md)，贡献流程见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)，发布流程见 [`RELEASING.md`](./RELEASING.md)。

## 许可证

本项目使用 [Apache License 2.0](./LICENSE)。

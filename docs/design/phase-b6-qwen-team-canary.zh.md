# Phase B6：Qwen Coding Plan + AgentTeams Team canary

> 状态：`rolled-back / blocked-at-gateway`。隔离 canary 的 Worker、Team、sidecar 和临时镜像已清理；默认 DeepSeek 路由已恢复。不能把本次结果当成 Qwen 全链路通过。

## 目标和隔离范围

本次只验证一套临时 Team，不改变默认 DeepSeek：

| 项目 | 值 |
| --- | --- |
| AgentTeams | v1.2.2 |
| Team | `phaseb6-qwen-team` |
| Leader | `phaseb6-leader` |
| Bridge Worker | `phaseb6-qwen-bridge` |
| provider | `openai-compat` |
| endpoint | `https://coding.dashscope.aliyuncs.com/v1` |
| model | `qwen3.7-plus` |
| transport | `responses-via-chat-bridge` |
| bridge | `opencodex` |

上游 key 只在临时部署配置中使用，未进入仓库、镜像、Worker consumer token、sidecar receipt、sidecar state、Matrix 消息或 ToolResult。Worker 只拿到 AgentTeams scope 内的 consumer token。

## 机器事实

### 通过的边界

- DashScope Coding Plan 直连：`GET /v1/models`、Chat/Completions 非流式、Chat/Completions 流式均返回 HTTP 200。
- OpenCodex sidecar：`/healthz` 和 `/readyz` 返回 200；使用 Worker consumer token 请求 sidecar `/v1/models` 返回 200。
- Worker 启动：`codex_gateway_preflight=pass`，transport 为 `responses-via-chat-bridge`，sidecar receipt 为 ready，随后 `tiangong_preflight=pass`。
- `agt create team` 能创建 Active Team；Leader ready，Bridge Worker ready，Matrix Team room 和 Leader DM room 均由 AgentTeams 生成。
- Dashboard 返回 HTTP 200。
- 手工重启 Bridge Worker 后，容器恢复 running，重新通过 Codex 和 Tiangong preflight，Team 仍保持 Active。

### 阻塞的边界

用同一个 Worker consumer token 从 AgentTeams 网关进入 Qwen 路由时：

| 请求 | 结果 | 观察 |
| --- | --- | --- |
| AgentTeams `/v1/models` | HTTP 418 | `istio-envoy`，有 upstream service time |
| AgentTeams `/v1/chat/completions` | HTTP 418 | `istio-envoy`，有 upstream service time |
| AgentTeams `/v1/chat/completions` stream | HTTP 418 | `istio-envoy`，有 upstream service time |
| sidecar 转发到 AgentTeams | HTTP 418 | sidecar 自身 ready，但上游路由失败 |

这不是 Worker 认证失败（认证失败会是 401），也不是 DashScope 上游不可达：同一套上游 key 直连为 200。当前应归类为 **AgentTeams/Higress `openai-compat` provider route 与 Coding Plan 的适配问题**。因此本次没有伪造真实模型 turn，也没有声称 ToolResult retention、完整 Matrix 对话或 WebUI 结果链路通过。

## 凭证边界发现

AgentTeams v1.2.2 的安装/切换脚本会把 provider key 物化到 controller 的 AI proxy 配置（`apiTokens`）中。这个位置不在 Worker，但也不是理想的 secret-only 引用；在官方管理面提供真正的 secret/consumer-token 注入前，不能把它描述成“上游 key 全程只在 secret manager 中”。本次没有把该配置内容复制到 Tiangong 仓库。

## 清理和回滚证据

- `agt get teams`：0 个 Team。
- `agt get workers`：0 个临时 Worker。
- `tiangong-opencodex-phaseb6-qwen-bridge` sidecar 已 drain/remove；对应 state/snapshot 已删除。
- 临时 `tiangong-worker-canary:qwen-phaseb6*` 镜像已删除。
- controller 已恢复：`openai-compat` + `https://api.deepseek.com/v1` + `deepseek-v4-flash`。
- `bash scripts/agentteams.sh verify`：AgentTeams controller、Manager、Matrix、MinIO、Dashboard 全部通过。
- 默认 Dashboard 仍返回 HTTP 200。

## 本地确定性验证

- `npm --prefix app test`：18 tests，14 pass，4 skip，0 fail。
- Qwen/sidecar 相关 Worker focused tests：29 pass，0 fail。
- 完整 Worker suite 在 Windows 工作区额外出现 44 个环境型失败（`EPERM` 的 fsync/symlink，以及 deployment-broker fixture 拒绝）；这不是本次 Qwen canary 的成功证据，后续应在 Linux/WSL runner 单独处理。

## 结论和下一步

现在不能切 Qwen，也不能进入 Qwen 的数据迁移或正式 Team smoke。保留现有 DeepSeek 和 `responses` 原生路径。

下一次只改一个变量：先在 AgentTeams/Higress 控制面修复或确认 `openai-compat` 到 Coding Plan 的路由/body 兼容性（尤其是 provider route、model mapping 和上游 key 注入），直到同一个 consumer-token 请求 Chat 返回 200；Worker、OpenCodex bridge 和 sidecar 合同不要先改。网关返回 200 后，再按本文件同一 Team 场景重跑真实 Leader/Worker、Matrix/WebUI、ToolResult retention、重启恢复和 cleanup，全部通过后才允许进入 shadow-read/cutover。

## 2026-08-17 隔离负向 canary

本轮在未改变默认 DeepSeek controller/provider 的前提下，创建了一个 disposable `codex/qwen3.7-plus` Worker。Worker 在 gateway preflight 阶段以 `gateway-model-config-missing` fail-closed，容器没有进入 ready，也没有创建 Team、sidecar 或模型 turn；随后 Worker 已删除，`agt get workers` 和 Docker 资源均无残留。

这次结果确认了当前栈的边界：Qwen Coding Plan 上游连通性曾经独立验证为 HTTP 200，但当前 AgentTeams v1.2.2 embedded gateway catalog 没有 Qwen route，不能把“上游可用”误写成“AgentTeams Team 可用”。因此本轮不能声称 WebUI/Matrix、ToolResult retention、重启恢复或回滚链路对 Qwen 已通过；这些项目须在 provider route 修复后重新执行。默认 DeepSeek 路由和现有 Codex A/B 不受影响。

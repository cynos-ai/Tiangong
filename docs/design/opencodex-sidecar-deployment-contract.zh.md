# OpenCodex sidecar 部署合同

> 状态：部署层 sidecar adapter、receipt service 和完整生命周期 smoke 已完成；AgentTeams v1.2.2 本身仍未内置 OpenCodex sidecar manager。
>
> 本文只定义公开项目需要的边界，不保存任何 provider key、consumer token、Matrix token 或运行日志。

## 结论

OpenCodex 2.15.0 可以作为 Chat/Completions-only 模型的内部协议桥接器，但它不是 AgentTeams 的第二个凭证中心，也不应该由 Worker 自己启动 Docker sidecar。生产拓扑必须由 AgentTeams 的部署/生命周期层拥有：

```text
AgentTeams Team / Worker
        |
        |  Worker-scoped consumer token
        v
OpenClaw -> Codex app-server (Responses)
        |
        |  x-opencodex-api-key: <same scoped token>
        v
OpenCodex sidecar (internal-only)
        |
        |  Authorization: Bearer <same scoped token>
        v
AgentTeams gateway -> Chat/Completions provider
```

原生 Responses 模型（例如 DeepSeek V4 Pro）不经过 sidecar，仍然由 Codex 直接访问 AgentTeams gateway。只有明确声明 `responses-via-chat-bridge` 和 `opencodex` 的模型 profile 才能进入这条路径。

## 当前实现（2026-08-15）

Tiangong 已提供一个部署层实现，落在 AgentTeams 同一受控 Docker 网络中：

- `scripts/deploy-opencodex-sidecar.sh` 启动、检查和移除 deployment-owned manager；manager 才持有 Docker socket，Worker 不持有。
- `tiangong-opencodex-sidecar:dev` 固定安装 OpenCodex `2.15.0`；每个 Worker 使用精确 owner labels 的独立 sidecar，无宿主机端口。
- `worker/agent/deployment/opencodex-sidecar-cli.mjs` 驱动 `provision → ready → reconcile → rotate → drain → remove`，并把 controller snapshot 原子写入受控卷。
- `opencodex-sidecar-receipt-service.mjs` 只通过内部 URL 返回 ready receipt；Worker 不需要挂载 manager 卷，缺失或非 ready 时 fail-closed。
- scoped consumer token 通过 manager 到 sidecar 的 stdin/tmpfs 短暂投影；配置只保存环境变量引用，凭证值不进入 Docker metadata、argv、普通文件、receipt 或日志。

这是一套 Tiangong deployment-owned adapter，不是 AgentTeams v1.2.2 的官方内置命令。未来 AgentTeams 提供正式 sidecar API 时，可保持本合同和 receipt schema 不变替换 adapter 实现。

## AgentTeams-owned 生命周期

1. 创建 Worker 前，部署层分配 sidecar 实例或可复用的受控 sidecar，并验证 `/healthz`、`/readyz` 与 `/v1/models` 的 bounded auth/connectivity probe。
2. sidecar 与 Worker 位于同一受控网络；只暴露内部地址，不发布到宿主机公网或 WebUI。
3. Worker 的 scoped consumer token 通过 AgentTeams secret projection 注入 sidecar 的 `OPENCODEX_API_AUTH_TOKEN` 和上游 provider 的 `apiKey` 引用。真实 Coding Plan key 只存在 AgentTeams gateway credential 中。
4. Worker 的临时 Codex TOML 使用 `env_http_headers = { "x-opencodex-api-key" = "OPENAI_API_KEY" }`。这个值是 consumer token，不是上游 provider key。
5. sidecar readiness 失败时，Worker 必须 fail-closed；不得静默切换到 builtin、另一个模型或另一个 credential。
6. Worker、Team 或 token rotation 结束时，部署层先撤销 sidecar admission，再回收 sidecar。sidecar 不拥有跨 Worker 的持久会话、账号池或 provider key。

## 必须实现的部署接口

部署实现需要提供以下可观测事实（值本身可以脱敏）：

| 接口 | 必须证明的事实 |
|---|---|
| `provision` | sidecar image/version、绑定的 Worker/Team、内部 endpoint、credential source |
| `ready` | `/healthz`、`/readyz`、provider route 与模型 profile 一致 |
| `rotate` | 旧 token 失效、新 token 生效，期间没有把 key 写入 Worker 文件系统 |
| `drain` | 不再接受新 Responses 请求，正在进行的 turn 有明确超时/取消结果 |
| `remove` | sidecar、临时配置、session/cache 均已回收；AgentTeams WebUI/Matrix room 不受影响 |

部署层还必须记录 sidecar 的版本、路由、Worker 资源名和 admission 结果，但禁止记录 header 值、完整 URL 中的 secret、prompt、tool payload 或模型返回原文。

## 已完成的真实验证

- `agt create worker` 创建自定义 `canary-chat-bridge` Worker，`phase=Ready`。
- `agt create team` 创建真实 Team，`phase=Active`，`leaderReady=true`，`readyWorkers=1`。
- Leader 在 Team room 发送任务；bridge Worker 回复 `QWEN_TEAM_MEMBER_TASK_OK`，运行元数据为 `provider=codex`、`model=qwen3.7-plus`、`fallbackUsed=false`。
- Leader 读取并转发 `TEAM_LEADER_RELAY_OK`。Team room、Worker room、Matrix/WebUI 路径保持 AgentTeams 所有权。
- 测试结束后 Team、Workers、sidecar 均已回收，Higress provider route 恢复为 DeepSeek。

这证明的是 Team 消息链和 bridge Worker 的兼容性；它不把 AgentTeams v1.2.2 宣称为官方 Controller-managed Codex runtime。官方 runtime 缺口由本节的 deployment-owned adapter 补齐。

## 不允许的实现

- 在 Worker 内使用 Docker socket 启动或销毁 OpenCodex。
- 把 Coding Plan、DeepSeek 或其他上游 key 写进 CR、镜像 `ENV`、OpenClaw 持久配置、Codex `config.toml`、session、Evidence 或日志。
- 让 OpenCodex dashboard、账号池或持久 provider 配置成为 Tiangong/AgentTeams 的权威控制面。
- 让 bridge 失败时自动 fallback 到 builtin 或另一个模型。

## 本轮实现的公共契约

Tiangong 已加入 `worker/agent/deployment/opencodex-sidecar.mjs`，它是
AgentTeams 部署层可以调用的无密钥生命周期契约，不是 Worker 自己的
sidecar 管理器。契约固定要求：

- `provision → ready → rotate → drain → remove` 的单向状态转换；
- 每次外部调用前先落入 in-flight 状态，失败后保留 `uncertain` 事实，禁止
  自动回退到 builtin、其他模型或其他凭证；
- `reconcile` 只能依据部署层的当前状态和 generation 恢复，不能靠重试猜测
  上一次调用是否生效；
- binding 只允许 `agentteams://credentials/...` 引用、模型/路由元数据和
  内部 endpoint，不接受或保存上游 key；
- `ready` receipt 是脱敏的普通 JSON，可只读投影到 Worker。Chat-only 路由的
  Codex preflight 必须读取并校验该 receipt；没有 receipt 就 fail-closed；
- snapshot、receipt、event 都拒绝 `apiKey`、`access_token`、`authorization`
  等凭证字段。

因此当前代码已经把 Worker 侧的 readiness gate、rotation/recovery 状态机、
真实容器 adapter、receipt service 和确定性测试补齐。adapter 作为独立部署组件
执行网络探针、轮换、drain 和精确回收；AgentTeams Controller 继续拥有 Worker、
Team、网关和 WebUI/Matrix 边界。bridge 只有在匹配的 ready receipt 存在时才会
进入 Worker admission。

## 部署层真实 smoke 结果

- DeepSeek `deepseek-v4-pro`：sidecar provision、ready、reconcile、generation
  rotate、真实 Responses 请求（HTTP 200）、drain、receipt 失效和 remove 全部
  通过；Worker 日志同时报告 gateway preflight、sidecar receipt 和 OpenClaw
  preflight 通过。
- Qwen `qwen3.7-plus`：sidecar 生命周期控制本身全部通过，但当前本地
  AgentTeams v1.2.2 gateway catalog 只声明 DeepSeek，真实请求被网关以
  “supported model names are deepseek-v4-pro or deepseek-v4-flash” 拒绝。
  这是当前 provider/catalog 配置缺口，不是 sidecar 生命周期失败；已有的
  独立 Qwen Team bridge canary 仍保留为路由可行性证据。
- manager 和 sidecar 均不发布宿主机端口，WebUI/Matrix 路径不变；测试结束后
  Team、Worker、sidecar 临时资源均按 owner 精确回收。

当前默认建议仍是：原生 Responses 模型直接走 Codex；明确 Chat-only 且有 ready
receipt 的模型走 OpenCodex bridge。要把 Qwen 纳入当前栈，只需先在 AgentTeams
gateway provider catalog/credential 路由中启用 Qwen，不需要重新设计 sidecar。

## Credential projection implementation note

The deployment-owned adapter may implement the provider credential as a
controller-scoped child-process environment reference (for example, the
sidecar config stores only `$TIANGONG_SCOPED_TOKEN`) if and only if the
platform proves that the resolved value is absent from Docker create metadata,
argv, Worker state, receipts, logs, and unrelated Worker `/proc` views. The
sidecar must run under a dedicated non-agent identity; this is not permission
for a Worker to create or inspect the process. If the isolation proof is not
available, use a platform secret file/FD projection or keep the bridge canary-only.

## AgentTeams v1.2.2 credential-provider boundary

AgentTeams v1.2.2 already defines generic `accessEntries` on Worker/Manager
resources and a credential-provider path for scoped cloud permissions. This is
the preferred source of provider authorization when the deployment runs with
the corresponding gateway/storage provider. It does not own an OpenCodex
process: it does not create the bridge, publish its internal endpoint, issue a
readiness receipt, or perform bridge generation rotation and drain.

The Tiangong adapter therefore remains intentionally small. It consumes an
AgentTeams-scoped credential reference, starts or reconciles an OpenCodex
generation under a dedicated deployment identity, and projects only the
sanitized binding/ready receipt defined above. A local `agt apply -f` probe with
`containerManaged: false` accepted a Worker manifest containing `accessEntries`,
but a second probe with an intentionally invalid `accessEntries.service` was
also accepted. The v1.2.2 REST DTO therefore does not preserve this field on
the embedded CLI path; the temporary resources were deleted afterward. Use the
native Kubernetes CR path (or an upstream DTO fix) before treating
`accessEntries` as an effective credential binding.

The embedded v1.2.2 REST DTO still omits `accessEntries`, so that field is not
used as an admission fact by the current Docker deployment. The running adapter
instead consumes the Worker-scoped AgentTeams gateway token through its
deployment-owned Docker authority, keeps the value in memory/child process only,
and records the limitation as an explicit integration boundary. A future
provider-enabled Kubernetes CR path or DTO fix can replace this credential
provider without changing the sidecar lifecycle contract.

## Shared capability cache

The Worker image's `auto` route uses a deployment-owned shared capability cache,
not a per-Worker probe. The cache key is the credential-free
`provider/model/baseUrl/detectorVersion` fingerprint. A cache miss is serialized
by an exact lock directory; only the first caller probes `/responses`, and later
Workers reuse the bounded metadata record. The record contains no key, token,
header, prompt, or model output. A bridge result still requires the current
Worker's matching ready receipt, so the cache never becomes sidecar lifecycle
ownership or an admission bypass. The default path is
`/var/lib/tiangong-capabilities/codex.json` and must be backed by an
AgentTeams-owned shared volume (or a future CoordinationStore adapter).

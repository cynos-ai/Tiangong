# OpenCodex sidecar 部署合同

> 状态：已通过真实 AgentTeams v1.2.2 Team canary；生产接入仍需由 AgentTeams 部署层实现。
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

这证明的是 Team 消息链和 bridge Worker 的兼容性，不等于 AgentTeams v1.2.2 已经提供了 Controller-managed Codex/OpenCodex runtime；生产化仍需完成上表的部署接口和 rotation/drain 证据。

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

因此当前代码已经把 Worker 侧的 readiness gate、rotation/recovery 状态机和
确定性测试补齐；真正创建容器、投影 secret、执行网络探针和回收资源的
adapter 仍必须由 AgentTeams Controller/deployment 层提供。没有这个 adapter
和它的真实重启/轮换 smoke，不能把 bridge 宣称为生产默认路径。

## Credential projection implementation note

The deployment-owned adapter may implement the provider credential as a
controller-scoped child-process environment reference (for example, the
sidecar config stores only `$TIANGONG_SCOPED_TOKEN`) if and only if the
platform proves that the resolved value is absent from Docker create metadata,
argv, Worker state, receipts, logs, and unrelated Worker `/proc` views. The
sidecar must run under a dedicated non-agent identity; this is not permission
for a Worker to create or inspect the process. If the isolation proof is not
available, use a platform secret file/FD projection or keep the bridge canary-only.

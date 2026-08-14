# AgentTeams 下 Codex / OpenClaw 运行时验收标准

> 范围：AgentTeams v1.2.2、OpenClaw Worker、Tiangong 自定义 Worker 镜像。
> 本文是公开的配置与验收合同，不包含任何凭证、私有端点或运行日志。

## 结论

AgentTeams 的 `runtime: openclaw` 只决定 Worker 容器使用 OpenClaw 运行时；它不自动决定 Worker 内部使用 OpenClaw 自带循环还是 Codex app-server。两种模式必须由镜像和运行时配置明确选择：

| 目标 | AgentTeams 资源 | Worker 镜像/启动合同 | 请求协议 |
|---|---|---|---|
| 普通 Agent / 协作 | `runtime: openclaw` | stock AgentTeams Worker；`embeddedHarness` 不设为 Codex | OpenAI-compatible Chat/Completions |
| Codex 编程 | `runtime: openclaw` | Tiangong canary；`OPENCLAW_AGENT_RUNTIME=codex`、`fallback=none`、Codex app-server | Responses |
| Chat-only 编程模型 | 同上 | Tiangong bridge canary；Codex Responses → OpenCodex → Chat | Responses 外部、Chat 内部 |

因此，不能仅修改 `spec.model` 就把一个已固定 Codex 模型的镜像切换为另一个模型；模型、provider endpoint、Codex wire API 和 bridge 必须作为同一版本化运行时合同发布。

## AgentTeams 官方配置边界

### Worker

公开资源路径使用 `agt create/apply worker` 或 Kubernetes `Worker` CR：

```yaml
apiVersion: agentteams.io/v1beta1
kind: Worker
metadata:
  name: tiangong-codex-worker
spec:
  model: deepseek-v4-pro
  modelProvider: agentteams-gateway
  runtime: openclaw
  image: tiangong-worker-canary:dev
  state: Running
```

`spec.modelProvider` 是 AgentTeams 的网关模型提供方选择；它不是 Codex 的 `model_provider` 配置，也不会把 Chat endpoint 变成 Responses endpoint。

v1.2.2 的 CRD 已声明 `spec.env`，但公开 REST DTO / `agt apply` 路径不完整透传该字段；在 embedded Docker 验证中，`agt apply -f` 提交的 `TIANGONG_CODEX_MODEL` 被镜像系统值覆盖，Worker 因模型目录不匹配而 fail-closed。未经独立验证，不得把 `spec.env` 作为本地 `agt` 路径的模型切换合同。

当前可接受的模型切换方式：

1. 为每个模型/transport 构建独立、可追溯的 Worker 镜像；或
2. 在确实支持 `spec.env` 的 Kubernetes CR 直连路径上重新验收，并确认保留键和更新重启语义；或
3. 等 AgentTeams REST/CLI 完整支持 env 后，再把配置回收到统一资源路径。

### Team Leader

Leader 也是一个独立 Worker。Team 只引用 Worker：

```yaml
apiVersion: agentteams.io/v1beta1
kind: Team
metadata:
  name: tiangong-codex-team
spec:
  workerMembers:
    - name: tiangong-codex-leader
      role: team_leader
    - name: tiangong-codex-worker
      role: worker
```

Leader 的 `model`、`modelProvider`、`runtime` 和 `image` 先在 Leader Worker 上验收，Team 只负责成员关系、房间和生命周期；不能在 Team 文本或 SOUL 中隐式切换模型或运行时。

## 凭证合同

AgentTeams 的 upstream provider key 由安装/Helm 的 LLM credential 配置持有（API key、base URL、默认模型），网关向 Worker 发放 Worker-scoped consumer token。Worker、OpenClaw、Codex 和执行命令不应接触 upstream provider key。

Codex 路由必须满足：

- consumer token 只在 Worker 启动时从受控配置解析到内存，并通过进程环境传给 Codex app-server；
- Codex 临时 `CODEX_HOME/config.toml` 权限为 `0600`，退出时删除；
- 启动后从持久化 OpenClaw provider 配置移除 `apiKey`，避免 token 进入 Worker 状态、备份或同步文件；
- provider key、consumer token、Authorization header 不得进入 CR、镜像 `ENV`、命令参数、Session、ToolResult、Evidence 或日志；
- 真实模型测试只允许使用 AgentTeams secret/credential 注入，禁止把 key 复制到仓库或临时 manifest。

## 必须通过的验收门槛

1. **资源门槛**：Worker `phase=Ready`；Team `phase=Active`；Leader 唯一且 `role=team_leader`。
2. **绑定门槛**：日志、OpenClaw effective config、Codex `thread/start` 的 model/provider 三者一致；镜像固定模型与 `spec.model` 不一致必须启动失败。
3. **协议门槛**：原生 Responses 模型完成文本、流式、`apply_patch`、多轮 tool replay；Chat-only 模型还必须通过 OpenCodex bridge 的同一组测试。
4. **运行时门槛**：Codex 目标必须出现 `provider=codex` 且 `fallbackUsed=false`；Builtin 目标必须出现 `provider=agentteams-gateway` 且 `embeddedHarness` 非 Codex。两者不得静默互换。
5. **凭证门槛**：Worker 内无 upstream provider key；持久化 OpenClaw/Codex 配置、session、日志和 Evidence 无 consumer token；测试结束后临时 Worker、Team、容器和临时状态全部清理。
6. **负例门槛**：错误 endpoint、错误 wire API、未知 bridge、模型目录缺失、`spec.model`/镜像模型不一致均 fail-closed，不自动 fallback 到另一个模型或 runtime。
7. **WebUI 门槛**：Matrix/Element Web、Worker room、Team room 和 OpenClaw Control UI 路径保持可观察；切换模型不能绕过 AgentTeams 房间和审计边界。

## 当前实测结果摘要

- 当前 AgentTeams v1.2.2 stack 的 DeepSeek endpoint：`deepseek-v4-pro`、`deepseek-v4-flash` 预检通过；当前分支构建的 Codex Worker 和 `team_leader` 均已完成真实文本调用。
- stock AgentTeams OpenClaw Worker 真实调用通过，但使用的是 OpenClaw 自带 Chat/Completions 循环，不是 Codex。
- 将同一 Codex 镜像的 `spec.model` 改成另一个模型时，因 v1.2.2 `agt` 路径不能覆盖镜像级 Codex 模型环境，Worker 按预期 fail-closed。
- Qwen Coding Plan、Qwen Token Plan、GLM、Kimi、MiniMax 尚未在本次 DeepSeek credential 上判定为“支持/不支持”；它们需要各自的 AgentTeams provider endpoint、model catalog、credential 和对应 wire/bridge canary。当前 DeepSeek credential 对这些模型的 400 只说明路由未配置，不能当作模型能力结论。

## 依据

- [AgentTeams v1.2.2 release](https://github.com/agentscope-ai/AgentTeams/releases/tag/v1.2.2)
- [AgentTeams v1.2.2 WorkerSpec](https://raw.githubusercontent.com/agentscope-ai/AgentTeams/v1.2.2/agentteams-controller/api/v1beta1/types.go)
- [AgentTeams v1.2.2 REST Worker DTO](https://raw.githubusercontent.com/agentscope-ai/AgentTeams/v1.2.2/agentteams-controller/internal/server/types.go)
- [AgentTeams v1.2.2 REST resource handler](https://raw.githubusercontent.com/agentscope-ai/AgentTeams/v1.2.2/agentteams-controller/internal/server/resource_handler.go)
- [OpenClaw Agent runtimes](https://docs.openclaw.ai/zh-CN/concepts/agent-runtimes)
- [Codex provider configuration](https://developers.openai.com/codex/config-reference)

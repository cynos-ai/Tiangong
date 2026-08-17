# Pi → OpenClaw 渐进式迁移

## 一句话结论

可以逐步切换，但不能把所有 Worker 一次性翻转。新 Team 走 OpenClaw
原生 runtime，旧 Team 保留 Pi 作为回滚路径；只有真实 Phase C 和后续
provider canary 都通过后，才删除 legacy harness。

## 两条运行车道

| 车道 | 运行方式 | 用途 |
| --- | --- | --- |
| `legacy-v0.2` | OpenClaw + Tiangong `tiangong-pi` harness | 现有 Team、回滚和对照 |
| `openclaw-native` | OpenClaw 内置 runtime；Tiangong 只注册 hook、tool 和 Gate | 新 Team 的渐进迁移 |

AgentTeams 的 `spec.runtime: openclaw` 只选择 Worker 容器。当前 pinned
OpenClaw 版本把内置 runtime 的历史 id 叫 `pi`；这不是仓库里的
`tiangong-pi` harness。原生车道通过 `TIANGONG_OPENCLAW_NATIVE=1` 明确
关闭 Tiangong harness 注册，避免两个模型循环同时存在。

角色默认路由保持不变：Leader、Designer、Assessor、Operator 使用
OpenClaw 内置 runtime；Implementor 使用 OpenClaw 官方 Codex runtime。
Chat-only provider 仍必须经过已验收的 OpenCodex bridge，且不允许隐式
fallback。

## 部署与回滚

`inject-b5-role-runtime-docker.sh` 在重建单个 Worker 时注入
`TIANGONG_OPENCLAW_NATIVE=1`。注入是原子替换：新容器的 role、runtime、
binding、endpoint 和 token 验证全部通过后才删除旧容器；失败则恢复原
容器。因此一次只切一个 Worker，Pi 仍然可回退。

若需要保留旧车道进行对照，可显式设置
`TIANGONG_B5_OPENCLAW_NATIVE=0`；这只是部署层的回滚/诊断开关，不应成为
新 Team 的默认值。

## 验收顺序

1. 先通过 `make test-phase-c-contract`，确认原生插件 API、角色注入、
   sidecar、Coordination 和 recovery 合同。
2. 修复 AgentTeams gateway/controller 后运行 `make phase-c-real`，证明
   Leader binding、Task/Result/ToolResult、WebUI/Matrix、重启和清理。
3. 以一个隔离 Team 做 Qwen 六门 canary：provider、Matrix/WebUI、
   ToolResult retention、restart、rollback、cleanup。
4. 迁移前做 PG/MinIO snapshot 和 rollback dry-run；没有完整机器事实时
   不做数据 cutover。
5. 重复运行稳定后，才删除 `tiangong-pi` harness 和 legacy lane。

当前真实 Phase C 仍受共享 AgentTeams 栈的 controller STS 503 和
Implementor capability-cache timeout 阻塞；这属于部署环境 No-Go，不是
原生 OpenClaw 车道已经通过的证据。

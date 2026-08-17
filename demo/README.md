# Tiangong Demo

这是一条不改变默认 provider 的可演示路径：5 个已有 Tiangong Worker 镜像组成一个 Team，使用当前默认 DeepSeek 路由，通过真实 Matrix 消息触发 Leader 房间。它复用现有 AgentTeams、OpenClaw、Tiangong runtime 和 WebUI；没有为 Demo 引入另一套业务流程。

为了不把尚未部署的 Leader Coordination Control sidecar 硬塞进演示，这个 v0 Demo 的 AgentTeams `team_leader` 使用 `tiangong-worker-member:dev` 作为可响应的演示 runtime。它能真实收发 Matrix 消息，但不宣称已经完成 Tiangong Leader 的 Project/Task 协调。后续 control runtime 就绪后，只需把 `demo/fixtures/workers.yaml` 的 Leader 镜像换回 `tiangong-worker-leader:dev`，不需要改 Team、WebUI 或发送路径。

## 启动

先确保 AgentTeams 已启动，然后在 WSL/Linux shell 执行：

```bash
./scripts/tiangong-demo.sh run
```

脚本会创建 `tiangong-demo-*` 资源，等待 5 个 Worker 和 Team 进入 Active，然后向 Leader 房间发送一个只读演示请求。脚本成功后打开：

- Dashboard：<http://127.0.0.1:13000/>
- Element Web：<http://127.0.0.1:18088/#/login>

登录后进入 Leader 房间即可看到真实回复和 Team 状态。也可以用 `show` 在终端查看最近的有界消息。若只想准备环境而不发送消息，用 `start`；查看状态用 `status`；发送自己的只读提示用 `send "..."`。

## 清理

演示资源默认保留，方便浏览器观察。结束后执行：

```bash
./scripts/tiangong-demo.sh stop
```

清理只匹配 `tiangong-demo-team` 和 `tiangong-demo-*`，不会删除其他 Team、Worker 或 provider 配置。若 `start` 发现同名资源已存在，先用 `stop`，不要强行覆盖。

## 边界

这版 Demo 的目标是展示真实的 Team/Matrix/WebUI/Worker 连接，不宣称 Qwen Coding Plan 已通过；Qwen 路由的 418 阻塞记录在 [`docs/design/phase-b6-qwen-team-canary.zh.md`](../docs/design/phase-b6-qwen-team-canary.zh.md)。

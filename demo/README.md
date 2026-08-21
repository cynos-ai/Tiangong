# Tiangong Demo

这是一条不改变默认 provider 的通用演示入口：Leader、Architect、Challenger、Developer、Reviewer、Tester 使用同一个 `tg-worker:dev` 镜像，由 AgentTeams 身份和部署配置区分职责。它复用现有 AgentTeams、OpenClaw、Tiangong Coordination runtime 和 Matrix；没有为 Demo 引入另一套业务流程。

当前公开 fixture 和确定性合同已证明 M1 Agent package、M2 product Skill 和 M3 chat-first Web 的配置、安全会话、Matrix chat 与 Work 投影边界。它仍不把部署侧完整 binding、真实 AgentTeams/Matrix 运行或 M4 真实项目纵切冒充为已实现能力。

## 启动

先确保 AgentTeams 已启动，然后在 WSL/Linux shell 执行：

```bash
./scripts/tiangong-demo.sh run
```

`start` 只创建 `tiangong-demo-*` 资源并等待 6 个 Worker 和 Team 进入 Active。由于 AgentTeams v1.2.2 manifest 不能表达 Agent package/MemberConfig 字段，发送 turn 前还必须由部署层完成 Coordination runtime 和六成员注入；没有该机器事实时 `run`/`send` 会拒绝发送，而不是让未绑定 Worker 接收消息。脚本成功后打开：

- Dashboard：<http://127.0.0.1:13000/>
- Element Web：<http://127.0.0.1:18088/#/login>

部署层完成 binding 并显式设置 `TIANGONG_DEMO_M1_RUNTIME_READY=1` 后，登录进入 Leader 房间即可看到真实回复和 Team 状态。也可以用 `show` 在终端查看最近的有界消息。若只想准备环境而不发送消息，用 `start`；查看状态用 `status`；发送自己的只读提示用 `send "..."`。

## 清理

演示资源默认保留，方便浏览器观察。结束后执行：

```bash
./scripts/tiangong-demo.sh stop
```

清理只匹配 `tiangong-demo-team` 和 `tiangong-demo-*`，不会删除其他 Team、Worker 或 provider 配置。若 `start` 发现同名资源已存在，先用 `stop`，不要强行覆盖。

## 边界

这版 Demo 的目标是展示真实的 Team/Matrix/WebUI/Worker 连接；Provider 和当前 Worker model 由 AgentTeams 控制面管理，Demo 不维护独立模型路由。

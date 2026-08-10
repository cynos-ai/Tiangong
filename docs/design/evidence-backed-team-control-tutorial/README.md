# Tiangong 可信团队控制教程

[阅读正式目标设计](../evidence-backed-team-control.md)

> 本教程解释目标设计，不表示当前运行时代码已经实现全部行为。若与正式设计不一致，以正式设计为准。

## 适合谁

面向需要理解或实现 Worker runtime、Adapter、产品界面和测试的读者。只需能阅读 JSON、Git commit 和少量伪代码，无需预先了解 Matrix、AgentTeams、模型会话、幂等或容器隔离。

## 全程案例

产品负责人陈晨提出：

> 给商城增加取消订单功能。只有未发货、尚未开始拣货的订单可以取消；取消后恢复预占库存并记录原因；不要改变现有下单接口。先在测试环境验证，部署生产前让我确认。

主要参与者：

- **陈晨**：提出需求，并决定是否批准精确生产操作的 Human；
- **林舟**：理解 Work、按需派发 Task、判断是否结束的 Leader；
- **周明**：实现成员；
- **乔安**：按需承担 review 或测试的成员；
- **高远**：外部状态无法自动查清时介入的认证 Operator；
- **Tiangong Kernel**：硬控身份、能力、并发、危险外部效果和恢复，不替人判断业务。

Review、测试、challenge、集成和发布都是 Leader 按风险创建的普通 Task，不是 Kernel 固定阶段。企业强制流程应由 CI、仓库保护或目标 Adapter 在最接近真实效果的位置执行。

## 阅读路线

首次阅读建议从 01 到 14。若已熟悉旧设计，可重点阅读 [04](04-one-bounded-delegation.zh.md)–[13](13-work-closure.zh.md)，最后用 [14](14-complete-walkthrough.zh.md) 串起完整路径。

## 课程地图

| 单元 | 核心问题 | 正式概念 |
|---|---|---|
| [01. 消息进入团队](01-message-to-team.zh.md) | 平台、Worker、Agent 和 Tiangong 怎样分工？ | Human、Agent、Worker、Team、Leader、AgentTeams |
| [02. 建立事务身份](02-one-request-one-work.zh.md) | 消息怎样进入可持续跟踪的事务？ | Work、timeline、消息去重、占位 Work |
| [03. 整理当前目标](03-clarify-the-goal.zh.md) | 怎样保留未知而不替 Human 猜？ | WorkSpec、完整快照、Human waiting |
| [04. 创建一次委托](04-one-bounded-delegation.zh.md) | 为什么不预建固定角色流程和 DAG？ | Task、TaskSpec、动态协作 |
| [05. 能力与上下文](05-capability-and-context.zh.md) | 哪些来源能真正授予能力？ | TeamConfig、MemberConfig、ControlProfile、Skill、runtime binding |
| [06. 执行环境](06-prepared-environment-and-bash.zh.md) | 怎样让 Bash 好用又不越过控制边界？ | prepared environment、single writer、sandbox、egress |
| [07. 终态报告](07-result-and-content.zh.md) | 内容身份和成员报告怎样交接？ | Result、ContentRef、ResultGuard |
| [08. 机器观察](08-tool-results-and-storage.zh.md) | 声明、工具观察和外部效果怎样区分？ | ToolResult、CoordinationStore、retention |
| [09. 外部写入](09-external-operation.zh.md) | push、部署和通知为何走受控边界？ | Adapter、Operation、typed request、preview |
| [10. 精确批准](10-exact-approval.zh.md) | 普通聊天为何不能授权部署？ | exact Approval event、pending、expiry、race |
| [11. 未知与恢复](11-uncertainty-and-recovery.zh.md) | timeout 后为何不能重试或直接报失败？ | started-before-call、reconciliation、rollback |
| [12. 并发与恢复执行](12-concurrency-cancellation-and-resume.zh.md) | 重放、竞态、取消和 session 丢失怎样处理？ | epoch、requestId、single active execution、budget |
| [13. 关闭 Work](13-work-closure.zh.md) | 怎样同时满足机器收口和语义判断？ | complete-work、stop-work、CloseGuard |
| [14. 完整案例](14-complete-walkthrough.zh.md) | 怎样串起全链路并从任意 ID 查询？ | 关系图、查询路线、系统不变量 |

## 阅读约定

- 教学 JSON 用于解释概念；正式字段约束以目标设计和未来 Schema 为准。
- “按需”不等于“不重要”。专业质量可由 Leader 选择的 Task 或外部硬门保证。
- 每类事实只证明自己的观察边界：Result 是成员报告，ToolResult 是工具观察，Operation event 才记录外部写入进展。

## 历史快照

旧教程与旧目标设计归档在 [`docs/archive/evidence-backed-team-control-2026-08-09/`](../../archive/evidence-backed-team-control-2026-08-09/README.md)，仅供历史查询。

从[第 01 单元](01-message-to-team.zh.md)开始。

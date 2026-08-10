# Tiangong 可信团队控制教程

[返回教程入口](../evidence-backed-team-control-tutorial.zh.md) | [阅读正式目标设计](../evidence-backed-team-control.md)

> 本教程解释目标设计，不表示当前运行时代码已经实现全部行为。遇到教程与正式设计不一致时，以正式设计为准。

## 适合谁

这套教程适合以下读者：

- 能阅读 JSON、Git 提交和少量伪代码；
- 没参与过 Tiangong 的设计；
- 想先弄懂“为什么”，再读正式合同；
- 需要实现 Worker runtime、Adapter、产品界面或测试；
- 需要判断某项控制应该放进代码、配置、Skill，还是外部系统。

不需要预先了解 Matrix、AgentTeams、模型会话、幂等或容器隔离。第一次出现这些概念时，正文都会从案例解释。

## 全程案例

产品负责人陈晨在团队消息通道中提出：

> 给商城增加取消订单功能。只有未发货、尚未开始拣货的订单可以取消；取消后恢复预占库存并记录原因；不要改变现有下单接口。先在测试环境验证，部署生产前让我确认。

课程中的主要参与者是：

- **陈晨**：提出业务需求，并对精确生产操作作决定的 Human；
- **林舟**：理解整件事、按需派发工作、判断何时完成的 Leader；
- **周明**：承担实现工作的团队成员；
- **乔安**：在林舟认为有价值时承担 review 或测试的团队成员；
- **高远**：只在外部状态无法自动查清时介入的认证 Operator；
- **Tiangong Kernel**：不替这些人理解业务，只硬控身份、能力、并发、危险外部效果和恢复。

乔安不是框架强制的“验证阶段”。Review、测试、challenge、集成和发布都只是 Leader 按当前风险创建的普通 Task。企业若要求合并前必须通过 review，应由仓库保护、CI 或相应 Adapter 代码强制，而不是把一种软件流程写进通用 Kernel。

## 这套教程怎样讲

每章遵循同一种节奏：

1. 回到案例中的下一步；
2. 尝试最自然的朴素做法；
3. 找出它会造成的具体错误；
4. 引入能够阻止该错误的最小结构；
5. 看一份小而完整的数据实例；
6. 分清它与相邻概念的边界；
7. 做一个可动手的练习；
8. 用**累积小结**重建从第一章到当前章的完整模型；
9. 用自检题确认自己不是只记住了英文名。

累积小结会有意重复前面的关键结论。重复不是为了凑篇幅，而是帮助你每学一层就把它接回整条链，而不是学到最后只剩一堆孤立对象名。

## 两种阅读路线

### 第一次接触：按顺序完整阅读

从第 01 单元读到第 14 单元。不要先跳到 Operation。若没有先理解 Work、Task、能力边界和 Result，很容易把 Operation 误解成普通工具日志。

### 已经读过旧设计：先看变化最大的单元

建议依次阅读：

1. [04：一次明确委托](04-one-bounded-delegation.zh.md)；
2. [05：能力与上下文](05-capability-and-context.zh.md)；
3. [06：热执行环境与 Bash](06-prepared-environment-and-bash.zh.md)；
4. [07：Result 与 ContentRef](07-result-and-content.zh.md)；
5. [08：ToolResult 与存储](08-tool-results-and-storage.zh.md)；
6. [09–11：Operation、Approval 与恢复](09-external-operation.zh.md)；
7. [13：关闭 Work](13-work-closure.zh.md)。

然后用第 14 单元把完整路径走一遍。

## 课程地图

| 单元 | 先解决的实际问题 | 最后认识的正式概念 |
|---|---|---|
| [01. 一条消息怎样进入受控团队](01-message-to-team.zh.md) | 消息平台、Worker、Agent 和 Tiangong 分别负责什么？ | Human、Agent、Worker、Team、Leader、AgentTeams |
| [02. 先给整件事一个稳定身份](02-one-request-one-work.zh.md) | 一句话怎样变成可持续跟踪的事务？关联错了怎样纠正？ | Work、timeline、消息去重、占位 Work |
| [03. 把模糊需求整理成当前目标](03-clarify-the-goal.zh.md) | 什么能确认，什么不能替 Human 猜？ | WorkSpec、完整快照、Human waiting |
| [04. 从整件事中拿出一次明确委托](04-one-bounded-delegation.zh.md) | 为什么不直接建立固定角色流程和完整 DAG？ | Task、TaskSpec、动态多 Agent 协作 |
| [05. 职责、能力、方法与上下文](05-capability-and-context.zh.md) | Task 文字为什么不能授予权限？Skill 和消息谁说了算？ | TeamConfig、MemberConfig、ControlProfile、Skill、runtime binding |
| [06. 热执行环境、Bash 与网络边界](06-prepared-environment-and-bash.zh.md) | 怎样既让 Agent 正常开发，又不把控制凭据交给 shell？ | prepared environment、单 writer、Bash、OS sandbox、egress |
| [07. “我做完了”怎样成为可接手报告](07-result-and-content.zh.md) | 一句完成声明、一个 commit 和正式交付有什么区别？ | Result、ContentRef、ResultGuard |
| [08. 机器实际看见了什么](08-tool-results-and-storage.zh.md) | 模型声明、工具输出、外部效果为什么不能混成一份“证据”？ | ToolResult、CoordinationStore、Execution Record、retention |
| [09. 本地动作与外部写入](09-external-operation.zh.md) | 为什么 push、部署和发通知要走另一条路？ | Adapter、Operation、typed request、preview、policy |
| [10. Human 批准的必须是精确动作](10-exact-approval.zh.md) | 普通聊天中的“可以”为什么不能授权部署？ | exact Approval event、pending、expiry、race |
| [11. 超时、未知结果与恢复](11-uncertainty-and-recovery.zh.md) | 外部系统可能已经改变时为什么不能重试或硬说失败？ | started-before-call、terminal outcomes、reconciliation、rollback |
| [12. 并发、取消、会话与预算](12-concurrency-cancellation-and-resume.zh.md) | 重复命令、双写进程、取消竞态和会话丢失怎样处理？ | epoch、requestId、single active execution、session、budget |
| [13. 谁决定整件事结束](13-work-closure.zh.md) | 没有 Result accept/reject 和固定状态机，Work 怎样安全关闭？ | complete-work、stop-work、CloseGuard、最小硬约束原则 |
| [14. 把完整案例走一遍](14-complete-walkthrough.zh.md) | 怎样从任意 ID 查回身份、委托、报告、工具观察和外部效果？ | 完整关系图、查询路线、系统不变量 |

## 三条阅读约定

### 教学 JSON 不是让你反推 Schema

每份 JSON 前都会先说明它代表什么，之后逐字段解释。示例会尽量贴近正式设计，但正式字段约束仍以目标设计和未来实现 Schema 为准。

### “可选”不等于“不重要”

Leader 可以按风险选择 review、测试、challenge 或集成 Task。某个企业也可以通过 CI、仓库保护或 Adapter 强制特定要求。教程说 Kernel 不强制某一流程，并不是说专业质量不重要。

### 机器事实只能证明自己的观察边界

ToolResult 能证明受控工具返回了什么，不能证明业务一定正确。Operation success 能证明 Adapter 确认了指定后置状态，不能证明 Leader 的产品判断一定正确。教程会反复指出每类事实不能证明什么。

## 每章怎样使用累积小结

读到“累积小结”时，先遮住正文，尝试自己从入口讲到当前步骤：

```text
Human 消息
→ 当前已经建立的持久事实
→ 谁拥有下一步语义决定
→ 代码硬控什么
→ 哪些内容仍然只是参考或声明
```

再与小结对照。如果中间有一层说不清，就回到首次引入它的章节，而不是继续背更多字段。

## 历史快照

被替换的旧教程与它所解释的旧目标设计已经按原文件归档在
[`docs/archive/evidence-backed-team-control-2026-08-09/`](../../archive/evidence-backed-team-control-2026-08-09/README.md)。归档只用于历史查询，不是当前合同，也不要把其中的旧对象带回本教程。

准备好后，从[第 01 单元](01-message-to-team.zh.md)开始。

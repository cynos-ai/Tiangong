# Tiangong 可信团队控制：从一条需求开始

这套教材写给这样的读者：

- 你是开发人员，能读懂 JSON、Git 提交和简单流程；
- 你没有参与 Tiangong 的设计；
- 你没有读过 Tiangong 的代码；
- 你可能只听说过 Agent、Matrix，甚至完全没听过 AgentTeams；
- 你希望先知道“为什么要这样做”，再学习正式名字和数据结构。

## 这套教材怎样讲

全课程只跟随一个案例：为商城增加“取消未发货订单”的能力，并在验证后安全上线。

每个新概念都按照同一个顺序出现：

1. 先回到案例，看到眼前的具体问题；
2. 尝试一个普通开发团队最容易想到的办法；
3. 观察这个办法在哪个边界会失效；
4. 引入一个最小解决办法；
5. 到这时才告诉你它在 Tiangong 里的正式名字；
6. 再看一份小而完整的数据实例；
7. 最后辨析它和相邻概念有什么不同。

前八个单元不会突然进入完整伪代码。第九、十单元仍以数据和流程为主；直到第十一单元讨论崩溃恢复时，才会逐步出现很短的伪代码。

遇到不熟悉的英文词时，不要先背定义。先继续看案例。正式名称只是为了让代码、文档和团队可以指向同一件东西。

## 全程使用的案例

产品负责人陈晨在团队聊天中提出：

> 给商城增加取消订单功能。只有未发货订单可以取消；取消后恢复库存并记录原因；不要改变现有下单接口。先在测试环境验证，上线生产前让我确认。

故事中的人和程序角色会逐步增加：

- 陈晨：提出需求并在必要时作出确认的人；
- 林舟：负责理解整件事、拆分工作和判断最终是否完成的团队负责人；
- 周明：负责实现订单取消能力；
- 乔安：不参与实现，负责独立验证同一份代码；
- Tiangong：让这些角色能自主协作，同时在权限、外部操作和机器事实处设置硬边界。

现在不需要记住这些人的正式类型。第一单元会从一条聊天消息开始解释。

## 课程地图

右侧一栏只是告诉你“学完这一单元后，正式文档会怎样称呼它”。它不是预习词表；现在看不懂可以直接跳过，正文会在第一次真正使用前解释。

| 单元 | 先解决的生活化问题 | 到最后才会认识的正式名称 |
|---|---|---|
| [01. 一条消息怎样走到 AI 团队](01-message-to-team.zh.md) | 群聊、AI、运行程序和团队管理平台分别负责什么？ | Human、Agent、Worker、Team、Matrix、OpenClaw、AgentTeams |
| [02. 先给整件事一个不会混淆的身份](02-one-request-one-work.zh.md) | 群里的一句话怎样变成一件可以持续跟踪的事情？ | Work、Work timeline |
| [03. 把模糊要求整理成共同目标](03-clarify-the-goal.zh.md) | 大家怎样知道当前到底要做什么？ | WorkSpec、`work-spec-changed` |
| [04. 从整件事中拿出一次明确委托](04-one-bounded-delegation.zh.md) | “完成整个需求”和“现在请你做这一步”为什么不是同一份说明？ | Task、TaskSpec |
| [05. 为什么收到委托仍不能随便使用工具](05-team-tools-and-workspace.zh.md) | Agent 的职责、方法和机器权限怎样分开？ | TeamConfig、MemberConfig、ControlProfile、Skill、Adapter |
| [06. “我做完了”怎样变成可接手的交付](06-result-and-content.zh.md) | 一句完成声明为什么还不够？ | Result、ContentRef、ResultGuard |
| [07. 为什么必须让另一个成员检查同一份代码](07-independent-verification.zh.md) | 自己测试过和独立验证有什么差别？ | verification Result、`producerResultId` |
| [08. 谁决定接不接受，又怎样结束整件事](08-decisions-and-closure.zh.md) | 机器检查通过后，谁判断它是否真的满足用户？ | CoordinationDecision、CloseGuard、Human confirmation |
| [09. 本地修改与真正改变外部系统](09-external-operation.zh.md) | 改工作区文件和部署生产为什么不是同一种工具调用？ | Operation、Gate、effect classification |
| [10. 人批准的必须是即将执行的那一件事](10-exact-approval.zh.md) | “可以上线”为什么不是足够精确的授权？ | Approval、operation digest、structured preview |
| [11. 请求超时后，为什么不能直接再试一次](11-uncertainty-and-recovery.zh.md) | 外部系统可能已经改变，但我们不知道时怎么办？ | `uncertain`、idempotency、reconciliation、rollback |
| [12. 系统怎样区分“Agent 说过”和“机器看到过”](12-records-and-evidence.zh.md) | 一条绿色输出究竟证明了什么？ | ToolResult、Execution Record、Machine Evidence |
| [13. 两个执行者、重试和恢复怎样不互相覆盖](13-concurrency-and-resume.zh.md) | 并发、响应丢失和旧进程复活时怎样保持安全？ | Work epoch、request replay、single active execution |
| [14. 把整个案例从头走到尾](14-complete-walkthrough.zh.md) | 怎样把所有概念连成一条可查询、可恢复的路径？ | 完整控制模型、存储与系统不变量 |

## 三条阅读约定

### 正式名字第一次出现时一定会解释

如果正文先使用了一个尚未解释的项目词，那就是教材的问题，不是读者的问题。可以把它记下来，在评审时要求补充。

### JSON 是实例，不是让你猜的数据结构定义

正式文档有时会把“字段有哪些、每个字段允许什么值”的定义叫 Schema。每份 JSON 前会先说明它代表什么，后面会逐字段解释。教程不会只扔出一个大对象，然后要求读者从字段名自行推断设计。

### 教程描述目标架构，不声称代码已经全部实现

正式设计当前的状态是“目标设计”。教程解释这套设计想建立的行为和边界，不把目标对象误写成现有代码中已经存在的同名类。

## 每个单元结束时问自己

每节最后都有自检。重点不是背英文名，而是确认三件事：

1. 我能不能用自己的话讲清楚为什么需要这一层？
2. 我能不能指出它保存的事实与不保存的事实？
3. 如果把这一层删除，我能不能举出一个具体故障？

准备好后，从[第一单元](01-message-to-team.zh.md)开始。

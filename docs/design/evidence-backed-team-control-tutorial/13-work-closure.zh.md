# 单元 13：谁决定整件事结束

[上一单元：并发、取消、会话与预算](12-concurrency-cancellation-and-resume.zh.md) | [返回课程目录](README.md) | [下一单元：把完整案例走一遍](14-complete-walkthrough.zh.md)

## 没有 Result accept/reject，Leader 怎样使用报告

取消订单 Work 现在可能有这些 Task：

| Task | 当前事实 |
|---|---|
| 调查库存接口 | 有 Result，说明现有接口可用 |
| 实现取消逻辑 | 有 Result，交付 `service-a@def456` |
| review 幂等风险 | 有 Result，提出并已修正一个问题 |
| 测试环境验证 | 有 Result，引用测试 ToolResult |
| 发布 | 有 Result，生产 Operation 已知成功 |

目标设计不要求林舟对每份 Result 再写 accept/reject。

林舟通过实际后续动作表达如何使用报告：

- 把调查 Result 的 Task ID 与文档 ContentRef 作为实现 Task 输入；
- 把实现 commit 交给 review、测试或发布 Task；
- review 提出问题后创建修复 Task；
- 认为某份报告不充分时创建补充 Task；
- 在当前目标已满足时 `complete-work`；
- 不再继续时 `stop-work`。

Result 保持成员当时的报告，不由 Leader修改。

## Work 只有两个终结命令

### `complete-work`

Leader判断当前非空 WorkSpec 已经语义满足。

### `stop-work`

Work 不再继续，并记录有界原因，例如：

- Human撤回；
- 目标无法实现；
- 重复 Work；
- 路由错误；
- 成本不再合理；
- 依赖方长期拒绝提供必要能力。

过去常见的 failed、cancelled 等终结词容易引发边界争论。`stop-work` 统一表达“不会继续”，具体原因保留在 timeline fact 中。

终结命令都是 Leader 的受控协调输入，不是模型在聊天里说“结束了”。

## complete 与 stop 的机器前置条件大部分相同

即使要停止，也不能留下：

- 正在写工作区的进程；
- 没有终态报告也没取消的 Task；
- pending Approval；
- uncertain 部署；
- recovery-needed 数据变更；
- 仍持有 writer lock 的旧 Worker。

业务不继续，不等于外部责任消失。

## CloseGuard 检查机器事实

在 `complete-work` 或 `stop-work` 前，**CloseGuard** 检查：

1. actor 仍是当前 Leader，Work 仍打开；
2. 若是 complete，当前 WorkSpec 非空；
3. 每个 Task 要么有 Result，要么有 `task-cancelled` fact；
4. 没有 Task 仍有 active turn、进程树或 writer lock；
5. 每个 Operation 都是：
   - `operation-not-executed`；
   - `operation-succeeded`；或
   - `operation-safe-failure`；
6. 没有 pending Approval；
7. 没有 uncertain、recovery-needed 或 unresolved incident path；
8. 所有 Result 引用的 deliverable 仍能解析。

CloseGuard 直接读取 Task、Result、ContentRef 和 Operation 来源，不建立中间 evidence index，也不让调用者挑一小部分“看起来安全”的依据。

## CloseGuard 明确不判断什么

它不判断：

- 取消订单产品体验是否好；
- 当前测试是否足够；
- review 意见是否应接受；
- known limitation 是否在范围内可接受；
- Human是否会满意；
- WorkSpec 的普通语言完成条件在语义上是否满足。

这些由 Leader综合当前 WorkSpec、timeline、Task、Result 和外部事实判断。

```text
CloseGuard：机器上有没有尚未安全收口的事实？
Leader：    当前目标在业务语义上是否完成或应该停止？
```

两者缺一不可。

## complete-work 走一遍

林舟准备完成 Work：

```text
当前 WorkSpec 非空
所有 Task 有 Result 或 cancellation
没有 active process/writer
测试和发布 Operation 都是 known terminal
没有 pending Approval
所有 commit/report ContentRef 可解析
```

CloseGuard 通过后，林舟判断：

- 合法订单取消行为符合目标；
- 重复请求不会重复释放库存；
- 原下单接口未改变；
- 测试环境验证完成；
- 陈晨批准的精确生产 Operation 已由 Adapter确认成功。

然后提交：

```text
complete-work
reason: “当前目标已交付，目标 commit 已完成测试环境验证并由生产 Adapter确认上线。”
```

系统原子追加 `work-completed` timeline fact、更新终结投影并推进 epoch。

## stop-work 也要安全收口

假设调查发现库存团队拒绝提供幂等接口，继续实现会产生重复释放风险。林舟决定停止。

在提交 `stop-work` 前：

- 已有调查 Result；
- 未完成实现 Task 已停止进程并取消；
- 没有 started Operation；
- 没有 active writer；
- 所有引用可解析。

然后：

```text
stop-work
reason: “库存服务缺少必要幂等能力，当前约束下无法安全实现；已停止所有执行且没有外部写入。”
```

若已有 uncertain Operation，仍不能 stop。必须先完成 recovery。

## WorkSpec 为空时可以 stop

歧义占位 Work通常始终 `workSpec: null`。确认它属于旧 Work后，可以直接 `stop-work`，因为系统不要求先为错误路由编造目标。

`complete-work` 则必须有非空 WorkSpec，否则 Leader没有明确目标可声称满足。

## 为什么不要求 Human 签署 Work closure

陈晨可以在普通消息中表达客户验收，也可以通过外部工单系统完成业务签收。某个 Skill 可以提醒 Leader在完成前询问客户。

但通用 Kernel 不建立强制 Human closure event：

- 很多 Work 是内部自动化或长期运维；
- 客户验收流程因企业而异；
- 外部危险动作已经由 exact Operation Approval 控制；
- Work semantic closure 属于 Leader职责；
- 把所有 Work 都卡在 Human签字会制造无安全收益的等待。

这不削弱生产 Approval。两者回答不同问题：

```text
Operation Approval
  “允许尝试这项精确外部写入吗？”

complete-work
  “根据当前全部事实，这整件 Work 是否语义完成？”
```

## Work 终结后不会重新打开

终结后，系统拒绝：

- late Result；
- late Task cancellation；
- late Approval；
- 新 Task；
- 其他协调写入。

陈晨后来提出新要求时，创建新 Work。可以在消息中引用旧 Work，但不会改写历史终点。

这样查询始终能回答：当时以什么目标、哪些报告和哪些外部状态结束。

## 安全模型的边界

目标设计假设单企业部署，基础设施、数据库和主机管理员受信。它要防的是：

- 模型错误和提示注入；
- route/Task/workspace 错配；
- prose/Skill/RAG 越权；
- credential 泄露给执行进程；
- 数据经网络误泄露；
- 并发 writer 和陈旧命令；
- 外部写重复、超时和未知；
- 误导性完成声明；
- Task/Work 终结后的迟到写入。

它不声称能防住恶意主机管理员重写存储、替换 Adapter 或读取进程内存，所以不增加面向受信管理员的签名链和多套账本。

## 新硬控制怎样进入 Kernel

以后有人建议增加一个 Gate、字段或状态时，先回答四个问题：

1. 它阻止哪个具体威胁或并发错误？
2. 为什么 Skill、MemberConfig、Adapter 或外部系统不够？
3. 代码怎样确定性验证？
4. 会给 Agent 和 Human 增加什么摩擦？

答不清时，优先改进默认 Skill、配置、Adapter 或产品提示，不扩 Kernel。

例如：

- “每个代码 Result 强制另一 Agent验证”更适合 CI/branch protection/Adapter；
- “每项外部写必须不可变并在 started 前持久化”直接阻止重复和未知恢复错误，适合 Kernel；
- “所有 Task 增加 12 种状态”如果只是 UI 展示，应从事实投影，不进业务模型。

## 动手练习：找出 CloseGuard 与 Leader 的分工

判断以下问题由谁回答：

| 问题 | CloseGuard / Leader / 外部系统 |
|---|---|
| 是否还有 active writer | CloseGuard |
| 取消订单体验是否满足陈晨 | Leader |
| commit 是否通过 required CI | 仓库/CI 或发布 Adapter；Leader可参考 |
| 是否还有 uncertain Operation | CloseGuard |
| known limitation 是否值得继续修 | Leader |
| Human是否批准精确生产 Operation | Operation policy/Gate，CloseGuard确认无 pending |
| 客户合同是否正式验收 | 对应外部业务系统，不由通用 Kernel假装 |

## 累积小结：到这里已经学会什么

从第一条消息到 Work 终结，完整控制模型是：

1. Human、通道、AgentTeams、Worker、Agent 与 Leader分工明确；平台身份不是业务授权；
2. Work 给整件事务稳定身份，消息入口去重，歧义路由用占位 Work 保守纠正并保留历史；
3. WorkSpec 是 Leader当前目标完整快照，缺少答案时等待 Human，不能授予权限或静默改写 Task；
4. Task/TaskSpec 是一次不可变委托，Leader动态派发分析、实现、review、测试、集成或发布，没有固定流程与 mandatory verification；
5. 实际能力来自 AgentTeams、ControlProfile、MemberConfig、runtime binding 当前交集，Skill和 prose 不能越权；
6. prepared environment 把 control 与 execution 分域，一等 Bash 在 OS、mount、credential、network 和完整进程树边界内正常工作；
7. 成员以精确 commit/ContentRef 交接，Result 是 assignee 唯一终态报告，ToolResult 是工具观察；
8. timeline、Result、ToolResult、Operation events 各自保存直接事实，不复制成第二账本；
9. 所有外部写都由 Adapter创建不可变 Operation，所有效果字段可见，credential 只用于认证；
10. exact Approval 是 Human 对一个 Operation ID 的认证 event，pending不拆 Task，rejection/expiry 产生 not-executed；
11. 外部调用 started-before-call，known terminal 由 Adapter确认，unresolved 必须对账、Operator升级或受控恢复；
12. message ID、requestId、epoch、operationId 和 single active execution 分别处理不同重复与并发；
13. cancellation 先停止真实执行并处理 Operation，Result 与 cancellation 原子竞争；session与预算故障不伪造 Result；
14. Leader用后续 Task和 Work终态表达如何使用 Result，不需要 accept/reject；
15. `complete-work` 与 `stop-work` 都先过 CloseGuard：所有 Task、进程、writer、Approval、Operation 和 ContentRef 必须安全收口；
16. CloseGuard只判断机器条件，Leader独自判断语义完成或停止；
17. Work终结后不重开，后续需求创建新 Work；
18. 新硬控制必须证明具体威胁、机器可验证性与摩擦，否则放在 Skill、配置、Adapter 或外部系统。

## 自检

1. Leader如何在没有 Result accept/reject 时表达报告的用途？
2. complete-work 与 stop-work 的语义差异和共同机器前置是什么？
3. CloseGuard 为什么必须扫描整个 Work，而不能接受调用者挑选的依据？
4. CloseGuard 和 Leader 分别判断什么？
5. 为什么 uncertain Operation 连 stop-work 也会阻止？
6. 为什么 Kernel 不强制 Human closure signature？
7. Work 终结后为什么不重新打开？
8. 新 Gate 进入 Kernel 前必须回答哪四个问题？

继续阅读：[第 14 单元](14-complete-walkthrough.zh.md)。

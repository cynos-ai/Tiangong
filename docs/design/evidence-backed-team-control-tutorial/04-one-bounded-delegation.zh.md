# 单元 04：从整件事中拿出一次明确委托

[上一单元：把模糊需求整理成当前目标](03-clarify-the-goal.zh.md) | [返回课程目录](README.md) | [下一单元：职责、能力、方法与上下文](05-capability-and-context.zh.md)

## 目标清楚后，Leader 仍不该说“大家开始做”

当前 WorkSpec 已说明整件事：实现取消订单、释放库存、记录原因、测试环境验证，并在生产部署前取得陈晨对精确动作的决定。

林舟现在想让周明先调查现有库存接口，再实现代码。

一种常见做法是提前画出完整流程：

```text
分析 → 设计 → 实现 → review → 测试 → 发布
```

然后为每个阶段创建固定角色和 Task。问题是：

- 调查可能发现根本不需要新接口；
- 小改动不一定需要独立设计 Task；
- review 可能在实现中途就有价值；
- 发布可能由外部 CI 完成；
- 非软件 Work 根本没有这些阶段；
- 预建 DAG 会把模型尚未知道的依赖伪装成确定事实。

Tiangong 选择让 Leader 按当前理解动态委托，而不是让 Kernel 规定专业流程。

## 先写清一次具体委托

林舟决定先让周明调查库存服务：

```text
本次目标
  确认库存服务是否已有按订单幂等释放预占库存的接口。

输入
  service-a 当前基线提交 abc123；
  库存服务公开接口文档 document-42/version-3。

约束
  只读调查；
  不修改共享仓库；
  不访问生产数据库；
  报告可用接口、缺口和建议下一步。
```

Tiangong 把这份“本次具体要做什么”叫 **TaskSpec**。

```json
{
  "objective": "确认库存服务是否支持按订单幂等释放预占库存",
  "inputs": [
    {
      "repositoryId": "service-a",
      "commitSha": "abc123"
    },
    {
      "adapter": "document-store@1",
      "ref": "document-42/version-3"
    }
  ],
  "constraints": [
    "只读调查",
    "不修改共享仓库",
    "不访问生产数据库",
    "说明可用接口、缺口和建议下一步"
  ]
}
```

TaskSpec 只含三类语义：objective、inputs、必要的普通语言 constraints。

## 再给这次委托一个正式身份

有说明还不够。系统还要知道它属于哪件 Work、交给谁、何时创建。

完整 **Task** 可以是：

```json
{
  "taskId": "task-investigate-inventory-01",
  "workId": "work-order-cancel-001",
  "assigneeId": "member-zhou",
  "taskSpec": {
    "objective": "确认库存服务是否支持按订单幂等释放预占库存",
    "inputs": [
      {
        "repositoryId": "service-a",
        "commitSha": "abc123"
      },
      {
        "adapter": "document-store@1",
        "ref": "document-42/version-3"
      }
    ],
    "constraints": ["只读调查", "不访问生产数据库"]
  },
  "createdBy": "leader-lin",
  "createdAt": "2026-08-10T09:40:00Z"
}
```

```text
TaskSpec = 一次委托的完整语义
Task     = 这次委托的稳定身份、所属 Work、负责人和创建事实
```

## 创建 Task 是 Leader 的权威协调输入

只有当前 Leader 可以 `create-task`。创建时，代码在一个事务里完成：

- 检查 Work 仍打开且 WorkSpec 非空；
- 检查林舟仍是当前 Leader；
- 检查周明当前被 Team 接纳；
- 保存不可变 Task 与 TaskSpec；
- 追加带有界理由的 `task-created` timeline fact；
- 推进 Work epoch；
- 保存同一请求的幂等结果。

要么全部成功，要么都不发生。

Leader 的命令直接产生 typed timeline fact，不先创建一个泛化的“决定对象”。

## Task 不复制哪些东西

Task 刻意不保存：

- WorkSpec 版本；
- 固定角色或 task kind；
- workflow stage；
- dependency DAG；
- 工具能力列表；
- 策略快照；
- workspace 业务对象；
- 预期 Result 类型。

原因不是这些信息都无用，而是它们有更合适的来源：

- 专业职责来自 MemberConfig；
- 当前权限每次按当前配置检查；
- writable root 来自 runtime capability binding；
- 前后依赖由 Leader 在输入实际出现后再创建后续 Task；
- Result 是自由但有界的终态报告，不需要按 Task 类型分子类。

## TaskSpec 创建后为什么不可修改

假设周明调查到一半，林舟把 objective 原地改成“直接实现并部署生产”。事后无法回答：

- 周明开始时看到什么；
- 哪些工具调用对应旧范围；
- 生产部署何时进入委托；
- 最终报告针对哪个目标。

因此 TaskSpec 和 assignee 都不可变。

如果只需要补充非权威背景，Leader可以发定向消息。如果目标或负责人实质改变，则：

1. 安全停止旧执行；
2. 若旧 Task 还没有 Result，取消它；
3. 创建新 Task 和新 TaskSpec。

不要建立通用 Task update 协议。

## Leader 怎样动态展开工作

调查 Result 返回后，林舟可能创建：

- 实现 Task；
- 对接口幂等风险的 challenge Task；
- 集成 Task；
- review Task；
- 测试 Task；
- 发布 Task。

也可能只创建实现 Task，然后自己阅读报告并结束。

这些都是普通 Task。Kernel 不理解“review”比“analysis”更高级，也不规定先后顺序。Leader 在输入可用时再派发：

```text
调查报告可用
→ Leader 决定实现方案
→ 创建实现 Task

实现 commit 可用
→ Leader 根据风险选择 review、测试、集成或直接继续
```

这不是反对计划，而是不把暂时的计划膨胀成通用状态机。计划可以存在于消息、Skill 或 Task 中；机器只硬控真正需要稳定身份和并发保护的委托。

## 企业强制 review 放在哪里

某企业要求所有生产分支必须两人 review。这是合理硬要求，但最佳执行点通常是：

- Git branch protection；
- CI required check；
- 合并 Adapter；
- 发布 Adapter。

这些系统能直接确认 commit、review identity 和目标分支。通用 Result 不需要增加 verification 子类型，Kernel 也不需要规定所有专业 Work 都走相同流程。

Leader仍可创建 review Task，让 Agent 产出有价值的专业报告；企业硬门在真正合并或发布处由代码执行。

## 一个 Task 为什么只有一个 assignee

一次委托必须有明确负责人。否则两个人都能提交最终报告，系统无法稳定判断：

- 谁拥有执行上下文；
- 哪些 ToolResult 属于这次工作；
- 谁能提交唯一 Result；
- 取消时应停止哪棵进程树。

多人并行不靠共享一个 Task，而是创建多个 Task。

## 同一个成员可以并发多个 Task 吗

可以，但必须同时满足：

- 当前 MemberConfig 和 ControlProfile 的并发额度允许；
- 每个 Task 有独立逻辑 session；
- 每个 Task 同时最多一个 execution owner；
- 涉及写入时使用不同 writable root 或 worktree；
- 网络、数据和工具能力仍逐次检查。

例如周明可以一边运行一个耗时测试 Task，一边在另一个只读 Task 中调查文档，只要资源和文件边界不冲突。

## Task 没有可编辑 status，界面怎么看进度

UI 可以显示：

- queued：已经委托，但没有活跃执行；
- running：存在活跃 turn 或进程树；
- waiting approval：有 pending Operation；
- reported：已有 Result；
- cancelled：有 `task-cancelled` fact。

这些都是从实际事实投影出来的标签。若再维护一个独立 `status` 字段，就可能出现 Result 已提交但 status 仍是 running 的双重真相。

## 当前 WorkSpec 与 Task 上下文怎样并存

成员默认得到：

- 不可变 TaskSpec；
- runtime binding；
- Leader 在派发时选择的定向背景；
- 为这次 Task 选择的 Human/Work 消息；
- 被允许的 Skills。

Task 不自动订阅以后所有 WorkSpec 变化。周明可以查询当前 Work 摘要，但返回内容会标成背景。

具体优先级和能力来源下一单元展开。

## 动手练习：把 Work 拆成最少 Task

假设调查确认库存接口已经存在。请为下一步写一个 TaskSpec：

```text
objective:
inputs:
constraints:
```

检查自己有没有误加：

- 固定 Task 类型字段；
- 固定 required-role 字段；
- 固定 review 后继节点；
- “允许生产部署”这种权限授予；
- 可移动的分支名而不是精确 commit。

如果 review 现在还不确定是否需要，就不要预建 review Task。等实现结果可用后由 Leader判断。

## 累积小结：到这里已经学会什么

从入口到第一次正式委托，完整模型是：

1. Human 消息通过认证通道进入 AgentTeams 管理的 Worker；
2. Tiangong 检查 Team 路由，Leader负责理解语义，代码负责机器边界；
3. 一条没有明确旧关联的消息原子创建 Work 和首条 timeline；
4. 歧义消息先建占位 Work，确认后追加到正确 Work并停止占位，不删除、不 merge；
5. Leader通过普通消息澄清，缺少安全默认时等待 Human，不编造答案；
6. WorkSpec 用完整快照表达整件事当前目标，投影只是最后一份 timeline 事实的当前视图；
7. WorkSpec 不授予权限，也不会自动修改已经派发的 Task；
8. WorkSpec 非空后，Leader才可创建 Task；
9. TaskSpec 是一次委托的 objective、inputs 和 constraints，Task 绑定 Work、assignee 和身份；
10. TaskSpec 与 assignee 不可变，实质变化通过取消旧 Task、创建新 Task表达；
11. 分析、实现、review、测试、集成和发布都只是按需普通 Task，不是 Kernel 阶段；
12. Kernel 不预建专业 DAG，也不要求通用独立验证；企业硬 review 放在最接近真实效果的仓库、CI 或 Adapter；
13. 一个 Task 一个 assignee、一个 active execution owner；同一成员可在额度内并发多个独立 Task；
14. 当前已经有第一份正式委托，但成员仍不能仅凭 Task 文字获得任何工具、数据或生产权限。

## 自检

1. Task 与 TaskSpec 分别保存什么？
2. 为什么 Task 不保存角色、阶段和依赖图？
3. 后续 WorkSpec 改变时，哪三种处理方式是合法的？
4. 企业强制代码 review 为什么更适合在合并或发布边界执行？
5. 同一成员并发两个 Task 时，哪些资源必须分开？
6. 没有 Task status 字段，UI 仍能从哪些事实显示进度？

继续阅读：[第 05 单元](05-capability-and-context.zh.md)。

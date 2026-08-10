# 单元 08：机器实际看见了什么

[上一单元：“我做完了”怎样成为可接手报告](07-result-and-content.zh.md) | [返回课程目录](README.md) | [下一单元：本地动作与外部写入](09-external-operation.zh.md)

## “测试通过”至少包含两种不同事实

周明的 Result 写：

> 实现取消订单，单元测试通过。

这是一份正式报告，但仍是周明的声明。另一个事实是受控 Bash 实际运行并返回：

```text
exit code = 0
summary   = 128 tests passed
```

如果把两者压成一个 `success: true`，以后无法回答：

- 是模型自报成功，还是命令真的退出为 0；
- 命令属于哪个 Task 和 actor；
- cwd 和输入是什么；
- 完整输出在哪里；
- 这项观察是否仍被保留；
- 外部系统是否真的发生了写入。

Tiangong 让每种事实留在自己的直接来源。

## 四类直接事实来源

| 来源 | 保存形式 | 案例 |
|---|---|---|
| Human 与 Leader 的沟通和协调 | Work timeline | 陈晨补充需求；林舟创建 Task |
| Agent 的最终报告 | Result | 周明报告实现内容和限制 |
| 顶层工具观察 | ToolResult | Bash 返回 exit code 0 |
| 外部写入真实进展 | Operation events | 部署已开始、成功或结果未知 |

同一个事实不再复制进第二层“证据包装”。查询时直接回到真实来源。

## ToolResult 是一次顶层工具调用的有界观察

周明运行：

```bash
npm test
```

受控 runtime 可以保存：

```json
{
  "toolResultId": "tool-result-unit-test-21",
  "workId": "work-order-cancel-001",
  "taskId": "task-implement-cancel-01",
  "actorId": "member-zhou",
  "tool": "bash",
  "requestSummary": {
    "command": "npm test",
    "cwd": "service-a",
    "commitSha": "def456"
  },
  "resultSummary": {
    "exitCode": 0,
    "summary": "128 tests passed"
  },
  "outputRef": null,
  "startedAt": "2026-08-10T11:50:00Z",
  "completedAt": "2026-08-10T11:52:00Z"
}
```

这份不可变、有界的机器观察叫 **ToolResult**。

Task 上下文对某些 Leader-level 工具可以为空。`commitSha`、查询范围、目标和 duration 等细节只在相关工具中进入有界 summary，不膨胀成所有工具共用的业务字段。

## ToolResult 能证明什么

在受信的工具包装和执行边界内，它能证明：

- 哪个 actor 在哪个 Work/Task 调用了哪个顶层工具；
- runtime 记录的关键输入摘要；
- 工具何时开始和完成；
- 工具返回什么状态与有界输出；
- 必要时，大输出存到哪个受控引用。

它不能证明：

- 周明理解了代码；
- 测试脚本设计正确；
- 测试覆盖所有业务风险；
- exit code 0 等于 WorkSpec 满足；
- 一条 `curl` 返回 200 就等于外部写入成功；
- 模型没有忽略重要警告。

机器事实的可信度来自准确表达观察边界，而不是把结论写得更强。

## 为什么 ToolResult 只记录顶层调用

Bash 内部可能运行：

```text
npm → shell script → node → compiler → test child processes
```

Tiangong 不把每个内部 executable 都升级为业务 ToolResult。顶层 Bash 调用是模型请求的受控边界；内部进程由 OS sandbox、进程树限制和必要日志观察。

如果某个内部步骤需要成为独立、可授权的外部动作，它就不应藏在 Bash 中，而应通过 Adapter 形成 Operation。

## 为什么不能保存全部原始输出

日志和工具输出可能包含：

- access token；
- 用户个人数据；
- 私有源码片段；
- 未受限 prompt 或模型响应；
- 终端控制字符；
- 数百 MB 构建日志。

ToolResult 保存 sanitized、bounded summary。确实需要的大输出放到受控存储，通过 `outputRef` 访问并受 retention 与权限约束。

以下内容不得进入普通 ToolResult：

- credential；
- 原始敏感 payload；
- 不受限完整 prompt/session；
- 无界日志；
- 为了“审计完整”而复制的全部上下文。

多记不等于更可信，可能只是扩大泄露面。

## Result 怎样引用 ToolResult

周明提交 Result 时列出：

```json
{
  "toolResultRefs": ["tool-result-unit-test-21"]
}
```

ResultGuard 检查它确实属于周明和当前 Task，并先增加 retention mark。

这表示：

> 周明把这项工具观察作为自己终态报告的支持材料。

它不表示 Kernel 已判定测试足够，也不表示 Leader必须采纳。Leader可以阅读 ToolResult、创建补充测试 Task，或由 CI/Adapter执行企业硬要求。

## 活跃 Task 的 ToolResult 怎样留存

目标设计规定：

- 活跃 Task 的 ToolResult 至少保留到 Result 提交或 Task 取消；
- 被 Result 引用后，保留到 Work 的 retention period；
- 其他 ToolResult、trace 和日志可以按 ControlProfile 采样或过期。

这样既不会让活跃工作中途失去上下文，也不要求所有调试日志永久保存。

Operation events 不走采样；外部写入的永久事件属于 CoordinationStore，下一单元开始学习。

## 三类存储职责

### CoordinationStore：协调与外部效果事实

保存：

- Work timeline 和当前投影；
- Task；
- Result；
- Operation；
- 永久追加的 Operation events。

它需要事务、唯一约束、epoch 与请求重放等能力。

### Execution Record storage：运行观察

保存：

- ToolResult；
- 有界日志和 trace；
- 模型与 Skill invocation metadata；
- 诊断和消息投递观察。

它可以根据规则采样，但被 Result 引用的 ToolResult 有 retention mark。

### Git 与 Adapter-owned content store：实际内容

Git 保存代码 commit；文档、制品或其他内容由对应 Adapter 存储，并通过 ContentRef 稳定引用。

这些是逻辑职责，不要求部署成三个物理服务。

## 哪些东西只是基础设施状态

下面这些帮助运行，但不成为新的业务记录：

- session state；
- prepared environment mapping；
- writer lock；
- reminder timer；
- request replay row。

例如 request replay row 用于响应丢失后返回同一结果，不需要出现在 Work timeline 中。把每个运行细节都提升成业务对象只会制造重复账本。

## 看见一条绿色输出时怎样提问

不要直接问“这是不是证据”。按顺序问：

1. 这是 Agent 的文字、ToolResult，还是 Operation event？
2. 谁产生它，哪个运行边界负责真实性？
3. 它绑定哪个 Work、Task、actor、cwd 或 target？
4. 它直接观察到什么？
5. 它明确不能证明什么？
6. 底层内容和引用保留多久？
7. 最终语义判断属于 Leader 还是外部强制系统？

这组问题比建立一个包罗万象的 evidence 对象更容易定位责任。

## 例子：测试、CI 和部署返回都写“success”

三种输出看起来相似，但事实不同：

```text
本地 npm test exit 0
→ ToolResult
→ 证明受控命令这样返回

CI required check 通过
→ 只读 Adapter observation，或在合并 Adapter Gate 中直接查询
→ 证明 CI 系统对精确 commit 的当前状态

部署后端 HTTP 200
→ 还不能直接成为安全终态
→ Adapter 必须查询并确认声明的外部后置状态
→ 才能写 operation-succeeded
```

不能把三者都包装成一个“机器成功”。

继续阅读：[第 09 单元](09-external-operation.zh.md)。

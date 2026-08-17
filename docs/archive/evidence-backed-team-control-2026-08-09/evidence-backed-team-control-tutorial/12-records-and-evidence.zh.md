# 单元 12：系统怎样区分“Agent 说过”和“机器看到过”

[上一单元：请求超时后，为什么不能直接再试一次](11-uncertainty-and-recovery.zh.md) | [返回课程目录](README.md) | [下一单元：两个执行者、重试和恢复怎样不互相覆盖](13-concurrency-and-resume.zh.md)

## 从“测试通过”这句话拆开

周明说：

> 我运行了测试，全部通过。

这句话至少混合了三个层次：

1. 周明声称自己做了什么；
2. 某个受控命令实际运行并返回什么；
3. 这些机器结果是否足以支持某项关键结论。

如果把三层都存成一个 `success: true`，以后就无法判断：是模型自报成功，还是命令真的退出为 0；命令是否跑在目标 commit；结果是否仍被保留；它又是否足以证明业务正确。

## 第一层：Agent 的声明

Result 中的：

```json
{
  "outcome": "completed",
  "summary": "实现订单取消并通过测试"
}
```

是提交者的正式声明。

它比普通聊天更正式，因为与一个 Task 的唯一终态交接绑定，但仍然是声明。代码不会因为 `outcome` 写了 completed 就假装测试实际发生。

## 第二层：受控工具看见了什么

周明通过 Tiangong 包装的命令工具运行测试。Tiangong 把每次受控工具调用的有界回执叫 **ToolResult**。实例是：

```json
{
  "toolResultId": "tool-result-unit-test-21",
  "workId": "work-order-cancel-001",
  "taskId": "task-implement-cancel-01",
  "actorId": "member-zhou",
  "toolName": "command",
  "adapterId": "isolated-runner",
  "adapterVersion": "1",
  "inputSummary": {
    "argv": ["npm", "test"],
    "cwd": "workspace/service-a",
    "repositoryId": "service-a",
    "commitSha": "9ab73e..."
  },
  "outcome": "success",
  "outputSummary": {
    "exitCode": 0,
    "summary": "126 tests passed"
  },
  "outputRef": null,
  "startedAt": "2026-08-10T11:50:00Z",
  "completedAt": "2026-08-10T11:51:00Z"
}
```

## ToolResult 能证明什么

它能证明，在当前受信运行边界内：

- 哪个成员在哪个 Task 中调用了哪个工具；
- 使用了什么经过清理的关键输入；
- 在哪个工作区和 commit 上运行；
- 工具返回了什么退出状态和有界摘要；
- 调用何时开始和结束。

它不能证明：

- 模型理解了代码；
- 测试覆盖了所有业务风险；
- 仓库里的 `npm test` 脚本本身设计正确；
- 外部后端绝对诚实；
- exit code 0 自动意味着 WorkSpec 已满足。

机器记录应准确表达自己观察到的边界，不夸大结论。

## 为什么不把完整 stdout 全塞进去

工具输出可能非常大，也可能包含凭据、用户数据或恶意控制字符。

ToolResult 只保存经过清理的参数、状态和有界摘要。必要的大输出放入受控内容存储并通过引用访问。

下面这些内容不能进入普通 ToolResult：

- 凭据；
- 原始敏感写入 payload；
- 无限制完整 prompt；
- 未清理的任意日志内容。

“为了审计什么都记下来”本身可能制造新的泄密边界。

## 第三层：哪些工具结果支持关键结论

乔安提交验证 Result 时，会提名两份 ToolResult。运行时代码检查：

- 它们确实属于乔安；
- 属于验证 Task；
- 来自独立工作区；
- 绑定 commit `9ab73e...`；
- 结果满足 ControlProfile 要求。

检查通过后，运行时创建一条较小的索引。Tiangong 把它叫 **Machine Evidence**，也就是机器证据：

```json
{
  "machineEvidenceId": "machine-evidence-verification-08",
  "workId": "work-order-cancel-001",
  "taskId": "task-verify-cancel-01",
  "type": "verification-executed",
  "subjectRef": {
    "kind": "git-commit",
    "repositoryId": "service-a",
    "commitSha": "9ab73e..."
  },
  "toolResultRefs": [
    "tool-result-unit-test-33",
    "tool-result-integration-test-34"
  ],
  "actorId": "member-qiao",
  "createdAt": "2026-08-10T14:00:00Z"
}
```

它不是把所有日志复制一遍，而是运行时代码创建的一个受控索引：哪些已验证 ToolResult 支持哪一类关键机器事实，并且对象是谁。

Agent 可以提名 ToolResult，不能直接伪造 Machine Evidence。

## 为什么 Machine Evidence 创建前先延长 ToolResult 留存

Machine Evidence 如果引用一个明天就被日志清理任务删除的 ToolResult，就会变成空壳。

因此顺序是：

1. 验证 ToolResult；
2. 在执行记录存储中幂等延长这些 ToolResult 的留存期限；
3. 等待留存更新被确认；
4. 再提交 Machine Evidence。

如果第二步成功、第四步前崩溃，只会多保留一段时间；重试仍然安全。如果反过来先写 Evidence，就可能出现证据存在、底层观察已经消失。

## Execution Record 是更宽的观察层

ToolResult 只是执行记录的一种。Tiangong 把下面这些宽泛运行信息合称 **Execution Record**：

- Trace，也就是一次请求经过多层组件时留下的调用轨迹；
- 有界日志；
- ToolResult；
- 模型调用元数据；
- Skill 调用元数据；
- 消息投递诊断。

普通 Trace 可以采样，因为它主要用于可观测性。被 Machine Evidence 引用的 ToolResult 则必须保留到当前 Work 的适用审计期限。

所以：

```text
Execution Record = 宽广的运行观察和诊断层
Machine Evidence = 运行时代码验证后，为关键事实建立的小索引
```

## 六类事实放在一起

现在可以完整区分：

| 事实类别 | 案例中的例子 | 它不代表什么 |
|---|---|---|
| 模型文字或声明 | 周明 Result 说 completed | 不自动证明命令运行或业务正确 |
| 协调决定 | 林舟 accept-result | 不证明代码客观正确 |
| Execution Record | 测试命令 exit code 0 | 不自动满足 WorkSpec |
| Machine Evidence | 运行时确认两份测试记录绑定同一 commit | 不替 Leader 作业务判断 |
| Approval | 陈晨批准精确部署 Operation | 不证明部署已经成功 |
| 外部状态 | Adapter 确认生产运行目标 commit | 不证明 Human 曾授权该动作 |

没有任何一格可以悄悄替代另一格。

## Operation 的机器证据从哪里来

Agent 不需要为部署事实自己挑几段日志。运行时会自动为关键 Operation 事件创建 Machine Evidence，例如：

- Gate 批准或拒绝结果；
- 实际执行开始；
- 已确认成功；
- Approval 结果；
- reconciliation 观察；
- rollback 事实。

这些 Evidence 仍然只在受信 Adapter 和部署边界的保证范围内成立。如果基础设施管理员恶意伪造后端状态，当前威胁模型并不声称能提供外部法证证明。

## 三种存储分别保存什么

### CoordinationStore：业务控制事实

保存 Work、时间线、Task、Result、Decision、配置历史、Approval、Operation 事件和 Machine Evidence。

它提供事务、Work epoch 检查、唯一约束和运行时视角下的追加历史。

### Execution Record store：运行观察

保存 Trace、日志、ToolResult、模型和 Skill 元数据、投递诊断。

### Content stores：实际内容

Git 保存代码；文件或对象存储保存非 Git 内容。ContentRef 提供精确交接，不把存储后端变成业务模型本身。

这三类存储可以由不同技术实现。重要的是职责边界，而不是必须部署三个独立服务。

## “evidence-backed”不等于“所有事情都有数学证明”

Tiangong 的目标是：关键机器结论能够回到受控观察，同时明确观察边界。

它不声称：

- 证明模型真正理解了代码；
- 证明业务判断永远正确；
- 抵抗受信数据库或主机管理员篡改；
- 把每份文档、测试计划和环境都变成强制对象；
- 用日志数量代替质量。

诚实标明不能证明什么，是可信设计的一部分。

## 本单元自检

1. Result 中的 completed 与 ToolResult 中的 success 有什么不同？
2. ToolResult 能证明测试命令执行，但为什么不能证明业务一定正确？
3. 为什么 Agent 只能提名 ToolResult，不能直接创建 Machine Evidence？
4. Machine Evidence 写入前为什么先延长 ToolResult 留存？
5. Approval 与外部状态分别回答什么问题？
6. 三种逻辑存储各自保存哪类内容？

下一单元会处理最后一组底层问题：两个 Leader turn 同时写入、命令响应丢失、Worker 失联和会话被清理时，怎样避免产生两套事实。

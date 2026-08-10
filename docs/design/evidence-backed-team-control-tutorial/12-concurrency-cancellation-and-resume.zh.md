# 单元 12：并发、取消、会话与预算

[上一单元：超时、未知结果与恢复](11-uncertainty-and-recovery.zh.md) | [返回课程目录](README.md) | [下一单元：谁决定整件事结束](13-work-closure.zh.md)

## “防重复”不是一个问题

到目前为止至少出现了五类重复或竞态：

1. 同一平台消息被重复投递；
2. 两个 Leader turn 都基于旧 Work 作协调写入；
3. 一条协调命令已成功，但响应丢失后再次发送；
4. 旧 Task 执行者失联，新执行者启动，而旧进程又恢复；
5. Result 提交与 Task cancellation 同时发生。

这些不能用一个万能 idempotency key 或一个 `status` 字段解决。

## 入口消息去重回顾

平台消息使用 `platformMessageId`：

```text
同一认证消息 ID 重放
→ 返回原 Work/关联结果
→ 不创建第二份 Work
```

它只解决入口输入重复，不解决 Leader协调命令和外部 Operation。

## Work epoch 防止旧判断覆盖新事实

假设两个 Leader turn 同时读取：

```json
{
  "workId": "work-order-cancel-001",
  "epoch": 7
}
```

- turn A 准备创建发布 Task；
- turn B 收到新 Human 消息并更新 WorkSpec。

B 先成功，把 epoch 推到 8。A 提交时携带 `expectedEpoch: 7`，数据库发现当前已经是 8，于是拒绝旧写入。A 必须重新读取并重新判断。

```text
读取 Work 和 epoch
→ 进行可能耗时的 Leader判断
→ 提交时要求 currentEpoch == observedEpoch
→ 成功后原子 +1
```

epoch 只是乐观并发 token。它不是 WorkSpec version、语义依据、幂等键或完成条件。

## requestId 解决命令响应丢失

林舟发送 `create-task`，数据库已经成功，但 Worker没收到返回，再次发送。

若只看 epoch，第二次请求会冲突；真正期望是返回第一次创建的 Task。

每条会修改协调状态的命令带 `requestId`。在认证 actor 与 command type 范围内，runtime 原子保存：

```text
requestId
→ normalized request
→ bounded saved response
```

处理逻辑：

```text
相同 requestId + 相同内容
→ 返回保存结果

相同 requestId + 不同内容
→ 冲突，拒绝

新 requestId
→ 检查 expectedEpoch，执行新修改
```

replay row 是有界基础设施状态，不进入 Work timeline。

## Operation identity 又解决另一层

外部写有不可变 `operationId`：

- 同一 top-level Adapter call 重放回到同一 Operation；
- Adapter可把 operationId 作为 backend idempotency key；
- started 后原 forward 不盲目重放；
- 新尝试必须创建新 Operation。

因此要分清：

```text
platformMessageId → 入口消息重放
requestId         → 协调命令重放
Work epoch        → 防止旧协调判断覆盖新事实
operationId       → 一项外部写入身份与 backend 幂等
```

不要把它们合并成一张万能业务账本。

## 一个 Task 同时只能有一个执行 owner

周明 Worker失联时，不能等 30 秒就假定旧进程已死。网络分区下，旧 Bash 和测试子进程可能仍在写工作区。

新执行者开始前，runtime 必须确认：

- 原 turn 和完整进程树已停止，或已被隔离；
- 原执行者不能再访问 writable root；
- writer lock/能力绑定已释放或转移；
- started Operation 已进入受控结果或恢复路径。

无法证明就保持等待恢复，不启动第二个 owner。

数据库“一 Task 最多一个 Result”不够，因为两个执行者在提交 Result 前就可能覆盖文件、消耗预算或创建不同 Operation。

## 同一成员并发多个 Task 与单活不冲突

MemberConfig 可以允许周明同时执行两个 Task：

```text
Task A → session A → execution owner A → writable root A
Task B → session B → execution owner B → writable root B
```

每个 Task 内仍是单活。两个 active writer 不能共享 root。并发额度还受 ControlProfile 和实际资源限制。

## Task cancellation 必须停止真实执行

只有 Leader能取消尚无 Result 的 Task。

正确顺序不是先写 cancelled 再慢慢杀进程，而是：

1. 停止并确认完整 active process tree；
2. 释放 writer lock 或 writable binding；
3. 把所有 pending、尚未 started 的 Operation 终结为 `operation-not-executed`；
4. 若有 started Operation仍 unresolved，拒绝隐藏性取消，先完成恢复；
5. 原子追加带有界理由的 `task-cancelled` timeline fact。

取消不生成虚假的 Result，也不只杀父 shell。

## Result submission 与 cancellation 怎样竞争

周明正在 `submitResult`，林舟同时 `cancel-task`。

数据库让两者直接竞争：

```text
Result 先提交
→ Task 已有 Result
→ cancellation 失败

cancellation 先提交
→ Task 已有 cancellation fact
→ ResultGuard 拒绝 Result
```

不会出现一个 Task 同时既有 Result 又被取消。

这也是为什么 Result 和 cancellation 不需要共同写一个 Task status。唯一约束与事务事实已经给出答案。

## 哪些写入必须原子

至少包括：

- 新 Work 与第一条 Human timeline 记录；
- WorkSpec 完整事件、当前投影和 epoch；
- Task、`task-created` fact 和 epoch；
- Result submission 与 cancellation 竞争；
- Work terminal fact、投影和 epoch；
- `operation-execution-started` 早于外部调用；
- requestId 与对应修改结果。

原子表示调用方永远不会看见一半事实。跨系统消息投递若需重试，也只能重复投递已经提交的事实，不能生成第二条 Work 历史。

## session 为什么不是业务事实源

Leader 每个 Work 使用独立逻辑 session；成员每个 Task 使用独立逻辑 session。每个 session 同时只处理一个 turn。

session 方便保留近期对话，但可能：

- 在等待 Human 时释放；
- 因长期无活动被清理；
- 因 provider 故障重建；
- 因上下文过长被摘要。

恢复 Task 时，系统从持久事实重新组装：

- 不可变 TaskSpec；
- runtime binding；
- Leader定向背景和为 Task 选择的消息；
- Result、ToolResult 与 Operation facts；
- 必要的 Work 摘要；
- 仍保留的 session 历史。

会话记忆不能覆盖这些来源。

## 等待 Human 为什么不占着模型和 Bash

需求澄清或 Approval 可能等数小时。期间继续模型循环只会消耗预算，也可能产生无意义动作。

runtime 可以：

- 持久化当前等待事实；
- 停止不必要计算；
- 释放 session、runner 或并发名额；
- 发送有界提醒；
- Human 回复后从持久事实重建。

“正在等待”是 UI 投影，不是 Result，也不是 Task status。

## 预算耗尽时为什么不生成失败 Result

ControlProfile 与 MemberConfig 可以限制：

- token；
- 成本；
- 时间；
- 模型调用次数；
- 本地进程资源；
- 并发。

耗尽时，runtime：

- 停止新的模型调用和本地执行进程；
- 记录有界运行事实；
- 通知 Leader；
- 不伪造 Result；
- 不抹掉已经 started 的 Operation。

Leader可以取消、缩小、重派或等待授权管理员调整配置。普通聊天不能增加预算。

## 模型 fallback 必须显式

模型不可用时，Tiangong 不静默换 provider 或模型。ControlProfile/MemberConfig 必须明确允许 fallback，运行记录要说明：

- 原模型；
- 有界失败原因；
- 替代模型；
- token/cost/time。

换模型不会改变 Agent身份、TaskSpec、数据范围或工具能力。

继续阅读：[第 13 单元](13-work-closure.zh.md)。

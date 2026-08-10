# 单元 13：两个执行者、重试和恢复怎样不互相覆盖

[上一单元：系统怎样区分“Agent 说过”和“机器看到过”](12-records-and-evidence.zh.md) | [返回课程目录](README.md) | [下一单元：把整个案例从头走到尾](14-complete-walkthrough.zh.md)

## “重复发生”其实有三种不同问题

分布式系统里经常听到“要防重复”。但下面三个故障不能靠同一种机制解决：

1. 两个 Leader turn，也就是两轮几乎同时发生的模型处理，都基于旧目标作出协调写入；
2. 同一条命令已经成功，但响应丢失，调用方再次发送；
3. 旧 Worker 似乎失联，新 Worker 启动后，旧进程又恢复并继续写工作区。

本单元逐个处理，不先抛出通用锁、租约或复杂调度框架。

## 问题一：两个判断都基于同一个旧状态

假设 Work 当前是：

```json
{
  "workId": "work-order-cancel-001",
  "epoch": 7,
  "workSpec": {
    "goal": "交付取消订单能力"
  }
}
```

两个 Leader turn 几乎同时读取它：

- turn A 根据 epoch 7 准备创建部署 Task；
- turn B 根据陈晨的新消息更新 WorkSpec，并把 epoch 推进到 8。

如果 turn A 不检查自己读到的版本，它可能在目标已经变化后继续提交旧计划。

## 用一个递增号码防止旧判断覆盖新状态

每个协调性写入都携带自己读取时的 `expectedEpoch`。

```text
turn A 说：只在当前仍是 epoch 7 时创建 Task
turn B 先成功：epoch 7 → 8
turn A 再提交：发现当前是 8，拒绝旧写入
```

Work 的这个递增并发号码叫 **epoch**。

它不是 WorkSpec 版本身份，也不是完成依据。它只回答：提交者作判断时看到的 Work 状态现在是否仍然是当前状态。

## 第一段小伪代码：epoch 检查

先看只有四行的形状：

```text
读取 Work，得到 epoch
根据读取内容作出判断
提交时要求 currentEpoch == observedEpoch
成功后 currentEpoch += 1
```

逐行理解：

- 第一行取得当前事实和并发号码；
- 第二行可能包含一次耗时的模型判断；
- 第三行防止耗时期间其他协调写入已经改变 Work；
- 第四行让后来的旧判断失效。

如果检查失败，不是把旧输出硬塞进去，而是重新读取当前事实并重新判断。

## 问题二：命令成功了，但调用方没收到回答

林舟发送 `create-task`。数据库已经创建 Task 并把 Work epoch 从 8 推进到 9，但 Worker 在收到响应前断开。

如果它再次发送同样命令，单靠 epoch 会得到冲突，因为当前已经是 9。可真正需要的答案不是“失败”，而是“你上次已经创建了哪个 Task”。

这说明 epoch 解决并发新旧，不能解决同一命令的网络重放。

## 给每次修改命令一个稳定请求身份

每个会修改状态的协调命令带 `requestId`。

第一次处理时，系统在同一事务中保存：

```text
认证边界 + 命令类型 + requestId
→ 请求内容 digest
→ 已保存的响应或输出引用
```

随后：

- 同一 requestId 和同一 digest 重放，返回原结果；
- 同一 requestId 却带不同内容，报冲突；
- 新 requestId 表示新的修改请求。

这张很小的重放记录是基础设施状态，不是新的业务对象，也不会加入 Work 完成关系。

## 第二段小伪代码：命令重放

```text
查找 requestId

如果已经存在且请求 digest 相同：
    返回保存的结果
如果已经存在但 digest 不同：
    返回冲突
否则：
    检查 expectedEpoch
    执行修改并保存结果
```

先查重放身份，再处理新的状态修改。这样“响应丢失后的同一命令”与“基于旧 epoch 的另一条新命令”不会混在一起。

读到这里应能区分：

```text
requestId 解决：这是不是同一次命令重试？
epoch     解决：新的命令是否基于仍然当前的 Work 状态？
```

## 问题三：旧执行者可能仍然活着

周明的 Worker 失去心跳。系统准备在另一个 Worker 上恢复 Task。

最危险的做法是等 30 秒，然后假定旧进程已经死了。网络分区时，旧进程可能还在运行，只是无法汇报；新进程启动后，两者会同时写同一个工作区或调用工具。

时间过去并不能证明访问权已经消失。

## 当前设计采用更保守的单活规则

每个 Task 最多只有一个活跃执行上下文。

新执行者启动前，AgentTeams 或运行时必须正面证明：

- 原 Worker 和负责实际运行命令或工具的子进程（runner）已终止，或者已被隔离；
- 原执行者不再能访问当前 Task 工作区；
- 工作区已安全交给替代执行者。

如果无法证明，就让 Task 保持 recovery-blocked，不启动第二个执行者。

设计层只规定这项不变量。具体实现可以使用容器终止确认、工作区访问控制或受控执行令牌，不需要在业务模型中建立一套通用分布式资源租约系统。

## 为什么唯一 Result 约束仍然不够

数据库限制一个 Task 最多一个 Result，可以阻止两个执行者同时提交两份终态交接。

但在到达 Result 之前，它们可能已经：

- 互相覆盖工作区文件；
- 消耗两倍模型预算；
- 创建两项不同 Operation；
- 产生难以解释的工具记录。

所以唯一 Result 是最后一道数据库不变量，不是替代单活执行的办法。

## Result 提交与 Task 取消同时发生

另一个短竞态是：周明正在提交 Result，林舟同时取消尚无 Result 的 Task。

系统让两个动作在数据库事务边界竞争：

- Result 先提交成功，取消看到已有 Result 后失败；
- 取消先提交成功，ResultGuard 看到取消 Decision 后拒绝创建 Result。

不会出现 Task 同时有 Result 和 cancel-task Decision。

如果有 pending Approval，取消 Task 还要在同一事务中终止 pending Operation，保证迟到批准无法复活它。

## 哪些写入必须一起成功

当前设计至少要求下面这些原子边界：

- 新 Work 与第一条 Human 消息；
- WorkSpec 完整快照事件、当前投影和 epoch 增量；
- applicable Human confirmation 事件和 epoch 增量；
- Task、TaskSpec、负责人和 create-task Decision；
- 一个 Task 的第一份也是唯一一份 Result；
- Result disposition、动作前置检查和 Work epoch 增量；
- Task 取消和 pending Operation 终止；
- 外部调用前必须持久化的 Operation 状态；
- Work 终结 Decision。

“原子”表示调用者不会看到其中一半已经生效、另一半缺失。

有时数据库事实提交成功后，还必须可靠地通知另一个系统，例如把已提交消息送到 channel。直接“先写数据库，再立即发送”会在两步之间留下崩溃窗口。此时实现可以在同一事务中写一条待投递记录，再由后台重复投递直到成功。这种只用于跨系统可靠交付的小机制叫 **outbox**。它不是另一套业务历史，也不需要套在所有内部写入上。

## 会话丢失为什么不等于业务事实丢失

每个 Task 有独立逻辑 Agent session，Leader 对每个 Work 也有独立 session。

会话可以保存方便继续对话的临时历史，但它不是业务事实源。长时间无活动后，会话可以被清理。

恢复时系统从下面这些内容重建：

- Work 当前投影和时间线；
- 不可变 TaskSpec 与执行上下文；
- Task 工作区；
- 可用的保留 session；
- Execution Records；
- 已提交 Result 和 Decision；
- pending Operation 的精确身份。

Task 恢复先看 TaskSpec。当前 WorkSpec 作为明确标注的最新背景加入，不能被误读成原委托修改。

## 等待 Approval 为什么不占着模型和 runner

Task 进入 waiting_approval 时，真正需要等待的是 Human 的外部决定，不需要模型一直空转。

所以系统释放活跃模型调用和 runner 的执行名额。恢复时重新加载同一个 TaskSpec 和 pending Operation，再从已认证 Approval 结果继续。

这既节省资源，也避免把长时间 Human 等待伪装成一个永不结束的模型调用。

## 模型不可用和预算耗尽为什么不是 Result

如果模型服务暂时不可用，Task 可以暂停或排队。运行时不会编造 `blocked` 或 `failed` Result，因为被委托者还没有提交终态交接。

运行时也不能在没有配置的情况下静默换成另一个模型。企业可以在 MemberConfig 和 ControlProfile 中设置允许的有序后备模型列表，也就是 **fallback**；真正发生替换时，Trace 会记录原模型、有界失败原因、替代模型以及 token 和成本。模型变化不会改变成员权限、Task 身份或工具边界。

如果 token、成本、调用次数或执行时间达到 ControlProfile 上限，系统停止新的模型调用并通知 Leader。Leader 或授权管理员可以：

- 调整预算；
- 取消 Task；
- 选择别的方法；
- 创建新 Task。

容量和预算是运行状态，不是 Machine Evidence，也不应被模型描述成业务失败事实。

## 无法安全恢复时怎么办

如果旧执行者无法确认隔离，Task 保持 recovery-blocked。

如果最终能够确认执行已停止，但原工作区或上下文无法安全恢复，Leader 可以在所有 Operation 已处理后取消没有 Result 的旧 Task，再创建新 Task。

框架不会为了让状态图好看而自动制造一份 failed Result。Result 必须是合法提交的终态交接。

外部 Operation 的恢复更严格：

- 没有 `execution_started`，可知后端调用尚未开始；
- 有 start 无终态，进入 uncertain；
- uncertain 必须 reconciliation，原正向阶段永不再执行；
- 确认无效果后只能创建新 Operation；
- 终态 Operation 重放只返回保存结果。

## 本单元自检

1. epoch 与 requestId 分别解决什么问题？
2. 为什么只等待超时不能证明旧 runner 已停止？
3. 一个 Task 最多一份 Result，为什么仍需单活执行上下文？
4. Result 提交和取消并发时怎样保持唯一结果？
5. session 丢失后，哪些记录用于重建？
6. 模型不可用或预算耗尽时，为什么不自动生成 blocked Result？

下一单元会把整件取消订单 Work 从第一条消息走到关闭，并给出以后排查“它在哪、谁决定、什么证明”的完整查询路线。

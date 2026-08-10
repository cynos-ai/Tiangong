# 单元 11：超时、未知结果与恢复

[上一单元：Human 批准的必须是精确动作](10-exact-approval.zh.md) | [返回课程目录](README.md) | [下一单元：并发、取消、会话与预算](12-concurrency-cancellation-and-resume.zh.md)

## 最危险的不是失败，而是不知道发生了什么

陈晨已经批准 `op-deploy-production-124`。执行前当前配置、target 前提和 Approval 都再次通过。Tiangong 调用部署后端，然后连接超时。

同一个 timeout 可能对应：

1. 请求没有到达后端；
2. 后端已经部署成功，但响应丢失；
3. 后端只完成一部分；
4. 后端返回前已经自动恢复；
5. 外部状态被另一个操作者同时改变。

如果直接重试，可能重复部署、重复迁移或覆盖新状态。如果直接报失败，又可能掩盖已经生效的生产变化。

核心原则是：

> 外部状态不清楚时，不猜、不盲目重放、不靠 Human 或模型声明把未知变成已知。

## 为什么必须先记录 started，再调用后端

错误顺序是：

```text
调用外部后端
→ 成功后才写“执行过”
```

如果进程在两步之间崩溃，CoordinationStore 看起来什么都没发生，外部系统却可能已经改变。恢复程序可能再次执行。

安全顺序是：

```text
检查当前 Gate
→ 持久化 operation-execution-started
→ 调用 Adapter 后端
→ 观察并记录结果
```

这会刻意偏保守：即使写完 started 后、真正发请求前崩溃，恢复时也不能假定没调用。系统需要只读核查。

宁可多一次对账，也不要重复一次可能不可逆的写入。

## Operation 的三个已知终态

只有三类 event 表示机器已经获得安全已知结论。

### `operation-not-executed`

外部执行没有被进入。例如：

- policy 拒绝；
- Human 拒绝；
- Approval 过期；
- Task 在 start 前取消；
- 前置条件在 start 前不满足。

它绝不能出现在 `operation-execution-started` 之后。

### `operation-succeeded`

Adapter 代码确认 typed request 声明的后置状态已经达到。

部署例子不是“HTTP 200”，而是：

```text
读取 production-a 当前状态
→ 确认实际运行 service-a@def456
→ 其他声明后置条件也满足
→ append operation-succeeded
```

### `operation-safe-failure`

请求没有成功，但 Adapter 代码确认当前没有未解决的持久效果。

它不一定表示“从未发生任何瞬时变化”。例如 request 和 preview 已明确描述立即健康检查与恢复 `release-41`，Adapter 在同一次 invocation 中执行并确认恢复后，可以记录 safe failure。

关键是当前没有遗留恢复责任，而不是错误信息听起来可控。

## 两个未解决结果

### `operation-uncertain`

系统无法确认外部状态。例如 timeout 后既不能证明目标版本已运行，也不能证明请求未应用。

### `operation-recovery-needed`

系统已经知道存在错误或部分效果，但尚未修复。例如生产有一半实例运行新版本、一半仍是旧版本。

它比 uncertain 知道得更多，但同样不是安全终态。

Operation 当前状态只是 append-only events 的投影，不是可手工编辑的 status 字段。

## 一张结果判断表

| 当前机器观察 | 应写 event |
|---|---|
| 外部执行没有开始 | `operation-not-executed` |
| Adapter 确认请求后置状态 | `operation-succeeded` |
| Adapter 确认无未解决持久效果 | `operation-safe-failure` |
| 当前状态无法确定 | `operation-uncertain` |
| 已知错误/部分效果仍存在 | `operation-recovery-needed` |

模型说“应该没问题”、Human 说“风险我接受”、HTTP 状态码或乐观 backend acknowledgement 都不足以写 known terminal event。

## 最小执行伪代码

```text
读取不可变 Operation
重新检查当前 policy、identity、binding、target 和 Approval

原子追加 operation-execution-started
调用 versioned Adapter

如果 Adapter 确认 declared postcondition：
    追加 operation-succeeded
否则如果 Adapter 确认没有 unresolved lasting effect：
    追加 operation-safe-failure
否则如果 Adapter 确认存在 residual effect：
    追加 operation-recovery-needed
否则：
    追加 operation-uncertain
```

伪代码中没有“遇到 timeout 自动重试”。这是有意缺失。

## unresolved 时系统必须限制什么

对 `production-a` 的 Operation unresolved 时：

- 阻止同一 Adapter/target 的冲突写；
- 阻止取消受影响 Task来隐藏责任；
- 阻止 `complete-work`；
- 阻止 `stop-work`；
- 不允许报告已知 success 或 safe failure；
- 允许无关的安全只读工作继续。

为什么连 `stop-work` 也阻止？因为停止业务目标不能让可能存在的生产效果消失。恢复责任仍属于原 Work。

## reconciliation 是特权只读对账

Tiangong 使用 Adapter 的特权只读接口核查：

- production-a 当前运行哪个 commit；
- 后端是否保存了 `operationId` 对应请求；
- 是否存在部分应用；
- 原 expected state 是否仍成立；
- 是否已由后端完成内部补偿。

这种把本地 Operation facts 与外部真实状态重新比对的过程叫 **reconciliation**。

它有三个重要限制：

1. 只读，所以本身不是 Operation；
2. 不作为普通模型工具暴露，避免 Agent拿到恢复凭据；
3. 由恢复控制器或认证 Operator 触发，Leader只能请求。

对账观察会有受控记录，但只有确认后置状态、确认未应用或确认已恢复时，才可追加 known terminal event。

## 对账后的几条路径

### 确认目标效果已经应用

生产确实运行 `def456`，Adapter确认所有声明后置条件，原 Operation 追加 `operation-succeeded`。

### 确认没有应用且没有遗留效果

原 Operation 追加 `operation-safe-failure`。

如果团队仍要部署，必须创建**新 Operation**，重新经过当前 policy 与 Approval。不能重放原 forward invocation。

### 确认存在部分或错误效果

追加 `operation-recovery-needed`。Operator或团队需要提出受控恢复动作。

### 仍无法确认

保持 `operation-uncertain`。时间和重复提醒不会把它自动转成终态。

## 为什么确认“没应用”后仍不能重试旧 Operation

原 Operation 已经经历过 started 和不确定恢复。再次执行同一个 ID 会模糊：

- 第一次与第二次调用的责任；
- Human当时批准的时点；
- 当前 policy 是否变化；
- target expected state 是否仍相同；
- 后端幂等记录是否仍有效。

因此“重试”是新的业务意图：

```text
新 operationId
+ 当前 typed request
+ 当前 preview
+ 当前 policy
+ 必要的新 Approval
```

同一个 Operation 的网络重放只允许读取已经保存的安全结果，不再产生 forward effect。

## 自动对账失败后怎样升级

Repeated reconciliation 仍无法确认时，系统升级到认证 Operator，例如高远。

Operator 可以：

- 做更深入的只读调查；
- 创建或发起一项完整受控的 recovery Operation；
- 转交企业 incident response。

“已转事故”不是安全终态。工单有人接手也不等于生产状态已确认。原 Work 仍不能关闭，直到实际观察或修复建立 known terminal event。

## rollback 为什么通常是新 Operation

已经终态的部署如果后来需要回滚，回滚本身会改变生产：

```text
rollback target
current expected state
commit/version to restore
health criteria
```

所以它是新 Operation，拥有新 ID，重新经过当前 policy 和 Approval。

目标设计不建立通用 rollback phase、rollback plan identity 或第二套 phase 幂等协议。

## 唯一例外：原 invocation 内的立即补偿

Adapter 可以在原调用内部完成立即补偿，但必须满足：

- 原 immutable request 已完整写明条件和精确恢复目标；
- preview 已向 approver 展示；
- 补偿只在原 Adapter invocation 内发生；
- forward 与 compensation 观察都进入原 Operation events；
- 以后不能把它当成可单独调用的 rollback。

例如：

```text
部署 def456
若 2 分钟内健康检查失败
立即恢复明确的 release-41
并确认 production-a 全部实例回到 release-41
```

若补偿本身无法确认，则 Operation 仍是 uncertain 或 recovery-needed，不能写 safe failure。

## Operation 记录与 events 为什么永久保留

ToolResult 可以按 retention 规则采样，但不可变 Operation 和外部写入 events 必须永久留在 CoordinationStore：

- proposed Operation record；
- Approval/rejection；
- execution start；
- success/safe failure；
- uncertain/recovery-needed；
- reconciliation 和恢复结论。

它们直接决定能否冲突写、取消 Task 和关闭 Work，不应因为日志轮转而消失。

继续阅读：[第 12 单元](12-concurrency-cancellation-and-resume.zh.md)。

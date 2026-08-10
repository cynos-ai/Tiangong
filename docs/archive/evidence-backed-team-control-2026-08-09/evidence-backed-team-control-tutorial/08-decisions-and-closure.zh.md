# 单元 08：谁决定接不接受，又怎样结束整件事

[上一单元：为什么必须让另一个成员检查同一份代码](07-independent-verification.zh.md) | [返回课程目录](README.md) | [下一单元：本地修改与真正改变外部系统](09-external-operation.zh.md)

## 机器检查通过后，还缺一个人能理解的判断

现在有两份 Result：

- 乔安完成独立验证，verdict 是 `pass`；
- 周明交付 commit `9ab73e...`，机器确认它与验证对象一致。

机器可以确认引用、身份、提交和测试记录，但它仍然不能独立回答：

- 这个接口设计对陈晨来说是否真的有用？
- 已知性能缺口是否在本次范围内可接受？
- 周明是否误解了“客服内部备注不能返回给用户”？
- 团队是否应该继续优化，还是已经足够进入下一步？

这些是业务语义判断，由 Leader 林舟作出。

## 为什么不直接在 Result 上改一个字段

最容易想到的是：

```json
{
  "resultId": "result-implement-cancel-01",
  "accepted": true
}
```

但 Result 是周明的终态交接。让林舟再去修改它，会把两个人作出的两种事实混在一起：

- 周明声明自己交付了什么；
- 林舟判断是否接受这份交接。

如果以后要追问“周明最初提交了什么”，系统不应先从被别人修改过的 Result 中猜。

因此 Result 保持不变，Leader 另外写一条正式选择记录。

## 一张正式选择记录

Tiangong 把这种由 Leader 作出的正式协调选择叫 **CoordinationDecision**。后文简称 Decision。实例是：

```json
{
  "decisionId": "decision-accept-verify-01",
  "workId": "work-order-cancel-001",
  "action": "accept-result",
  "taskId": "task-verify-cancel-01",
  "resultId": "result-verify-cancel-01",
  "reason": "验证绑定正确提交，要求的测试已运行，已知缺口不阻止当前代码验收",
  "actorId": "leader-lin",
  "createdAt": "2026-08-10T14:15:00Z"
}
```

字段并不神秘：

- `action` 说明作出了哪一类选择；
- `taskId` 与 `resultId` 指明直接对象；
- `reason` 保留有界、可阅读的理由；
- `actorId` 和时间由受控边界记录。

林舟先接受乔安的通过验证 Result，随后才能接受周明的代码 Result。

## 接受 Result 到底表示什么

`accept-result` 表示：

> Leader 认为这是一份真实、清楚、对当前 Task 有用的终态交接。

它不表示“客观真理已经被证明”。也不强行把 outcome 改成 completed。

例如一个 Task 因外部依赖缺失提交 `blocked` Result。林舟可以接受它，因为阻塞说明真实且有用。接受后，它仍然是 blocked，不会变成成功。

## 拒绝又表示什么

`reject-result` 表示 Leader 认为交接不充分、误解了 Task 或与当前意图不一致。

一个 Result 最多有一个 disposition，也就是最终处置：

```text
要么 accept-result
要么 reject-result
不能两者都有
也不能后来改成相反选择
```

如果林舟错误接受了一个语义上不好的结果，历史记录不会被改写。纠正工作使用新 Task。终态事实保持原样，避免后来的系统把历史重写成从未犯错。

对于包含正式 Git commit 的 completed Result，机器还会在接受前要求：存在已接受、completed、verdict 为 pass 的独立验证 Result，并且 `producerResultId` 和 commit 都精确匹配。

## 目前有哪些 Decision

当前第一组动作很小：

| action | 用普通话解释 |
|---|---|
| `create-task` | Leader 正式派发一个 Task |
| `accept-result` | 接受一份终态交接 |
| `reject-result` | 拒绝一份不充分的终态交接 |
| `cancel-task` | 结束一个尚未产生 Result 的 Task |
| `complete-work` | 判断整件 Work 已语义完成 |
| `fail-work` | 以已知不成功结果结束 Work |
| `cancel-work` | 有意停止整件 Work |

这张表定义每个动作的含义，不规定所有 Work 必须走同一条流水线。Leader 可以根据工作需要安排 Task，不需要先通过固定阶段图。

## 接受所有 Task 仍不等于 Work 完成

周明的实现和乔安的验证都被接受，但陈晨的 WorkSpec 还要求生产上线前确认。

所以：

```text
accept-result
  回答：这一个 Task 的交接是否可接受？

complete-work
  回答：当前 WorkSpec 所描述的整件事是否已经完成？
```

Leader 负责判断 WorkSpec 的业务含义是否满足；代码负责检查不能靠 Leader 一句话绕过的机器条件。

## 哪些 Result 能支持 complete-work

只有同时满足下面两个词的 Result 才具有完成资格：

```text
accepted + completed
```

accepted blocked Result 仍然是有价值的真实记录，但不能拿来证明目标已完成。accepted failed Result 同理。

Tiangong 不要求 Leader 提交一份“我具体使用了哪些 Result”的机器依据清单。Leader 从当前 WorkSpec 和所有具有完成资格的 Result 作语义判断。

为了不让调用者挑选性绕过安全检查，关闭前的机器检查会扫描整个 Work 中全部具有完成资格的 Result 和全部外部操作。

## 先把关闭前的硬检查说成人话

在允许任何终结动作前，系统会确认：

- 没有仍在排队、运行或等待 Human 精确批准的 Task；
- 每份已提交 Result 都已经接受或拒绝；
- 其他未完成 Task 已明确取消；
- 每项外部操作已得到已知终态，或者在执行前终止；
- 没有结果仍无法确定的外部操作；
- 没有必须处理的待批准事项；
- 引用的记录和正式交付物仍可访问。

这组关闭前硬检查叫 **CloseGuard**。

它不判断“取消订单功能是否让用户满意”。它只返回具体机器缺口，例如“task-release-01 仍在等待批准”。

## complete-work 还要多检查什么

如果请求的是完成而不是失败或取消，还要检查：

- 每个 accepted completed 代码 Result 都有精确匹配、已接受且 pass 的独立验证；
- accepted Result 中的外部效果声明与受控外部操作的真实终态一致；
- ControlProfile 要求的其他测试或验证存在；
- 如果当前风险规则要求 Human 确认，确认仍适用于当前 WorkSpec。

然后由林舟作最后的语义判断：这些结果是否真的满足当前目标。

## 普通确认怎样保持“当前有效”

陈晨最初说“上线生产前让我确认”，这首先要求的是一次生产部署批准，不会自动变成关闭 Work 的确认。

为了展示两者为什么必须分开，本教材再假设当前 ControlProfile 还规定：高风险 Work 在关闭前，Human 必须确认当前目标对应的最终结果。于是所有代码和部署准备完成后，林舟展示当前结果，陈晨通过受认证的界面另作一次“可以结束 Work”的确认。

运行时向时间线追加：

```json
{
  "eventType": "human-confirmed",
  "workId": "work-order-cancel-001",
  "actorId": "human-chen",
  "scope": "current-work-spec",
  "createdAt": "2026-08-10T16:30:00Z"
}
```

这项确认只有在以下条件下适用：

- 陈晨身份经过平台认证；
- 当前 ControlProfile 允许她作这类确认；
- 事件写在最后一次 `work-spec-changed` 之后；
- 写入使用当时读到的 Work epoch；
- 后面没有新的 WorkSpec 变化；
- scope 与请求的终结动作或当前目标匹配。

如果陈晨确认后，林舟又把目标改为“还要支持批量取消”，旧确认自动不再适用。系统不需要建立 WorkSpec 版本对象，只要比较时间线顺序和当前 epoch。

## 关闭确认与外部执行批准不同

这一节的确认表示“我认可当前目标或关闭动作”。它不能授权任意工具。

后面还会出现另一种更强的决定：“我精确允许这一项外部操作”。它会绑定待执行动作的指纹、目标、参数、有效期和实际展示内容。第九、十单元会先解释问题，再给它们正式命名。

| 普通关闭确认 | 精确外部执行批准 |
|---|---|
| 绑定当前 WorkSpec 或终结动作 | 绑定一项精确待执行动作 |
| 作为 Work 时间线事实 | 作为外部执行的直接授权记录 |
| 不能扩展工具权限 | 通过执行前硬检查后，只允许对应外部效果 |
| 后续 WorkSpec 变化会失效 | 待执行内容变化后，旧批准不能复用 |

## Work 终结后还能继续追加吗

`complete-work`、`fail-work` 和 `cancel-work` 都是最终决定。

终结后，不会通过改写记录重新打开 Work。陈晨如果提出新的需求，系统创建新的 Work，并可以在普通时间线中说明两者关系。

这样历史查询始终能回答：当时为什么结束，结束时有哪些 Task、Result、验证和外部效果。

## 一条简化时间线

```text
Work 创建
→ WorkSpec 形成
→ 周明 Task 创建
→ 周明 Result submitted
→ 乔安验证 Task 创建
→ 乔安验证 Result submitted
→ accept 验证 Result
→ accept 周明 Result
→ 生产相关外部操作处理完毕
→ Human 当前确认有效
→ CloseGuard 通过
→ complete-work
```

顺序并不是通用工作流模板。例如非代码研究 Work 可能没有独立代码验证，低风险 Work 也可能不需要 Human 关闭确认。表中的每一步来自当前案例的实际要求。

## 本单元自检

1. 为什么接受动作不能直接修改 Result？
2. accepted blocked Result 为什么仍不能支持 complete-work？
3. `accept-result` 与 `complete-work` 各自回答什么问题？
4. CloseGuard 为什么扫描整个 Work，而不是让 Leader 选择一个机器依据清单？
5. WorkSpec 在 Human 确认后发生变化，为什么旧确认失效？
6. Work 终结后为什么通过新 Work 继续，而不是重新打开？

代码现在经过验证和接受。接下来要把它发布到共享仓库、测试环境或生产环境，这会进入与本地编辑完全不同的边界。

# 单元 07：为什么必须让另一个成员检查同一份代码

[上一单元：“我做完了”怎样变成可接手的交付](06-result-and-content.zh.md) | [返回课程目录](README.md) | [下一单元：谁决定接不接受，又怎样结束整件事](08-decisions-and-closure.zh.md)

## 周明已经测试过，为什么还不够

周明的 Result 引用了 commit `9ab73e...`，并附带单元测试通过的工具结果。

这已经比一句“我测过了”可靠得多，但生产者仍然可能有共同盲区：

- 测试只覆盖自己想到的路径；
- 工作区残留文件让测试偶然通过；
- 测试命令实际跑在另一个 commit 上；
- 生产者误读了需求；
- 代码和测试一起犯了同一种错误。

独立验证不是因为生产者一定不可信，而是用不同成员、独立环境和精确对象降低共同错误。

## 先说清“检查哪一份”

林舟不能只对乔安说：

> 帮忙测一下取消订单。

因为周明的分支可能继续变化，乔安也可能默认拉取最新提交。两个人最后谈论的代码就不一定相同。

验证委托必须明确指向：

```text
仓库：service-a
提交：9ab73e...
生产 Result：result-implement-cancel-01
```

其中 commit 确定字节内容，生产 Result 确定“这是哪一次正式交付中的内容”。

## 给乔安创建独立 Task

林舟创建新的 Task，负责人是乔安，目标是验证周明 Result 中的精确提交。

这个 Task 使用单独的干净工作区：

```text
周明工作区
  workspace-task-implement-cancel-01
  负责生产 commit 9ab73e...

乔安工作区
  workspace-task-verify-cancel-01
  从干净状态检出同一个 commit 9ab73e...
```

乔安不能复用周明的工作目录。否则未提交文件、缓存或本地服务状态可能让验证结果失去独立性。

## 乔安究竟做什么

乔安在受控工具边界内：

1. 检出仓库 `service-a` 的 `9ab73e...`；
2. 阅读取消状态与库存恢复逻辑；
3. 运行控制配置要求的测试；
4. 检查测试工具记录确实绑定该 commit；
5. 记录仍未覆盖的风险；
6. 提交自己的终态 Result。

注意，乔安不是给周明的 Result 增加一个可修改字段。她完成的是一个独立 Task，因此也提交独立 Result。

## 验证 Result 长什么样

```json
{
  "resultId": "result-verify-cancel-01",
  "taskId": "task-verify-cancel-01",
  "outcome": "completed",
  "summary": "已在独立工作区完成订单取消代码验证",
  "deliverableRefs": [],
  "toolResultRefs": [
    "tool-result-unit-test-33",
    "tool-result-integration-test-34"
  ],
  "machineEvidenceRefs": ["machine-evidence-verification-08"],
  "verification": {
    "producerResultId": "result-implement-cancel-01",
    "subjectRef": {
      "kind": "git-commit",
      "repositoryId": "service-a",
      "commitSha": "9ab73e..."
    },
    "verdict": "pass",
    "toolResultRefs": [
      "tool-result-unit-test-33",
      "tool-result-integration-test-34"
    ],
    "knownGaps": [
      "尚未在生产等规模数据量下进行性能验证"
    ]
  },
  "submittedBy": "member-qiao",
  "createdAt": "2026-08-10T14:00:00Z"
}
```

## 最容易混淆的两个字段

### `outcome: completed`

这表示乔安完成了“执行验证”这项 Task。

即使她发现代码有问题，她仍可能完整执行了验证 Task，所以 outcome 仍然是 `completed`。

### `verification.verdict`

这表示被检查的 commit 得到什么结论，可以是：

- `pass`：要求的检查通过；
- `fail`：验证发现明确不满足；
- `inconclusive`：完成了能做的检查，但无法形成通过或失败结论。

因此完全可能出现：

```json
{
  "outcome": "completed",
  "verification": {
    "verdict": "fail"
  }
}
```

意思是“验证工作顺利完成，并且发现被验证代码不通过”。这不是矛盾。

## `producerResultId` 为什么不能省

只引用 commit 仍可能有歧义。同一 commit 可能被多个 Result 引用，也可能有人对自己生产的 commit 假装作独立验证。

`producerResultId` 明确表示：

> 我正在验证 `result-implement-cancel-01` 交付的这一个 commit。

代码会检查：

- 该生产 Result 确实存在；
- subjectRef 出现在它的 `deliverableRefs` 中；
- 生产者和验证者不是同一成员；
- 工具结果属于乔安的验证 Task；
- 工具结果绑定同一个 commit；
- `pass` 没有被已验证的失败工具结果反驳；
- ControlProfile 要求的检查确实运行。

## 验证 Result 也需要 Leader 接受

乔安提交 Result 后，它先处于 submitted。

林舟检查这份交接是否清楚、工具记录是否足够、已知缺口是否诚实，然后接受验证 Result。

只有满足下面整条链，周明的代码 Result 才能被接受：

```text
乔安不是周明
→ 乔安使用独立工作区
→ 验证绑定周明 Result 中的同一个 commit
→ 要求的机器检查真实执行
→ 验证 Task outcome = completed
→ verification verdict = pass
→ 验证 Result 已被 Leader 接受
```

周明的生产 Result 在此期间可以保持 submitted。无需为了验证先假装接受它。

## 接受顺序完整走一遍

1. 周明提交生产 Result，状态投影为 submitted；
2. 林舟派发乔安的验证 Task；
3. 乔安提交验证 Result；
4. 林舟先接受通过的验证 Result；
5. 机器确认验证 Result 的 `producerResultId` 与 commit 精确匹配；
6. 林舟才可以接受周明的生产 Result。

这是一项针对正式 Git 代码交付的安全前置条件，不代表所有专业工作都必须经过同样流程。

## 如果验证失败怎么办

假设乔安发现重复取消会释放两次库存，提交：

```json
{
  "outcome": "completed",
  "verification": {
    "producerResultId": "result-implement-cancel-01",
    "subjectRef": {
      "kind": "git-commit",
      "repositoryId": "service-a",
      "commitSha": "9ab73e..."
    },
    "verdict": "fail",
    "knownGaps": ["重复请求会二次释放预占库存"]
  }
}
```

林舟可以接受这份验证 Result，因为它是真实且有用的验证交接；但不能据此接受周明的代码 Result。

周明原 Task 已经有终态 Result，不能修改或再交一份。林舟会拒绝该生产 Result，再创建新 Task 修复问题。新 Task 产生新 commit 和新 Result，随后重新独立验证。

## 为什么不能只验证分支名

`feature/order-cancel` 会移动。乔安验证后，分支可能又增加一个提交。如果部署只看分支名，就可能发布一份从未验证过的代码。

所以生产、验证和后续发布都绑定仓库与 commit SHA。

分支方便协作，commit 才是这里的精确内容身份。

## 多人代码合并后为什么要重新验证

假设另一个 Task 同时修改库存模块。林舟创建集成 Task，把两个提交合并成新 commit `c0ffee...`。

即使两个输入提交各自通过验证，合并结果也可能产生冲突或新行为。因此最终用于交付或部署的集成 commit 必须由另一名成员再次验证。

验证的是“实际准备使用的精确内容”，不是它的祖先曾经分别通过。

## 本单元自检

1. 为什么生产者自己的测试不能满足独立验证？
2. 为什么验证需要同时绑定 commit 和 `producerResultId`？
3. `outcome: completed`、`verdict: fail` 为什么可以同时出现？
4. 为什么先接受验证 Result，再接受生产 Result？
5. 两个已验证 commit 合并后，为什么集成 commit 仍需重新验证？

下一单元会解释 Leader 的“接受”到底表示什么，以及接受一个 Task 的 Result 为什么仍不等于整件 Work 已经完成。

# 证据型团队控制架构

> 状态：draft。本文记录已达成共识的目标合同。它不描述当前实现，也不授权任何交付声明。
>
> 范围：协调、信任与完成、外部效果与授权、组织与行为塑造、质量与环境，以及运行时闭合的完整目标控制合同。平台特定 adapter 和物理实现拓扑仍为实现工作。

## 1. 目的

Tiangong 协调一个 AI 团队，使其能够理解软件系统、规划工作、委派有界的 Task、产出并验证交付物、与人交互，并执行已批准的外部效果。

控制架构必须在不把模型文本当作机器事实的前提下，保持 Agent 和团队的自主性。因此它在关键边界施加约束，而不是规定每一个活动。

目标设计不是固定的软件交付流水线，也不是通用工作流 DSL。

## 2. 设计哲学

### 2.1 约束而非编排

无论 Agent 还是团队，都不被驱动着走一条预定义的活动序列。Agent 可以探索、编辑、测试、使用工具、修订方法。Leader 可以随着 Work 演进创建、并行、替换或停止 Task。

运行时在信任边界处介入：

1. 用指令、Skills、检索知识和 Concerns 塑造行为；
2. 在不安全或未授权动作发生前用 gate 拦截；
3. 在受信边界执行后捕获机器事实；
4. 在封存 Result 前检查最低机器可证明条件；
5. 在机器事实不足时要求 Leader 或 Human 做语义决策。

### 2.2 两个自主循环

Agent 循环：

```text
Task
  -> 指令 + Skills + RAG + Agent Concerns
  -> 自主工作
  -> Tool Gate + Evidence 捕获
  -> Result candidate
  -> Completion Check
  -> 封存 Result 或继续工作
```

团队循环：

```text
Work
  -> Leader 理解与规划
  -> Task 委派
  -> Result 提交
  -> Leader 接受、替换或后续跟进
  -> 需要时与人交互
  -> Work 完成决策或继续工作
```

框架拥有确定性安全、身份、持久化、恢复和证明。Leader 拥有语义解释、规划、委派和沟通。

### 2.3 Task 永不等待 Human

专业 Agent 不会为了等待 Human 输入或授权而挂起 Task。每个已派发 Task 恰好以一个正式 Result 终结。未派发 Task 可以由 CoordinationDecision 直接终局取消：

- `completed` —— 产出者声称 Task 目标已完成；
- `blocked` —— 需要外部决策、授权或依赖；
- `failed` —— 执行或受信机器边界失败。

Leader 负责与人交互，并在答案或授权被记录后创建新 Task。精确的高风险授权使用两个 Task：

```text
Prepare Task -> Human 授权 -> Execute Task
```

### 2.4 单一事实来源

同一事实不被复制进多个记录。例如：

- Result 不保存产出者或创建时间；受信 Evidence 记录认证提交者和账本时间。
- Work 不保存可变状态；它从不可变记录投影。
- Task 不包含 Result 引用；Result 指向 Task。
- 替换和接受是 CoordinationDecision，不是可变标志。

### 2.5 声明不等于证据（Claim ≠ Evidence）

以下都是不同的事实：模型或 Human 的声明、Artifact payload、机器状态、机器捕获的 Evidence、语义接受、授权。

Result 是一个声明和一次交接。Evidence 能证明动作和观测，但不能让 Result 在语义上变得正确。Completion Check 是必要条件；Leader 或 Human 的接受是充分的语义条件。

### 2.6 语义、合法性与策略分离

对于一个权威的协调动作：

```text
action  -> 这条记录意味着什么
Guard   -> 现在是否合法
Leader  -> 为什么、何时选择它
```

因此 `CoordinationDecision.action` 是代码拥有的语义判别符。它不定义流程顺序。仅用于展示的 purpose 和 category 标签是非权威的。

### 2.7 不可变事实，派生视图

Work revision、Task、Result 和 CoordinationDecision 不可变。ready、running、stale、accepted、rejected、superseded 和 terminal 都是派生视图。旧事实永远不被重写以制造更干净的历史。

## 3. 概念分层

### 3.1 业务平面

用户和 Leader 主要围绕以下推理：

```text
Work -> Task -> Result
```

- Work：为一个 Human 目标的一次持续演进的团队委托。
- Task：对唯一责任 Agent 的一次不可变委派。
- Result：一个 Task 的不可变终局交接。

### 3.2 信任地基

四个概念构成信任链：

- Artifact：产出了什么；
- Evidence：受信机器边界观测到了什么；
- Operation：一个外部副作用；
- Approval：对一个精确或有界 Operation 的授权。

Artifact 和 Evidence 正交。Artifact 是产出载体；Evidence 证明观测和执行。Operation 只用于外部副作用，不代表每一次 read、write 或 test 工具调用。

### 3.3 轻量组织

Finding 是 `Result.findings` 中的一个结构化条目，不是独立的聚合对象。Leader 可以在后续 Task 中引用它，或把它提升为长期 issue 或 Artifact。

没有通用的 Change 对象。代码、配置、文档和测试改动都是 Artifact 类型。

### 3.4 支撑协调记录

CoordinationDecision 是必需的不可变后台记录。它表达接受、拒绝、Work revision 关联、Task 替换、Result carry-forward、取消、Work 终结和显式撤销。

一个 Evidence 事件证明是谁、何时记录了该 Decision；它不替代 Decision 的语义。

## 4. 通用记录纪律

所有协调记录：

- 使用 canonical JSON；
- 带有版本化的 `schema`；
- 封存后不可变；
- 对除 `contentDigest` 自身以外的每个字段计算 `contentDigest`；
- 拒绝未知字段；
- 不含通用 metadata 或 extension bag；
- 省略自报的 actor 和时间；
- 使用包含身份和 content digest 的精确引用；
- 拒绝裸 ID 和悬空引用。

记录的真实性和可信时间来自 Evidence ledger。

## 5. Work 合同

Work 有稳定的逻辑 `workId` 和一个或多个不可变物理 revision。

```json
{
  "schema": "tiangong.work/v1",
  "workId": "work-123",
  "revision": 1,
  "teamRef": {
    "teamId": "team-1",
    "contentDigest": "sha256"
  },
  "specRef": {
    "artifactId": "work-spec-1",
    "contentDigest": "sha256"
  },
  "policyRef": {
    "policyId": "resolved-work-policy/work-123-r1",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

| 字段 | 合同理由 |
| --- | --- |
| `schema` | 固定解释。 |
| `workId` | 把不可变 revision 连接到一个逻辑委托。 |
| `revision` | 支持单调 scope 版本化、并发检查和缺失 revision 检测。 |
| `teamRef` | 固定负责 Team 和 roster 权威。 |
| `specRef` | 固定目标、scope、验收标准和 Human 约束。 |
| `policyRef` | 固定已解析的预算、质量、报告和审批策略。 |
| `contentDigest` | 让 Task 和 Decision 绑定确切的 Work revision。 |

Work 排除可变状态、当前标志、内联 scope 副本、requester、时间戳、角色绑定、进度、任意 metadata，以及直接的 supersession 字段。revision 关系是 CoordinationDecision。

## 6. Task 合同

Task 是一次不可变委派，没有 revision。对 scope、assignee、输入、执行约束或完成合同的任何改变都创建新 Task。

```json
{
  "schema": "tiangong.task/v1",
  "taskId": "task-123",
  "workRef": {
    "workId": "work-123",
    "revision": 2,
    "contentDigest": "sha256"
  },
  "assigneeRef": {
    "workerId": "worker-7",
    "agentDefinitionDigest": "sha256"
  },
  "specRef": {
    "artifactId": "task-spec-123",
    "contentDigest": "sha256"
  },
  "inputRefs": [],
  "executionPolicyRef": {
    "policyId": "task-execution/default",
    "version": "1",
    "contentDigest": "sha256"
  },
  "completionPolicyRef": {
    "policyId": "task-completion/code-change",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

| 字段 | 合同理由 |
| --- | --- |
| `schema` | 固定解释。 |
| `taskId` | 提供稳定的团队路由和 Human 可读身份。 |
| `workRef` | 固定确切的 scope revision。 |
| `assigneeRef` | 确立唯一责任 Worker 和 Agent 定义。 |
| `specRef` | 固定 Task 目标、预期产出和语义约束。 |
| `inputRefs` | 固定不可变 baseline 和依赖集。 |
| `executionPolicyRef` | 固定工具、环境、预算和效果约束。 |
| `completionPolicyRef` | 固定最低机器可证明完成合同。 |
| `contentDigest` | 让 Result 绑定确切的委派。 |

Task 排除 TaskKind、可变状态或 phase、Task revision、supersession、重复的依赖字段、内联语义规格、Skill 选择、环境和预算副本、Result 引用、Operation 和 Approval 引用、actor 和时间、parent Task，以及 attempt 计数。

## 7. Result 合同

```json
{
  "schema": "tiangong.result/v1",
  "taskRef": {
    "taskId": "task-123",
    "contentDigest": "sha256"
  },
  "outcome": "completed",
  "claim": "Task 目标已完成。",
  "artifactRefs": [],
  "evidenceRefs": [],
  "findings": [],
  "contentDigest": "sha256"
}
```

| 字段 | 合同理由 |
| --- | --- |
| `schema` | 固定解释。 |
| `taskRef` | 把交接绑定到确切的 Task。 |
| `outcome` | 给出机器可读的终局语义：`completed`、`blocked` 或 `failed`。 |
| `claim` | 声明产出者声称完成了什么或阻止了什么。 |
| `artifactRefs` | 标识正式产出。 |
| `evidenceRefs` | 标识为支持 claim 而提供的机器事实。 |
| `findings` | 保留可单独寻址的发现，供 Leader 处置。 |
| `contentDigest` | 给 Result 不可变身份。 |

最小 Finding 包含一个 statement 和 Evidence 引用。Finding 通过 Result digest 和 JSON Pointer 寻址；它没有独立 ID 或可变状态。

Result 排除独立 ID、WorkRef、产出者、时间戳、assignee、输入副本、Skill 引用、验收策略、Checkpoint 结果、接受状态、Operation 和 Approval 引用、下一步动作、blocker 分类法、revision 索引、重复 summary，以及 extension metadata。

## 8. CoordinationDecision 合同

```json
{
  "schema": "tiangong.coordination-decision/v1",
  "action": "accept-result",
  "subjects": [
    {
      "role": "result",
      "ref": {
        "taskId": "task-123",
        "contentDigest": "sha256"
      }
    },
    {
      "role": "target-work",
      "ref": {
        "workId": "work-123",
        "revision": 2,
        "contentDigest": "sha256"
      }
    }
  ],
  "basisRefs": [],
  "claim": "该 Result 满足当前 Work revision。",
  "contentDigest": "sha256"
}
```

| 字段 | 合同理由 |
| --- | --- |
| `schema` | 固定解释。 |
| `action` | 告诉确定性 Projection 这条记录意味着什么。 |
| `subjects` | 命名确切的受影响记录及其方向角色。 |
| `basisRefs` | 固定用作决策依据的事实和 Artifact。 |
| `claim` | 记录语义理由，不假装它是 Evidence。 |
| `contentDigest` | 支持精确引用和显式撤销。 |

权威 action 词汇表：

| Action | 必需的 subject 角色 |
| --- | --- |
| `revise-work` | `source-work`、`target-work` |
| `accept-result` | `result`、`target-work` |
| `reject-result` | `result`、`target-work` |
| `supersede-task` | `source-task`、`target-task` |
| `carry-forward-result` | `source-result`、`source-work`、`target-work` |
| `cancel-task` | `task`、`target-work` |
| `complete-work` | `target-work` |
| `fail-work` | `target-work` |
| `cancel-work` | `target-work` |
| `revoke-decision` | `decision`、`target-work` |
| `revoke-approval` | `approval`、`target-work` |

新增 action 需要代码拥有的 subject schema、Guard、Projection 规则、truth table 和确定性测试。Skills、TeamPolicy 和模型不能发明 action。

CoordinationDecision 排除独立 ID、非权威 type、任意 payload、actor、时间戳、可变状态、reversed 标志、resulting state、metadata 和 extension 字段。

## 9. 协调不变量

### 9.1 记录

1. Work、Task、Result 和 CoordinationDecision 不可变。
2. 每个引用解析到一个已提交且 digest 匹配的记录。
3. actor 和时间来自 Evidence。
4. 运行时视图是派生的，永远不写回不可变记录。
5. 相同命令重放幂等；相同命令身份配不同输入是冲突。

### 9.2 Work

1. genesis revision 为 `1`。
2. 新 revision 是当前 revision 加一。
3. 只有当前有效 head 可以被修订。
4. 禁止 revision fork 和环。
5. 新 revision 不改变任何更早的记录。
6. 当前 head 从有效的 `revise-work` Decision 派生。

### 9.3 Task

1. 一个 Task 恰好一个 assignee。
2. Task 没有 revision。
3. 一个 Task 至多一个封存的 Result。
4. Task 永不等待 Human。
5. 输入必须在 Task 创建前已提交。
6. 新 Task 依赖只指向更早的不可变记录。
7. 新 Task 绑定当前 Work revision。
8. 未派发的旧 revision Task 不能被派发。
9. 运行中的旧 revision Task 可以完成，但其 Result 在新 Work revision 下不自动可用。
10. Task supersession 只指向当前 supersession leaf，不能 fork 或成环。

### 9.4 Result 与接受

1. 每个 outcome 在封存前通过其适用的 CompletionPolicy。
2. 失败的 Completion candidate 不是 Result。
3. `blocked` 和 `failed` 不能被接受为完成。
4. Checkpoint 通过是必要条件；Leader 或 Human 的语义接受是充分条件。
5. 接受和拒绝不能同时对一个 Result 生效。
6. 来自祖先 Work revision 的 Result 在当前 revision 接受前需要有效的 `carry-forward-result`。
7. Carry-forward 要求该 Result 在其源 Work 中已被接受。

### 9.5 Decision

1. `action` 是权威语义判别符。
2. subject 角色和基数匹配 action schema。
3. Decision 合法性由 Coordination Guard 决定。
4. Decision 是 append-only。
5. 撤销是新的 `revoke-decision`；原记录仍是历史事实。
6. revoke 不能针对另一个 revoke。
7. 协调撤销不能抹除外部副作用。
8. Decision 引用在已提交 ledger 中向后指，不能成环。

## 10. Scope 修订与 staleness

scope 变化创建新的 Work revision 和一个 `revise-work` Decision。

- 上一 revision 的未派发 Task 必须被替换。
- 运行中的 Task 可以完成以保持 Task 原子性。
- 其 Result 对确切 Task 仍是历史有效的。
- 没有 carry-forward 时，它在当前 revision 不可被接受。
- 已接受的 Result 仍是已接受的历史事实。
- 当前 Work 关闭只考虑当前接受的 Result 和显式 carry-forward 的祖先 Result。

因此 staleness 是一个关系，不是 Result 的可变状态：

```text
Result.Task.WorkRef != 当前 WorkRef
且没有到当前 WorkRef 的有效 carry-forward
```

一个 carry-forward Decision 显式绑定全部三个方向：源 Result、源 Work revision 和目标 Work revision。

## 11. 协调命令与 Guard

| 命令 | 确定性 Guard | 原子产出 |
| --- | --- | --- |
| `create_work` | 认证权威；新 workId；revision 1；有效 Team 和 Spec；ResolvedWorkPolicy 来源匹配 TeamPolicy 和 Kernel | Work + 记录 Evidence |
| `revise_work` | 源是当前 head；目标是相同 workId 且 revision +1；无 fork；无 executing 或 uncertain Operation；Team 和 ResolvedWorkPolicy provenance 一致；变更已授权 | 目标 Work + revise Decision + Evidence |
| `create_task` | 当前开放 Work；有效 Team 成员和 Agent 定义；有效输入；Task 策略派生自 ResolvedWorkPolicy 且不扩权 | Task + Evidence |
| `dispatch_task` | 未派发、未取消、未替换、未完成；当前 Work revision；依赖已接受；预算可用 | dispatch Evidence + TaskRun 启动 |
| `submit_result` | 认证 assignee 或受信框架；确切 TaskRef；无先前 Result；有效引用；适用 CompletionPolicy 通过 | Result + Completion/记录 Evidence |
| `accept_result` | completed Result；Checkpoint 有效；无冲突处置；当前 scope 或有效 carry-forward | accept Decision + Evidence |
| `reject_result` | Result 存在；无冲突处置；有界理由和依据 | reject Decision + Evidence |
| `supersede_task` | 源是未被替换、非运行且无有效接受的 leaf；替换是新的有效当前 revision Task；无环或分支 | 替换 Task + supersede Decision + Evidence |
| `carry_forward_result` | 源 Result 在源 Work 已接受；源是当前目标的祖先；Evidence 仍新鲜 | carry-forward Decision + Evidence |
| `cancel_task` | Task 未派发且无 Result 或先前取消/替换 | cancel Decision + Evidence |
| `complete_work` | 当前 head；关闭策略通过；必需 Result 已接受；必需 QualityAssessment 新鲜且 satisfied；无必需 Human 响应、运行中 Task、pending 效果或未决不确定性 | complete Decision + Evidence |
| `fail_work` | 当前 head；安全继续已耗尽；效果已解决或显式不确定；失败 Evidence 完整 | fail Decision + Evidence |
| `cancel_work` | 授权取消；Task 和效果安全终结；需要时 Human 决策 | cancel Decision + Evidence |
| `revoke_decision` | 目标 Decision 有效且可撤销；授权 actor；无未处理的不可逆依赖 | revoke Decision + Evidence |

已派发 Task 不被协调标志取消。如果执行必须停止，运行时终结 TaskRun、保留 Evidence、解决或标记外部效果为不确定，并封存一个 failed Result。

## 12. Completion 出口

```text
completed candidate
  -> Checkpoint 通过 -> 封存 Result
  -> Checkpoint 失败
       -> Task 内正常修复
       -> 真正缺外部条件时提交 blocked candidate
       -> 不可恢复时提交 failed candidate
       -> 执行预算耗尽时由框架产生 failed Result
```

completed、blocked 和 failed 有不同的最低策略。blocked 策略必须防止 Agent 用 `blocked` 绕过 completed 要求。它验证已有产出和 Evidence 被保留、无效果仍活跃，且 blocker 在机器事实允许的范围内有支撑。

## 13. 必需的 Evidence 语义

包1要求这些事件含义。包2提供通用 Evidence 信封，各归属包提供严格的事件特定 facts schema 和 Recorder 权威：

| 事件 | 必需绑定 |
| --- | --- |
| `work.recorded` | Work digest、认证 actor、命令身份 |
| `task.recorded` | Task digest、WorkRef、Leader actor |
| `task.dispatched` | TaskRef、assignee、TaskRunRef |
| `completion.checked` | TaskRef、candidate digest、policy digest、checker 结果 |
| `result.recorded` | Result digest、TaskRef、认证提交者 |
| `decision.recorded` | Decision digest、action、认证 actor |
| `coordination.command.denied` | 命令身份、subject digest、稳定 reason code |
| `task-run.budget-exhausted` | TaskRef、TaskRunRef、执行策略 |
| `task-run.terminated` | TaskRef、TaskRunRef、已知失败或不确定效果结果 |

记录 Evidence 不包含在被记录对象自身的引用中；那会形成 digest 循环。信任通过 Evidence ledger 对对象 digest 的反向绑定来验证。

## 14. 恢复与并发

恢复在投影状态前验证 schema、对象 digest、精确引用和 Evidence。它从不可变记录重建 Work head、Task 关系、Result、处置、carry-forward、撤销和终局 Decision。fork、环、缺失引用、冲突 Result 和无效 Evidence fail closed。模型 transcript 不是权威。

并发使用 compare-and-swap 和窄锁：

- Work revision 比较期望的当前 head digest；
- Result 提交按 Task 串行化；
- supersession 比较期望的源 leaf；
- 冲突处置按 Result 串行化；
- carry-forward 在提交时重新检查目标 head；
- Work 关闭在提交时重新检查所有关闭事实。

相同 digest 重放成功。相同身份配不同内容是冲突。禁止 last-write-wins。

多记录命令使用事务或 write-ahead intent 加 Evidence outbox 和 commit marker。未提交记录对 Projection 不可见。

并行 Task 共享不可变输入 digest。冲突产出被保留，由新的集成 Task 调和，而不是覆盖任一产出。

## 15. 协调 truth table

| 场景 | 决策 |
| --- | --- |
| 用有效 Team、Spec 和 Policy 引用创建 revision 1 | 允许 |
| 为同一 workId 创建第二个 revision 1 | 拒绝 |
| 把当前 head 修订到 revision +1 | 允许 |
| 修订非 head 的 Work revision | 拒绝 |
| 为当前 Work revision 创建 Task | 允许 |
| 为旧 Work revision 创建或派发 Task | 拒绝 |
| 派发已取消或已替换的 Task | 拒绝 |
| 允许已运行的旧 revision Task 完成 | 允许封存 Result；标记当前不可用 |
| 由确切 assignee 提交 Checkpoint 通过的 Result | 允许 |
| 由其他 Agent 提交 Result | 拒绝 |
| Completion candidate 失败 | 不封存；继续 Task |
| 真正缺外部信息且 blocked 策略通过 | 封存 blocked Result |
| 执行预算耗尽且无有效 candidate | 封存框架产生的 failed Result |
| 为一个 Task 重放相同 Result | 重放成功 |
| 为一个 Task 提交不同的第二个 Result | 冲突 |
| 接受 completed、当前 scope、Checkpoint 有效的 Result | 允许 |
| 接受 blocked、failed 或 Checkpoint 无效的 Result | 拒绝 |
| 无 carry-forward 接受祖先 Result | 拒绝 |
| 把已接受的祖先 Result carry-forward 到当前后代 | 允许 |
| carry-forward 未接受、反向或跨 Work 的 Result | 拒绝 |
| 用有效替换替换当前非运行 Task leaf | 允许 |
| 替换运行中的 Task | 拒绝；先终结它并封存 Result |
| 替换已接受、已替换的 Task 或创建分支/环 | 拒绝 |
| 取消未派发 Task | 允许 |
| 用设置标志取消运行中 Task | 拒绝；终结执行并产生 Result |
| 关闭策略通过且无活跃效果时完成 Work | 允许 |
| 有活跃 Task 或未决效果时完成 Work | 拒绝 |
| 撤销无安全依赖的合格接受 | 作为新 Decision 允许 |
| 修改原始接受 | 拒绝 |
| 撤销一个 revoke 或抹除不可逆效果 | 拒绝 |
| 并发 Work revision | 一个提交，一个 stale-head 冲突 |
| 一个 Task 的并发不同 Result | 一个提交，一个冲突 |
| 恢复发现 fork、环、digest 不匹配或缺失引用 | fail closed |

## 16. 包2：信任与完成

包2定义三个正交机制：

- Artifact 标识产出了什么不可变内容；
- Evidence 记录受信机器边界观测到了什么；
- Completion 检查这些事实是否满足一个 Task outcome 的最低机器可证明合同。

Artifact provenance 不证明语义正确。Evidence 不因被记录就证明任意 claim。Completion 是封存 Result 的必要条件；Leader 或 Human 接受仍是充分的语义条件。

## 17. Evidence 合同

Evidence 是由授权 Recorder 发出的不可变机器事件。它不是模型文本、原始日志、Artifact 内容或可变状态。

```json
{
  "schema": "tiangong.evidence/v1",
  "ledgerId": "work:work-123",
  "sequence": 42,
  "eventKey": "sha256",
  "eventType": "tool.execution.completed",
  "recorderRef": {
    "recorderId": "tiangong-worker-runtime",
    "implementationDigest": "sha256"
  },
  "actorRef": {
    "actorKind": "agent",
    "actorId": "worker-7"
  },
  "subjects": [
    {
      "role": "task",
      "ref": {
        "taskId": "task-123",
        "contentDigest": "sha256"
      }
    }
  ],
  "facts": {
    "toolName": "run_test_command",
    "invocationDigest": "sha256",
    "exitCode": 0,
    "outputDigest": "sha256"
  },
  "recordedAt": "2026-08-05T08:30:00.000Z",
  "previousHash": "sha256",
  "hash": "sha256"
}
```

| 字段 | 合同理由 |
| --- | --- |
| `schema` | 固定 Evidence 信封和哈希语义。 |
| `ledgerId` | 标识验证该事件的 hash chain。 |
| `sequence` | 确立权威顺序，暴露 gap 和 fork。 |
| `eventKey` | 使受信捕获幂等并检测冲突重放。 |
| `eventType` | 选择权威事实含义、facts schema 和允许的 Recorder。 |
| `recorderRef` | 标识观测该事实的受信机器边界。 |
| `actorRef` | 标识导致该动作的认证 actor 或系统。 |
| `subjects` | 把事实绑定到确切的已注册记录或 Artifact，包括 Work、Task、Result、TaskRun、Human 交互和 Operation。 |
| `facts` | 携带有界的、事件特定的机器观测。 |
| `recordedAt` | 为审计和显式时间 freshness 提供可信账本时间。 |
| `previousHash` | 把事件绑定到前一个链位置。 |
| `hash` | 保护事件内容，给 EvidenceRef 其完整性身份。 |

`eventType` 是权威语义判别符。每个类型有严格 facts schema、必需 subject 角色、Recorder allowlist、event-key 派生规则、敏感数据策略和大小上界。`facts` 不是自由 payload。

`actorRef` 回答谁导致了动作。`recorderRef` 回答哪个受信边界观测了它。Agent 可以影响工具输入，但不能选择其认证 actor、Recorder、sequence、时间、前驱或 hash。

Evidence 排除独立的 content digest 或 event ID、通用可变状态、severity、metadata 和 extension bag、自报 actor 或时间、原始 prompt、模型响应、凭据、原始 write payload、无界日志、Artifact payload、裸 Work 或 Task ID，以及自然语言成功声明。

### 17.1 EvidenceRef

```json
{
  "ledgerId": "work:work-123",
  "sequence": 42,
  "hash": "sha256"
}
```

该元组标识 ledger、确切顺序位置和不可变事件。不需要额外 event ID。

### 17.2 Evidence 事件纪律

Evidence 区分 proposal、Gate 决策、执行开始、执行完成、replay、失败、回滚开始、回滚完成和不确定结果。更早的事件永远不证明更晚的阶段。特别地，Agent 或工具循环的成功消息不证明 backend 效果。

需要后续检查的原始内容作为 Artifact payload 存储。敏感恢复 payload 存储在独立的受保护 store 中，按 digest 绑定。Evidence 只包含有界的规范化事实、digest、大小和稳定错误码。

## 18. Evidence Ledger 与 anchoring

每个 Work 有一个逻辑 Evidence Ledger。Agent 和工具执行保持并行；只有短的 append 事务被串行化。一个 Work 在其初始 Human 输入和 WorkSpec 被记录前预留其 ledger。

管理 Catalog、schema、权威、撤销和安全事实使用独立的命名空间 scope 管理 ledger，具有相同信封、anchoring、Recorder 和 fail-closed 规则。它们不把不相关的 Work 顺序合并成虚假的全局序列。Work ledger 记录对外部 Catalog 事实的确切采纳和使用，而活的安全撤销也在 dispatch、context、tool、Gate 和恢复边界检查。

第一个事件使用 ledger 特定的 genesis 值：

```text
genesisHash = SHA-256(canonicalJson({
  schema: "tiangong.evidence-ledger/v1",
  ledgerId
}))
```

每个事件 hash 为：

```text
hash = SHA-256(canonicalJson(eventWithoutHash))
```

Append 在原子 append 和 sync 前，验证当前 terminal、下一个 sequence、previous hash、event key、事件和 facts schema、Recorder 权威、subjects 和敏感数据规则。

hash chain 只相对可信 terminal hash 是防篡改的。因此包2要求签名 Evidence Anchor，保存在模型写权限之外。一个 Anchor 绑定连续 sequence 范围、上一个 Anchor、terminal 事件 hash、segment digest、Recorder 实现和签名。轮转保持 sequence 和 terminal-hash 连续性。Evidence 不被自动删除。

Anchor checkpoint 和物理 segment 轮转是分离的：

- 关键边界对活动 tail 同步签名一个小 terminal checkpoint；
- segment 轮转、导出和归档可以异步运行；
- Result 封存不必等待大文件轮转；
- Result 接受要求相关 completion 和 recording 事件被可信 Anchor 覆盖。

以下使用要求 anchored Evidence：正式 Completion 通过、Leader 或 Human 接受、高风险 Artifact 消费、Work 终结、Operation 审批或 reconciliation，以及正式 Evidence 导出。Agent Concern 只能把未 anchor 的活动 tail 当作 provisional 观测来读取。

可信活动时钟提供 `recordedAt`，但 sequence 仍是排序权威。Temporal checker 只用于确实会过期的事实。如果时钟健康未知，temporal checker 返回 `indeterminate`。

### 18.1 Evidence 不变量

1. 只有受信 Recorder append Evidence。
2. 事件权威按事件类型和 Recorder 检查。
3. 事件不可变且 append-only。
4. 读取和 append 验证链；篡改永远不被静默截断或修复。
5. 重复 event key 配相同 facts 重放；不同 facts 冲突。
6. Sequence gap、fork、无效 anchor、未知事件类型和 schema 不匹配 fail closed。
7. Sequence（非墙上时间）决定顺序。
8. Tool proposal、start、completion、replay、rollback 和 uncertainty 保持不同事实。
9. Evidence 永不存储凭据、无限制日志或原始受保护 payload。
10. 轮转和保留保持链连续性和验证材料。

## 19. Artifact 合同

Artifact 是一个不可变 Manifest，绑定语义类型、payload 身份、机器 provenance 和 handling 策略。

```json
{
  "schema": "tiangong.artifact/v1",
  "artifactId": "artifact-123",
  "artifactSchemaRef": {
    "schemaId": "tiangong.artifact-schema/test-report",
    "version": "1",
    "contentDigest": "sha256"
  },
  "payload": {
    "mediaType": "application/json",
    "byteLength": 1842,
    "digest": "sha256"
  },
  "provenanceEvidenceRefs": [
    {
      "ledgerId": "work:work-123",
      "sequence": 38,
      "hash": "sha256"
    }
  ],
  "handlingPolicyRef": {
    "policyId": "artifact-handling/internal",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

| 字段 | 合同理由 |
| --- | --- |
| `schema` | 固定 Manifest 解释和 digest 规则。 |
| `artifactId` | 提供稳定交付身份和外部映射。 |
| `artifactSchemaRef` | 选择语义解析和确定性验证。 |
| `payload` | 绑定媒体类型、字节长度和确切交付字节。 |
| `provenanceEvidenceRefs` | 证明 payload 的受信物化或捕获。 |
| `handlingPolicyRef` | 固定分类、访问、导出、保留和销毁规则。 |
| `contentDigest` | 给 Result 不可变 Manifest 身份。 |

Manifest digest 和 payload digest 不同。前者保护语义打包和 provenance；后者保护交付字节。不同 Artifact 可以合理引用相同 payload。

ArtifactRef 包含 `artifactId` 和 Manifest `contentDigest`。物理存储位置由 Artifact Store 作为以 payload digest 为键的可变机器状态维护；它不是 Artifact 身份的一部分。复合 Artifact 使用 canonical payload manifest 传递地绑定其成员。

Artifact 排除 actor 和时间、通用 Work 或 Task 字段、存储路径或 URL、内联 payload、可变状态、revision、重复 summary 或 claim、Evidence 正文、通用 lineage metadata、直接 Operation 和 Approval 字段，以及 extension bag。

### 19.1 Provenance 序列

```text
受信输入/工具/Runner 边界
  -> payload 写入内容 store
  -> 验证 digest 和字节长度
  -> artifact.materialized Evidence
  -> Artifact Manifest 引用更早的物化 Evidence
  -> artifact.recorded Evidence 引用 Manifest digest
```

`artifact.recorded` 不包含在 Artifact 自身的 provenance 中，因为那会创建 digest 循环。正式验证遵循反向 Evidence 绑定。

Artifact 有效性要求有效 Manifest 和 payload、可解析的 Artifact schema、来自授权 Recorder 的 anchored provenance、匹配的物化描述符、反向 recording Evidence，以及允许请求用途的 handling 策略。这证明来源和字节身份，不证明语义质量。

### 19.2 Artifact 不变量

1. Manifest 和 payload 不可变。
2. 一个 artifact ID 映射到一个 Manifest digest。
3. 相同 payload 可以在不同 Artifact 间去重。
4. Payload 在 Manifest 封存前完整写入、sync 并验证。
5. Provenance 只引用更早的 Evidence。
6. Payload 读取重新验证 digest 和字节长度。
7. 缺失或损坏 payload 使 Artifact 不可用；仅 Manifest 不能授权重新验证声明。
8. 缺失反向 recording Evidence 把 Manifest 排除出可信投影。
9. Handling 策略在读取、模型上下文、导出、保留和销毁边界执行。
10. 已接受 Result 引用建立 retention pin。Payload 删除使未来验证不可能，因此需要显式保留决策；它永远不是静默的。
11. 拒绝或 Work 取消不自动删除 Artifact。
12. AI 产出的内容可以是 Artifact，但仍是带 claim 的输出。

ArtifactSchema 和 HandlingPolicy 是被引用的、不可变的、内容寻址的包。ArtifactSchema 提供确定性 payload 验证，永远不运行任意模型或工具代码。HandlingPolicy 管理分类和生命周期，不改变 Artifact 身份或 provenance。

## 20. CompletionPolicy 合同

CompletionPolicy 是内容寻址的机器认证合同。它不是 Skill、Prompt、工作流或语义评审者。

```json
{
  "schema": "tiangong.completion-policy/v1",
  "policyId": "task-completion/code-change",
  "version": "1",
  "kernelRef": {
    "kernelId": "tiangong-completion-kernel",
    "version": "1",
    "contentDigest": "sha256"
  },
  "outcomeChecks": {
    "completed": [
      {
        "checkerRef": {
          "checkerId": "required-artifact-schema",
          "version": "1",
          "implementationDigest": "sha256"
        },
        "parameters": {
          "requiredSchemaRefs": []
        }
      }
    ],
    "blocked": [],
    "failed": []
  },
  "contentDigest": "sha256"
}
```

| 字段 | 合同理由 |
| --- | --- |
| `schema` | 固定策略解释。 |
| `policyId` | 提供稳定 registry 身份。 |
| `version` | 支持显式审查和升级。 |
| `kernelRef` | 防止 Kernel 变化静默改变既有 Task。 |
| `outcomeChecks` | 给 completed、blocked 和 failed 不同最低合同。 |
| `contentDigest` | 让 Task 绑定确切已解析策略。 |

每个 outcome 分支都是显式的，即使它除了 Kernel 不加检查。这防止 blocked 或 failed 成为逃逸口。

每个 Checker 引用绑定代码身份和版本。其参数符合 Checker 的严格参数 schema；它们不是任意 payload。已解析策略是扁平的，不含通用布尔表达式 DSL。

CompletionPolicy 排除工作流步骤、Prompt 或 Skill 文本、基于模型的 checker、任意脚本、warning、可变 enable 标志、actor 和时间、自由形式 metadata、Human 审批、语义质量分数，以及恢复工作流。建议性检查属于 Concern。

## 21. Checker 合同

Checker 是代码拥有的、确定性的、无副作用的函数，作用于 Task、Result candidate、Work 投影、Evidence、Artifact、TaskRun 和已验证参数的不可变快照。它不调用模型、执行工具、修改状态或读取未声明的可变全局状态。

它返回：

```text
verdict: pass | fail | indeterminate
reasonCode
subjectRefs
evidenceRefs
```

`indeterminate` fail closed。诊断文本是有界的、脱敏的，并从稳定 reason code 派生。Concern 和 Skill 解释恢复；Checker 不成为方法引擎。

组合是固定的：

```text
所有 Kernel Checker 通过
AND
所选 outcome 的所有 Checker 通过
```

Checker 不消费彼此输出。如果两个检查需要有序状态，它们组成一个经审查的 Checker。这防止求值顺序改变 verdict。

### 21.1 强制 Kernel Checker

版本化的 Completion Kernel 始终执行：

- candidate schema 和 digest 完整性；
- Task、TaskRun 和认证提交者绑定；
- 确切 Artifact 和 Evidence 引用完整性；
- Evidence 链、Anchor、事件权威和 facts-schema 验证；
- Evidence subject 和 digest 绑定到当前 Task 和产出；
- Artifact payload、schema、provenance、recording 和 handling 验证；
- Finding Evidence 子集验证；
- completed、blocked 和 failed outcome 一致性；
- 包3提供 Operation 事实后的 terminal-effect 安全。

一个 blocked Checker 可以验证机器事实，如缺失依赖、Gate 拒绝、保留产出和无活跃效果。它不能证明 Agent 已尝试所有合理方法的语义声明。Leader 判断 blocker 是否正当。

策略可选 Checker 包括必需 Artifact schema、必需 Evidence 事件、payload schema、命令退出结果、subject digest 绑定、环境绑定、temporal freshness、独立产出者、测试结果、测试覆盖、部署 receipt 和 Approval receipt。包3和包5提供相应领域事实；实现注册经审查的代码拥有 Checker 模块。

## 22. Completion 执行

框架规范化 Result candidate 并计算封存 Result 将获得的相同 digest。它解析确切的 Task、CompletionPolicy、Kernel、Checker 实现、Artifact 集合、Evidence 集合和不可变 frontier。

失败或 indeterminate 尝试记录有界的 `completion.checked` Evidence，包含 candidate digest、policy 和实现 digest、Checker reason code 和 Evidence frontier。它不创建 Result。Agent 继续、提交有效的 blocked 或 failed candidate，或达到执行预算并收到框架产生的 failed Result。

通过的尝试原子封存：

```text
Result
+ completion.checked(pass)
+ result.recorded
+ Evidence outbox
```

然后活动 ledger tail 被同步 Anchor-checkpoint。Segment 轮转不阻塞此路径。

一个 pass 事件绑定 candidate/Result digest、outcome、CompletionPolicy、Kernel、Checker 结果、Evidence frontier、verdict 和可选的 `validUntil`。Recording 和 completion 事件不包含在 Result.evidenceRefs 中，因为那会形成 digest 循环。

历史的 anchored pass Evidence 即使可执行 Checker 包后来不可用，仍是历史事实。需要当前计算的重新评估、carry-forward 或 pending 接受在确切实现无法加载时 fail closed。不可变 Checker 包和 registry manifest 应在适用审计和重新评估期限内保留，但包丢失不重写已记录的历史决策。

重复失败检查保留为 Evidence。它们可以被轮转、归档并总结成 Artifact 用于可观测性，但不被自动删除或语义塌缩。

## 23. Freshness

Freshness 是相对 subject、策略、环境和时间的谓词；它永远不是 Evidence 或 Artifact 上的可变标志。

- 结构 freshness 要求确切的 subject 和 payload digest。
- Scope freshness 比较 Task WorkRef 与当前 Work，使用包1 carry-forward 规则。
- 策略 freshness 在需要时绑定 CompletionPolicy、Kernel、Checker、Team 和环境策略 digest。
- Temporal freshness 只用于确实会过期的事实，使用可信 backend 完成时间或 ledger 时间。
- 因果 freshness 要求 Evidence 在且绑定到确切的物化 Artifact 或环境状态之后。

时钟健康不确定性使 temporal 检查 indeterminate。Sequence 仍是排序权威。

Leader 接受重新验证 anchored pass、策略适用性、`validUntil`、Artifact 可用性、scope 关系和更晚的 Operation 不确定性。封存的 Result 永不接收额外 Evidence。如果其固定 Evidence 不再适用，Leader 创建新的验证 Task 和 Result。

## 24. 捕获边界

Evidence 由受信 wrapper 和 adapter 自动发出，包括协调 port、工具 wrapper、Runner broker、Artifact Store、Approval 服务、部署 adapter，以及浏览器或外部服务 adapter。模型不接收通用 append-Evidence 工具。

小型安全事实进入 Evidence。需要后续检查的完整输出进入 Artifact Store。敏感重启材料保留在受保护 payload store 中，只按 digest 引用。无界低价值日志被总结和有界，而非复制进 Evidence。

## 25. 包2恢复与并发

恢复验证 Ledger genesis、Anchor、segment 范围、链 hash、活动 tail、event-key 唯一性、事件和 facts schema、Recorder 权威和 EvidenceRef 索引。Gap、fork、冲突 event key、无效 Anchor 和未知类型 fail closed。

Artifact 恢复验证 Manifest digest、schema 和 handling 引用、provenance、反向 recording Evidence 和 payload 位置索引。Payload 在访问时重新哈希。可用性是 Projection，不是 Manifest 字段。

Completion 恢复从 Evidence 重建所有尝试和通过证明。缺失策略或实现使所需的重新评估 indeterminate。它不抹除 anchored 历史事件。

多记录写入使用 write-ahead intent、不可变记录、Evidence outbox 和 commit marker。没有完整 commit 的记录不可见。恢复可以完成一个确切持久 outbox，但永远不问模型动作是否可能完成。

Evidence append 使用按 Work 锁或对 terminal hash 的 compare-and-swap。Payload 发布使用临时写入、sync、digest 验证和原子内容寻址发布。相同 payload 字节去重；digest 冲突或不匹配是安全失败。Artifact ID 和 Task Result 提交拒绝 last-write-wins 冲突。

Completion 运行在 Task、candidate digest、策略、Artifact、Evidence、frontier 和 TaskRun 的固定快照上。新的并发 Evidence 不进入既有 candidate。最终封存重新检查没有 Result 或 terminal 冲突被并发提交。

## 26. 包2 truth table

| 场景 | 决策 |
| --- | --- |
| 授权 Recorder 发出有效事件 facts | 允许 |
| Agent 选择 Recorder、sequence 或时间 | 拒绝 |
| Recorder 发出未授权或未知事件类型 | 拒绝 |
| 相同 event key 和 facts 重放 | 重放既有 EvidenceRef |
| 相同 event key 配不同 facts | 冲突并 fail closed |
| 链 gap、fork、hash 不匹配或无效 Anchor | fail closed |
| 有效但未 anchor 的活动事件 | 仅 provisional |
| 工具 proposal 无 completion Evidence | 不证明执行 |
| 有效 payload、schema、provenance 和 handling 策略 | 封存 Artifact |
| Payload digest 不匹配或缺失 provenance | 拒绝 |
| Manifest 无反向 recording Evidence | 排除出可信投影 |
| 相同 Artifact ID 和 digest 重放 | 重放成功 |
| 相同 Artifact ID 配不同 digest | 冲突 |
| 不同 Artifact 共享相同 payload | 允许 |
| Payload 移动后仍按 digest 验证 | 允许 |
| Payload 缺失或损坏 | 不可用；无法重新验证 |
| AI 报告有有效 provenance | 证明产出，不证明语义正确 |
| Kernel 和 outcome Checker 全通过 | 封存 Result |
| 任一 Checker 失败或 indeterminate | 不封存 |
| Evidence 属于另一个 Task 或 revision | 失败 |
| Blocked candidate 满足机器最低 | 封存 blocked Result；Leader 判断 blocker 语义 |
| Failed candidate 缺失败 Evidence | 失败 |
| 策略或实现 digest 与 Task 不匹配 | fail closed |
| 通过的 Evidence 在接受前过期 | 拒绝接受；创建新验证 Task |
| Result 已封存且新 Evidence 出现 | 不修改 Result |
| Completion 失败尝试累积 | 保留、轮转、归档并可选总结；不自动删除 |
| 历史 anchored pass 存在但实现包不可用 | 保留历史事实；当前重新评估 indeterminate |
| Result 记录存在但无已提交 completion 和 recording Evidence | 排除出投影 |
| 恢复发现 payload 无 Manifest | orphan payload，不是 Artifact |

## 27. 包3：外部效果与授权

包3控制 Task 隔离工作空间之外的持久效果：

```text
Task 或 HumanInteraction -> Operation -> 精确 Approval -> Gate allow
                         -> 执行 Evidence -> receipt Artifact
```

Operation 覆盖外部、共享、公开、昂贵、安全敏感或不可逆效果，如 push、publish、deploy、云资源变更、数据库写入、外部通知、工单变更、密钥轮换、生产命令和资源删除。读取、搜索、隔离工作空间编辑、build、test、内部 Artifact 持久化、Evidence append 和只读 reconciliation 不是 Operation。

效果边界由实际语义决定，不是工具名。把 `publish` 或 `deploy` 包在 shell 命令里不能绕过 Operation 控制。

## 28. Operation 合同

Operation 是一个不可变的、可审批的、可幂等执行的外部效果意图。它不是执行状态或工具调用日志。

```json
{
  "schema": "tiangong.operation/v1",
  "operationId": "operation-123",
  "origin": {
    "kind": "task",
    "ref": {
      "taskId": "task-prepare-17",
      "contentDigest": "sha256"
    }
  },
  "adapterRef": {
    "adapterId": "deployment-adapter",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "scope": {
    "workspaceBindingRef": {
      "artifactId": "workspace-binding-1",
      "contentDigest": "sha256"
    },
    "environmentRef": {
      "environmentId": "pre-production",
      "contentDigest": "sha256"
    }
  },
  "spec": {
    "schema": "tiangong.operation/deploy/v1",
    "targetRef": {
      "serviceId": "orders-api",
      "contentDigest": "sha256"
    },
    "artifactRef": {
      "artifactId": "image-123",
      "contentDigest": "sha256"
    },
    "expectedTargetStateDigest": "sha256",
    "desiredEffectDigest": "sha256",
    "protectedPayloadDigest": null
  },
  "effectPolicyRef": {
    "policyId": "effect-policy/pre-production-deploy",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

| 字段 | 合同理由 |
| --- | --- |
| `schema` | 固定 Operation 信封语义。 |
| `operationId` | 提供稳定的 journal、幂等和恢复身份。 |
| `origin` | 把效果意图绑定到其确切的 Task 或 HumanInteraction 来源。 |
| `adapterRef` | 固定解释并执行 spec 的受信实现。 |
| `scope` | 绑定工作空间、租户、环境和其他权威边界。 |
| `spec` | 绑定确切目标、输入、前置条件和期望效果。 |
| `effectPolicyRef` | 固定授权、风险、幂等、验证、重试、补偿和恢复规则。 |
| `contentDigest` | 让 Approval 和 Journal 绑定确切 Operation。 |

`spec.schema` 是权威的、代码拥有的 Operation 类型，带严格 schema 和 Adapter allowlist。它永远不含任意 shell 命令。凭据和原始受保护 payload 不进入 Operation 或 Evidence。当重启需要这类材料时，模型不可访问的受保护 store 持有 payload，Operation 只记录其 digest。

Operation 排除可变状态、Approval 引用、actor 和时间、幂等键、尝试、执行结果、回滚状态、任意原始命令、凭据、原始受保护 payload、自由风险标签、面向 Human 的审批文字、metadata 和 extension。

### 28.1 Operation 不变量

1. Operation 不可变；目标、输入、前置条件或期望效果的任何改变都创建新 Operation。
2. 一个 operation ID 映射到一个 digest。
3. 只有固定的授权 Adapter 可以执行固定的 Operation schema。
4. Origin kind 是代码拥有的：普通效果绑定 Task；正式 Human 投递绑定 HumanInteraction。不存在其他隐式 system origin。
5. Task-origin scope 必须同时被 Agent capability、Task 执行策略和 ResolvedWorkPolicy 允许。Interaction-origin 投递必须被 Leader 协调 capability 加已解析的 Human、报告、audience、channel 和效果策略允许。
6. 效果策略由代码解析，不能被模型弱化。
7. `operation.recorded` 证明封存的意图，不证明执行。
8. 每次实际执行都有对应相同 Operation digest 的精确 Approval。
9. 一个 Operation 有一个稳定的外部幂等身份。
10. 不确定结果阻断自动重试。
11. Result 拒绝或 Work 取消永不抹除真实效果。
12. 新 Operation 尝试要求 origin Work revision 和确切 Approval Work revision 是当前的。除了代码拥有的、策略授权的 Interaction-origin 终局或恢复 `inform` 投递外，还要求开放的 Work。先前尝试仍是历史事实，但 revision 使旧意图的未来重试失效。

## 29. OperationProposal Artifact

Prepare Task 封存 Operation 并产出 OperationProposal Artifact。Proposal 包含 OperationRef、安全的目标和效果摘要、确切的 Artifact/配置/环境 digest、风险和成本、前置条件、验证计划、失败影响，以及补偿或恢复方案。

Human 授权展示从 Operation、EffectPolicy 和 Proposal 确定性生成。Approval 绑定 Operation digest、Proposal Artifact digest 和展示 digest，使 Leader 文本不能在审查后替换另一个效果。

## 30. Approval 合同

Approval 是不可变授权 grant。它不证明执行或语义 Result 接受。

```json
{
  "schema": "tiangong.approval/v1",
  "approvalId": "approval-123",
  "grant": {
    "schema": "tiangong.approval-grant/exact-human/v1",
    "operationRef": {
      "operationId": "operation-123",
      "contentDigest": "sha256"
    },
    "workRef": {
      "workId": "work-123",
      "revision": 2,
      "contentDigest": "sha256"
    },
    "validUntil": "2026-08-05T10:00:00.000Z"
  },
  "basisRefs": [
    {
      "kind": "artifact",
      "artifactId": "operation-proposal-123",
      "contentDigest": "sha256"
    },
    {
      "kind": "evidence",
      "ledgerId": "work:work-123",
      "sequence": 80,
      "hash": "sha256"
    }
  ],
  "contentDigest": "sha256"
}
```

| 字段 | 合同理由 |
| --- | --- |
| `schema` | 固定 Approval 信封。 |
| `approvalId` | 提供稳定的消费和撤销身份。 |
| `grant` | 定义精确或有界权威、Work scope、限制和有效期。 |
| `basisRefs` | 绑定策略、Human 展示和认证回答 evidence。 |
| `contentDigest` | 让 Gate 和 Journal 绑定确切 grant。 |

认证的授权者和可信时间由 `approval.recorded` Evidence 记录，而非复制进 Approval。

Approval 排除自报授权者和时间、可变状态、consumed 或 use-count 字段、revoked 标志、Operation 结果、Leader 文本、原始 Human 消息、任意 scope 表达式、可复用 bearer token、metadata 和 extension。

### 30.1 Grant 类型

- `exact-human` 在认证 Human 授权后绑定一个 Operation 和当前 Work。
- `bounded-human` 绑定严格 Operation schema、目标、环境、次数、成本和有效期限制。它不能直接执行。
- `exact-derived` 为一个 Operation 原子消费有界权威，不能扩大 parent。
- `exact-policy` 记录某个具体 Operation 被固定的 standing EffectPolicy 允许。

每次实际执行使用一个精确 grant。有界 Human 和 standing 策略权威永远不直接传给 Adapter。

### 30.2 Approval 不变量

1. 只有受信 Authorization 边界创建 Approval。
2. Human grant 要求认证 Human 和被展示的确切展示内容。
3. 精确 Approval 绑定一个 Operation 身份和当前 Work revision。
4. 有界权威不能执行，每个派生 grant 原子消费 quota。
5. 策略派生的精确 Approval 固定当时使用的策略版本。
6. 过期或有效撤销的 Approval 不能开始或重试执行。
7. 执行开始后过期不妨碍完成记录或 reconciliation。
8. Approval 首次使用分配和 Operation Journal 开始是原子的；同一 Operation 重试重新验证精确 grant，不授权另一个 Operation。
9. Human 拒绝不创建 Approval。
10. 撤销是新的 `revoke-approval` CoordinationDecision，永不抹除已开始的执行。
11. Approval、Proposal 和权威 Evidence 与 Operation 一起在审计期限内保留。

包3用 `revoke-approval` 扩展 CoordinationDecision，其 subjects 为 `approval` 和 `target-work`。撤销停止未消费或未来权威；它不制造一个进行中或已完成效果从未发生的声明。

## 31. Task 与授权流程

精确 Human 授权使用分离的 Task：

```text
Prepare Task
  -> Operation + OperationProposal Artifact + completed Result
Leader
  -> authorize 交互
  -> 认证 exact-human Approval + anchored Evidence
Execute Task
  -> 输入包含 OperationRef 和 ApprovalRef
  -> Gate -> 效果 -> receipt Artifact -> Result
```

Task 永不为 Human 审批而挂起。

Standing 策略和有界预授权不需要每个 Operation 的 Human 往返：

```text
具体 Operation
  -> 策略或有界 scope 检查
  -> exact-policy 或 exact-derived Approval
  -> 执行
```

如果意外需要 Human grant，当前 Task 封存 Operation 和 Proposal，返回 blocked Result 而不执行，并终结。Leader 请求授权并创建新 Execute Task。

## 32. Gate 分层

Gate 是代码，不是 Agent。它按顺序检查：

1. **Schema 和完整性** —— Operation、Approval、Registry、digest、引用和敏感数据有效性。
2. **Capability** —— 对 Task origin，dispatch、assignee、Agent capability 和 Task 策略；对 HumanInteraction origin，Leader 和受信投递运行时 capability；两者都解析 scope、工作空间、channel 和环境。
3. **效果策略** —— 目标、风险、成本、数据分类、授权模式、验证和补偿要求。
4. **Approval** —— 精确 grant、anchored 权威 Evidence、Operation 和 Work 匹配、过期、撤销、parent scope、quota 和 approver 权威。
5. **幂等与恢复** —— 完成 replay、执行冲突、不确定 reconciliation 要求和受保护 payload 可用性。
6. **前置条件** —— 执行前即时的当前目标状态、输入、配置、环境、lease 和执行计划 digest。

Gate 返回 `allow`、`deny`、`approval-required` 或 `reconcile-required`，并记录严格 `gate.decided` Evidence。approval-required 永不挂起 Task 或 Matrix turn。已变化的前置条件通常需要新 Operation，而非修改旧的。

## 33. 效果执行协议

效果生命周期是一个小型的代码拥有的安全协议，不是团队工作流。运行时视图从 Journal 和 Evidence 派生：

```text
recorded -> authorized -> execution-started
  -> succeeded
  -> failed-no-effect
  -> partial-effect
  -> uncertain
  -> compensated 或 recovery-required
```

执行顺序：

```text
Operation 和 Anchor
-> 精确 Approval 和 Anchor
-> Gate allow
-> 原子 Approval 首次使用分配或同 Operation 重试验证 + Journal begin
-> 持久且 anchored 的 execution.started
-> backend 调用
-> receipt 和 postcondition 验证
-> terminal Evidence
-> OperationReceipt Artifact
```

成功要求可信 backend receipt 和已验证 postcondition。仅 HTTP 成功或模型文本不够。只有当 Adapter 证明没有外部效果发生时，失败才是 `failed-no-effect`。超时、开始后进程丢失、不可验证 receipt、Journal/backend 冲突或不支持的幂等默认为 uncertain。

## 34. 以 Operation 为中心的幂等与 Journal

稳定键独立于模型 session 和 turn：

```text
idempotencyKey = SHA-256(canonicalJson({
  schema: "tiangong.operation-idempotency/v1",
  operationId,
  operationDigest
}))
```

完成 replay 返回保存的安全 Receipt，不调用 backend。已开始无终局为 uncertain。只有特权 reconciliation 证明 `not-applied` 且当前策略和 Approval 仍允许时，才允许重试。任何 spec 变化创建新 Operation 和 Approval。

代码拥有的 Operation Journal 存储不可变 Operation 绑定、幂等键、受保护 payload digest 和 append-only 尝试。每次尝试绑定其确切 ApprovalRef、授权 TaskRun 或受信系统执行器、调用、持久开始和 terminal 事实、安全 replay Receipt 和 reconciliation 事实。Journal 是机器状态，不是 Evidence 或模型可写 Artifact。它跨进程串行化、加载时验证、hash 保护，并通过 outbox 与 Evidence 协调。不确定条目保留恢复材料，永不自动清理。

## 35. 补偿与 reconciliation

外部回滚本身是外部效果，因此是一个新 Operation，有自己的 EffectPolicy、精确 Approval、Evidence 和 Receipt。原 Operation 仍是历史事实。只有本地临时清理可以仍是内部 Adapter 生命周期动作。

Forward 审批可以单独授权一个精确补偿 Operation，或 standing 紧急策略可以派生一个。否则失败后请求 Human 授权。

Reconciliation 是模型不可访问的特权服务或 CLI。它使用 OperationRef、幂等键、目标和 receipt 查询 backend 状态，并记录 `applied`、`not-applied`、`partially-applied` 或 `still-uncertain`。只读 reconciliation 不是 Operation。任何纠正性变更都是新 Operation。

- applied：验证 postcondition 并记录成功；
- not applied：仅在策略和 Approval 仍有效时允许同键重试；
- partially applied：创建补偿或恢复 Operation；
- still uncertain：保持 recovery-required 并拒绝重试。

## 36. Result 与 Completion 绑定

Execute Task Result 引用 OperationReceipt Artifact 和执行、reconciliation 或补偿 Evidence；Result 不添加 Operation 字段。Receipt 语义绑定 Operation、Approval、Adapter、幂等键 digest、backend receipt、观测到的 terminal 结果、已验证 postcondition、目标和环境，以及任何补偿 Operation。

包2 `terminal-effect-safety` 检查与 candidate Task 关联的所有 Task-origin Operation。Work 关闭单独检查每个其 Task 或 HumanInteraction origin 属于该 Work 的 Operation：

- completed 要求精确 Approval、已验证成功、Receipt Artifact，且无 executing、partial 或 uncertain 效果；
- blocked 允许已记录但未执行的 Operation 和 Proposal，无执行开始；
- failed 允许已知无效果失败、显式 partial 恢复、补偿或披露的不确定性。

已开始的不确定 Operation 不能被软化为 blocked。一个 failed Result 可以真实地保留不确定性，但 Work 在恢复达到允许的 terminal 条件前不能成功完成。Work 可以改为以显式 recovery-required 条件失败。该 terminal Decision 不关闭其 Evidence Ledger 或 Journal：后续 reconciliation 事实 append 而不改变 failed Decision，而任何纠正性变更由独立的恢复或事故 Work 协调。

## 37. 包3命令与 Guard

| 命令 | 确定性 Guard 与产出 |
| --- | --- |
| `record_operation` | 验证确切 Task 或 HumanInteraction origin、对应 capability 和已解析策略、严格 spec、Adapter、scope、EffectPolicy provenance、输入引用、前置条件和 secret 排除；写 Operation 和 Evidence。 |
| `request_authorization` | 要求 anchored Operation 和有效 Proposal；从机器字段生成展示；记录请求 Evidence 并发送 Human authorize 交互，不挂起 Task。 |
| `record_exact_human_approval` | 认证 Human，匹配请求、Operation、Proposal、展示、当前 Work、权威角色和有效期；写 Approval、Evidence 和 Anchor。 |
| `record_bounded_human_approval` | 要求严格有界 scope、有限限制、授权 Human 和显式生成的展示。 |
| `derive_exact_approval` | 证明具体 Operation 在 standing 或 parent 权威内；原子消费 quota；永不扩大 scope；写精确 Approval 和 Evidence。 |
| `execute_operation` | 运行所有 Gate 层；原子分配或重新验证精确 Approval 并开始 Journal 尝试；在 backend 调用前持久化开始。 |
| `replay_operation` | 要求已验证 terminal 成功和匹配 digest；返回保存的 Receipt，不调用 backend。 |
| `reconcile_operation` | 只允许特权 reconciler 处理 uncertain 或 partial Operation；执行只读验证查询并记录 Evidence。 |
| `create_compensation_operation` | 要求需要补偿的真实效果、兼容 schema 和策略、有效当前前置条件、有界影响和精确 Approval。 |
| `revoke_approval` | append CoordinationDecision；与执行 begin 串行化；阻止未来权威而不抹除真实效果。 |

## 38. 包3 Evidence

必需事件含义包括：

```text
operation.recorded
approval.requested
approval.recorded
approval.derived
approval.consumed
approval.revoked
gate.decided
operation.execution.started
operation.execution.succeeded
operation.execution.failed-no-effect
operation.execution.partial
operation.execution.uncertain
operation.execution.replayed
operation.reconciliation.started
operation.reconciliation.completed
operation.compensation.linked
operation.receipt.recorded
```

Approval 记录绑定认证权威。Gate allow 绑定确切 Operation 和 Approval。执行开始在 backend 调用前持久。超时和异常永不暗示无效果失败。Terminal Evidence 绑定已验证 backend Receipt 和 postcondition。Approval 和 execution-start frontier 在外部效果前 anchor。Evidence 不含凭据、原始受保护 payload 或无限制 backend 响应。

## 39. 效果恢复与并发

重启时：

- 已记录但无 Journal begin 的，已知未被 Tiangong 执行；
- 有效 terminal Journal 和 Receipt 可以完成确切 Evidence outbox，无需另一次 backend 调用；
- begin 无 terminal 为 uncertain；
- terminal Evidence 配缺失 Journal 需要已验证 backend receipt 和特权 reconciliation 才能恢复；
- 受保护 payload 在 pending、executing 或 uncertain 时保留。

一个 Operation 键串行化执行。并发调用观测 executing、replay terminal Receipt 或收到 reconcile-required。有界 quota 使用 CAS；已开始的 Operation 即使后来失败也消费 quota。

Approval 撤销和执行 begin 共享一个线性化点。撤销先则拒绝执行；begin 先则效果已开始且撤销只限制未来使用。Work revision 和执行 begin 同样排序。revision 先提交则旧权威失效。如果执行先 begin，revision 看到活跃效果；当 Operation executing 或 uncertain 时，普通 Work revision 被拒绝。紧急响应使用独立的恢复或事故 Work，而非改变活跃 Operation 的含义。

## 40. 包3 truth table

| 场景 | 决策 |
| --- | --- |
| 隔离 read、edit、build 或 test | 普通工具执行 |
| Push、publish、deployment、外部写、消息或删除 | 需要 Operation |
| Shell 命令试图隐藏外部效果 | 拒绝原始命令路径 |
| 未知 Operation schema、Adapter 不匹配或 spec 含 secret | 拒绝 |
| 精确 Human Approval 匹配 Operation 和当前 Work | 符合 Gate 条件 |
| Human 审查后 Operation 变化 | Approval 不适用 |
| Standing 策略覆盖具体 Operation | 派生 exact-policy Approval |
| 有界 grant 覆盖 Operation 且 quota 可用 | 派生 exact-derived Approval |
| 有界 grant 直接传给 Adapter | 拒绝 |
| Operation 超出有界 scope、成本、时间或目标 | 拒绝并请求新权威 |
| Human 拒绝或未认证 Leader 声称同意 | 无 Approval |
| Task 试图等待 Human | 拒绝；封存 blocked Result 并返回 Leader |
| 所有 Gate 层通过 | 开始一次幂等执行 |
| 缺 Approval | approval-required；无效果 |
| Operation uncertain | reconcile-required；不重试 |
| 目标前置条件已变化 | 拒绝；通常创建新 Operation |
| Backend 成功且 postcondition 验证 | succeeded |
| backend 效果前失败 | failed-no-effect |
| 请求发出后超时或 receipt 无法验证 | uncertain |
| Backend 部分应用效果 | partial；恢复或补偿 |
| 完成 Operation 再次调用 | replay 保存的 Receipt |
| Reconciliation 证明 not applied 且权威仍有效 | 允许同键重试 |
| Reconciliation 证明 applied | 验证并记录成功 |
| Reconciliation 仍不确定 | recovery-required |
| 外部回滚是隐藏回调 | 拒绝目标设计 |
| 独立补偿 Operation 有精确 Approval | 允许 |
| completed Result 有 uncertain 或 partial Operation | Completion 失败 |
| blocked Result 无执行开始且有有效 Proposal | 符合 blocked 检查 |
| failed Result 显式保留 uncertain Evidence | 可封存 failed；Work 不能完成 |
| failed Work 后来收到 reconciliation Evidence | append 恢复事实；不重写 terminal Decision |
| 重启后 Journal begin 无 terminal | uncertain |
| 两个并发 execute | 一个效果；其他等待、replay 或 reconcile |
| Approval 撤销先于 begin | 拒绝执行 |
| begin 先于撤销 | 执行事实保留 |
| Work revision 先于 begin | 旧 Approval 失效 |
| begin 先于 revision | revision 看到活跃效果，通常拒绝 |
| 相同 operation ID 配不同 digest | 冲突并 fail closed |

## 41. 包4：组织与行为塑造

包4定义谁属于一个 Team、哪个 Worker 运行哪个 Agent 定义、允许做什么，以及指令、Skills、检索知识和 Concerns 如何塑造自主行为。权限始终在 Prompt 内容之外。

包4增加 TeamDefinition 作为必需的不可变 roster 记录。没有它，Work.teamRef 和 Task.assigneeRef 没有确切的 Leader 身份、成员、Worker 绑定或 AgentDefinition 版本来源。

## 42. TeamDefinition 合同

```json
{
  "schema": "tiangong.team-definition/v1",
  "teamId": "team-1",
  "leaderMemberId": "member-leader",
  "members": [
    {
      "memberId": "member-leader",
      "workerRef": {
        "provider": "agentteams",
        "workerId": "leader-worker",
        "bindingDigest": "sha256"
      },
      "agentDefinitionRef": {
        "agentDefinitionId": "delivery-leader",
        "version": "1",
        "contentDigest": "sha256"
      }
    }
  ],
  "teamPolicyRef": {
    "policyId": "team-policy/default-delivery",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

| 字段 | 合同理由 |
| --- | --- |
| `schema` | 固定 roster 和成员绑定语义。 |
| `teamId` | 提供稳定 Team 和平台映射身份。 |
| `leaderMemberId` | 不靠角色名推断地标识唯一 Leader。 |
| `members` | 把每个 Worker 身份绑定到确切的 AgentDefinition。 |
| `teamPolicyRef` | 固定 Team 默认值和可配置策略边界。 |
| `contentDigest` | 让 Work 绑定确切 roster 快照。 |

一个 Team 恰好一个 Leader 和任意数量的已批准专业成员。成员和 Worker 身份唯一。Leader 定义必须包含协调 capability。Kernel 没有固定的 Designer、Implementor、Assessor 或 Operator 枚举。

TeamDefinition 不可变。Roster 或 TeamPolicy 变化产生新 digest。既有 Work 只有通过新 Work revision 才采用它。旧 Task 绑定仍是历史事实。安全撤销可以阻止 dispatch 或执行而不重写旧 TeamDefinition。

TeamDefinition 排除可变 presence 或 health、Work 和 Task 引用、actor 和时间、平台容器或 Matrix 细节、权限内容、Skill 内容、工作流、固定专业角色名、metadata 和 extension。

## 43. AgentDefinition 合同

AgentDefinition 打包稳定的责任指令、机器 capability 和允许的方法，同时保持其权威分离。

```json
{
  "schema": "tiangong.agent-definition/v1",
  "agentDefinitionId": "backend-engineer",
  "version": "1",
  "responsibilityRef": {
    "artifactId": "agent-responsibility-backend-v1",
    "contentDigest": "sha256"
  },
  "capabilityPolicyRef": {
    "policyId": "capability/backend-engineer",
    "version": "1",
    "contentDigest": "sha256"
  },
  "skillRefs": [
    {
      "skillId": "code-implementation",
      "version": "1",
      "contentDigest": "sha256"
    }
  ],
  "contentDigest": "sha256"
}
```

| 字段 | 合同理由 |
| --- | --- |
| `schema` | 固定完整 Agent 定义。 |
| `agentDefinitionId` | 提供稳定 Catalog 身份。 |
| `version` | 支持显式审查的演进。 |
| `responsibilityRef` | 固定专业责任、边界和判断原则。 |
| `capabilityPolicyRef` | 独立于指令地固定机器强制权限。 |
| `skillRefs` | 为一个职业内的多样工作提供已批准方法集。 |
| `contentDigest` | 让 Team 和 Task 绑定确切定义。 |

SOUL 不是独立领域对象。既有 SOUL 文档可以是 responsibility Artifact。它塑造专业行为，但不能注册工具、授予路径或环境、授权 Operation、覆盖 Gate 或决定 Completion。

AgentDefinition 排除 Worker 和 Team 身份、Work 和 Task 状态、model/provider、工具名、凭据、已选 Skill 状态、Concern 状态、检索结果、transcript、可变 enabled 标志、metadata 和 extension。

## 44. CapabilityPolicy 合同

```json
{
  "schema": "tiangong.capability-policy/v1",
  "policyId": "capability/backend-engineer",
  "version": "1",
  "capabilityRefs": [
    {
      "capabilityId": "repository.read",
      "version": "1",
      "contentDigest": "sha256"
    },
    {
      "capabilityId": "repository.modify-isolated",
      "version": "1",
      "contentDigest": "sha256"
    }
  ],
  "scopePolicyRef": {
    "policyId": "resource-scope/backend-engineer",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

Capability 引用是代码拥有的 grant，如团队协调、仓库读取、隔离修改、隔离测试、Artifact 创建、Operation 准备或精确效果执行。未声明 capability 被拒绝。

有效权限是交集：

```text
Control Kernel
AND TeamPolicy 上限
AND Agent CapabilityPolicy
AND Task ExecutionPolicy
AND 活动环境策略
```

每一层只能收窄，不能扩大另一层。Skill、RAG、Task 文本和模型输出不授予 capability。Standing 效果授权不暗示 Agent 有执行该效果的 capability。

CapabilityPolicy 排除 Prompt 和 SOUL、Skill 引用、凭据、任意 tool glob、default allow、运行时状态、model 身份、metadata 和 extension。

## 45. TeamPolicy 合同

TeamPolicy 组合版本化的默认值和有界可配置策略模块。它不是 Control Kernel、工作流、roster、权限合集或 Prompt。

```json
{
  "schema": "tiangong.team-policy/v1",
  "policyId": "team-policy/default-delivery",
  "version": "1",
  "controlKernelRef": {
    "kernelId": "tiangong-control-kernel",
    "version": "1",
    "contentDigest": "sha256"
  },
  "moduleBindings": [
    {
      "slot": "task-control",
      "policyRef": {
        "policyId": "task-control/default",
        "version": "1",
        "contentDigest": "sha256"
      }
    },
    {
      "slot": "effect-authorization",
      "policyRef": {
        "policyId": "effect-authorization/default",
        "version": "1",
        "contentDigest": "sha256"
      }
    },
    {
      "slot": "knowledge-access",
      "policyRef": {
        "policyId": "knowledge-access/internal",
        "version": "1",
        "contentDigest": "sha256"
      }
    },
    {
      "slot": "concern-selection",
      "policyRef": {
        "policyId": "concerns/default",
        "version": "1",
        "contentDigest": "sha256"
      }
    }
  ],
  "contentDigest": "sha256"
}
```

| 字段 | 合同理由 |
| --- | --- |
| `schema` | 固定 TeamPolicy 组合语义。 |
| `policyId` | 提供稳定策略身份。 |
| `version` | 支持显式 Team 策略演进。 |
| `controlKernelRef` | 防止 Kernel 变化静默改变既有 Team。 |
| `moduleBindings` | 选择严格代码已知的默认和可配置模块。 |
| `contentDigest` | 让 Team 固定确切默认值，Work 策略从中解析。 |

代码拥有有限的 slot 目录，包括 task control、资源预算、质量基线、效果授权、环境访问、知识访问、Concern 选择、Human 交互、报告和保留。每个 slot 至多一个已解析 PolicyRef 和带默认值及有界 override 范围的严格 schema。这是策略组合，不是工作流或表达式 DSL。

Work 创建把 Team 默认值加允许的 Work override 解析成不可变 ResolvedWorkPolicy，由 Work.policyRef 引用。省略值在哈希前物化。Override 不能突破 Kernel 下限。TeamPolicy 更新不追溯改变 Work；采用需要 Work revision。

TeamPolicy 排除阶段、固定角色列表、Agent 工具 grant、Skill 内容、知识内容、Concern evaluator 代码、任意规则 DSL、Prompt 片段、可变 override、metadata 和 extension。

## 46. Skill 合同

Skill 是一个已批准的方法包，可供一个或多个兼容 Agent 定义使用。它既不改变职业也不授予权限。

```json
{
  "schema": "tiangong.skill/v1",
  "skillId": "regression-test-selection",
  "version": "1",
  "selectionDescription": "从影响分析和 core 测试中选择证据支撑的回归集。",
  "instructionRef": {
    "artifactId": "skill-regression-test-selection-v1",
    "contentDigest": "sha256"
  },
  "resourceRefs": [],
  "requiredCapabilityRefs": [
    {
      "capabilityId": "repository.read",
      "version": "1",
      "contentDigest": "sha256"
    }
  ],
  "contentDigest": "sha256"
}
```

| 字段 | 合同理由 |
| --- | --- |
| `schema` | 固定 Skill 包解释。 |
| `skillId` | 提供稳定方法身份。 |
| `version` | 支持审查的方法演进。 |
| `selectionDescription` | 从允许集中启用与 Task 相关的选择。 |
| `instructionRef` | 固定确切方法指令。 |
| `resourceRefs` | 固定脚本、模板、参考资料和资产。 |
| `requiredCapabilityRefs` | 声明兼容前提而不授予它们。 |
| `contentDigest` | 让 Context Evidence 把确切加载方法绑定到 TaskRun。 |

专业 Skill 教一个 Agent 如何完成工作。Leader 协调 Skill 教 Leader 如何分解、委派、审查和报告一个经典多 Agent 模式。协调 Skill 仍只通过 Leader 工具和 Guard 行动。

Task 不绑定强制 Skill 列表。运行时使用 TaskSpec 提示、选择描述和上下文，从 AgentDefinition 选择子集，Context Evidence 把确切加载 digest 记录到 TaskRun。Agent 可以在 Task 内加载另一个允许的 Skill。如果某个方法必须机器强制，它成为 Checker 或 Gate，而非 Skill 名称要求。

Skill 排除工具权威语义、角色切换、Practice 或 PracticeRun、工作流状态、Completion verdict、Approval 覆盖、任意运行时安装、私有依赖、secret、可变进度、metadata 和 extension。打包脚本仍是供应链输入，只通过 Capability、Task 策略、Gate 和 Evidence 边界执行。

## 47. 检索知识

知识源首先作为带 provenance 的 Artifact 存在，包括固定的仓库快照、架构和接口文档、System Map、需求、测试、Result 和 Finding、事故、runbook 和组织规范。搜索索引和 embedding 是可重建的缓存，不是权威。

一个 RetrievalBundle Artifact 记录查询 digest、索引快照 digest、知识策略 digest，以及带 Artifact 和切片 digest 的确切源切片。`knowledge.retrieved` Evidence 绑定 Task、Agent、查询、源、策略和 Bundle。丰富的查询文本遵循 handling 策略，不必进入 Evidence。

检索内容是不可信数据，永远不是系统指令。它不能覆盖 Kernel、CapabilityPolicy、Task、Gate 或 Skill。Handling 策略在检索前和模型上下文前各检查一次。没有确切 provenance 的 Bundle 不被接纳。源变化使旧切片结构上 stale。模型对检索材料的综合是 Claim 或 Artifact，不是 Evidence。

## 48. Concern 合同

Concern 是从当前事实派生的前瞻建议指导。它不授予权限、阻断动作、决定 Completion 或要求接受。Agent 和 Team Concern 使用分离的 evaluator 和输入模型，但共享一个小展示信封。

### 48.1 ConcernDefinition

```json
{
  "schema": "tiangong.concern-definition/v1",
  "concernId": "evidence-after-latest-write",
  "version": "1",
  "scope": "agent",
  "evaluatorRef": {
    "evaluatorId": "evidence-after-latest-write",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "guidanceRef": {
    "artifactId": "concern-guidance-evidence-freshness",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

### 48.2 ConcernView

ConcernView 是派生 Projection，而非不可变业务记录：

```json
{
  "definitionRef": {
    "concernId": "evidence-after-latest-write",
    "version": "1",
    "contentDigest": "sha256"
  },
  "scopeRef": {
    "taskId": "task-123",
    "contentDigest": "sha256"
  },
  "state": "drift",
  "severity": "warning",
  "subjectRefs": [],
  "factRefs": [],
  "guidance": "验证 Evidence 早于最近的物化产出。",
  "suggestedActions": ["rerun-relevant-verification"],
  "snapshotDigest": "sha256"
}
```

State 为 `active`、`drift` 或 `resolved`；severity 为 `info` 或 `warning`。没有 critical severity。必须阻断的条件是 Gate 或 Completion 规则。建议动作仍通过 Agent 或 Leader 判断和 Guard。

Agent Concern 读取一个 Task、TaskRun、已选 Skill、工具 Evidence、Artifact、completion 尝试和预算。Team Concern 读取 Work、Task、Result、Decision、Finding、Operation、Approval、预算、测试和环境。它们的 evaluator 逻辑不被强制进一个通用 schema。

TeamPolicy 选择启用的定义和有界阈值；它不拥有 evaluator 逻辑。Concern 可以检查 provisional 活动 tail Evidence 但标记其依据强度。`concern.presented` 证明展示了指导，不证明指导正确。重复 drift 可以证明一个新 Checker 或 Gate 的正当性。Human 默认不接收原始 Concern；Leader 把相关条件转换成 inform、decide 或 authorize 交互。

Concern 排除阻断或权限标志、直接创建 Task/Decision/Approval 或 Operation、通用模型 evaluator、可变 acknowledgement、工作流转换、原始 telemetry、metadata 和 extension。

## 49. Context 组装

每个 Agent turn 按权威顺序组装确切引用：

```text
Control Kernel 和工具 schema
Agent Capability 边界
Agent 责任指令
Work 和 Task 合同
已选 Skill
当前 ConcernView
检索知识 Bundle
会话和 Task 局部文本
```

低层不能改变高层权威。Prompt 标注 Skill 为方法、Concern 为建议、RAG 为不可信数据。框架发出 `agent.context.assembled`，带 AgentDefinition、Task、已选 Skill、RetrievalBundle、Concern 快照、model/runtime 和 system-prompt digest。它不把完整敏感 Prompt 复制进 Evidence。

Leader 是有协调能力和相关协调 Skill 及 Team Concern 视图的唯一 Team 成员。它决定语义下一步动作和 Human 沟通，但不能绕过 Gate、Completion、Approval、Catalog 或 Capability 边界。

## 50. 包4命令与 Guard

| 命令 | 确定性 Guard |
| --- | --- |
| `register_agent_definition` | 管理/代码拥有入口；有效 responsibility、Capability、Skill 和供应链引用；无隐藏权限或私有依赖。 |
| `register_team_definition` | 有效 Worker 身份；唯一成员和 Worker 绑定；恰好一个有协调能力的 Leader；有效 TeamPolicy。 |
| `register_team_policy` | 有效 Kernel；唯一已知 slot；严格模块 schema；不弱化 Kernel。 |
| `resolve_work_policy` | 物化默认值；只允许有界 override；发出不可变已解析策略。 |
| `create_task` | 扩展包1：assignee 属于确切 Work Team；定义未撤销；Task 策略是 capability 子集。 |
| `assemble_agent_context` | 确切 Agent 和 Task；只允许 Skill；授权知识和 handling；有界 Concern 快照。 |
| `load_skill` | Skill 在 AgentDefinition allowlist 中、未撤销、capability 兼容且资源有效。 |
| `retrieve_knowledge` | 授权源和分类；有效快照和源引用；有界查询和输出。 |
| `evaluate_concerns` | 有效定义和实现；匹配 scope；只读事实；无副作用。 |
| `update_team_roster` | 创建新 TeamDefinition；永不修改旧记录；当前 Work 通过 revision 采用。 |
| `revoke_agent_or_skill` | 管理权威和记录的撤销；阻止新使用；安全终结受影响的高风险执行。 |

## 51. 包4 Evidence、恢复与并发

必需事件包括定义、策略、Team、Skill、检索、context 和 Concern 的记录、加载、撤销和展示。事件携带确切 digest，而非完整敏感指令、RAG 内容或 Prompt。Skill-loaded 不证明方法合规；knowledge-retrieved 不证明真实；Concern-presented 不证明 drift。

Catalog 记录不可变、内容寻址、已审查、公共依赖安全，且可通过新管理事实撤销。新版本不撤销旧版本。安全撤销阻止新 dispatch、Skill 加载、工具使用或 Operation，并按策略终结受影响的运行工作而不重写历史。

恢复验证 Catalog 和撤销状态、TeamDefinition 和唯一 Leader、Work team 绑定、Task assignee AgentDefinition digest、TaskRun 绑定、Context Evidence Skill digest、RetrievalBundle 和 context 快照。ConcernView 重新计算。运行时永远不从 transcript 猜测加载的 Skill 或知识。缺失确切 context 包导致确切恢复或 Task 终结；它们不被静默替换为最新版本。

Catalog 更新使用 CAS。Work 保持确切 Team digest。并发相同 Skill 加载重放。RAG 索引并发重建，但 Bundle 绑定一个快照。Concern evaluator 是纯且可重复的。安全撤销与 dispatch 和工具调用线性化。

## 52. 包4 truth table

| 场景 | 决策 |
| --- | --- |
| Team 有一个 Leader 和任意已批准专业人员 | 允许 |
| Team 无 Leader 或多个 Leader | 拒绝 |
| 定义新的安全、数据或测试 Agent | 通过已批准 AgentDefinition 允许 |
| 核心要求原始五个角色名 | 拒绝目标设计 |
| 一个 Worker 在一个 Team 绑定到两个成员 | 拒绝 |
| Work 不通过 revision 采用新 roster | 拒绝 |
| Work revision 显式采用新 TeamDefinition | 允许 |
| Task assignee 不在确切 Work Team 中 | 拒绝 |
| Task assignee 定义被安全撤销 | 拒绝 dispatch |
| 每层 capability 允许一个动作 | 符合工具 Gate 条件 |
| Skill 声称一个不在 Agent capability 中的工具 | 拒绝 |
| Task 要求比 Agent 更多权限 | 拒绝 |
| Task 收窄 Agent capability | 允许 |
| Standing deploy 授权存在但 Agent 缺 deploy capability | 拒绝 |
| 责任文本说部署是必要的 | 无授权效力 |
| 加载已批准兼容 Skill | 允许 |
| Leader 加载协调 Skill | 允许；所有协调仍受 Guard |
| Skill 试图切换角色或权限 | 拒绝/无效果 |
| Skill 脚本调用工具 | 应用完整 Capability、Task、Gate 和 Evidence 控制 |
| 运行时安装未审查 Skill | 拒绝 |
| 必需机器行为必须强制 | 实现 Checker 或 Gate，而非 Skill 名称检查 |
| RetrievalBundle 有确切源、切片、索引和策略 digest | 允许 context 注入 |
| 检索结果缺源 provenance | 拒绝正式 Bundle |
| 检索内容含指令注入 | 作为不可信数据处理 |
| Agent 缺源分类访问 | 拒绝检索 |
| RAG 内容的模型总结 | Claim 或 Artifact，不是 Evidence |
| Agent Concern 读取 Task 事实 | 允许 |
| Team Concern 读取 Work 投影 | 允许 |
| 强制一个通用 evaluator 跨两个 scope | 拒绝设计 |
| Concern 建议重跑测试 | 仅建议 |
| Concern 说阻断而 Gate 允许 | Concern 无阻断权威 |
| Concern 条件消失 | 解决或移除 Projection |
| Concern 反复识别必须阻断的风险 | 把不变量提升到 Checker 或 Gate |
| TeamPolicy 选择已知严格模块 | 允许 |
| TeamPolicy 嵌入工作流 DSL 或 Prompt | 拒绝 |
| Work override 在允许范围内 | 解析不可变 ResolvedWorkPolicy |
| Work override 弱化 Kernel | 拒绝 |
| TeamPolicy 更新 | 不追溯改变 Work |
| 重启恢复确切 context digest | 允许 |
| 重启从 transcript 猜测 Skill 或 RAG | 拒绝 |

## 53. 包5：质量与环境

包5通过绑定确切的测试、subject、配置、数据、环境状态和机器执行事实，使一个测试声明变得有意义。

```text
SystemMap -> ImpactAssessment -> TestPlan -> TestRun(s)
          -> QualityAssessment -> Completion 或 Promotion Gate
```

除权威的 EnvironmentDefinition 和版本化的 QualityPolicy 外，包5有八个核心严格 Artifact schema：SystemMap、ImpactAssessment、TestDefinition、TestSet、TestPlan、EnvironmentSnapshot、TestRun 和 QualityAssessment。可选的面向 Human 的 TestReport 是普通类型化 Artifact。这复用 Artifact 身份、provenance、handling 和保留，而非创建并行存储。

## 54. EnvironmentDefinition 合同

EnvironmentDefinition 是不可变的环境身份和控制策略，不是当前运行时状态。

```json
{
  "schema": "tiangong.environment-definition/v1",
  "environmentId": "pre-production",
  "environmentClass": "pre-production",
  "adapterRef": {
    "adapterId": "kubernetes-environment-adapter",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "environmentPolicyRef": {
    "policyId": "environment-policy/pre-production",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

| 字段 | 合同理由 |
| --- | --- |
| `schema` | 固定环境定义语义。 |
| `environmentId` | 提供稳定环境身份。 |
| `environmentClass` | 选择代码拥有的风险和验证语义。 |
| `adapterRef` | 固定受信环境观察者和控制器。 |
| `environmentPolicyRef` | 固定访问、配置、数据、网络、测试、cleanup 和生命周期规则。 |
| `contentDigest` | 让 Operation、TestPlan 和 Snapshot 绑定确切定义。 |

基础 class 为 `isolated-runner`、`preview`、`integration`、`pre-production`、`production-canary` 和 `production`。class 是风险分类，不是强制发布序列。Team 可以定义多个或省略 class；QualityPolicy 和 EffectPolicy 决定哪些是必需的。

EnvironmentDefinition 排除 endpoint、凭据、当前 Artifact、配置、数据、状态、health、actor、时间、工作流阶段、角色名、metadata 和 extension。

## 55. EnvironmentSnapshot Artifact

一个具名环境可能变化。因此 TestRun 绑定时间点的 start 和 end EnvironmentSnapshot Artifact，而非单独的环境 ID。

```json
{
  "schema": "tiangong.environment-snapshot/v1",
  "environmentRef": {
    "environmentId": "pre-production",
    "contentDigest": "sha256"
  },
  "generation": "environment-generation-42",
  "stateManifestRef": {
    "artifactId": "environment-state-manifest-42",
    "contentDigest": "sha256"
  }
}
```

StateManifest 使用 class 特定严格 schema，绑定已部署 subject Artifact、配置、依赖、Runner 或容器 image、容器配置、网络策略、数据边界、fixture、环境策略、资源所有权、lease 或 generation、观测到的 health，以及相关 Operation receipt。

Snapshot 只由受信 Environment Adapter 用 `environment.snapshot.captured` provenance 发出。它不含凭据或 endpoint。环境变化创建另一个 Snapshot。测试捕获 start 和 end 两者；未授权 generation 或关键状态漂移使 run indeterminate。StateManifest 有严格观测结果 `observed`、`absent` 或 `unavailable`。Ephemeral 销毁使用机器证明的 absent end Snapshot。如果运行后观测无法完成，unavailable end Snapshot 绑定失败观测 Evidence 而不虚构状态，TestRun 为 indeterminate。unavailable start Snapshot 永不允许执行。

## 56. TestRun Artifact

TestRun 是 terminal 机器执行 Artifact，不是 Assessor 文本或退出码。

```json
{
  "schema": "tiangong.test-run/v1",
  "taskRef": {
    "taskId": "task-test-17",
    "contentDigest": "sha256"
  },
  "testPlanRef": {
    "artifactId": "test-plan-17",
    "contentDigest": "sha256"
  },
  "testDefinitionRefs": [
    {
      "artifactId": "test-order-cancel-api",
      "contentDigest": "sha256"
    }
  ],
  "executionBinding": {
    "subjectArtifactRefs": [
      {
        "artifactId": "orders-service-image",
        "contentDigest": "sha256"
      }
    ],
    "environmentStartRef": {
      "artifactId": "environment-snapshot-start",
      "contentDigest": "sha256"
    },
    "environmentEndRef": {
      "artifactId": "environment-snapshot-end",
      "contentDigest": "sha256"
    },
    "configurationRefs": [
      {
        "artifactId": "orders-config",
        "contentDigest": "sha256"
      }
    ],
    "dataBoundaryRef": {
      "artifactId": "test-data-boundary-17",
      "contentDigest": "sha256"
    }
  },
  "outcome": "passed",
  "caseResultsRef": {
    "artifactId": "test-case-results-17",
    "contentDigest": "sha256"
  }
}
```

Artifact provenance 绑定持久测试开始、Runner 身份和 image、执行计划、确切测试定义、subject、配置、数据和环境、case 结果、cleanup、end Snapshot 和聚合结果。

结果为 `passed`、`failed` 或 `indeterminate`。Passed 要求所有强制 case 和 oracle、稳定的授权环境状态、成功 cleanup 和可验证 Evidence。断言或 cleanup 失败为 failed。Runner 中断、harness 失败、不可验证环境、未授权漂移、不完整 case 结果或不确定 cleanup 为 indeterminate。只有 passed 满足质量义务。

TestRun 排除 actor 和时间、可变状态、文本报告、原始日志、单独退出码、TestSet 重复、裸环境 ID、最新版本引用、重试计数、通过百分比、metadata 和 extension。每次重试是新 TestRun Artifact，永不覆盖先前失败。

## 57. 测试数据边界

每个 TestRun 绑定一个 TestDataBoundary Artifact，包括当它显式不使用持久数据时。它定义源和快照、synthetic、masked 或 production-derived 状态、分类、允许的访问和写入、唯一测试身份、拥有资源、cleanup 策略、预期 terminal 状态和禁止数据。

生产敏感数据默认拒绝。测试只清理拥有的资源。Cleanup 失败保持 run 红色。

## 58. TestDefinition 与 TestSet Artifact

TestDefinition 绑定稳定身份和版本、系统层级、质量维度、确切覆盖 subject、可执行和 oracle Artifact、环境和数据要求，以及副作用策略。

层级为 `static`、`unit`、`component`、`contract`、`integration`、`scenario` 和 `post-deploy`。质量维度如 functional、security、performance、compatibility、data migration、resilience、observability 和 accessibility 与层级正交。Regression 是选择目的，不是层级。

测试实现或 oracle 变化创建新定义。定义不授予权限或决定 Core 成员资格。

TestSet 是不可变的确切集合：

```json
{
  "schema": "tiangong.test-set/v1",
  "testSetId": "orders-core-tests",
  "version": "3",
  "memberRefs": [],
  "governancePolicyRef": {
    "policyId": "test-set-governance/core",
    "version": "1",
    "contentDigest": "sha256"
  }
}
```

QualityPolicy 标识策划的 Core TestSet。增加覆盖通常需要质量接受。删除、禁用、跳过、弱化 oracle 或弱化环境需要独立评估，高风险需要 Human decide。历史 set 保持不可变。

回归选择是动态的：

```text
Core TestSet
+ 直接受影响 subject 测试
+ 传递影响路径测试
+ 当前 Finding 复现测试
+ 相关历史风险测试
+ QualityPolicy 要求
+ 未知边界的保守扩展
```

## 59. QualityPolicy 合同

```json
{
  "schema": "tiangong.quality-policy/v1",
  "policyId": "quality-policy/standard-delivery",
  "version": "1",
  "coreTestSetRefs": [],
  "ruleBindings": [
    {
      "slot": "test-selection",
      "policyRef": {
        "policyId": "test-selection/impact-based",
        "version": "1",
        "contentDigest": "sha256"
      }
    },
    {
      "slot": "environment-matrix",
      "policyRef": {
        "policyId": "environment-matrix/standard",
        "version": "1",
        "contentDigest": "sha256"
      }
    },
    {
      "slot": "independence",
      "policyRef": {
        "policyId": "test-independence/default",
        "version": "1",
        "contentDigest": "sha256"
      }
    }
  ],
  "contentDigest": "sha256"
}
```

QualityPolicy 控制 Core set、影响和选择要求、层级和维度、环境矩阵、独立执行、freshness、flaky 和 rerun 处理、cleanup、accepted-gap 权威和发布要求。它使用严格代码拥有的规则 slot，不规定团队工作流。

## 60. SystemMap Artifact

SystemMap 是对确切源快照的、有证据支撑的、显式不完整的理解。一个 SubjectRef 有稳定的系统和 subject 身份加版本特定 subject digest。

SystemMap payload 绑定系统定义、源快照、extractor set、subject 和 relation shard，以及已知缺口。Shard 防止单体图记录。基础 subject 包括 repository、module、service、API、event、schema、data store、deployment unit、business journey、external dependency、test 和 environment。

关系绑定确切的源和目标 Subject、关系类型、basis kind、basis 引用，以及仅推断的 confidence。Extracted 关系来自可信的 import、route、OpenAPI、schema、migration、build、deployment 和 test 分析，带机器 Evidence。Inferred 关系来自文档、历史、AI 分析或专家声明，带源 Artifact 和显式 high、medium 或 low confidence。Confidence 不是证明。

Map 输入变化创建新 Artifact。确定性和推断边保持分离。已知缺口不能被抹除以暗示完整性。图索引是可重建的 Projection。

## 61. ImpactAssessment Artifact

ImpactAssessment 消费当前 Work、SystemMap、输入 Artifact、可选 Finding 引用和确切的 ImpactPolicy。Finding 引用使用包1定义的确切 Result digest 加 JSON Pointer；它们永远不发明独立 Finding ID。Assessment 记录确定性 seed Subject、受影响 Subject、关系路径、环境影响、候选测试和显式 unknown。

过程冻结源 Artifact 和 Map、提取确定性差异、通过代码拥有的关系规则传播、通过 AI/RAG 添加带来源的语义候选、保留动态和未知边界、映射既有测试、推导环境影响，并接受独立质量审查。

需求、代码变更和 Finding 使用相同机制；没有 Bug 分类法。直接、传播和推断影响保持分离。每次传播有路径或依据。unknown 永不被表示为无影响。输入、Map、策略或 Work scope 变化使 Assessment 不适用于新版本。Assessment 推荐测试，但不能证明计划充分性。

## 62. TestPlan Artifact

TestPlan 绑定当前 Work、subject Artifact、SystemMap、已接受的 ImpactAssessment、QualityPolicy、显式义务、已选确切测试和环境、basis 引用和覆盖缺口。

每个义务命名受影响 Subject、必需层级和质量维度、TestDefinition、EnvironmentDefinition 和选择依据。Core TestSet 是强制的。每个直接影响和高风险传递影响有覆盖或显式缺口。高风险缺口需要策略授权的 Human decide。Plan 是专业 Claim，只有通过已接受 Task Result 才变得可用。

任何 subject Artifact、ImpactAssessment、Map、TestDefinition、Core TestSet、QualityPolicy 或环境要求变化使 Plan stale。TestPlan 表达义务，不编排 Agent 活动。

## 63. QualityAssessment Artifact

QualityAssessment 确定性聚合一个已接受 TestPlan、确切 QualityPolicy 和 subject Artifact、TestRun 引用、每义务结果、Evidence frontier 和 verdict `satisfied`、`unsatisfied` 或 `indeterminate`。

每个强制义务要求一个新鲜的 passed TestRun，带匹配的 subject、test、配置、数据和环境绑定。确定性 evaluator 发现截至其 Evidence frontier 的所有相关 TestRun；列出的引用不能隐藏一个合格的 failed 或 indeterminate Run。更晚的通过是新 Run，不抹除更早失败；rerun 和 flaky 策略决定两者如何处理。`quality.assessed` provenance 绑定 evaluator 实现 digest。覆盖缺口遵循显式策略和 Human 决策。

QualityAssessment 证明一个已接受 Plan 的执行，不证明 Plan 在语义上无所不知。Promotion Gate 只消费新鲜 satisfied 的 Assessment。TestReport 是独立的 Human 解释，永远不替代它。

## 64. 质量与环境执行

```text
已接受 TestPlan
-> 解析确切 TestDefinition
-> 分配或选择环境
-> 策略要求时获取 lease 或 generation guard
-> 在该 guard 下捕获 start EnvironmentSnapshot
-> 验证 subject、配置和数据绑定
-> 持久 test-run.started Evidence
-> 执行确切测试资产
-> 捕获 case 结果
-> 清理拥有资源
-> 捕获 end EnvironmentSnapshot
-> 验证授权状态转换且无漂移
-> 聚合结果
-> 封存 TestRun Artifact 和记录 Evidence
```

外部资源分配、数据变更和 cleanup 是 Operation，其效果边界要求时带精确 Approval。一个 run 永不从用户控制输入扩大 cleanup。

首选的多环境规则是 build 一次并推广同一个不可变 Artifact。环境特定重建创建不同 Artifact，需要独立证明。隔离 Runner 中的 unit 成功不证明 integration、pre-production、canary 或生产行为；每个 QualityPolicy 义务绑定其有意义的环境。

## 65. 包5命令与 Guard

| 命令 | 确定性 Guard |
| --- | --- |
| `register_environment_definition` | 管理权威；有效 Adapter 和策略；合法 class；无 endpoint 或 secret。 |
| `capture_environment_snapshot` | 受信 Adapter；确切 Definition；匹配 StateManifest 和 Evidence；无隐藏凭据。 |
| `record_system_map` | 确切源快照和 ExtractorSet；extracted 和 inferred 关系分离；保留已知缺口。 |
| `record_impact_assessment` | 当前 Work 和确切 Artifact、Map、策略引用；每个影响有路径或依据；unknown 显式。 |
| `record_test_definition` | 有效可执行、oracle、环境、数据、副作用和 Subject 引用；无权限声明。 |
| `record_test_set` | 有效唯一成员和治理；Core 弱化有所需独立和 Human 决策。 |
| `record_test_plan` | 当前确切 subject；已接受 Impact；QualityPolicy 和环境 provenance 来自 ResolvedWorkPolicy；强制 Core 义务；显式缺口。 |
| `execute_test_run` | 已接受 Plan；确切 TestDefinition；预留唯一 TestRun Artifact 身份和 attempt 键；授权环境、数据和配置；受信 Runner 和 lease。 |
| `record_test_run` | 有效 start 和 end Snapshot、case 结果、cleanup、Evidence 和一致的聚合结果。 |
| `assess_quality` | 已接受 Plan；新鲜确切 Run；确定性每义务结果；不选择性隐藏失败。 |
| `promote_artifact` | 包3 Operation，要求确切 Artifact 和新鲜 satisfied QualityAssessment。 |

## 66. 包5 Evidence、freshness、恢复与并发

必需事件包括 SystemMap 提取和丰富、影响评估、TestDefinition、TestSet 和 TestPlan 记录、环境快照和 lease、测试开始、每 case 完成、cleanup 开始和 terminal 结果、测试完成和记录，以及质量评估。Evidence 绑定 Runner image、策略、执行计划、fixture、subject、配置、数据、环境、case 和 cleanup 事实。原始日志是 Artifact；文本报告不是执行 Evidence。

Freshness 是确切的和关系的：

- Map 绑定源快照和 extractor；
- Impact 绑定 Map、输入、策略、Finding 和 Work scope；
- Plan 绑定 subject、Impact、Map、测试、Core set、QualityPolicy 和环境要求；
- Run 绑定 Plan、测试、subject、start/end 环境状态、配置、数据和 Runner 策略；
- QualityAssessment 绑定 Plan、Run、策略、Evidence frontier 和 subject。

任何相关 digest 或显式 temporal 要求变化需要新 Assessment、Plan 或 Run；无可变 stale 字段被写入。

Map、测试、set、plan、run 和 assessment 不可变。Catalog-head 和 Core-set 更新使用 CAS。环境执行使用 generation 或 lease，并把未授权并发漂移标记为 indeterminate。开始前，运行时预留唯一 TestRun Artifact ID 和 attempt 键，绑定到 Task、Plan、定义和执行绑定。该预留键的重放返回其保存结果；重试预留新 Artifact ID 和键，保留先前 Run。开始后 Runner 丢失封存一个 indeterminate TestRun 并执行拥有 cleanup 或 reconciliation。

QualityAssessment 使用固定 frontier。并发 Run 不进入既有 Assessment。恢复验证确切 Artifact、Evidence、Runner、Snapshot、资源和 cleanup；它永远不从 transcript 或部分输出猜测通过。

## 67. 包5 truth table

| 场景 | 决策 |
| --- | --- |
| TestRun 只记录环境 ID | 拒绝 |
| TestRun 绑定确切 start/end Snapshot、subject、config 和 data | 符合验证条件 |
| 相同 EnvironmentDefinition 运行另一个 Artifact 或配置 | 旧 Run 不适用 |
| 测试期间环境 generation 未授权变化 | indeterminate |
| 断言通过但 cleanup 失败 | failed |
| Runner 或环境结果不可知 | indeterminate |
| 报告说通过但无 TestRun Artifact 和 Evidence | 不证明通过 |
| Extracted 关系有机器 Evidence | 记录为 extracted |
| AI 关系有源和 confidence | 记录为 inferred claim |
| AI 关系无依据 | 拒绝正式关系 |
| Map 有已知缺口 | 有效但不完整 |
| 输入或 Map 变化 | 旧 Impact 和依赖 Plan stale |
| 未知影响被表示为无影响 | 拒绝 |
| Core 测试全部包含 | 满足 Core 最低 |
| AI 删除强制 Core 测试以降成本 | 拒绝 |
| 直接影响有测试或显式缺口 | 符合 Plan 审查 |
| 高风险 unknown 既无测试也无缺口 | 拒绝 |
| Core 中测试或 oracle 被弱化 | 需要治理的新版本和决策 |
| 所有 case、oracle、cleanup 和环境检查通过 | Run passed |
| 一个 oracle 失败 | Run failed |
| 只有聚合退出码存在 | TestRun 不足 |
| 失败后重试 | 新 Run；保留两者事实 |
| QualityAssessment 隐藏更早失败 | 拒绝 |
| 所有强制义务有新鲜匹配 passed Run | satisfied |
| 强制义务失败 | unsatisfied |
| 强制义务不可验证 | indeterminate |
| 发布绑定新鲜 satisfied Assessment 和确切 Artifact | 符合包3 Gate |
| 相同 Artifact digest 跨多环境推广 | 可追溯证据链 |
| 环境重建创建另一个 Artifact | 需要新验证 |
| unit 成功被呈现为 pre-production 场景证明 | 拒绝 |
| 环境 class 被用作固定工作流阶段 | 拒绝设计 |

## 68. 运行时闭合

运行时闭合定义包1–5已经要求的四个记录：TaskRun、HumanInteraction、ResolvedWorkPolicy 和 Operation Journal。它不增加业务工作流层。

```text
ResolvedWorkPolicy
        |
Work -> Task -> TaskRun -> context、工具、completion -> Result
        |
Leader -> HumanInteraction -> HumanResponse -> Decision 或 Approval
        |
Operation -> Operation Journal -> 幂等效果和恢复
```

## 69. TaskRun 合同

TaskRun 是一个已派发 Task 的不可变运行时绑定。一个已派发 Task 恰好一个 TaskRun。进程重启只有在其确切 Task、Runtime、Workspace 和 Context 引用可重建时才能恢复同一 Run。否则框架封存一个 failed Result，Leader 可以创建替换 Task。

```json
{
  "schema": "tiangong.task-run/v1",
  "runId": "run-123",
  "taskRef": {
    "taskId": "task-123",
    "contentDigest": "sha256"
  },
  "runtimeRef": {
    "runtimeId": "tiangong-agent-runtime",
    "version": "1",
    "implementationDigest": "sha256",
    "runtimePolicyRef": {
      "policyId": "agent-runtime/default",
      "version": "1",
      "contentDigest": "sha256"
    }
  },
  "workspaceBindingRef": {
    "artifactId": "workspace-binding-123",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

| 字段 | 合同理由 |
| --- | --- |
| `schema` | 固定运行时绑定语义。 |
| `runId` | 绑定 Evidence、Context、工具和预算事件。 |
| `taskRef` | 固定确切的不可变委派。 |
| `runtimeRef` | 固定受信运行时实现和策略。 |
| `workspaceBindingRef` | 固定 baseline、mount、隔离、cwd 和 Runner 环境。 |
| `contentDigest` | 防止静默绑定变化。 |

WorkspaceBinding 是严格 Artifact，绑定源 baseline、所有权、允许和禁止 mount、cwd、EnvironmentDefinition、隔离、网络、fixture、scratch 和输出位置，以及 cleanup 策略。它不含凭据。

Task 仍是 Work、assignee、ExecutionPolicy 和 CompletionPolicy 的单一来源。实际 model 身份、Skill、RetrievalBundle、Concern、Prompt digest、工具调用、预算消耗、Operation 和 completion 尝试是绑定到 TaskRun 的动态 Evidence 或 Artifact 事实。它们不是可变 TaskRun 字段。

TaskRun 排除状态、phase、assignee 副本、Work 副本、Skill 和检索状态、Concern 状态、当前 model、预算计数器、ResultRef、当前工具、transcript、思维链、actor、时间、metadata 和 extension。

## 70. TaskRun 不变量与 context

- 未派发 Task 没有 TaskRun；
- 已派发 Task 至多一个，一旦执行开始则恰好一个；
- 认证 Worker 必须匹配 Task assignee 和 AgentDefinition digest；
- Runtime 和 Workspace 必须满足 Task ExecutionPolicy；
- TaskRun 永不等待 Human 输入；
- TaskRun 无业务 phase；
- 每次 Context 组装记录确切 digest；
- Skill、RAG、Concern 或 model 变化不修改 TaskRun；
- 执行预算从 Task 策略解析；
- 预算耗尽封存框架 failed Result；
- terminal 权威来自 Result 和 Evidence，不是 Run 状态；
- 恢复使用 Task、Artifact、Evidence、Journal 和确切 Context 引用；
- 缺失或撤销的必需材料失败，而非静默改变执行身份；
- 外部效果不确定性在 Task terminal 处理前先 reconciliation；
- 替换创建新 Task，而非旧 Task 的另一个 Run。

每个 model turn 有一个逻辑 Context Snapshot，绑定 TaskRun、AgentDefinition、Responsibility、已选 Skill、Work 和 Task、RetrievalBundle、Concern 快照、已解析策略 digest、实际 model/runtime、system Prompt digest，以及可选的受保护会话摘要 Artifact。`agent.context.assembled` Evidence 事件记录这些引用和 digest。会话摘要是 HandlingPolicy 下的 Claim Artifact；隐藏的模型推理既不要求也不存储。

重启时运行时读取 Task 和 TaskRun、解析确切 AgentDefinition、Skill 和 RetrievalBundle、重新计算当前 Concern，并从 Artifact 和 Evidence 构建机器事实 RecoveryContext。只有当所有必需绑定验证且无工具或 Operation 不确定性未决时，它才继续同一 Run。

## 71. HumanInteraction 合同

HumanInteraction 是 Leader 与 Human 的不可变正式交互合同。它永远不含更晚的响应或可变等待状态。

```json
{
  "schema": "tiangong.human-interaction/v1",
  "interactionId": "interaction-123",
  "workRef": {
    "workId": "work-123",
    "revision": 2,
    "contentDigest": "sha256"
  },
  "semantics": "decide",
  "purpose": "test-plan-review",
  "audienceRef": {
    "audienceKind": "policy-role",
    "audienceId": "work-requester",
    "authorityPolicyRef": {
      "policyId": "human-audience/work-requester",
      "version": "1",
      "contentDigest": "sha256"
    }
  },
  "presentationRef": {
    "artifactId": "human-presentation-123",
    "contentDigest": "sha256"
  },
  "basisRefs": [],
  "responseContract": {
    "schema": "tiangong.human-response-contract/decision/v1",
    "optionIds": ["accept", "request-revision", "cancel"],
    "responseSchemaRef": null,
    "validUntil": "2026-08-06T10:00:00.000Z",
    "cardinality": "one"
  },
  "contentDigest": "sha256"
}
```

| 字段 | 合同理由 |
| --- | --- |
| `schema` | 固定交互信封。 |
| `interactionId` | 关联投递、响应和去重。 |
| `workRef` | 固定讨论中的 scope revision。 |
| `semantics` | 权威区分 inform、decide 和 authorize。 |
| `purpose` | 提供非权威的展示和路由标签。 |
| `audienceRef` | 固定有资格接收和回答的主体或策略角色。 |
| `presentationRef` | 固定 Human 实际看到的内容，包括附件 manifest。 |
| `basisRefs` | 固定相关 Result、Artifact、Finding、Decision 或 Operation。 |
| `responseContract` | 定义是否以及如何接受响应。 |
| `contentDigest` | 防止替换问题、选项或展示。 |

`inform` 不需要响应，覆盖进度、风险、质量、文件交付、恢复和最终报告。`decide` 请求语义判断，如 scope、设计、test-plan、known-gap 或最终接受。`authorize` 请求机器权限，绑定确切的 Operation 或有界 grant 提案。decide 永不替代 authorize。

HumanInteraction 排除可变状态、响应、sender、时间、原始可变消息、可变附件、Task 所有权、Approval、CoordinationDecision、自由形式 semantics、基于 purpose 的权威和 extension 字段。Presentation Artifact 在 Interaction 前封存，且不得引用该 Interaction digest，避免 digest 循环。投递是 Operation；Interaction 自身不声称成功投递。

## 72. HumanResponse Artifact 与交互不变量

一个认证 Human 响应是严格 HumanResponse Artifact，带 `human-response.captured` provenance。Decision payload：

```json
{
  "schema": "tiangong.human-response/decision/v1",
  "interactionRef": {
    "interactionId": "interaction-123",
    "contentDigest": "sha256"
  },
  "selectedOptionId": "accept",
  "responseContentRef": null
}
```

Authorization payload：

```json
{
  "schema": "tiangong.human-response/authorization/v1",
  "interactionRef": {
    "interactionId": "interaction-456",
    "contentDigest": "sha256"
  },
  "decision": "approve",
  "operationRef": {
    "operationId": "operation-123",
    "contentDigest": "sha256"
  },
  "presentationDigest": "sha256"
}
```

schema 合法的自由形式响应内容是单独的确切 ArtifactRef，而非内联无界文本。只有当响应合同显式允许时，authorization 才可绑定严格有界 grant 提案而非 Operation。

Response 是 CoordinationDecision 或 Approval 的依据，但本身不是它们。消费原子记录 `human-response.consumed` 及创建的 Decision、Work revision 或 Approval。inform 响应是普通新 Human 输入，而非修改原始 Interaction。

- 只有 Leader 或受信系统边界创建正式交互；
- 专业成员不直接与 Human 正式交互；
- 没有 Task 等待响应；
- Interaction、Presentation 和 Response 不可变；
- 实际响应者必须满足 AudiencePolicy；
- 有效响应要求对确切 Interaction、Presentation、audience 和 channel 有可信投递或展示 Evidence；
- 响应绑定确切 Interaction digest 且必须满足类型、基数和有效期；
- decide 和 authorize 不可互换；
- authorization 绑定确切效果意图和已查看展示；
- 有效 authorize 交互之外的自由形式同意不是 Approval；
- 相同响应重放幂等；
- 不同响应不能覆盖已消费的单响应；
- Human 改变意图创建新 Interaction、Response 和 Decision；
- 过期或旧 Work 的响应不能直接产生当前权威；
- Work 终结后只允许策略授权的 terminal 或恢复 `inform` 投递；decide 或 authorize 从新 Work 开始；
- 原始 Human 内容是 Claim Artifact，而认证和 receipt 是 Evidence；
- 投递是 Interaction-origin Operation，使用确切 standing 或有界通信权威，不能依赖同一未投递 Interaction 请求的授权；
- quiet 报告偏好永不抑制 decide、authorize 或恢复 exception 交互。

## 73. Human 报告策略

ProgressReport 是一个 `inform` HumanInteraction。最终和恢复报告可在 Work 终结后根据狭窄的 terminal-inform 例外投递；它们 append Evidence 且永不重开或修订 Work。必需触发是（策略要求时的）初始理解、decide 或 authorize 请求、实质性 scope 或计划变化、高风险 Finding、blocked 或 recovery-required 状态、实质性质量结论和最终完成。里程碑报告可跟随已接受的关键 Result、重要 Artifact、主要分支完成、实质性风险或预算变化，以及 QualityAssessment。

heartbeat 只有当 Work 仍活跃、策略间隔已过、存在新事实、Human 不在 quiet 模式，且没有更高优先级 Interaction 取代它时才合格。报告投影的 digest 抑制重复报告。报告陈述已变化事实、已确认完成、当前焦点、下一步、风险和不确定性、所需 Human 行动，以及确切 Result、Artifact 和 Quality 引用。它们既不暴露思维链也不暴露原始日志。

## 74. ResolvedWorkPolicy 合同

ResolvedWorkPolicy 是 TeamPolicy 默认值和合法 Work override 的完整不可变展开。Work 创建后运行时绝不查阅可变的当前默认值。

```json
{
  "schema": "tiangong.resolved-work-policy/v1",
  "policyId": "resolved-work-policy/work-123-r2",
  "version": "1",
  "sourceTeamPolicyRef": {
    "policyId": "team-policy/default-delivery",
    "version": "3",
    "contentDigest": "sha256"
  },
  "controlKernelRef": {
    "kernelId": "tiangong-control-kernel",
    "version": "1",
    "contentDigest": "sha256"
  },
  "moduleBindings": [
    {
      "slot": "task-control",
      "policyRef": {
        "policyId": "task-control/default",
        "version": "1",
        "contentDigest": "sha256"
      }
    },
    {
      "slot": "quality-baseline",
      "policyRef": {
        "policyId": "quality-policy/standard-delivery",
        "version": "1",
        "contentDigest": "sha256"
      }
    }
  ],
  "overrideBasisRefs": [],
  "contentDigest": "sha256"
}
```

所有强制 slot 都物化，无运行时继承或隐式默认。Slot 包括 task control、执行预算、completion、capability、质量、效果、环境、知识、Concern、Human 交互、报告、保留，以及任何其他 Kernel 强制的策略。Slot 名和解析规则是代码拥有的。

解析是确切 Kernel、TeamPolicy、模块和 override 输入上的确定性纯函数。它在采用它的 Work revision 前完成；override 依据不能依赖该目标 Work digest，避免 digest 循环。Override 保持在 TeamPolicy 范围内，不能弱化 Kernel。任何实质性变化创建新 ResolvedWorkPolicy。采用它的 Work 创建新 Work revision；既有 Work、Task、Result 和 Operation 事实保留旧策略语义。策略不含工作流、Prompt、任意代码或 extension bag。`work-policy.resolved` Evidence 绑定输入和输出 digest。

跨包策略 provenance 是强制的：

- Work.teamRef 解析一个 TeamDefinition，其 teamPolicyRef 恰好等于 ResolvedWorkPolicy 的 sourceTeamPolicyRef；
- TeamPolicy 和 ResolvedWorkPolicy 绑定相同 Control Kernel；
- Task ExecutionPolicy 和 CompletionPolicy 从已解析的 Task 和 completion 模块中选择或有效收窄；
- Operation EffectPolicy 从已解析的效果模块中选择；
- TestPlan QualityPolicy 和允许的环境从已解析的质量和环境模块中选择；
- Human audience、交互、报告和授权策略来自已解析的 Human 和效果模块；
- Handling、知识、保留和 Concern 策略使用对应已解析 slot。

下游记录不能仅因某策略在 Catalog 中有效就选择不相关或更弱的策略。Work 创建和 revision 原子重新检查此完整 provenance 链。

## 75. Operation Journal 绑定

Operation Journal 是用于幂等、replay 和恢复的机器协调状态。Evidence 是可审计的观测链。Journal 和 Evidence 分离，但通过持久 outbox 关联。

每个 Operation 至多一个不可变 Journal 绑定：

```json
{
  "schema": "tiangong.operation-journal-binding/v1",
  "operationRef": {
    "operationId": "operation-123",
    "contentDigest": "sha256"
  },
  "idempotencyKey": "sha256",
  "requestDigest": "sha256",
  "protectedPayloadDigest": null,
  "contentDigest": "sha256"
}
```

| 字段 | 合同理由 |
| --- | --- |
| `operationRef` | 固定确切效果意图。 |
| `idempotencyKey` | 给执行、replay 和恢复一个稳定身份。 |
| `requestDigest` | 防止请求替换。 |
| `protectedPayloadDigest` | 让恢复验证不可访问的敏感材料。 |
| `contentDigest` | 防止绑定修改。 |

Approval 绑定在每个 attempt 上，而非复制进 Journal 绑定。一个 reconciled 重试只有当其 grant 和当前策略仍允许同一 Operation attempt 时才可复用确切 Approval，或可能需要新确切 Approval。Operation 和幂等键保持不变。

## 76. Operation Journal 事件

```json
{
  "schema": "tiangong.operation-journal-event/v1",
  "operationRef": {
    "operationId": "operation-123",
    "contentDigest": "sha256"
  },
  "sequence": 1,
  "eventKey": "sha256",
  "eventType": "execution-started",
  "attemptRef": {
    "attemptId": "attempt-1",
    "executorRef": {
      "kind": "task-run",
      "ref": {
        "runId": "run-123",
        "contentDigest": "sha256"
      }
    },
    "approvalRef": {
      "approvalId": "approval-123",
      "contentDigest": "sha256"
    },
    "invocationDigest": "sha256"
  },
  "facts": {
    "executionPlanDigest": "sha256"
  },
  "previousHash": "sha256",
  "hash": "sha256"
}
```

`eventKey` 从 Operation、事件类型、attempt 或 reconciliation 身份及逻辑阶段确定性派生。相同 key 和 content 重放；相同 key 配不同 content 冲突。第一个事件使用 `SHA-256(canonicalJson(JournalBinding))` 作为其 genesis previous hash，每个事件 hash 在不含 `hash` 的 canonical 事件上计算。

事件类型为 `prepared`、`execution-started`、`execution-succeeded`、`execution-failed-no-effect`、`execution-partial`、`execution-uncertain`、`reconciliation-started`、`reconciliation-applied`、`reconciliation-not-applied`、`reconciliation-partial`、`reconciliation-uncertain`、`receipt-recorded`、`replay-served`、`protected-payload-released` 和 `compacted`。每个有严格代码拥有的 facts schema。

Operation 投影从此 append-only 的按 Operation hash chain 派生。Journal actor 和可信时间是 Evidence，receipt 是 Artifact，secret 或原始 backend 响应永不进入 Journal facts。

## 77. Operation Journal 不变量

- 一个 Operation 至多一个绑定；
- 绑定不可变，事件序列连续且 hash-chained；
- 相同 eventKey 和 content 幂等重放；相同 key 配不同 content 冲突；
- Approval 验证、首次使用分配或同 Operation 重试验证，与 `execution-started` 是一个线性化事务或恢复等价协议；
- 每个 backend attempt 绑定确切 Approval 和调用，加上授权 TaskRun 执行器或 Interaction-origin 投递允许的受信系统运行时执行器；
- 所有 attempt 保留 Operation 幂等键；
- 已开始无终局投影为 uncertain；
- uncertain 阻断另一个 attempt 直到 reconciliation；
- 只有 reconciliation-not-applied 能使重试合格；
- 重试有新 attempt 身份、当前 Work Operation 和对该 attempt 有效的确切 Approval；
- 成功 replay 返回保存的 Receipt，无 backend 执行；
- terminal Receipt 是 Artifact，不是原始 Journal payload；
- Journal 到 Evidence 发布使用持久 outbox；
- 损坏 fail closed；
- 结果 uncertain 时保留受保护 payload；
- payload 释放是 Journal 和 Evidence 事实；
- 显式 compaction 只在 terminal summary、Anchor、保留和无恢复依赖后允许，且必须保持连续性和 replay 证明；
- 模型不能读取或修改 Journal。

## 78. 运行时组合

Agent 运行时组合：

```text
dispatch Task
-> 开启 TaskRun
-> 组装确切 context
-> 自主 model turn
-> 工具 Guard、Evidence 和 Artifact 捕获
-> 重新计算 Agent Concern
-> Result candidate
-> 确定性 Completion Check
   -> 在 Task 内继续，或封存 completed/blocked/failed Result
-> 终结 TaskRun
```

Leader 组合：

```text
读取 Work 投影、已接受 Result、Team Concern、策略和预算
-> 选择语义协调动作
-> 创建或替换 Task、接受或拒绝 Result
-> 需要时创建 HumanInteraction
-> 为 scope 变化创建 Work revision
-> 目标解决时终结 Work
```

Human 组合：

```text
封存 HumanInteraction
-> 投递 Operation
-> Human 查看确切 Presentation
-> 认证 HumanResponse Artifact 和 Evidence
-> 作为 CoordinationDecision、Work revision 或 Approval 消费一次
```

这些组合解释信任边界。它们不是工作流图，不规定 Leader 的专业策略。

## 79. 运行时闭合命令与 Guard

| 命令 | 确定性 Guard |
| --- | --- |
| `open_task_run` | Task 已 dispatch；无 Run 或 Result；确切 Runtime 和 Workspace；Worker 匹配 assignee。 |
| `assemble_context` | 有效 TaskRun；有效 AgentDefinition、Skill、RAG、Concern 和策略引用；HandlingPolicy 允许材料。 |
| `resume_task_run` | 确切 Run；无 terminal Result；Context 可重建；无未决效果不确定性；预算允许。 |
| `terminate_task_run` | Result 已封存或框架 failed Result 已封存；无隐藏活跃执行。 |
| `record_human_interaction` | Leader 或受信边界；当前 Work；Human、audience、报告和效果策略 provenance 有效；匹配 semantics 和合同；有效 Presentation 和依据。 |
| `deliver_human_interaction` | 包3 Operation；确切 Interaction；去重；channel 和 audience 授权。 |
| `capture_human_response` | 认证 Human；确切 Interaction 和可信展示/投递 Evidence；有效 audience、channel、合同和时间；封存 Response Artifact 和 Evidence。 |
| `consume_human_response` | 有效未消费响应；semantics 匹配；原子创建 Decision、Work revision 或 Approval。 |
| `resolve_work_policy` | 确切 TeamPolicy 和 Kernel；所有默认物化；override 已授权且在范围内。 |
| `open_operation_journal` | 有效 Operation、请求和 payload digest；不存在或相同重放。 |
| `begin_operation_attempt` | origin 和确切 TaskRun 或受信系统执行器匹配；确切有效 Approval；无活跃或 uncertain attempt；前置条件通过；原子分配首次使用或验证同 Operation 重试并开始。 |
| `append_operation_terminal` | 受信 Adapter；匹配 attempt；一致 Receipt 和 facts；持久 Evidence outbox。 |
| `reconcile_operation_journal` | 特权 Reconciler；uncertain 或 partial Operation；严格结果 schema。 |
| `compact_operation_journal` | terminal、已保留且 anchored；无恢复依赖；保持连续性证明。 |

## 80. 运行时闭合 Evidence

必需事件包括 `task-run.opened`、`task-run.resumed`、`task-run.budget-exhausted`、`task-run.terminated`、`agent.context.assembled`、`human-interaction.recorded`、`human-interaction.delivered`、`human-response.captured`、`human-response.consumed`、`human-response.rejected`、`work-policy.resolved`、`operation-journal.opened`、`operation-payload.released` 和 `operation-journal.compacted`。包3 `operation.execution.*`、`operation.reconciliation.*` 和 `operation.receipt.recorded` Evidence 额外绑定 Journal sequence 和 attempt 身份；运行时闭合不创建重复执行事件含义。

TaskRun 事件绑定确切 Task。Context 事件包含引用和 digest，而非复制的 secret。Human 投递绑定确切 Presentation；响应 Evidence 绑定认证 Human；消费绑定产生的 Decision、Work revision 或 Approval。Journal 和 Evidence outbox 恢复而不暴露受保护 payload、凭据、隐藏推理或原始敏感 Prompt。

## 81. 运行时闭合恢复与并发

TaskRun 开启使用 Task CAS。相同绑定重放；另一个绑定冲突。Result 封存和 Run 终结协调。确切可恢复 Run 使用相同 runId。缺失 context、撤销权威、未 reconciliation 工具结果或耗尽预算封存 failed Result，而非创建另一个 Run。

outstanding Human 交互从投递和响应 Evidence 投影。已捕获未消费响应被确定性消费。相同响应重放；冲突或过期响应不能覆盖权威。Work revision 重新验证 outstanding 交互适用性。

ResolvedWorkPolicy 解析是确定性和内容寻址的。并发相同解析去重。TeamPolicy 更新不影响已解析 Work。Work revision CAS 决定采用。

Operation Journal 使用按 Operation CAS 或串行化。Approval 撤销和 attempt 开始共享一个线性化边界。只有一个 attempt 活跃；replay 永不调用 backend。Journal compaction 与读取和 reconciliation 串行化。从备份恢复尊重 terminal tombstone，永不复活受保护 payload 或已完成效果。

## 82. 运行时闭合 truth table

| 场景 | 决策 |
| --- | --- |
| 未派发 Task 开启 Run | 拒绝 |
| 已派发 Task 开启首个确切 Run | 允许 |
| 相同 Task 和 Run 绑定重放 | 幂等 |
| 相同 Task 开启不同 Run | 冲突 |
| Worker 与 assignee 不同 | 拒绝 |
| Workspace baseline 与 Task 输入不同 | 拒绝 |
| TaskRun 等待 Human | 拒绝；封存 blocked Result |
| 确切 Context 可重建 | 恢复同一 Run |
| 恢复需要 transcript 猜测 | 拒绝恢复 |
| 必需 Skill、Artifact 或权威被撤销 | 失败 Run 和 Task |
| 预算耗尽 | 框架 failed Result |
| terminal Result 后跟随工具调用 | 拒绝 |
| Leader 发送进度或文件交付 | inform |
| Human 审查 scope、设计、测试或接受 | decide |
| Human 授予外部效果许可 | authorize |
| decide 响应被用作 Operation 授权 | 拒绝 |
| Presentation 与提议 Operation 不同 | 拒绝 Approval |
| 无可信 Evidence 证明确切 Presentation 投递 | 拒绝响应权威 |
| 响应者不满足 AudiencePolicy | 拒绝 |
| 相同 HumanResponse 重放 | 幂等 |
| 已消费单响应收到冲突 | 不覆盖；创建新交互 |
| quiet 模式遇到 authorize 或恢复 exception | 仍通知 |
| 相同进度投影重复 | 抑制 |
| 已解析策略完全物化合法输入 | 允许 |
| 运行时读取可变当前默认值 | 拒绝 |
| override 弱化 Kernel | 拒绝 |
| TeamPolicy 更新 | 旧 Work 不变 |
| Work 采用另一个策略 | 新 Work revision |
| 相同 Operation 和绑定重放 | 幂等 |
| 相同 Operation 有不同请求 digest | 冲突 |
| 有效 Approval 且无活跃 attempt | begin |
| 已开始无 terminal 事件 | uncertain |
| uncertain attempt 直接重试 | 拒绝 |
| reconciliation 证明 not applied | 重试可能合格 |
| 重试有新有效确切 Approval | 允许 |
| 成功 Operation 再次调用 | replay Receipt |
| terminal Journal 缺已发布 Evidence | 确定性投递 outbox |
| Journal、Evidence 和 backend 冲突 | reconcile |
| uncertain 时删除受保护 payload | 拒绝 |
| 损坏 Journal 被自动截断 | 拒绝并 fail closed |

## 83. 引用闭合与支撑 registry

本架构中没有引用隐式创建另一个业务聚合。每个确切引用属于四个闭合家族之一：

- 领域 RecordRef，包含其稳定身份字段和 content digest；
- ArtifactRef，包含 artifact ID 和 Manifest digest；
- PolicyRef，包含策略 ID、版本和 content digest；
- ImplementationRef，包含实现身份、适用时的版本和实现 digest。

EvidenceRef 是已定义的 ledger、sequence 和 hash 元组。认证主体引用由平台身份边界解析，不是模型创作的内容引用。

策略包包括 TaskExecutionPolicy、closure、effect、environment、quality、handling、knowledge、Human-interaction、reporting、retention 和其他有限 TeamPolicy slot。实现包包括 Kernel、Checker、Adapter、Recorder、Concern evaluator、SystemMap extractor、Runtime 和 schema validator。每个包有不可变的已审查 catalog 条目、严格代码拥有的 schema、公共供应链 provenance 和撤销事实。它不能含 Prompt 控制的权限表达式或通用规则 bag。

ArtifactSchema、事件 facts schema、Operation spec schema、响应合同和环境状态 schema 是 validator 包，不是额外权威记录。Human audience 和 approval-role 定义是权威策略包。凭据、签名密钥和受保护 payload 记录保留在模型不可访问的安全 store 内，仅在合同要求时按安全身份或 digest 引用。

一个消费命令在被引用的每个 registry 类型、严格 schema、validator、权威规则和撤销检查都存在之前是禁用的。未知、缺失、冲突或撤销的引用解析 fail closed。具体 catalog 内容是实现交付物，但它们不能引入新协调 action、扩大权限、改变 digest 语义，或弱化任何包1–5 或运行时闭合不变量。

## 84. 延迟的实现合同

实现规划覆盖 AgentTeams adapter、存储拓扑、Matrix、Runner 和环境 backend、测试框架、SystemMap extractor、CI、smoke 场景、model-provider failover、session backend、物理事务策略、用户界面、具体 catalog 内容和仓库迁移。

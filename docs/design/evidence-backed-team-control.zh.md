# 证据支撑的团队控制

> 状态：目标设计。
>
> 本文定义 Tiangong 应达到的形态，与具体实现无关。
>
> 落实本目标设计的第一条公开产品纵切见 [`product-mvp.zh.md`](product-mvp.zh.md)。

<a id="1-purpose"></a>
## 1. 目的

Tiangong 协调一支 AI Agent 团队，开展开放式专业工作。它提供足够持久的结构，用于委托、交接、恢复和安全执行外部操作，同时不会把某一种首选的团队方法变成工作流引擎。

核心职责划分如下：

- **Leader** 作出语义判断；
- Agent 在受委托的工作范围内选择专业方法；
- 代码负责执行身份、能力、并发和外部效果安全控制；
- 记录保留 Human、Agent、工具和外部系统实际做过的事，不把同一事实复制到多个台账中。

Team 可以开展分析、规划、质疑、实现、集成、review、测试、发布、研究或其他工作。这些都是普通 Task，不是 Kernel 阶段。小型 Work 可能不需要委托；复杂 Work 可以让多个 Agent 并行工作。Tiangong 不要求固定的角色名单、Task 分类、依赖图、review 顺序或独立验证步骤。

<a id="2-scope-and-trust-boundary"></a>
## 2. 范围与信任边界

### 2.1 部署模型

一个 Tiangong 部署服务于一家企业。一家企业可以运行多个 Team，每个 Team 都有自己的 Leader、成员、路由、能力和外部系统。

本设计假定基础设施管理员、数据库管理员和主机管理员是受信任的。不试图证明系统能够抵抗恶意管理员或恶意主机对完整性的破坏。

在这个信任模型内，以下仍是现实中可能发生的失败：

- 模型错误和提示注入；
- Team、Work、Task、workspace 或 channel 路由错误；
- 通过 prose、Skills、检索内容或工具输出提升能力；
- 凭据泄露给 Agent 控制的进程；
- 通过网络意外泄露源代码；
- 并发写入者和过期的协调命令；
- 外部操作重复、被中断或结果不确定；
- 误导性的完成声明；以及
- Task 或 Work 终止后到达的迟到事件。

### 2.2 产品职责边界

AgentTeams 负责平台 Team、Worker/容器、通道身份、投递和存储集成层。

Tiangong 负责自己的 Worker 控制运行时、专业委托、会话上下文、准备好的执行边界、工具、外部系统 Adapter、Operation 策略、精确 Approval、恢复和产品体验。

通道认证能够识别 Human 或 Worker，但本身不会授予 Tiangong 工具、数据、批准或外部效果权限。

### 2.3 永久非目标

Tiangong 不是：

- 能抵抗恶意管理员篡改的日志；
- 多企业隔离证明；
- 内容寻址的归档平台；
- 固定的软件开发生命周期；
- 通用调度器 DAG；
- 记录所有可能在 Bash 中运行的可执行文件的注册表；也不是
- 仓库分支保护、CI、变更管理或事件响应系统的替代品。

白名单网络访问以部分隔离为代价，换取实际的 Git、软件包、文档和研究访问能力。能力分离与监控可以降低残余泄露风险，但不会让风险归零。

<a id="3-design-principles"></a>
## 3. 设计原则

### 3.1 语义权威属于 Leader

Leader 决定：

- Human 的意图是什么；
- 是否已经足够明确；
- 是否委托，以及如何委托；
- 哪些 Agent 报告有用；
- 是否需要更多工作、review、测试或质疑；以及
- Work 是否完成，或是否应当停止。

Kernel 不会从 criterion 标识符、结果 outcome 枚举、角色名称或流程图中推断这些判断。

### 3.2 机器权限属于代码

由代码而不是 prompt 负责：

- 已认证的身份和 Team 路由；
- 成员准入和实际能力；
- 可读、可写路径；
- 进程、网络和凭据边界；
- Operation 策略和精确 Approval；
- 命令幂等与乐观并发控制；
- 单写入者和单活跃执行规则；
- 外部效果结果与恢复检查；以及
- Task 的原子终止和 Work 的关闭。

WorkSpec、TaskSpec、消息、Skills、模型输出、检索内容和 MCP 响应都不能授予机器权限。

### 3.3 保持不同事实彼此分离

Tiangong 区分四种事实来源：

| 来源 | 记录 |
|---|---|
| Human 和 Leader 的通信或协调 | Work 时间线 |
| Agent 的最终报告 | Result |
| 顶层工具观察到的内容 | ToolResult |
| 外部写入发生的情况 | Operation 事件 |

同一事实不会被复制到第二个证据包装对象中。尤其不存在独立的机器证据对象或机器证据存储。

### 3.4 结构帮助自主工作

WorkSpec、TaskSpec、Result、稳定的内容引用和类型化的 Operation 请求，能够帮助 Agent 恢复工作并协作，但不会规定专业方法。

协调 Skill 可以提供规划模式、质疑提示、review 清单或发布实践。Leader 可以使用、调整顺序、替换或跳过它们。

### 3.5 不确定性既不是成功，也不是失败

当外部操作可能已经生效、但无法确认其状态时，Tiangong 记录不确定性，并阻止冲突效果。时间、模型信心和 Human 的风险接受都不能把未知的外部状态变成已知状态。

### 3.6 硬控制必须证明其摩擦是值得的

新增 Kernel Gate、字段或状态时，必须说明：

1. 它阻止的具体威胁或并发错误是什么；
2. 为什么 Skill、MemberConfig、Adapter 或外部系统不足以解决问题；
3. 代码如何验证这项属性；以及
4. 它会给 Agent 增加什么额外摩擦。

如果无法说明这些，Tiangong 应改进默认设置和能力，而不是扩张 Kernel。

<a id="4-core-facts"></a>
## 4. 核心事实

持久化的协调模型只包含：

- Work、其有界展示标题及只追加时间线；
- Work 当前的 WorkSpec 和当前 Plan 引用投影；
- 带有不可变 TaskSpec 的 Task；
- 每个 Task 至多一个不可变 Result；
- 不可变 ContentRef；
- 执行记录层中有界的 ToolResult；
- 不可变 Operation 以及只追加的 Operation 事件；以及
- TeamConfig、MemberConfig 和 ControlProfile。

“queued”“running”“waiting for approval”“reported”“cancelled”等 Task 标签，是从实际事实得到的 UI 投影，不是第二套 Task 状态机。

Leader 的操作是命令，会追加带类型的 Work 时间线事实。每条事实都带有自己的直接主题、有界理由、已认证的操作者和时间。不存在通用的协调决策对象或决策台账。

权威的控制输入仍彼此独立：

| Actor | 控制输入 | 持久化事实 |
|---|---|---|
| Leader | `create-task`、`cancel-task`、`complete-work` 或 `stop-work` | 带类型的 Work 时间线事实 |
| Task assignee | `submitResult` | 以 Task ID 为键的不可变 Result |
| 已认证 Human | 批准或拒绝一项精确的 Operation | Operation 事件 |
| 恢复控制器或已认证 Operator | 对未解决的 Operation 做对账 | 只读观察，以及仅在验证通过时追加的 Operation 事件 |

这张表描述的是操作者和事实归属，不是共享的 action 枚举或工作流。

<a id="5-work-workspec-and-human-communication"></a>
## 5. Work、WorkSpec 与 Human 通信

### 5.1 消息接纳与 Work 创建

一条经过认证的 Human 消息通过通道集成进入系统。它的平台消息标识符就是入口幂等键。Team 的 Leader 会收到这条普通通道事件和开放 Work 的有界摘要，并执行一次幂等的接纳操作：

- 把平台消息引用关联到一个开放 Work，并将该引用追加到其时间线；或
- 原子地创建新 Work、绑定该引用并追加第一条时间线记录。

在 Leader 提交任一操作前，该事件可以留在一个以平台消息标识符为键、有界且持久的待归单队列中。这是基础设施状态，不是 Work 或 Task：它只保存通道引用、已认证 actor、接收时间、lease/retry 数据和有界错误码，不保存消息正文。归单唤醒必须幂等，并按稳定的 Room 顺序处理。Leader 模型不可用时，消息仍在通道中可见并等待重试，不会丢失，也不会创建一个猜测出来的 Work。运维和 Web 可以观察待处理数量、最老等待时间和最后一个有界错误，而无需读取复制的消息内容。

这种路由是 Leader 的语义判断，不是 Human 在 UI 中选择的消息作用域。Kernel 仍会验证操作者是当前 Leader，并且目标 Work 仍开放、属于同一 Team 和通道路由。Web 选择可以改变当前查看哪个 Work 的事实，但绝不能决定下一条 Room 消息进入哪个 Work。Work 路由不会修改 Human 消息正文，不会向其通道内容增加 Tiangong 字段，也不要求使用 thread 或 reply 约定。Tiangong 只保存平台消息引用及其 Work 绑定，消息文本仍以通道为来源。

关联有歧义时，Leader 默认创建新 Work，避免把无关上下文悄悄合并，并且可以在继续行动前向 Human 确认。附件使用 ContentRef，普通文本仍是普通消息。

Work 投影最初可以是：

```json
{
  "workId": "work-123",
  "teamId": "team-a",
  "epoch": 1,
  "title": "交付所请求的变更",
  "workSpec": null,
  "currentPlanRef": null,
  "createdBy": "human-42",
  "createdAt": "2026-08-09T10:00:00Z"
}
```

原始请求的平台消息引用是 Work 时间线的第一条记录。消息正文仍保留在通道中，不会复制到上面的投影或第二份聊天存储中。

`title` 是供 Human 导航和搜索使用的有界、非唯一展示元数据。它绝不是标识符、授权输入、幂等键、Session key 或遥测关联值。临时标题可以来自第一条消息；Leader 形成 WorkSpec 时可以完善它，已授权 Human 也可以重命名。重命名会追加 `work-title-changed`。其他成员可以读取标题，但不能修改。

### 5.2 更正错误关联

Human 的纠正仍是一条普通、经过认证的通道消息。来源 Work 仍开放时，Leader 可以执行一次受限的 `correct-message-association` 命令：

1. 验证原始绑定、纠正消息、当前 Leader 以及相同的 Team 和通道路由；
2. 指向另一个开放 Work，或以纠正消息为起点原子创建一个新的 `workSpec: null` Work；
3. 向来源和目标 Work 都追加 `message-association-corrected` 事实，并原子更新当前消息关联投影；
4. 保留原始时间线记录，使消息重放和最初的归单错误仍可解释。

重新处理原始平台事件时会读取纠正后的当前关联，绝不会把它移回来源 Work。不可变的初始接收记录只用于历史解释，不能作为过期的路由响应。

如果最初的歧义创建了占位 Work，且之后没有 Task 或外部效果，同一事务会停止该占位 Work，并在理由中标明目标 Work。如果来源 Work 已经终止，则绝不改写它；纠正消息会启动一个新 Work，并把原始消息和已终止 Work 作为上下文引用。

Task、Result、ToolResult 和 Operation 绝不会在 Work 之间移动。如果错误关联后已经发生工作或外部效果，Leader 必须更新仍开放的来源 WorkSpec，取消或完成其 Task，并显式处理其 Operation。这只是受限的消息关联纠正，不是通用 Work 合并、Task 迁移、重新挂接或继承协议。

### 5.3 形成和变更 WorkSpec

WorkSpec 是 Leader 对整件 Work 的简洁当前理解。它可以包含：

```json
{
  "goal": "交付所请求的行为",
  "scope": ["仓库 service-a"],
  "constraints": ["保留公共 API"],
  "doneWhen": ["所请求的行为可用"],
  "unresolvedAssumptions": []
}
```

这些字段提供语义指引，不是机器 criterion 标识符。

首次形成 WorkSpec 以及每次修改，都会追加一条 `work-spec-changed` 时间线事实，包含：

- 已认证的操作者和时间；
- 有界理由；
- 完整的新 WorkSpec 快照；以及
- 相关的 Human 消息或 Leader 理由。

当前 WorkSpec 是这些事件的事务性投影，不存在单独的 WorkSpec 历史存储。

当前 WorkSpec 非空，是创建 Task 和执行 `complete-work` 的机器前置条件。即使 WorkSpec 为空，Work 仍然可以被停止。

`workSpec: null` 是合法的中间投影，不是数据缺失或损坏。API 必须显式返回它；Web 将其显示为“需求待形成”，不能凭空渲染空 Plan、Task 或完成状态。

### 5.4 共享 Work Plan

较复杂的软件交付或其他多 Agent Work 可以维护一份当前 Plan。Plan 是 Markdown ContentRef，是团队当前准备如何满足 WorkSpec 的共享工作指南。它不是 Task 清单、工作流、授权对象、完成检查表或独立聚合。

已经发布的 Plan 内容不可变。灵活性来自创建新的 Markdown ContentRef，再由 Leader 追加一条带新引用和有界理由的 `work-plan-changed`。`currentPlanRef` 是这些事实的投影；候选 Plan ContentRef 在 Leader 发布前只是普通 Task 交付物。系统不存在 Plan 表、Plan 状态、Plan Approval、PlanStep schema 或版本状态机。

Architect 通常是主要作者。任何成员都可以通过普通沟通或 Result 提出修改建议；Leader 可以做小型协调修改，也可以要求 Architect 修订。只有 Leader 能修改 `currentPlanRef`。默认的软件交付方法要求初始 Plan 和实质性技术变更在发布前由 Challenger 挑战，但“实质性”仍由 Leader 在 Skill 指引下判断，不成为 Kernel 工作流阶段。如果改变 Human 的目标、范围、约束或 `doneWhen`，必须先修改 WorkSpec，不能把变化藏进 Plan。

形成 Plan 所需的规划、研究和挑战 Task，可以在当前 Plan 尚不存在时创建。Leader 创建执行 Task 时，可以把当时的 Plan ContentRef 作为输入，同时只把相关背景和 Plan 片段组织进 TaskSpec。同一 Work 的成员可以按需读取完整当前 Plan，但它会明确标为背景。Plan Markdown 不保存执行进度；Task、Result、ToolResult 和 Operation 事实才是权威记录。

### 5.5 已存在的 Task 不会悄悄改变

已经派发的 Task 不会自动接收后来的 WorkSpec 或 Plan。它不可变的 TaskSpec 和已引用输入仍是委托权威。

WorkSpec 或 Plan 发生变化后，由 Leader 决定：

- 无关的 Task 无需更新；
- 可以将有用但不具权威性的上下文作为明确指向某个 Task 的背景消息发送；或者
- 实质性变化要求安全取消旧 Task 并创建新 Task。

Agent 可以查询当前 Work 摘要和当前 Plan，但返回结果会标记为背景，不能重写 TaskSpec。Tiangong 不把 Task 绑定到可变的 Work 或 Plan 投影，也不引入通用的 Task 更新协议。

### 5.6 等待 Human 输入

澄清属于普通 Work 通信，不是 Approval 对象。

需要 Human 输入时，Tiangong 会清楚地通知 Human，停止不必要的活跃计算，可以释放逻辑会话，并可以发送有界、去重的提醒。

如果不存在安全的默认值，时间流逝不会替系统凭空作出决定。澄清请求可以让 Work 保持打开且 `workSpec: null`，UI 则可以显示“等待 Human”等投影标签。之后的回复会继续同一个开放 Work。

提醒计时器、投递重试和等待标签属于基础设施或投影，不是权威业务对象。

### 5.7 Work 终止

Leader 有两个 Work 终态命令：

- `complete-work` —— Leader 判断当前非空 WorkSpec 已满足；
- `stop-work` —— Work 不再继续，并记录有界理由，例如撤回、无法完成、重复或路由错误。

两者都会追加带类型的时间线事实，并原子地更新 Work 的终态投影。终态 Work 不会重新打开；之后的新需求会创建新的 Work。

Work 完成和停止是内部语义决定，不需要 Kernel 级别的 Human 确认。Team 可以通过普通消息、Skill 或外部系统请求客户验收。

<a id="6-task-delegation-and-result-handoff"></a>
## 6. Task 委托与 Result 交接

### 6.1 创建 Task

只有 Leader 可以创建 Task。创建操作会与 `task-created` Work 时间线事实、有界的委托理由以及 Work epoch 推进一起原子完成。

```json
{
  "taskId": "task-456",
  "workId": "work-123",
  "assigneeId": "member-9",
  "taskSpec": {
    "objective": "实现取消处理",
    "inputs": [
      {
        "repositoryId": "service-a",
        "commitSha": "abc123"
      }
    ],
    "constraints": ["不要修改公共 API"]
  },
  "createdBy": "leader-1",
  "createdAt": "2026-08-09T10:10:00Z"
}
```

TaskSpec 是完整的语义委托。它不可变，只包含 objective、inputs 和必要的普通语言 constraints。Leader 可以把选出的 Work 背景和相关 Plan 片段组织进这些文本，同时把完整 Plan ContentRef 作为输入引用。运行时默认不会注入整份 Plan，也不会增加 Markdown section、行号范围或 PlanStep selector。

Task 不会复制：

- WorkSpec 版本；
- Plan 进度或可变 Plan 状态；
- role 或 task-kind 枚举；
- workflow stage；
- dependency graph；
- capability 列表；
- policy 快照；
- workspace 对象；或
- 预期的 Result 类型。

如果 objective 或 assignee 必须实质性改变，Leader 会创建新的 Task。

### 6.2 动态的多 Agent 工作

Leader 可以直接推理，也可以为分析、规划、质疑、研究、实现、集成、review、测试、发布或其他任何职责创建普通 Task。

Kernel 不理解这些专业标签。后续 Task 可以用 Task ID、commit 或其他 ContentRef 引用早期 Task 的唯一 Result 作为输入。当它们的可写根目录和其他能力不冲突时，Task 可以并行运行。

Leader 会在输入确实可用时创建后续 Task；Tiangong 不预先构建调度 DAG。集成 Task 是普通 Task。Review 和测试是可选的普通 Task。要求硬性 review 门禁的企业，应在相关仓库、CI 或 Adapter 中执行，而不是增加一种通用 Result 子类型。

一个 Team 可以配置多个承担相近职责的成员。Kernel 不会把一种职责限制给一个 Agent。

当当前 MemberConfig 和 ControlProfile 的限制允许时，一个成员可以同时执行多个 Task。每个 Task 都保留自己的逻辑会话和执行所有者，并且并发写入者使用不同的可写根目录。

### 6.3 执行所有权

每个 Task 同一时刻至多有一个活跃的 Agent turn 或执行所有者。只有在确认前一个进程树已经停止，或已与可写根目录隔离后，才允许替换执行者。

Task 可以处于以下情况：

- 工作继续时没有 Result；
- 恰好有一个不可变的最终 Result；或者
- 没有 Result 时，有一条 `task-cancelled` 时间线事实。

待处理的 Operation 可以暂停同一个 Task，之后再把结果返回给它。这不会创建 Approval 阶段，也不会创建替代 Task。

### 6.4 Result

Result 是 assignee 的最终报告，不是平台对质量作出的判定。

```json
{
  "taskId": "task-456",
  "summary": "已实现取消处理；仍有一个旧版边界情况，已在报告中说明。",
  "deliverableRefs": [
    {
      "repositoryId": "service-a",
      "commitSha": "def456"
    }
  ],
  "toolResultRefs": ["tool-result-21"],
  "submittedBy": "member-9",
  "createdAt": "2026-08-09T11:00:00Z"
}
```

`deliverableRefs` 和 `toolResultRefs` 是可选的。summary 说明完成了什么、没有完成什么、有哪些限制以及有用的后续步骤。

不存在 Result ID，因为每个 Task 至多有一个 Result。不存在 Result outcome 枚举、verification 子类型、producer 关系、verdict、digest、version 或 accept/reject disposition。

创建 Result 前，代码只检查：

- 已认证的操作者是当前 assignee，且仍然被接纳；
- Task 既没有 Result，也没有取消事实；
- 有界 schema 有效；
- 引用的 ContentRef 可访问且稳定；
- 引用的 ToolResult 属于该操作者和 Task；以及
- 引用的 ToolResult 的留存标记已经成功写入。

检查不会判断质量、完整性、测试情况、WorkSpec 覆盖程度或业务正确性。

### 6.5 取消与竞态

只有在 Task 没有 Result 时，Leader 才可以取消它。

提交取消前，运行时会：

1. 停止并确认整个活跃进程树；
2. 释放 Task 的写入锁或可写绑定；
3. 将所有待处理且尚未开始的 Operation 标记为 `operation-not-executed`；以及
4. 拒绝隐藏已经开始且仍需要恢复的 Operation。

Result 提交和取消会在数据库中竞争。先提交成功的事务获胜；另一方被拒绝。取消成功后，会追加一条带 Leader 有界理由的 `task-cancelled` Work 时间线事实。不会改写 Task status 字段。

<a id="7-team-capability-skills-and-context"></a>
## 7. Team、能力、Skills 与上下文

### 7.1 TeamConfig

一个 Team 恰好有一个 Leader。

```json
{
  "teamId": "team-a",
  "leaderId": "leader-1",
  "routeScope": ["channel:room-a", "repository:service-a"],
  "controlProfileId": "enterprise-standard"
}
```

TeamConfig 不会复制成员白名单。当前存在的 AgentTeams 身份，只要有为该 Team 启用的 MemberConfig，就会被接纳。TeamConfig 选择 Leader、路由和企业 ControlProfile。

### 7.2 MemberConfig

MemberConfig 定义成员实际拥有的工作能力，包括：

- 专业职责；
- 可访问的仓库和数据范围；
- 执行配置和可写范围上限；
- 网络配置；
- 暴露给成员的顶层本地工具和 Adapter；
- 可用的专业 Skill 和协调 Skill；
- 允许使用的模型；以及
- 成员预算和并发限制。

数据范围和网络能力必须结合验证。拥有广泛搜索或文档出口的成员，不得同时获得核心私有源代码。拥有核心私有源代码的成员，只能获得用途受限的网络路径，例如精确的仓库拉取、软件包下载和指定测试服务。

受控的 ContentRef 和上下文组装负责执行配置的数据范围。自由文本仍可能携带敏感内容，因此仍需要路由纪律、脱敏和监控；Tiangong 不声称能够实现完美的语义数据防泄漏。

专业身份和能力来自已认证的 AgentTeams 状态、MemberConfig、ControlProfile 和加载的 Agent 包，而不是角色专用容器镜像。Provider、Provider credential 和 Worker 当前 model 以 AgentTeams 官方控制面为权威；Agent 包只提供初始 `defaultModel`，不能覆盖已认证 Worker 配置。Tiangong 将当前 model 绑定进 MemberConfig revision，并要求部署投影与 AgentTeams 为该 Worker 生成的实际 OpenClaw model 配置完全一致；不能假设 AgentTeams 一定提供 `AGENTTEAMS_MODEL` 环境变量。管理员通过 AgentTeams 修改单个 Worker 后，只有在 Worker 生命周期重建使实际配置生效时才能产生新 revision；旧 Session/绑定随之失效。Task、Prompt、Skill 和模型自己都不能改 Provider/Model。

第一版不在 Agent package、MemberConfig 和环境之间复制一个抽象 `capabilityProfile` 字段。Agent package 的显式 `toolGroups` 决定顶层工具集合，MemberConfig 的 Skill allowlist 只缩小已安装 Skill，工作区、可写路径、网络和凭据由部署绑定及 ControlProfile 决定。Leader 使用协调工具；其余五个专业成员使用固定 OpenClaw 版本验证过的共同 workspace 工具。仓库中的机器可读工具锁是 allowlist 的单一来源，镜像合同必须核对 pinned OpenClaw 实际注册的工具；新增上游工具默认拒绝。专业职责只限制交付物和交付链位置，不充当文件系统安全边界；工具层不承诺 Reviewer 等角色只读。只有 Developer Commit 能进入交付链。部署应优先使用一个版本化的通用 Worker runtime 镜像。共享镜像或工具组绝不意味着共享工作区、凭据或交付权。

### 7.3 ControlProfile

ControlProfile 是企业级上限。它定义：

- 允许、需要 Approval 和禁止的 Operation 类别；
- 获得授权的 approver 以及 Approval 过期规则；
- 未知动作的处理方式；
- 进程、文件系统、网络和数据边界要求；
- 模型白名单和明确的 fallback 规则；
- 预算和并发上限；
- Execution Record 和 Work 的留存策略；以及
- 脱敏和事件升级要求。

未知的外部写入和未知的特权工具类别都会被拒绝。ControlProfile 不编码专业工作流，也不规定通用的 review/test 规则。

### 7.4 有效权限

一次调用只有在四类独立检查都通过时才允许：

1. AgentTeams 确认当前身份和路由；
2. ControlProfile 原则上允许这项能力；
3. MemberConfig 授予该成员实际的数据、网络、工具或 Adapter 能力；以及
4. 运行时绑定识别出当前的 Work/Task、cwd、可写根目录或 Adapter 目标。

运行时绑定是能力句柄，不是另一份可编辑的策略。Tiangong 不创建已解析的 Work policy，也不把权限复制到 Task 中。

每个新 turn、本地工具调用和 Adapter 调用都会检查当前配置。环境激活和每个新 turn 还会验证实际的数据挂载、可写根目录和出口绑定是否符合当前 MemberConfig 与运行时能力绑定。缺失、过期、冲突或不匹配的状态会 fail closed。撤销权限会停止或隔离尚未启动的本地能力；已经开始的 Operation 只保留后文所述的受限恢复路径。

### 7.5 Skills 与上下文

Skill 是版本化的方法、指令和可复用代码。它们可以提供强默认值，但不能授予能力、追加特权事件，也不能直接改变 Task 或 Work 事实。

部署的 Agent 包提供已安装 Skill 集合，MemberConfig 启用其中一个子集；成员只能使用两者交集。Skill 可以跨专业职责复用，不由 Human、Leader、Task 或 prompt 动态指派。Agent 根据触发说明在已启用 Skill 中自主选择。在线安装和 Task 级 Skill 变更不属于第一版产品边界。实际解析的 Skill 身份和版本属于执行元数据，不是 Task 权威。

对 Task Agent 而言，上下文按权威和用途分层：

1. 硬性的运行时边界和当前配置；
2. 不可变的 TaskSpec 和运行时绑定；
3. Leader 明确指向的背景，以及为该 Task 选定的 Work 或 Human 消息；
4. 启用的 Skill 作为受治理的方法默认值；
5. 主动查询的当前 Work 摘要；
6. 可选的检索；以及
7. 较早的对话历史。

Task 专属的背景不能重写 TaskSpec。Skill 可以提出风险或建议更好的方法，但不能覆盖具体委托。后来的 WorkSpec 不会自动作为新的 Task 指令插入。

对 Leader 而言，当前 WorkSpec、Work 时间线、Task、Result 和 Operation 是持久化的恢复上下文。

检索是可选的本地工具或 Adapter。它的索引可重建，永远不具权威性。风险和分歧通过普通消息或 Result 内容表达，不存在专门的 concern 对象。

<a id="8-prepared-execution-environments"></a>
## 8. 准备好的执行环境

### 8.1 控制域与执行域是分开的安全域

Worker 控制运行时负责身份、消息、会话、Gate 和 provider 访问。由 Agent 启动的 Bash、构建、测试和脚本，则运行在准备好的执行环境中。

以下是不变量：

> 由 Agent 控制的执行进程树无法读取 Worker 控制凭据、模型 provider 密钥、通道身份材料、会话或运行时状态、待处理 Operation 状态、生产凭据、容器 socket 或主机控制端点。

这个边界可以在 Worker 内使用 OS sandbox 实现，也可以通过长驻的 sidecar/container 实现。物理形式不是领域对象；能力边界才是强制要求。

### 8.2 准备执行环境

稳定的操作系统软件包、shell、Git、语言运行时、编译器和 sandbox 辅助工具，属于不可变的版本化镜像。项目可以增加一层稳定的项目工具链镜像。

可变源代码不会成为镜像权威。准备好的环境使用本地 Git 对象镜像或缓存，以及一个或多个 checkout/worktree。同步源代码使用 `git fetch`，随后 checkout、reset 或 worktree 到精确 commit；默认不会使用 `git pull` 和隐式 merge。

软件包下载缓存和构建缓存可以跨 Task 和 Work 保留。只有当镜像、平台、工具链和 lockfile key 都匹配时，才会复用依赖树；否则环境执行增量安装或重建。缓存是优化手段，不是权威记录。

当测试服务的数据已经正确命名空间隔离或重置时，可以复用长驻测试服务。生产系统只能通过 Adapter 访问。

Agent 通常进入已经准备好的 cwd，执行轻量 fetch 和 key 检查，运行健康检查，然后开始工作。Tiangong 不会为每个 Work、Task 或 Bash 命令重新构建环境。环境在受到污染、工具链改变、安全域改变或明确请求干净复现时才会回收重建。

### 8.3 成员 workspace 与并行写入者

默认情况下，每个 AgentTeams 成员拥有一个长驻的 Worker 控制运行时和自己的无凭据执行区域。成员不共享可写文件系统。

代码以精确 Git commit 的形式在成员之间移动。其他稳定内容以 ContentRef 的形式移动。成员可以共享受控的只读 Git 对象、软件包和构建缓存、内容存储以及带命名空间的测试服务。

同一成员和同一 Work 的串行 Task 可以复用主 workspace。并行写入者使用不同的 worktree 或可写根目录。两个活跃写入者绝不能同时拥有同一个可写根目录。

独立 review、干净测试、不受信源代码或复现任务，可以在需要时使用干净 workspace 或临时 sandbox。这不是所有 Task 的通用要求。

### 8.4 OS 能力边界

执行进程树使用多层防御控制，例如：

- 非 root 身份；
- 丢弃 capabilities 并启用 no-new-privileges；
- 只读系统根目录；
- 明确指定的可读、可写挂载；
- 干净的环境变量；
- 进程、CPU、内存和时间限制；
- 阻断主机、控制和元数据端点；以及
- 作用于整个进程树的网络策略。

控制路径、运行时路径和不适合执行的临时挂载保持 `noexec`。在编译器、本地软件包或测试有需要时，可以允许明确的构建/workspace 路径执行。可执行性不等于获得凭据、网络或路径逃逸能力。

取消、预算终止和环境回收会杀死并确认整个进程树，而不只是父 shell。

<a id="9-tools-network-and-adapters"></a>
## 9. 工具、网络与 Adapter

### 9.1 Bash 是一等本地工具

Tiangong 将 Bash 作为包装后的顶层模型工具暴露出来。Agent 可以在准备好的执行环境中使用普通 shell 语法、管道、重定向、Git、软件包管理器、构建工具和脚本。

Tiangong 不会注册 Bash 调用的每一个可执行文件，也不会为每条命令创建一个容器。

运行时会拦截顶层工具调用，绑定操作者、Work/Task 和执行环境，应用资源限制，并捕获有界结果。Shell 文本分析可以用于警告、改善 UX 或拒绝明显错误，但它不是文件系统、凭据或网络安全边界。Shell 语法无法可靠地被白名单化。

read、edit、write 等捆绑的本地文件工具也可以作为便利工具暴露。它们使用与 Bash 相同的环境能力边界。

### 9.2 按成员配置网络能力

网络访问是 MemberConfig 的一项能力。

面向研究的成员可以获得面向读取的搜索和文档出口，同时不接触核心私有源代码。这应通过用途特定的代理或 Adapter 实现，而不是提供任意的、可写入的原始 Internet socket。面向实现的成员可以获得核心源代码，但只能访问用途受限的精确 Git fetch、软件包注册表和指定测试服务。

出口控制通过网络命名空间、代理或等效的强制机制作用于整个进程树。子进程、脚本和 `curl` 都不能绕过。云元数据、主机控制端点、平台控制服务和未经批准的内部网络始终被拒绝。

私有 Git 和软件包访问使用范围受限的只读代理、凭据助手或准备服务。原始凭据不会暴露给 Bash。

白名单目标仍可能被滥用，依赖也可能是恶意的，自由文本上下文还可能包含敏感数据。能力分离是首要后盾；有界监控用于发现和响应，而不是声称能够证明预防成功。

### 9.3 三类顶层能力

Tiangong 区分：

1. **本地执行工具** —— 在准备好的 sandbox 中运行的 Bash 和可选本地文件工具；
2. **外部系统 Adapter** —— 对仓库、数据库、日志、云系统、部署系统、通知、工单和其他外部服务提供版本化、类型化的访问；
3. **Kernel 命令** —— 创建或取消 Task、提交 Result、终止 Work、处理精确 Approval 以及调用恢复控制。

MemberConfig 决定成员能看到哪些有限的顶层入口。这是正常的能力配置，不是全局可执行文件注册表。

只在准备好的 sandbox 内运行的扩展，可以作为本地工具。若扩展在控制域执行、持有凭据或能够修改外部状态，就必须成为 Adapter，并且不能绕过 Operation 策略。

### 9.4 Adapter 合同

一个 Adapter：

- 拥有稳定的身份和版本；
- 校验类型化请求和目标；
- 执行成员的数据范围或动作范围；
- 将范围受限的凭据保存在 Agent 可见内存之外；
- 对读取返回有界且脱敏的观察；
- 对写入创建不可变 Operation；
- 在报告安全的写入终态前，验证声明的后置条件；以及
- 当写入可能变得不确定时，提供特权的只读对账能力。

外部读取不是 Operation，但仍然需要身份、数据范围和脱敏检查。外部写入一律是 Operation。未知的写入类别会被拒绝。

Git push、软件包发布、部署、数据库变更、外部通知、工单变更和生产配置，都是 Operation 的代表。本地编辑、构建、测试、缓存更新和只读查询不是 Operation。

MCP 是本地工具或 Adapter 的可选传输方式，不会创建新的授权层。持有凭据或具备写能力的 MCP server 仍受 Adapter 和 Operation 规则约束。MCP 输出是不受信任的输入，不能授予权限。

<a id="10-content-and-execution-records"></a>
## 10. 内容与执行记录

### 10.1 ContentRef

Git commit 的标识方式是：

```json
{
  "repositoryId": "service-a",
  "commitSha": "def456"
}
```

其他持久化内容由 Adapter 所有的不可变或版本化引用标识：

```json
{
  "adapter": "document-store@1",
  "ref": "document-42/version-3"
}
```

可变路径不能作为 Result deliverable。其 Adapter 必须先创建快照或版本。显示名称和路径是 UI 元数据，不是身份。

Tiangong 不要求通用的内容 digest。需要 digest 的 Adapter 可以在自己的不透明引用中编码它。

只有当 Result 列出某个 ContentRef 时，该内容才成为正式的 Task deliverable。Tiangong 不会围绕这种关系构建通用内容仓库。

commit 标识源代码内容，不代表正确性。本地集成是普通 Task 工作。推送集成 commit 是一项 Operation。

### 10.2 ToolResult

ToolResult 是执行记录层中对一次顶层工具调用的不可变、有界观察。

```json
{
  "toolResultId": "tool-result-21",
  "workId": "work-123",
  "taskId": "task-456",
  "actorId": "member-9",
  "tool": "bash",
  "requestSummary": {
    "command": "npm test",
    "cwd": "service-a"
  },
  "resultSummary": {
    "exitCode": 0,
    "summary": "测试通过"
  },
  "outputRef": null,
  "startedAt": "2026-08-09T10:30:00Z",
  "completedAt": "2026-08-09T10:31:00Z"
}
```

Leader 级别的工具可以不关联 Task 上下文。Git HEAD、查询范围、目标或持续时间等工具特定细节，在相关时写入有界摘要；它们不是通用业务字段。

ToolResult 证明包装后的工具观察到了什么。它不证明 Agent 理解了观察，也不证明语义工作正确，更不证明外部写入发生过。

凭据、原始敏感 payload、未受限的 prompt 和无界日志不得进入 ToolResult。大型输出会单独存储，并通过引用关联。

活跃 Task 的 ToolResult 会一直保留到 Result 提交或取消。Result 的引用会通过 Work 留存期增加一个留存标记。其他 ToolResult、trace 和日志可以依据 ControlProfile 采样或过期。

### 10.3 存储类别

Tiangong 使用：

- **CoordinationStore**：存储 Work 时间线和投影、Task、Result、Operation 以及永久只追加的 Operation 事件；
- **Execution Record 存储**：存储 ToolResult、有界日志、trace、模型和 Skill 调用元数据以及诊断信息；以及
- **Git 和 Adapter 所有的内容存储**：存储持久化内容。

会话状态、待归单消息引用、Room cursor 和归单 lease、准备好的环境映射、写入锁、提醒计时器和请求重放记录属于基础设施状态，不是新的领域记录。

Operation 事件永远不会从 CoordinationStore 中采样。不存在第二个机器事实索引、哈希链台账或内容清单。

<a id="11-operations-and-exact-approval"></a>
## 11. Operation 与精确 Approval

### 11.1 不可变 Operation

Operation 是一项拟议的外部写入：

```json
{
  "operationId": "op-123",
  "taskId": "task-456",
  "adapter": "deploy@1",
  "action": "deploy",
  "request": {
    "target": "staging",
    "commit": "def456"
  },
  "preview": "将 commit def456 部署到 staging",
  "createdBy": "member-9",
  "createdAt": "2026-08-09T11:10:00Z"
}
```

创建后，Operation ID、Adapter、action、request、target 和风险相关的 preview 都不可变。可信 CoordinationStore 记录就是精确的授权对象；Tiangong 不另外增加 operation digest、business invocation ID、approval ID 或 approval-view digest。

所有决定外部效果的内容，都必须存在于类型化 request 中，并在 preview 中如实体现：适用的目标、动作、commit、查询或 mutation、配置、目的地和消息正文。如果所有与风险有关的属性都无法安全展示，就不能批准该动作。

Adapter 凭据是认证材料，不是隐藏的动作 payload。它们不会进入 Operation、prompt、preview、Bash 环境、ToolResult 或诊断信息，其值也不会被 fingerprint。Adapter 不得从凭据值推导 target 或 action。

以凭据轮换为例，request 指定目标、principal 和生成策略；随机值由 Adapter 或外部 secret manager 生成。最小 Kernel 不支持由 Agent 选择、却不会展示给 approver 的隐藏 payload，因为这种 payload 会改变动作而不被看见。

### 11.2 策略与 Approval

使用时，ControlProfile 会把不可变 Operation 分类为：

- 自动允许；
- 需要精确的 Human Approval；或
- 拒绝。

对于精确 Approval，运行时会发送并保存实际的有界 preview 及其通道投递元数据。已认证 Human 的操作会追加 `operation-approved` 或 `operation-rejected`，并直接引用 Operation ID。拒绝还会将 Operation 终止为 `operation-not-executed`。普通聊天文本不是授权。不存在独立的 Approval 对象。

运行时在处理该操作时验证当前 approver 策略，并在执行前立即再次验证。Approval、拒绝、过期、取消和执行开始之间的竞态会被串行化，因此 `operation-not-executed` 绝不会跟在执行开始事实之后。拒绝决定、使待处理路径失效的策略收紧或 Approval 过期，都会将 Operation 终止为 `operation-not-executed`；这些情况都不会执行、复活或取消 Task。过期前可以发送有界提醒。

同一个 Task 可以带着被拒绝或过期的工具结果继续运行，并选择另一种方法。之后的尝试是新的 Operation。

### 11.3 幂等执行

运行时重放记录会把同一个已认证的顶层工具调用映射到同一个 Operation ID。这条记录属于本地基础设施状态，不是业务图的一部分。

当后端支持时，Adapter 使用 Operation ID 作为后端幂等键。

调用后端前，运行时会持久化追加 `operation-execution-started`。一旦这条事实存在，Tiangong 就不会盲目重放正向调用。后端如果返回自己已经为同一 Operation ID 保存的结果，那是读取已有结果，不是产生新的效果。

### 11.4 已知与未解决的结果

只有三类事件能够建立一个已知的 Operation 终态：

- `operation-not-executed` —— 外部执行没有开始；
- `operation-succeeded` —— Adapter 代码确认 request 声明的后置条件；或
- `operation-safe-failure` —— request 没有成功，但 Adapter 代码确认没有未解决的持久效果。

安全失败不声称从未发生过任何瞬时效果。例如，它可以确认一次明确批准的即时补偿已经恢复显示的基线。

Adapter 不得仅凭模型声明、传输状态或乐观的后端确认来追加 success 或 safe failure。

以下两类事件会使 Operation 保持未解决：

- `operation-uncertain` —— 无法确认外部状态；
- `operation-recovery-needed` —— 已知存在错误或部分效果，但尚未修复。

未解决的 Operation 会阻止针对同一 Adapter 目标的冲突写入，也会阻止两种 Work 终止。它不会阻止无关的安全工作。Human 接受风险不能把未解决事实转换成终态事实。

Operation 状态是不可变事件的投影，不是可以单独编辑的状态字段。

### 11.5 对账与升级

执行开始后发生超时、断开、崩溃或后端响应有歧义，会产生 `operation-uncertain`。

对账使用特权的只读 Adapter 接口。它不是 Operation，也不会作为普通模型工具暴露。恢复控制器或已认证 Operator 可以触发对账；Leader 可以请求对账。

只有在确认请求的后置条件、确认未应用或确认已经恢复后，对账才能追加已知终态事件。已知存在残余效果时，追加 `operation-recovery-needed`。如果状态仍然未知，就保持不确定。

自动对账反复失败后，会升级给已认证 Operator。Operator 可以：

- 进行更深入的只读调查；
- 发起一项全新的、完全受控的恢复 Operation；或
- 将处理转交企业事件响应流程。

只有实际观察或修复才能建立安全终态事件。事件交接可以显示为升级或暂停，但它不是安全的 Operation 结果，也不允许关闭 Work。恢复责任在外部状态解决前仍属于原 Work。

### 11.6 回滚

终态 Operation 之后的回滚是另一项外部写入，是拥有新 ID、并重新经过当前策略和 Approval 检查的新 Operation。

Adapter 只有在不可变 request 和 preview 已完整描述立即补偿时，才可以在原始调用内部实现即时补偿。例如，部署 request 可以写明健康条件，以及健康检查失败时要立即恢复的精确 commit。这种补偿：

- 属于一项已批准的复合动作；
- 只在原 Adapter 调用内部运行；
- 在原 Operation 事件中记录正向操作和补偿的观察；以及
- 不能在之后作为可复用的 rollback 阶段被调用。

Tiangong 没有通用的回滚计划、回滚阶段身份或第二套阶段幂等协议。正向调用结果不确定时，必须先完成对账，再考虑新的回滚 Operation。

<a id="12-sessions-concurrency-budgets-and-closure"></a>
## 12. 会话、并发、预算与关闭

### 12.1 逻辑会话

Leader 为每个 Work 使用独立的逻辑会话。成员为每个 Task 使用独立的逻辑会话。每个会话一次只处理一个 turn。

会话只是便利机制，不是权限来源。等待 Human 输入或长时间不活跃时，会话可以释放，之后再根据 Work 时间线、TaskSpec、定向背景、Result、ToolResult 和 Operation 事实重建。会话 transcript 可能包含敏感内容，应遵循 Execution Record 留存策略。

### 12.2 模型与预算

AgentTeams 官方控制面定义 Provider、凭据和每个 Worker 的当前 model。ControlProfile 给出模型、token/成本/时间和并发上限，MemberConfig revision 保存 Tiangong 当前接受的 Worker model 投影。三者必须一致；AgentTeams 管理员变更会使旧 revision 和旧 Session 失效，普通聊天不能修改它们。模型 fallback 必须明确；一个 provider 失败时，Tiangong 不会悄悄切换 provider 或模型。

预算或资源耗尽时，系统会停止新的模型调用和本地执行进程，记录这一事实并通知 Leader。它不会伪造 Result，也不会删除已经开始的 Operation；该 Operation 仍按正常结果和恢复规则处理。Leader 可以取消、重新委托或缩小工作范围。经过授权的管理员可以修改当前配置；普通聊天不能增加预算。

### 12.3 乐观并发与命令幂等

Work 的 `epoch` 是内部乐观并发令牌。协调写入带上它读取到的 epoch，成功时原子递增。Epoch 不是 WorkSpec 版本、语义依据、幂等键或完成标准。

在已认证操作者和命令类型的范围内，`requestId` 会原子地绑定到规范化请求和有界响应。重复相同请求时返回保存的响应；使用相同 ID 提交不同内容会发生冲突。重放记录是有界的基础设施状态，不会出现在 Work 时间线中。消息接纳使用平台消息标识符作为重放身份；保存的接收回执不会冻结 Work ID。返回的当前关联必须从消息关联投影读取，因此之后的纠正不会被重放撤销。

存储至少为以下操作提供原子边界：

- 消息接纳与 Work 创建；
- 消息关联纠正、两个 Work 的时间线事实以及当前绑定投影更新；
- WorkSpec 事件、投影和 epoch 更新；
- Task 创建、时间线事实和 epoch 更新；
- Result 提交与 Task 取消之间的竞争；
- Work 终态事件、投影和 epoch 更新；以及
- 在调用外部系统前记录 Operation 执行开始。

### 12.4 ResultGuard

`ResultGuard` 是 `submitResult` 中的本地校验，不是记录或服务。它只执行第 6.4 节所列检查以及 Result/取消竞态检查，不判断专业质量。

### 12.5 CloseGuard

在 `complete-work` 或 `stop-work` 之前，`CloseGuard` 验证机器事实：

- 操作者是当前 Leader，且 Work 仍然开放；
- `complete-work` 的当前 WorkSpec 非空；
- 每个 Task 都有 Result 或取消事实；
- 没有 Task 仍有活跃 turn、进程树或写入锁；
- 每个 Operation 都是 `not-executed`、`succeeded` 或 `safe-failure`；
- 没有待处理的 Approval，也没有不确定、需要恢复或未解决的事件路径；以及
- 每个被引用的 deliverable 仍然可以解析。

有 Result 的 Task 投影为 `reported`；不存在逐 Task 的 `accepted` 或 `blocked` 处置，也不存在 CoordinationDecision。`complete-work` 本身就是 Leader 对 WorkSpec 已满足的语义确认。CloseGuard 不能把这个判断重新包装成第二份逐 Task 记录。

CloseGuard 直接读取 Task、Result、ContentRef 和 Operation 的事实来源。它不会建立中间证据索引，也不会信任调用者选择的一份依据列表。

Leader 独自判断 WorkSpec 在语义上是否满足。关闭、对应的时间线事实、终态投影和 epoch 更新是原子的。Work 终止后，迟到的 Result、取消、Approval 和协调写入都会被拒绝。

<a id="13-security-model"></a>
## 13. 安全模型

### 13.1 抵御未授权效果和泄露的三层控制

Tiangong 使用分层控制，而不是单一命令过滤器。

1. **凭据隔离。** Bash 没有仓库写入、部署、生产数据库、带 token 的 API 或平台控制所需的凭据。这些凭据只保留在范围受限的 Adapter 中。
2. **网络强制。** 出口策略将无凭据的外部操作和数据泄露限制在已配置的目标与协议内。它作用于整个进程树，而不只是父 Bash 命令。
3. **能力分离与监控。** 拥有广泛搜索或文档出口的成员不会获得核心私有源代码；拥有核心源代码的成员只获得用途受限的 fetch、软件包和测试访问。有界记录和网络监控用于发现和响应允许渠道中的残余滥用。

Shell 文本分析在这三层中都只是辅助措施。

### 13.2 主要控制

主要控制包括：

- 已认证的 AgentTeams 身份和路由验证；
- 当前 ControlProfile 和 MemberConfig 检查；
- Worker 控制域与 Agent 执行域的分离；
- 具有明确路径和网络边界的非 root、最小能力进程树；
- 数据能力与出口能力配对；
- 只由 Adapter 持有的范围受限凭据；
- 不可变、类型化的 Operation 和精确 Approval 事件；
- 调用前记录执行开始，以及禁止盲目重放；
- 由 Adapter 验证外部终态；
- 只读对账和 Operator 升级；
- 单活跃 Task 执行和单可写根目录所有者；
- Work epoch 和请求幂等；以及
- 直接从来源保留时间线、ToolResult 引用和 Operation 事件。

### 13.3 信任边界的限制

本设计不防护受信管理员重写 CoordinationStore、替换 Adapter、改变目标配置或控制主机。因此，它不会针对这些操作者增加签名链或内容锚点。

外部后端可能撒谎或发生故障。Tiangong 可以要求 Adapter 进行检查并记录观察，但无法证明超出其受信 Adapter 和外部系统权限范围的事实。

白名单网络服务、软件包注册表、依赖以及 Human 或 Leader 的 prose，仍可能成为泄露渠道。成员分离、脱敏和监控能够降低风险，但无法消除风险。

<a id="14-system-invariants"></a>
## 14. 系统不变量

1. 每个 Work 都从一条经过认证、去重的 Human 消息开始。
2. 每条 Human 通道消息最初都由 Leader 使用平台消息标识符恰好接纳一次；UI 选择和调用方提供的 Work 标记都不能授予关联。受限且经过认证的纠正可以更新当前关联，但绝不会删除历史、迁移 Task 或 Operation 事实，也不会引入通用合并协议。
3. WorkSpec 历史由完整的 `work-spec-changed` 时间线快照构成；当前 WorkSpec 只是它们的投影。
4. 当前 WorkSpec 为空时，不会创建 Task。
5. TaskSpec 和 assignee 不可变；之后的 WorkSpec 变化不会悄悄修改它们。
6. Kernel 没有 task-kind、workflow-stage、dependency-DAG、固定角色或强制验证协议。
7. 每个 Task 至多有一个活跃执行所有者和一个 Result。
8. Result 提交和 Task 取消是原子竞争者。
9. Result 是 Agent 报告，不是机器质量判定，也不需要 accept/reject disposition。
10. 每次新的受控动作都会检查 AgentTeams 身份、ControlProfile、MemberConfig 和运行时能力绑定。
11. Prose、Skill、检索、工具输出和 MCP 输出都不能授予能力。
12. Agent 控制的进程无法读取控制平面、provider、生产环境、容器运行时或主机控制的凭据和状态。
13. 两个并发写入者绝不会拥有同一个可写根目录。
14. Bash 可以在自己的能力 sandbox 中运行任意本地命令；Shell 解析不是安全边界。
15. 广泛的搜索或文档出口与核心私有源代码不会被配置到同一个成员执行环境中。
16. 每个外部写入都是不可变的 Operation，其定义效果的 request 会显示在风险 preview 中。
17. Approval 是针对一个不可变 Operation ID 的已认证事件；聊天 prose 不是 Approval。
18. 运行时会在调用外部后端前记录执行开始。
19. 只有 Adapter 代码确认所需的外部后置条件后，才会写入 success 和 safe failure。
20. 不确定或需要恢复的 Operation 绝不会被盲目重试、靠断言宣布安全、通过取消 Task 隐藏，或转移到另一个 Work。
21. 后续重试或回滚都是新的 Operation；唯一例外是完全包含在原始不可变 request 和调用中的即时补偿。
22. Operation 事件是永久的、只追加的 CoordinationStore 事实。Result 引用的 ToolResult 会在 Work 留存期内保留。
23. 终止 Work 要求每个 Task 都有 Result 或取消事实，每个 Operation 都有安全终态事件，并且没有活跃执行所有者。
24. 只有 Leader 决定 Work 在语义上是否完成；Kernel 的关闭检查不编码专业流程。
25. 新的硬控制在进入 Kernel 前，必须有具体威胁、机器可验证属性以及明确的摩擦分析。

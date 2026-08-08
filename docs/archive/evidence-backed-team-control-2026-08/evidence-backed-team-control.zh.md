# 证据支持的团队控制架构

> 状态：已采纳的取代性目标架构；合同规范草案，仍在闭合中。它取代固定的五角色、固定 TaskKind、TeamPlaybook 路径，作为 Tiangong 的目标方向。公开 v0.2 仍是当前实现基线，直到每个目标边界被实现和验证。本文不授权任何交付声明。
>
> 范围：协调、信任与完成、外部效果与授权、组织与行为塑造、质量与环境、知识检索，以及运行时闭合的目标控制合同。平台特定的 adapter、物理拓扑、迁移和未验证的延迟合同仍是实现工作。
>
> 译注：本文是非规范性翻译快照，可能落后于英文主规范。合同争议的唯一权威来源是 [`evidence-backed-team-control.md`](evidence-backed-team-control.md)（英文）。

## 1. 目的

Tiangong 协调一个 AI 团队，能够理解一个软件系统、规划工作、委托有界的 Task、产出并验证交付物、与人类交互，并执行已批准的外部效果。

控制架构必须在不把模型叙述当作机器事实的前提下，保持 Agent 和 Team 的自主性。因此它约束关键边界，而非规定每个活动。

目标设计不是一个固定的软件交付流水线，也不是一个通用工作流 DSL。

## 2. 设计哲学

### 2.1 约束而非编排

Agent 和 Team 都不被驱动通过预定义的活动序列。Agent 可以探索、编辑、测试、使用工具并修订其方法。Leader 可以随 Work 演进创建、并行化、替换或停止 Task。

运行时在信任边界介入：

1. 用指令、Skill、检索到的知识和 Concern 塑造行为；
2. 在未授权或不安全的动作发生前 gate 它们；
3. 在可信边界执行后捕获机器事实；
4. 在密封 Result 前检查最低的机器可证明条件；
5. 在机器事实不足处要求 Leader 或 Human 的语义决策。

### 2.2 两个自主循环

Agent 循环是：

```text
Task
  -> 指令 + Skill + RAG + Agent Concern
  -> 自主工作
  -> Tool Gate + Evidence 捕获
  -> Result candidate
  -> Completion Check
  -> 密封的 Result 或继续工作
```

Team 循环是：

```text
Work
  -> Leader 理解和规划
  -> Task 委托
  -> Result 提交
  -> Leader 验收、替换或跟进
  -> 需要时的 Human 交互
  -> Work 完成决策或继续工作
```

框架拥有确定性的安全、身份、持久化、恢复和证明。Leader 拥有语义解释、规划、委托和沟通。

唯一 Leader 意味着一个协调权威，不是一个全局可变模型 session。不同的 Work 可以在团队容量内并发地接收隔离的 Leader turn。一个 Work 至多一个当前 fenced Leader-turn 租约，且每个协调提交仍使用 Work-head compare-and-swap。

### 2.3 一个 Task 永不等待 Human

专业 Agent 不会在等待 Human 输入或授权时挂起 Task。每个已派发的 Task 恰好以一个正式 Result 结束。一个未派发的 Task 可以转而被 CoordinationDecision 终态取消：

- `completed` —— 生产者声明 Task 目标已完成；
- `blocked` —— 需要外部决策、授权或依赖；
- `failed` —— 执行或可信机器边界失败。

Leader 处理 Human 交互，并在答案或授权被记录后创建新的 Task。精确的高风险授权使用两个 Task：

```text
Prepare Task -> Human 授权 -> Execute Task
```

### 2.4 单一真相源

同一事实不被复制到多个记录。

示例：

- Result 不存储生产者或创建时间；可信 Evidence 记录已认证的提交者和 ledger 时间。
- Work 不存储可变状态；它从不可变记录投影。
- Task 不包含 Result 引用；Result 指向 Task。
- Supersession 和验收是 CoordinationDecision，不是可变标志。
- 一个正式 Task 是允许后续调度器派发的持久委托；没有独立的 DispatchIntent 复制该权威。

### 2.5 Claim 不是 Evidence

以下是分离的事实：

- 模型或 Human 的 claim；
- Artifact payload；
- 机器状态；
- 机器捕获的 Evidence；
- 语义验收；
- 授权。

Result 是一个 claim 和一次交接。Evidence 只证明一个被授权的 Recorder 在精确的 EventDefinition 下记录了一次有界观察；其保证受限于该 Recorder 和部署信任边界。它本身不证明外部效果、语义正确性或源真相。Completion Check 是必要的机器认证条件。一个有效的 Leader 或 Human 支持的验收 Decision 是精确策略下的权威语义处置，不是 Result 客观正确的证明。

### 2.6 含义、合法性与策略是分离的

对于一个权威协调动作：

```text
action  -> 记录的含义
Guard   -> 它现在是否合法
Leader  -> 为何以及何时选择它
```

因此 `CoordinationDecision.action` 是一个代码拥有的语义判别符。它不定义流程顺序。仅用于显示的 purpose 和 category 标签是非权威的。

### 2.7 不可变事实，派生视图

Work revision、Task、Result 和 CoordinationDecision 不可变。Ready、running、stale、accepted、rejected、superseded 和 terminal 是派生视图。旧事实永不被重写以制造更干净的历史。

### 2.8 取代性目标与迁移边界

本架构取代当前固定的交付路径作为目标架构，不是关于已部署行为的声明。没有兼容性承诺要求目标 Kernel 保留过时的工作流权威。迁移是垂直的且 fail closed：一个目标合同只在其 schema、Guard、Evidence、恢复和确定性测试一起存在后才被使用。

| 当前公开 v0.2 机制 | 目标处置 |
| --- | --- |
| 五个固定 RoleProfile 和角色特定镜像 | 保留为第一方 `software-change-delivery` TeamDefinition 和 AgentDefinition 集合；从 Kernel 枚举中移除。 |
| 固定的 `design`、`implement`、`assess` 和 `release` TaskKind | 作为协调权威移除；目标和输出移至 WorkSpec、TaskSpec、Policy、Skill 和 Checker 合同。 |
| TeamPlaybook 和 TransitionPolicy 阶段路径 | 仅作为当前实现和参考材料保留；不被包装为目标工作流或 DSL。 |
| WorkRun、ProjectBinding、TaskBinding 和 ResultEnvelope | 当垂直目标路径就绪时，被 Work、Task、Result、CoordinationDecision、TaskRun 和 ResolvedWorkPolicy 记录取代。 |
| AgentTeams Project/Task 文件和 Matrix 消息 | Adapter 传输、存储载体或投影；叙述和可变平台文件不是第二套语义权威。 |
| 文件 hash chain、幂等存储、Journal 和对账 | 有用的实现基础，升级为此处的精确 ledger、Command、Operation、Anchor、fencing 和恢复合同。 |
| Docker Runner 和部署客户端 | 可替换的 Adapter，服从精确的 Workspace、Environment、Operation、Approval、Receipt 和清理合同。 |
| OpenTelemetry | 仅作为脱敏诊断；绝不作为 Evidence、授权或 Completion 证明。 |

当前代码和发布文档在迁移前继续描述 v0.2。一个第一方 profile 可以保留其经过验证的专业分离，而不使这些角色或其顺序成为通用的。

### 2.9 所有权边界

| 边界 | 拥有 | 不拥有 |
| --- | --- | --- |
| AgentTeams | 实际的 Team 和 Worker 资源生命周期、容器、平台存储传输，以及平台身份和凭证。 | Tiangong Work 语义、专业完成、Approval、Evidence 含义，或目标 roster 准入。 |
| OpenClaw | Matrix 登录、E2EE 和 room 行为、allowlist、mention、sync、媒体、排队和交付机制。 | Agent capability、Human 决策含义、审批权威，或 Result 验收。 |
| Tiangong | Worker 运行时、TeamDefinition 准入快照、Work、Task、Result、Decision、Policy 解析、Capability、Context、Gate、Evidence、Completion、Approval、质量和恢复。 | 平台资源创建，或不被支持的平台隔离保证。 |
| TeamDefinition | 被准入到一个 Tiangong roster generation 的精确平台 Team 和 Worker 绑定的不可变集合。 | 可变的平台 presence、健康、生命周期，或对平台 roster 变更的自动采纳。 |
| Runner、存储、模型、索引和效果 provider | 通过已审核 Adapter 暴露的有界物理执行或存储行为。 | Policy、Artifact 身份、Evidence 权威、Context 权威，或授权。 |

平台状态对一个平台资源和已认证身份是否实际存在具有权威。TeamDefinition 对该精确绑定是否被准入到一个 Work 具有权威。派发要求两者匹配。平台 roster 或 Worker-generation 变更永不修改 TeamDefinition；它要求一个新的 TeamDefinition 和显式的 Work revision。

AgentTeams 文件和消息可以物理地携带严格的 Tiangong 记录。它们的权威随后来自 Tiangong schema、digest、Evidence 和 Guard 验证，而不是文件名、可变叙述、room 角色或传输交付。Tiangong 不重新实现平台 Team、容器、Matrix 或存储生命周期。

一个部署只有在端到端验证平台身份、Matrix、存储、容器、网络、凭证、Runner、知识 realm、模型 provider 和管理边界后，才能声明租户隔离。否则其安全档位明确为单租户，即使标识符包含租户字段。

### 2.10 威胁模型与保证上限

模型、模型叙述、Human 叙述、Skill、检索到的内容、仓库和文档字节、Workspace 输出、外部响应，以及可变传输状态是不可信输入。一个模型不能通过重复 Policy、Evidence 事件、工具响应或源文档而变得可信。

可信计算基有意被限定为：已认证的平台身份 adapter；版本化的 Control 和 Completion Kernel；schema 和 registry 验证；Policy 解析；Guard 和 Checker；Artifact、受保护 payload、Journal 和 Evidence 存储；Anchor 签名和 trust-root 服务；fencing 和租约管理器；以及每个 Recorder 或效果 Adapter 仅对其 allowlisted 的观察。每个成员都是 pinned、可撤销、最小权限，且独立地无法扩展自己的权威。

保证上限是显式的：

- Evidence 证明一个被授权的 Recorder 记录了定义的观察；一个被攻陷或有缺陷的 Recorder 可以在其权威内伪造事实。
- 一个 Anchor 相对可信的已签名 frontier 检测后期的 mutation、截断、gap 和 fork；它不证明一个事件在被记录时为真，或不证明一个被省略的 pre-Anchor 动作从未发生。
- Receipt 加上已验证的 postcondition，而非 Recorder 叙述本身，确立一个外部效果结果，达到 Adapter 和 provider 的有界保证。
- 一个 Worker 或容器被攻陷会使暴露给该边界的事件族和密钥失效。容器隔离和持有 Docker socket 不是 hostile-host 安全边界。
- 平台或主机管理员在本地单租户档位中被信任。一个 hostile-administrator 或多租户声明要求一个单独验证的档位，具有分离的凭证、存储、网络、签名密钥、Runner、索引和管理权威。
- 未知的身份、密钥状态、schema、完整性、隔离、provider 结果、时钟健康或恢复状态 fail closed。可用性损失可以延迟派发或中止执行，但永不扩大权限或制造证明。

支持的部署档位是有限的、已审核的 Policy 包。初始公开档位是本地、单租户、operator 信任的。一个更强的档位是一个新的已验证合同，不是从目标架构的推断。

## 3. 概念分层

### 3.1 业务平面

用户和 Leader 主要围绕以下推理：

```text
Work -> Task -> Result
```

- Work：为一个 Human 目标的一个演进中的 Team 事务。
- Task：对一个负责 Agent 的一次不可变委托。
- Result：一个 Task 的不可变终态交接。

### 3.2 信任基础

四个概念构成信任链：

- Artifact：产出了什么；
- Evidence：可信机器边界观察到了什么；
- Operation：一个外部副作用；
- Approval：对一个精确或有界 Operation 的授权。

Artifact 和 Evidence 是正交的。Artifact 是输出载体；Evidence 记录一个被授权 Recorder 的有界观察。执行保证来自精确的事件序列，以及对外部效果的 Receipt 和已验证 postcondition。Operation 保留给外部副作用，不代表每次读、写或测试工具调用。

### 3.3 轻量组织

Finding 是 `Result.findings` 中的一个结构化条目。它不是独立的 aggregate。Leader 可以在后续 Task 中引用它，或将其晋升为长期 issue 或 Artifact。

没有通用的 Change 对象。代码、配置、文档和测试变更是 Artifact 种类。

### 3.4 支撑协调记录

CoordinationDecision 是一个必需的不可变后端记录。它表达验收、拒绝、Work revision 链接、Task 替换、Result carry-forward、取消、Work 终止和显式撤销。

一个 Evidence 事件认证谁记录了该 Decision，并在 Recorder 和部署保证边界内提供可信 ledger 时间；它不替代 Decision 的语义。Leader turn 使用运行时 Evidence 和租约，但不创建 LeaderRun 或 CoordinationTurn 业务 aggregate。权威仍留在一个 turn 成功提交的 Work、Task、Result 和 CoordinationDecision 记录中。

## 4. 通用记录与命令纪律

所有协调记录：

- 使用 4.1 节的规范化合同；
- 有一个版本化的 `schema`；
- 密封后不可变；
- 对除记录自身 `contentDigest` 字段外的每个字段计算 `contentDigest`；
- 拒绝未知字段；
- 不含通用 metadata 或扩展 bag；
- 省略自报告的 actor 和时间；
- 使用包含身份和 content digest 的精确引用；
- 拒绝裸 ID 和悬空引用。

记录真实性和可信时间来自 Evidence ledger。

### 4.1 规范化、SchemaRef 与 digest 编码

所有签名或哈希的 JSON 使用版本化的 Tiangong JCS profile，基于 [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)。`tiangong-jcs/v1` profile 要求有效的 I-JSON 输入、UTF-8 编码、无重复对象名、无孤立 Unicode 代理项、无 Unicode 规范化，以及无超出绑定 schema 的值。JSON 数字限于安全整数；十进制量、金钱、高精度计数器和时间戳使用 schema 定义的规范化字符串。NaN、infinity、负零、`undefined` 和实现特定的数字值无效。

JCS 对象排序是权威的。数组顺序被保留且是语义的；当顺序无关时，拥有的 schema 定义唯一排序键并拒绝重复。省略和 `null` 是不同的：一个可选项的缺失字段被省略，`null` 只在精确 schema 要求处合法。

一个 digest 是小写的 `sha256:<64 个小写十六进制字符>`，覆盖拥有的合同选择的精确字节。对于一个记录的 `contentDigest`，输入是移除该记录自身 `contentDigest` 后的 JCS 编码；嵌套的被引用 digest 保留。签名和事件哈希显式声明各自选择的字段。本文档示例中的 digest 和签名值，包括 `"sha256"` 和 `"sha256:<64hex>"`，是非验证占位符，除非显式标识为测试向量。

一个 SchemaRef 是对非可执行结构 schema 的精确引用：

```json
{
  "schemaId": "tiangong.schema/work-spec",
  "version": "1",
  "contentDigest": "sha256:<64hex>"
}
```

Schema 包是不可变的、已审核的、内容寻址的，并为使用它们的记录保留。一个 schema 变更创建新的版本和 digest；当前 registry 选择永不改变历史解释。跨语言 Adapter 必须通过通用的规范化和 digest fixture，才能写入权威记录。

### 4.2 CommandEnvelope 与幂等 replay

每个权威命令通过严格的 CommandEnvelope 进入一个可信命令边界：

```json
{
  "schema": "tiangong.command-envelope/v1",
  "commandId": "cmd-123",
  "commandType": "create_work",
  "commandDefinitionRef": {
    "implementationId": "command/create-work",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "payloadDigest": "sha256",
  "expectedStateRefs": [],
  "contentDigest": "sha256"
}
```

精确的 CommandDefinition pin 住 payload SchemaRef、身份派生、已认证权威规则、Guard、expected-state schema、原子输出 schema、EventDefinition、脱敏和恢复行为。它是已审核代码，不是 Prompt 定义的命令。

已认证的 ingress、Leader 运行时、调度器、Agent 运行时或管理边界在自己抗碰撞的命名空间中派生或分配 `commandId`。模型提供的 ID 永不被直接信任。稳定源身份的示例：ingress 的精确 channel-message 身份、调度器派发的 TaskRef 加派发 generation，以及 Agent 命令的 TaskRunRef 加 Context 调用和调用序号。已认证 actor 和可信时间来自执行上下文和 Evidence，不是信封。

在任何权威输出变得可见之前，命令边界持久化有界的 CommandEnvelope 并预留其幂等身份。原始或受保护的命令 payload 在恢复需要它时留在受保护存储中，且仅由 `payloadDigest` 绑定；它不进入信封或 Evidence。

幂等存储绑定命令边界、CommandDefinitionRef、commandId、信封 digest 和已提交输出引用。相同 replay 返回精确的已保存输出，不重新执行。相同身份配另一个信封或 payload digest 则冲突。Expected-state 引用是 CAS 前置条件，不是命令身份。一个多记录命令使用一个事务，或一个 write-ahead intent、outbox 和 visibility commit，以提供相同的 replay 语义。信封、幂等绑定和输出引用在其审计和 replay horizon 内保持可用。

## 5. 包 1：协调 —— Work 合同

包 1 包含第 5–15 节，定义 Work、Task、Result、CoordinationDecision、调度合法性、完成出口、Evidence 含义、恢复和并发，而不规定工作流。

Work 有一个稳定的逻辑 `workId` 和一个或多个不可变物理 revision。

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

| 字段 | 合同原因 |
| --- | --- |
| `schema` | Pin 住解释。 |
| `workId` | 把不可变 revision 连接到一个逻辑事务。 |
| `revision` | 支持单调 scope 版本化、并发检查和缺失 revision 检测。 |
| `teamRef` | Pin 住负责的 Tiangong TeamDefinition 和已准入的 roster 快照。 |
| `specRef` | Pin 住目标、scope、验收标准和 Human 约束。 |
| `policyRef` | Pin 住已解析的预算、质量、报告和审批策略。 |
| `contentDigest` | 让 Task 和 Decision 绑定一个精确的 Work revision。 |

Work 排除可变状态、当前标志、内联 scope 副本、请求者、时间戳、角色绑定、进度、任意 metadata 和直接的 supersession 字段。Revision 关系是 CoordinationDecision。

### 5.1 Human ingress 与 Work 身份

每个独立的 Human 目标创建一个独立的 Work。对一个精确 HumanInteraction 或 Work 引用的回复向该 Work 追加输入；一个显式的 scope 变更可以产生新的 Work revision。精确的 channel-message replay 返回原始准入结果。歧义输入永不静默修改既有 Work，而在策略允许时创建新的 Work。

IngressPolicy 是一个严格的平台或租户管理 Policy，在 Work 创建前评估，并可为精确的团队身份收窄。它不是 TeamPolicy slot，永不物化进 ResolvedWorkPolicy。它控制认证、去重、路由、滥用和硬租户配额，以及初始 HandlingPolicy 选择。它不能决定 Work 语义、创建 Agent capability、授权 Operation 或替代 Leader 判断。

Ingress 有一个非循环的准入协议：

```text
在管理 ingress ledger 中记录 human-request.received
-> 评估精确的 IngressPolicy 和已认证路由事实
-> 拒绝时，追加 human-request.admission-denied
-> 允许时，预留 workId 和 Work ledger
-> 原子地或 outbox 等价地提交：
     Work + work.recorded + human-request.admitted(WorkRef)
-> 只有在三个绑定都验证后才使 Work 对 Leader 调度可见
```

`create_work` 消费 received EvidenceRef 和当前正面策略评估；它不要求预先存在的 `human-request.admitted` 事件。admitted 事件是持久的正面决策，绑定结果 WorkRef、Work 记录 EvidenceRef、精确 IngressPolicyRef 和 received EvidenceRef。如果管理 ledger 和 Work ledger 使用不同物理存储，一个 write-ahead intent 和 outbox 恢复精确预留的身份；部分输出在 visibility commit 前保持不可见。Replay 完成那个 outbox 或返回原始 Work，永不分配另一个 Work。

每个 ingress 事件绑定精确 IngressPolicyRef、可信 channel-message 身份和有界 payload digest。原始 Human 内容是 HandlingPolicy 下的 Claim Artifact。被拒绝的输入保持为有界的管理事实，而非从审计中消失。

每个已认证、策略可准入的请求都被持久捕获，即使没有 Leader 或 Task 执行 slot 可用。执行容量可以延迟 Leader turn 或 Task 派发，但不能创建未定义的 pre-Work 队列。因此 `maxOpenWorksPerTeam` 不是执行并发控制；租户准入和滥用限制只属于 IngressPolicy。

不同的 Work 有独立的 revision、ResolvedWorkPolicy、Human 权威、Evidence Ledger、Task、Result、Decision、预算、报告、Context 和 Handling 边界。共享 TeamDefinition 或 Leader 永不合并它们的记录、机密内容或权威顺序。

### 5.2 WorkSpec 与 TaskSpec Artifact

WorkSpec 和 TaskSpec 是严格的 typed Artifact payload。它们的正式身份是来自第 19 节的外层 ArtifactRef；它们的 payload 不携带另一个 ID 或 content digest。一个最小的 WorkSpec payload 是：

```json
{
  "schema": "tiangong.work-spec/v1",
  "objective": "Deliver the bounded Human objective.",
  "scope": {
    "included": [],
    "excluded": []
  },
  "acceptanceCriteria": [
    {
      "criterionId": "criterion-1",
      "statement": "The requested behavior is delivered and independently verified."
    }
  ],
  "inputRefs": [],
  "humanConstraintRefs": []
}
```

一个最小的 TaskSpec payload 是：

```json
{
  "schema": "tiangong.task-spec/v1",
  "objective": "Produce the exact delegated outcome.",
  "workCriterionIds": ["criterion-1"],
  "expectedOutputs": [
    {
      "artifactSchemaRef": {
        "schemaId": "tiangong.artifact-schema/change-set",
        "version": "1",
        "contentDigest": "sha256"
      },
      "minimumCount": 1,
      "maximumCount": 1
    }
  ],
  "semanticConstraints": []
}
```

字符串和数组由其精确 SchemaRef 限定。WorkSpec 的 `inputRefs` 是精确的已提交 RecordRef 或 ArtifactRef；`humanConstraintRefs` 是在 HandlingPolicy 下捕获的精确 Claim ArtifactRef。Criterion ID 是唯一的，且仅在该精确 WorkSpec Artifact 内稳定。

TaskSpec 的 `workCriterionIds` 是唯一的，必须解析为 Task WorkRef 绑定的精确 WorkSpec 中的 criterion。Expected-output 条目有唯一的 SchemaRef、非负安全整数 cardinality，且 `maximumCount >= minimumCount`。它们陈述预期交付形状，但不创建 pending prerequisite；Task.inputRefs 仍是完整的已提交执行输入集。

Criterion 和语义约束是 Claim，不是机器证明或权限。WorkSpec 和 TaskSpec 不含角色、阶段、TaskKind、工作流边、工具授权、Approval、可变状态或扩展 bag。TaskSpec 不能静默添加 Work scope。CompletionPolicy 和 ClosurePolicy 提供分离的机器认证合同。

## 6. Task 合同

Task 是一次不可变委托。它没有 revision。对其 scope、assignee、input、执行约束或完成合同的任何变更都创建新的 Task。

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
    "memberId": "member-implementor",
    "memberBindingDigest": "sha256"
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

| 字段 | 合同原因 |
| --- | --- |
| `schema` | Pin 住解释。 |
| `taskId` | 提供稳定的团队路由和 Human 可读身份。 |
| `workRef` | Pin 住精确的 scope revision。 |
| `assigneeRef` | 在 Task WorkRef 内选择一个精确的团队成员绑定。 |
| `specRef` | Pin 住 Task 目标、预期结果和语义约束。 |
| `inputRefs` | Pin 住完整的不可变基线和已提交 input。 |
| `executionPolicyRef` | Pin 住工具、环境、预算和效果约束。 |
| `completionPolicyRef` | Pin 住最低的机器可证明完成合同。 |
| `contentDigest` | 让 Result 绑定精确委托。 |

`assigneeRef` 是一个有界的 MemberRef composite。Task WorkRef 解析一个精确的 TeamDefinition；`memberId` 选择一个成员，`memberBindingDigest = digest("sha256", jcs("tiangong-jcs/v1", exact member entry))` 绑定其 workerRef 和 AgentDefinitionRef，而不把它们复制进 Task。派发重新解析该条目，验证 digest 和活的平台绑定，并派生 provider、Worker generation、AgentDefinition 版本和成员并发上限。

Task 排除 TaskKind、可变状态或阶段、Task revision、supersession、重复依赖字段、内联语义规范、Skill 选择、环境和预算副本、Result 引用、Operation 和 Approval 引用、actor 和时间、父 Task 和 attempt 计数。

Task 创建是一个有资格进行确定性调度器派发的真实委托，不是草稿规划卡，也不是容量存在的证明。尚未被授权派发的 Leader 规划保持为推理或非权威的规划 Artifact，其 payload 是 Claim，不授予 Task 创建或派发权威。

## 7. Result 合同

```json
{
  "schema": "tiangong.result/v1",
  "taskRef": {
    "taskId": "task-123",
    "contentDigest": "sha256"
  },
  "outcome": "completed",
  "claim": "The Task objective was completed.",
  "artifactRefs": [],
  "evidenceRefs": [],
  "findings": [],
  "contentDigest": "sha256"
}
```

| 字段 | 合同原因 |
| --- | --- |
| `schema` | Pin 住解释。 |
| `taskRef` | 把交接绑定到一个精确 Task。 |
| `outcome` | 给出机器可读的终态含义：`completed`、`blocked` 或 `failed`。 |
| `claim` | 陈述生产者称已实现或阻止了什么。 |
| `artifactRefs` | 标识正式输出。 |
| `evidenceRefs` | 标识为支持该 claim 而提供的机器事实。 |
| `findings` | 保留可单独寻址的发现，供 Leader 处置。 |
| `contentDigest` | 给 Result 不可变身份。 |

一个最小的 Finding 包含一个 statement 和 Evidence 引用。一个 Finding 由 Result digest 和 JSON Pointer 寻址；它没有独立 ID 或可变状态。

Result 排除独立 ID、WorkRef、生产者、时间戳、assignee、输入副本、Skill 引用、验收策略、Completion Check 结果、验收状态、Operation 和 Approval 引用、下一步动作、blocker 分类、revision 索引、重复摘要和扩展 metadata。

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
  "claim": "The Result satisfies the current Work revision.",
  "contentDigest": "sha256"
}
```

| 字段 | 合同原因 |
| --- | --- |
| `schema` | Pin 住解释。 |
| `action` | 告诉确定性 Projection 该记录的含义。 |
| `subjects` | 命名精确受影响记录及其方向角色。 |
| `basisRefs` | Pin 住作为决策基础的事实和 Artifact。 |
| `claim` | 记录语义理由，不假装它是 Evidence。 |
| `contentDigest` | 启用精确引用和显式撤销。 |

权威 action 词汇表是：

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

一个新的 action 要求代码拥有的 subject schema、Guard、Projection 规则、truth table 和确定性测试。Skill、TeamPolicy 和模型不能发明 action。

CoordinationDecision 排除独立 ID、非权威类型、任意 payload、actor、时间戳、可变状态、反转标志、结果状态、metadata 和扩展字段。

## 9. 协调不变量

### 9.1 记录

1. Work、Task、Result 和 CoordinationDecision 不可变。
2. 每个引用解析到一个带匹配 digest 的已提交记录。
3. Actor 和时间来自 Evidence。
4. 操作视图是派生的，永不写回不可变记录。
5. 相同命令 replay 幂等；相同命令身份配不同输入是冲突。

### 9.2 Work

1. Genesis revision 是 `1`。
2. 新 revision 是当前 revision 加一。
3. 只有当前有效 head 可以被修订。
4. 禁止 revision fork 和循环。
5. 新 revision 不改变更早的记录。
6. 当前 head 从有效的 `revise-work` Decision 派生。

### 9.3 Task

1. 一个 Task 恰好一个 assignee。
2. Task 没有 revision。
3. 一个 Task 至多一个密封 Result。
4. 一个 Task 永不等待 Human。
5. 每个 input 必须在 Task 创建前已提交、可解析且已授权。
6. `inputRefs` 只指向更早的不可变记录或 Artifact。没有 pending prerequisite 或调度器拥有的依赖边。
7. 新 Task 绑定当前 Work revision。
8. 一个未派发的旧 revision Task 不能被派发。
9. 一个运行中的旧 revision Task 可以完成，但其 Result 不会自动在新 Work revision 下变得合格。
10. Task supersession 只针对当前 supersession 叶子，不能 fork 或循环。
11. 一个有效的正式 Task 是其精确委托的持久调度权威；没有独立的 DispatchIntent。
12. 派发资格要求 Task 是当前的、未派发的、未取消的、未 supersede 的、无 Result 或 TaskRun；每个精确 input 必须保持可解析、可用、已许可且未撤销；所有策略和安全事实必须保持有效。
13. 容量不足使 Task 保持未派发，无 TaskRun、等待的 Agent 或伪造的 blocked Result。
14. 派发原子地预留精确容量、记录 `task.dispatched`，并打开 Task 的唯一 TaskRun。

### 9.4 Result 与验收

1. 每个 outcome 在密封前通过其适用的 CompletionPolicy。
2. 一个失败的 Completion candidate 不是 Result。
3. `blocked` 和 `failed` 不能被作为完成验收。
4. Completion Check 通过是必要的。一个有效的 Leader 或 Human 支持的验收 Decision 是策略下的权威语义处置，不是客观正确性的证明。
5. 验收和拒绝不能对同一个 Result 都有效。
6. 一个来自祖先 Work revision 的 Result 在当前 revision 验收前要求有效的 `carry-forward-result`。
7. Carry-forward 要求 Result 已在其源 Work 中被验收。

### 9.5 Decision

1. `action` 是权威语义判别符。
2. Subject 角色和 cardinality 匹配 action schema。
3. Decision 合法性由协调 Guard 决定。
4. Decision 是 append-only。
5. 反转是一个新的 `revoke-decision`；原始记录保持为历史事实。
6. 一个 revoke 不能针对另一个 revoke。
7. 协调撤销不能抹除外部副作用。
8. Decision 引用在已提交 ledger 中向后指，不能循环。

### 9.6 调度

1. 调度器是可信机器协调，不是业务权威。
2. 它可以在代码拥有的 FairnessPolicy 和 Guard 下选择一个合格 Task 何时消费容量。
3. 它不能创建 Task、改变 assignee 或 scope、从模型叙述推断语义优先级、绕过策略或制造容量。
4. 队列、slot、租约和可用性是可变机器状态和可重建 Projection，绝不是 Work 或 Task 状态字段。
5. 公平性防止一个 Work 消费所有团队 slot；只有严格的、已检查权威的优先级输入可以影响排序。

### 9.7 Action 特定的 Decision 可撤销性

`revoke-decision` 有意收窄。"No unhandled irreversible dependency" 被实现为一个精确的 reverse-dependency Projection 和以下代码拥有的矩阵：

| 目标 action | 可撤销？ | 附加确定性条件 |
| --- | --- | --- |
| `accept-result` | 是，当 Work 开启时 | Result 无有效依赖的 Task 执行、已验收的下游 Result、carry-forward、QualityAssessment 消费、Operation、Approval、Human 处置或 Work 关闭。 |
| `reject-result` | 是，当 Work 开启时 | 无有效 replacement、依赖的 Task 执行、Human 处置，或终态 Work Decision 依赖该拒绝。 |
| `carry-forward-result` | 是，当 Work 开启时 | 目标 scope 的 Result 尚未被下游 Task、质量事实、效果或关闭验收或消费。 |
| `revise-work` | 否 | 修正创建一个更晚的 Work revision 或新 Work；已提交的后代永不被孤立。 |
| `supersede-task` | 否 | 修正从当前有效叶子创建另一个 replacement。 |
| `cancel-task` | 否 | 需要新 Task；被取消的委托不被静默复活。 |
| `complete-work`、`fail-work`、`cancel-work` | 否 | 终态 Work 永不被重开；修正或恢复从新 Work 开始。 |
| `revoke-decision`、`revoke-approval` | 否 | 撤销不能撤销自己或恢复已消费的权威。 |

任何本身可撤销的有效依赖 Decision 必须先被撤销，产生逆拓扑顺序。不可变依赖记录保持为历史，但 Guard 要求其有效权威被移除或终态解决。一个 TaskRun 启动、外部执行启动、已消费的 Approval、已交付的 HumanInteraction 或终态 Work Decision 对协调目的是不可逆的。撤销永不删除 Evidence、Artifact、Receipt、Journal 或外部状态。

撤销验收或拒绝使 Result 无有效语义处置。撤销 carry-forward 只移除目标 revision 资格，永不改变源验收。提交在目标 Decision、当前 Work head、reverse-dependency frontier 和当前 Leader epoch 上串行化；一个并发的后代或终态 Decision 胜出或冲突，而非被遗漏。

## 10. Scope revision 与 staleness

一个 scope 变更创建一个新的 Work revision 和一个 `revise-work` Decision。

- 旧 revision 上的一个未派发 Task 必须被替换。
- 一个运行中的 Task 可以完成以保留 Task 原子性。
- 其 Result 对该精确 Task 保持历史有效。
- 没有 carry-forward 时，它对当前 revision 验收不合格。
- 一个已验收的 Result 保持为已验收的历史事实。
- 当前 Work 关闭只考虑当前已验收的 Result 和显式 carry-forward 的祖先 Result。

因此 staleness 是一个关系，不是可变的 Result 状态：

```text
Result.Task.WorkRef != 当前 WorkRef
且无有效的 carry-forward 到当前 WorkRef
```

一个 carry-forward Decision 显式绑定三个方向：源 Result、源 Work revision 和目标 Work revision。

Work revision、Task 取消或 supersession 和派发在相同的当前 Work head 和 Task 执行所有权上线性化。如果 invalidation 先提交，派发被拒绝。如果派发先提交，Task 正在运行，必须通过 Result 终止；一个更晚的 Work revision 可以使该 Result 变 stale，但不能假装执行从未开始。

## 11. 协调命令与 Guard

| 命令 | 确定性 Guard | 原子或恢复等价输出 |
| --- | --- | --- |
| `create_work` | 精确的 received ingress Evidence；当前正面 IngressPolicy 评估；已认证权威；预留的新 workId 和 ledger 或相同 CommandEnvelope replay；revision 1；有效 Team 和 Spec；ResolvedWorkPolicy 来源匹配 TeamPolicy 和 Kernel | 通过一个事务或 visibility-gated outbox 的 Work + `work.recorded` + `human-request.admitted`，或相同 replay 的原始 WorkRef |
| `revise_work` | 当前 Leader-turn fencing epoch；源是当前 head；目标是相同 workId 且 revision +1；无 fork；无执行中或不确定的 Operation；Team 和 ResolvedWorkPolicy provenance 连贯；变更已授权 | 目标 Work + revise Decision + Evidence |
| `create_task` | 当前开启的 Work；有效团队成员和 Agent 定义；有效 input；Task 策略从 ResolvedWorkPolicy 派生且不扩展权限；创建是即时调度委托 | Task + Evidence |
| `dispatch_task` | Task 是当前的、未派发的、未取消的、未 supersede 的、无 Result 或 TaskRun；精确 input 保持可解析、可用、已许可且未撤销；MemberRef 和活的平台绑定匹配；精确的 Team、Work、provider、Runner、预算、Workspace、策略、安全和资源容量已预留 | 原子 slot 预留 + 派发 Evidence + 一个 TaskRun |
| `submit_result` | 已认证 assignee 或可信框架；精确 TaskRef；无先前 Result；有效引用；适用的 CompletionPolicy 通过 | Result + Completion/记录 Evidence |
| `accept_result` | Completed Result；Completion Check 有效且 anchored；无冲突处置；当前 scope 或有效 carry-forward；策略下精确语义权威 | accept Decision + Evidence |
| `reject_result` | 既有 Result；无冲突处置；有界理由和基础 | reject Decision + Evidence |
| `supersede_task` | 源是一个未 supersede 的非运行叶子，无有效验收；replacement 是新的有效当前 revision Task；无循环或分支 | replacement Task + supersede Decision + Evidence |
| `carry_forward_result` | 源 Result 在源 Work 中已验收；源是当前目标的祖先；Evidence 保持新鲜 | carry-forward Decision + Evidence |
| `cancel_task` | Task 未派发且无 Result 或先前取消/supersession | cancel Decision + Evidence |
| `complete_work` | 当前 head；精确的 complete-work ClosurePolicy 分支通过；必需的 Result 已验收；必需的 QualityAssessment 新鲜且满足；无必需的 Human 响应、运行中 Task、待处理效果或未解决不确定性 | anchored `closure.checked(pass)` -> complete Decision + 记录 Evidence + 终态 Anchor visibility commit |
| `fail_work` | 当前 head；精确的 fail-work ClosurePolicy 分支通过；安全延续已耗尽；效果已解决或显式不确定；失败和恢复 Evidence 完整 | anchored `closure.checked(pass)` -> fail Decision + 记录 Evidence + 终态 Anchor visibility commit |
| `cancel_work` | 当前 head；精确的 cancel-work ClosurePolicy 分支通过；授权取消；Task 和效果安全终止；需要时 Human 决策 | anchored `closure.checked(pass)` -> cancel Decision + 记录 Evidence + 终态 Anchor visibility commit |
| `revoke_decision` | 目标 action 在 9.7 节下可撤销；Work 保持开启；已认证权威；当前 Leader epoch 和 Work head；精确的 reverse-dependency frontier 无有效后代或不可逆事实 | revoke Decision + Evidence |

一个已派发的 Task 不被协调标志取消。如果执行必须被停止，运行时终止 TaskRun、保留 Evidence、解决或标记外部效果为不确定，并密封一个 failed Result。

## 12. 完成出口与 Work 关闭

```text
completed candidate
  -> Completion Check 通过 -> 密封 Result
  -> Completion Check 失败
       -> 在 Task 内正常修复
       -> 当真正需要外部条件时 -> blocked candidate
       -> 当恢复不可能时 -> failed candidate
       -> 当执行预算耗尽时 -> 框架产出的 failed Result
```

completed、blocked 和 failed outcome 有不同的最低策略。一个 blocked 策略必须防止 Agent 用 `blocked` 绕过 completed 要求。它验证既有输出和 Evidence 被保留、无效果保持活跃，且 blocker 在机器事实允许范围内得到支持。

### 12.1 ClosurePolicy 合同

ClosurePolicy 是通过 `work-closure` ResolvedWorkPolicy slot 选择的确定性 Work 终态认证合同：

```json
{
  "schema": "tiangong.closure-policy/v1",
  "policyId": "work-closure/software-change-delivery",
  "version": "1",
  "kernelRef": {
    "kernelId": "tiangong-closure-kernel",
    "version": "1",
    "contentDigest": "sha256"
  },
  "outcomeChecks": {
    "complete-work": [],
    "fail-work": [],
    "cancel-work": []
  },
  "contentDigest": "sha256"
}
```

每个列表包含带严格参数的精确确定性 CheckerRef。Closure Kernel 总是重新验证当前 Work head 和 Team；WorkSpec 和策略 provenance；有效 Result 处置；必需的已验收 criterion 和 Artifact；Completion 和 Anchor 有效性；必需的新鲜 QualityAssessment；Human 决策；TaskRun、租约和资源终止；Operation、Approval、Journal、不确定性、补偿和恢复状态；必需的报告；以及 retention pin。每个终态 action 有独立分支，因此失败或取消不能绕过披露和安全要求。

ClosurePolicy 不含阶段列表、TaskKind、工作流边、模型 checker、任意脚本或布尔表达式 DSL。一个机器通过使一个终态 Decision 合格；它不选择语义结果，也不证明 Work 目标客观正确。

一个 closure check 绑定一个 `inputFrontier`，包含检查前的 Work-ledger 终态 EvidenceRef 和 Checker 消费的每个 Work head、有效 Decision、Task/Result/TaskRun、Human、质量、资源、Operation、Approval、Journal、Policy 和 retention 事实的 digest。它追加 `closure.checked(pass)` 作为下一个 Work-ledger 事件，并通过该事件同步 Anchor。Anchor 审计事件位于管理安全 ledger，不改变 Work frontier。

终态提交只接受精确的 `inputFrontier` 后跟那一个预期的 `closure.checked` 事件。它在追加终态 Decision 和 `decision.recorded` 前重新检查当前 Leader epoch、Work head、reverse dependency、活的撤销和所有外部可变前置条件。任何无关或变更的 Work-ledger 事件、projection digest 或活事实使检查变 stale，不创建 Decision。一个最终 Anchor 和 visibility commit 使终止对消费者具有权威。崩溃恢复完成这个精确的分阶段 outbox，或使 Work 保持开启；它永不从部分写入猜测终止。

## 13. 必需的 Evidence 语义

包 1 要求这些事件含义。包 2 提供通用 Evidence 信封，每个拥有包提供严格的事件特定事实 schema 和 Recorder 权威：

| 事件 | 必需绑定 |
| --- | --- |
| `human-request.received` | 可信 channel-message 身份、有界 payload digest、精确 IngressPolicyRef |
| `human-request.admitted` | received EvidenceRef、精确 IngressPolicyRef、WorkRef、TeamRef 和 `work.recorded` EvidenceRef |
| `human-request.replayed` | 原始 received 和 admission EvidenceRef；无新 Work |
| `human-request.admission-denied` | received EvidenceRef、精确 IngressPolicyRef、稳定拒绝码 |
| `work.recorded` | Work digest、已认证 actor、精确 CommandEnvelope digest |
| `leader-turn.started` | 精确 WorkRef 和 head、Leader、Evidence frontier、SchedulerPolicyRef、Team slot 和租约 epoch |
| `leader.context.assembled` | started EvidenceRef、策略过滤的 context digest、运行时和模型身份 |
| `leader-turn.completed` | started EvidenceRef 和已提交记录 EvidenceRef（如有） |
| `leader-turn.aborted` | started EvidenceRef 和稳定中止或 stale-owner 码 |
| `task.recorded` | Task digest、WorkRef、Leader actor、started Leader-turn EvidenceRef |
| `capacity.observed` | 精确管理 scope、代码拥有的 metric 和 unit、有界容量值、generation、有效性截止、精确 Adapter 实现 |
| `team-scheduler-policy.selected` | 稳定团队身份、精确 SchedulerPolicyRef、先前选择（若有）、单调选择 generation 和管理权威 |
| `scheduler.slot-reserved` | TaskRef、Team、Work、member、Worker、精确 SchedulerPolicyRef、slot ID、容量 generation、源容量 EvidenceRef 和租约 epoch |
| `scheduler.capacity-unavailable` | 合格 TaskRef、精确 SchedulerPolicyRef、有界不可用维度和观察到的容量 EvidenceRef |
| `scheduler.slot-released` | 预留 EvidenceRef、终态或 fenced 释放基础和当前 epoch |
| `scheduler.lease-suspect` | 预留 EvidenceRef、最后已知 owner generation 和稳定 suspect 码 |
| `scheduler.lease-reconciled` | suspect EvidenceRef、fencing 结果和释放或恢复处置 |
| `workspace.binding-prepared` | TaskRef、精确 WorkspaceBindingRef、Runner generation 和租约 epoch |
| `workspace.resource-lease-acquired` | 规范化资源身份、owner TaskRunRef、策略、generation、epoch 和过期 |
| `workspace.resource-lease-released` | 获取 EvidenceRef、fenced owner 和释放基础 |
| `task.dispatched` | TaskRef、assignee、TaskRunRef 和 slot 预留 EvidenceRef |
| `completion.checked` | TaskRef、candidate digest、策略 digest、checker 结果 |
| `closure.checked` | WorkRef、提议终态 action、ClosurePolicy、Kernel 和 Checker digest、精确 projection frontier、结果和原因码 |
| `result.recorded` | Result digest、TaskRef、已认证提交者 |
| `decision.recorded` | Decision digest、action、已认证 actor |
| `coordination.command.denied` | 精确 CommandEnvelope digest、subject digest、稳定原因码 |
| `task-run.budget-exhausted` | TaskRef、TaskRunRef、执行策略 |
| `task-run.terminated` | TaskRef、TaskRunRef、已知失败或不确定效果结果 |

Ingress 事件只由可信 Ingress Recorder 在管理 ingress ledger 中发出。Leader-turn 事件只由可信 Leader Runtime Recorder 在精确 Work ledger 中发出。Scheduler 事件只由可信 Team Scheduler Recorder 发出。Workspace 和 resource-lease 事件只由可信 Workspace 或 Runner Manager Recorder 发出。Capacity Adapter 事件只由为该代码拥有 metric allowlist 的精确 Adapter 实现写入管理容量 ledger。`team-scheduler-policy.selected` 只由可信管理 Policy Registry Recorder 发出。`completion.checked` 只由精确 TaskRun 的 Completion Kernel Recorder 发出；`closure.checked` 只由精确当前 Work frontier 的 Closure Kernel Recorder 发出。

`capacity.observed` 事实有严格 schema：精确 scope 引用、metric enum、unit enum、非负有界值、源 generation、`validUntil` 和 Adapter 实现 digest。未知 metric 或 unit、不一致值、缺失 generation、过期观察或 Recorder 不匹配 fail closed。Scheduler Evidence 引用容量 EvidenceRef，而非冒充 Adapter。

`scheduler.slot-reserved` 只证明机器分配；`task.recorded` 是委托权威，而 `task.dispatched`（随 TaskRun 开启一起提交）是权威派发事实。成功的 `work.recorded`、`task.recorded` 和 `decision.recorded` 事件和被拒绝的 `coordination.command.denied` 事件可以引用更早的 `leader-turn.started`；不存在重复的 leader-command 事件含义。

记录 Evidence 不包含在被记录对象自身的引用中；那会形成 digest 循环。信任通过 Evidence ledger 到对象 digest 的反向绑定来验证。

## 14. 恢复与有界并发

恢复在投影状态前验证 schema、对象 digest、精确引用、Evidence、SchedulerPolicy、容量 generation、租约和 fencing epoch。它从不可变记录重建 Work head、Task 关系、Result、处置、carry-forward、撤销和终态 Decision。Fork、循环、缺失引用、冲突 Result、无效 Evidence 和 stale 所有权 fail closed。模型记录不是权威。

### 14.1 Leader turn

唯一 Leader 跨隔离 Work 可重入。每个 Leader turn 绑定一个精确 WorkRef、当前 Work head、ResolvedWorkPolicy、已验收 Result、Team Concern 快照、策略过滤的跨 Work 资源事实、Evidence frontier、运行时、模型和 context digest。没有全局可变 Leader 对话。

一个 Work 至多一个当前协调 turn 租约。租约获取或所有权转移递增一个单调 fencing epoch。租约减少重复推理，但位于正确性边界之上：每个协调提交验证当前 epoch、预期 Work head、Evidence frontier 和相关事实，然后执行 compare-and-swap。过期、崩溃、延迟消息或分裂所有权不能把 stale 模型输出变成权威。一个 stale turn 被中止并从当前事实重新规划。不同 Work 可以在活的团队容量内并发运行 Leader turn。

### 14.2 派发与容量

调度器只选择已由 Leader 创建授权的合格未派发 Task。它应用不可变 Work 上限、活的团队和 Worker 容量、FairnessPolicy、基础设施观察、预算和资源租约。它不创建或重新解释 Task。

派发预留精确 slot 和 WorkspaceBinding，追加预留和派发 Evidence，并在一个事务或恢复等价的 write-ahead 协议中打开唯一 TaskRun。内部事务 intent 不是业务 DispatchIntent，除 Task 外不授予任何权威。如果准备或容量不可用，Task 保持未派发，调度器可以无 Leader 轮询循环地重试其 Guard。

Work revision、取消、supersession 和派发在其线性化边界比较相同的当前 head 和 Task 所有权事实。Invalidation 先行使 Task 不合格。派发先行创建必须通过 Result 终止的运行中执行。

有效并发是以下各项的最小值：不可变 Work 和成员上限、活的团队和 Worker slot、模型 provider 配额、CPU 和内存、Runner 和容器 slot、Workspace 和存储容量、外部服务配额、成本和 token 预算、资源租约，以及有用的独立工作。一个模型不能声明容量或覆盖背压。

### 14.3 租约 fencing 与恢复

每个可回收的 Leader-turn、TaskRun 执行 owner、调度器 slot、Runner、Workspace 和内部资源租约携带一个单调递增的 fencing epoch。所有权转移在容量被重用前使旧 epoch 无效。权威 mutation 边界验证当前 epoch，包括 Evidence 追加、Artifact 密封、Result 密封、Task 派发、TaskRun 的 Operation Journal attempt 和租约转移。

原始文件系统写入不能总是检查 epoch。因此 Workspace 和 Runner fencing 终止或隔离旧进程或容器，并绑定一个新 generation。由 stale epoch 产出的字节可能保持物理存在，但不能被密封为可信 Artifact 或 Result。容量只在旧 owner 被从权威写入 fenced 后才释放。

一个丢失的 TaskRun 永不导致同一 Task 的第二个 TaskRun。恢复标记其租约为 suspect，检查 TaskRun、工具和 Operation Journal、Evidence、Workspace 和外部不确定性，fence 旧执行，并只在每个精确绑定保持有效时在当前 epoch 下恢复相同 runId。否则框架密封一个 failed Result，Leader 可以创建 replacement Task。

### 14.4 窄串行化与共享资源

并发使用 compare-and-swap 和窄锁：

- Work revision 比较预期当前 head digest；
- Result 提交按 Task 串行化；
- supersession 比较预期源叶子；
- 冲突处置按 Result 串行化；
- carry-forward 在提交时重新检查目标 head；
- Work 关闭在提交时重新检查所有 closure 事实；
- 一个 Work Evidence Ledger 只串行化其短的追加事务。

相同 digest replay 成功。相同身份配不同内容是冲突。禁止最后写者胜。多记录命令使用一个事务或 write-ahead intent 加 Evidence outbox 和 commit marker。未提交记录对 Projection 不可见。

并行 Task 共享不可变输入 digest，但使用分离的 WorkspaceBinding。产出独立文件或模块的 Task 保留独立 Artifact。重叠输出使用派发前已知的非重叠所有权、独立 patch Artifact 加一个更晚的集成 Task，或一个排他内部资源租约。两个 TaskRun 永不修改同一物理 workspace，禁止最后写者胜。

内部共享资源使用规范化身份、严格 ResourceLeasePolicy、generation、owner TaskRunRef、fencing epoch、过期和可信 Workspace 或 Runner Manager Evidence。外部分支、环境、服务、数据库、工单和发布目标额外使用 Operation Gate 前置条件、幂等和 Operation Journal 串行化。模型协作永不是资源锁。

## 15. 协调 truth table

| 场景 | 决策 |
| --- | --- |
| 执行饱和时两个独立可准入 Human 目标到达 | 持久捕获两个请求，原子准入两个独立 Work，并延迟执行 |
| 正面 ingress 评估尚无 WorkRef | 预留 workId 和 ledger，然后一起提交 Work 和 admitted Evidence |
| 跨 ledger 准入一侧写入后崩溃 | 保持 Work 不可见并恢复精确 outbox；永不分配另一个 Work |
| 精确 Human channel message replay | 返回原始准入；无重复 Work |
| Human 回复一个精确 Interaction 或 Work | 绑定输入到该 Work |
| ingress 关联歧义 | 永不静默修改既有 Work |
| IngressPolicy 试图语义 Work 决策或权限授予 | 拒绝 |
| 用有效 Team、Spec 和 Policy 引用创建 revision 1 | 允许 |
| 为相同 workId 创建第二个 revision 1 | 拒绝 |
| 修订当前 head 到 revision +1 | 允许 |
| 修订非 head Work revision | 拒绝 |
| 为当前 Work revision 创建 Task | 允许并使其有资格调度器派发 |
| 无正式 Task 记录规划 Artifact | 无派发权威 |
| 为旧 Work revision 创建或派发 Task | 拒绝 |
| 派发已取消或 supersede 的 Task | 拒绝 |
| 合格 Task 无执行 slot | 保持未派发；无 TaskRun 或 blocked Result |
| 合格 Task 获得容量 | 原子预留、派发并打开一个 TaskRun |
| 派发前 revision、取消或 supersession 胜出 | Task 变不合格 |
| 取消前派发胜出 | 只通过 Result 终止，非取消标志 |
| 调度器改变 Task assignee、目标或语义优先级 | 拒绝 |
| 让已运行的旧 revision Task 完成 | 允许 Result 密封；标记当前不合格 |
| 由精确 assignee 提交通过 Completion Check 的 Result | 允许 |
| 由另一个 Agent 提交 Result | 拒绝 |
| Completion candidate 失败 | 不密封；继续 Task |
| 真正缺失外部信息且 blocked 策略通过 | 密封 blocked Result |
| 执行预算过期且无有效 candidate | 密封框架产出的 failed Result |
| 为一个 Task replay 相同 Result | replay 成功 |
| 为一个 Task 提交不同的第二个 Result | 冲突 |
| 验收 completed、当前 scope、Completion Check 有效的 Result | 允许策略下语义处置 |
| 验收 blocked、failed 或 Completion Check 无效的 Result | 拒绝 |
| 无 carry-forward 验收祖先 Result | 拒绝 |
| 把已验收祖先 Result carry-forward 到当前后代 | 允许 |
| carry-forward 未验收、反向或跨 Work Result | 拒绝 |
| 用有效 replacement supersede 当前非运行 Task 叶子 | 允许 |
| supersede 运行中 Task | 拒绝；先终止它并密封 Result |
| supersede 已验收、已替换 Task 或创建分支/循环 | 拒绝 |
| 取消未派发 Task | 允许 |
| 通过设置标志取消运行中 Task | 拒绝；终止执行并产出 Result |
| 通过 closure 策略且无活效果时完成 Work | 允许 |
| 有活 Task 或未解决效果时完成 Work | 拒绝 |
| 有空有效 reverse-dependency frontier 时撤销开启 Work 的验收 | 允许为新 Decision |
| 在精确 9.7 节条件下撤销拒绝或 carry-forward | 允许为新 Decision |
| 撤销 revision、supersession、取消、终态 Work、撤销或已消费效果权威 | 拒绝 |
| 撤销前并发后代提交 | 撤销冲突并必须重新评估 |
| 修改原始验收 | 拒绝 |
| 撤销一个 revoke 或抹除不可逆效果 | 拒绝 |
| 相同 Leader 处理不同 Work 的隔离 turn | 在活的团队容量内允许 |
| 两个 Leader turn 针对一个 Work | 一个当前租约 epoch；stale epoch 被拒绝，CAS 保持最终防线 |
| 两个独立 Task 针对可用成员 | 在所有限制内并发派发 |
| 两个 Task 针对一个有一个可用 slot 的成员或 Worker | 派发一个；另一个保持未派发 |
| 两个 Run 共享一个模型 session、可变工具状态或物理 Workspace | 拒绝运行时实现 |
| 并行 Task 产出重叠 patch | 保留两者；使用集成 Task |
| 并发事件针对一个 Work Ledger | 只串行化追加并保留精确 TaskRun subject |
| 不同 Work 追加到不同 Ledger | 允许；不发明全局排序 |
| slot 租约过期而旧执行可能写入 | 重用前 fence 并对账 |
| 未授权 Recorder 发出 Scheduler 或容量 Evidence | 拒绝并 fail closed |
| 并发 Work revision | 一个提交，一个 stale-head 冲突 |
| 一个 Task 的并发不同 Result | 一个提交，一个冲突 |
| 恢复发现 fork、循环、digest 不匹配、缺失引用或 stale epoch | fail closed |

## 16. 包 2：信任与完成

包 2 定义三个正交机制：

- Artifact 标识产出了什么不可变内容；
- Evidence 记录可信机器边界观察到了什么；
- Completion 检查这些事实是否满足一个 Task outcome 的最低机器可证明合同。

Artifact provenance 不证明语义正确性。Evidence 不因为被记录就证明任意 claim。Completion 是 Result 密封所必需的；有效的 Leader 或 Human 支持的验收是精确策略下的权威语义处置，绝不是客观正确性的证明。

## 17. Evidence 合同

Evidence 是由授权 Recorder 发出的不可变机器事件。它不是模型叙述、原始日志、Artifact 内容或可变状态。

```json
{
  "schema": "tiangong.evidence/v1",
  "ledgerId": "work:work-123",
  "sequence": 42,
  "eventKey": "sha256",
  "eventType": "tool.execution.completed",
  "eventDefinitionRef": {
    "implementationId": "evidence-event/tool.execution.completed",
    "version": "1",
    "implementationDigest": "sha256"
  },
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

| 字段 | 合同原因 |
| --- | --- |
| `schema` | Pin 住 Evidence 信封和哈希语义。 |
| `ledgerId` | 标识验证该事件的 hash chain。 |
| `sequence` | 建立权威顺序并暴露 gap 和 fork。 |
| `eventKey` | 使可信捕获幂等并检测冲突 replay。 |
| `eventType` | 提供由精确定义选择的稳定人类可读事件含义。 |
| `eventDefinitionRef` | Pin 住事实 SchemaRef、subject 角色、Recorder allowlist、event-key 派生和处理规则。 |
| `recorderRef` | 标识记录该有界观察的可信机器边界。 |
| `actorRef` | 标识导致该动作的已认证 actor 或系统。 |
| `subjects` | 把事实绑定到精确的已注册记录或 Artifact，包括 Work、Task、Result、TaskRun、Human 交互和 Operation。 |
| `facts` | 携带有界的、事件特定的机器观察。 |
| `recordedAt` | 为审计和显式时间新鲜度提供可信 ledger 时间。 |
| `previousHash` | 把事件绑定到前一个链位置。 |
| `hash` | 保护事件内容并给 EvidenceRef 其完整性身份。 |

`eventType` 只有与其精确不可变 EventDefinitionRef 一起才是权威语义判别符。EventDefinition 是一个已审核的实现包，绑定稳定的 eventType、信封和事实 SchemaRef、必需的 subject 角色和 cardinality、授权 Recorder 实现、actor 规则、event-key 派生、敏感数据策略和大小边界。语义、schema、Recorder 或 key-derivation 变更创建新的定义版本和 digest。历史验证永不解析"最新"。`facts` 不是自由格式 payload。

`actorRef` 回答谁导致了一个动作。`recorderRef` 回答哪个可信边界记录了观察。Agent 可以影响工具输入，但不能选择其已认证 actor、EventDefinition、Recorder、sequence、时间、predecessor 或 hash。Recorder 授权限制谁可以陈述该事实；它不让被攻陷的 Recorder 变得可信。

Evidence 排除独立 content digest 或事件 ID、通用可变状态、严重性、metadata 和扩展 bag、自报告 actor 或时间、原始 prompt、模型响应、凭证、原始写入 payload、无界日志、Artifact payload、裸 Work 或 Task ID，以及自然语言成功断言。

### 17.1 EvidenceRef

```json
{
  "ledgerId": "work:work-123",
  "sequence": 42,
  "hash": "sha256"
}
```

该元组标识 ledger、精确顺序位置和不可变事件。不需要额外事件 ID。

### 17.2 Evidence 事件纪律

Evidence 区分 proposal、Gate 决策、执行开始、执行完成、replay、失败、rollback 开始、rollback 完成和不确定结果。一个更早的事件永不证明一个更晚的阶段。特别是，一个 Agent 或工具循环的成功消息不证明一个后端效果。

需要后续检查的原始内容作为 Artifact payload 存储。敏感恢复 payload 存储在分离的受保护存储中，由 digest 绑定。Evidence 只包含有界规范化的事实、digest、大小和稳定错误码。

## 18. Evidence Ledger 与 anchoring

每个 Work 有一个逻辑 Evidence Ledger。Agent 和工具执行保持并行；只串行化短的追加事务。一个 Work 在其初始 Human 输入和 WorkSpec 被记录前预留其 ledger。

管理 Catalog、schema、权威、撤销、安全、Human ingress 和跨 Work 容量事实使用分离的命名空间限定管理 ledger，具有相同信封、ledger 特定 genesis、anchoring、Recorder 和 fail-closed 规则。Ingress 和容量 ledger 是这个既有管理 ledger 家族的成员，不是新的无引导存储。它们不把无关 Work 顺序合并为一个虚假全局序列。一个 Work ledger 记录对外部 Catalog、ingress 和容量 EvidenceRef 的精确采纳和使用，而活的安全撤销和容量新鲜度也在派发、context、工具、Gate 和恢复边界检查。

第一个事件使用 ledger 特定 genesis 值：

```text
genesisHash = digest("sha256", jcs("tiangong-jcs/v1", {
  schema: "tiangong.evidence-ledger/v1",
  ledgerId
}))
```

每个事件 hash 是：

```text
hash = digest("sha256", jcs("tiangong-jcs/v1", eventWithoutHash))
```

追加在原子追加和同步记录前验证当前 terminal、下一个 sequence、previous hash、event key、事件和事实 schema、Recorder 权威、subject 和敏感数据规则。

一个 hash chain 只相对可信 terminal hash 是防篡改的。因此包 2 要求保存在模型和普通 Worker 写入权威之外的签名 Evidence Anchor。一个 Anchor 是一个不可变安全记录：

```json
{
  "schema": "tiangong.evidence-anchor/v1",
  "anchorId": "anchor-work-123-42",
  "ledgerId": "work:work-123",
  "range": {
    "firstSequence": 1,
    "lastSequence": 42
  },
  "previousAnchorRef": null,
  "terminalEvidenceRef": {
    "ledgerId": "work:work-123",
    "sequence": 42,
    "hash": "sha256"
  },
  "rangeDigest": "sha256",
  "anchorServiceRef": {
    "implementationId": "evidence-anchor-service/default",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "signingKeyRef": {
    "keyId": "evidence-anchor-key-1",
    "version": "1",
    "publicKeyDigest": "sha256"
  },
  "signatureAlgorithm": "Ed25519",
  "signature": "base64url-without-padding",
  "contentDigest": "sha256"
}
```

AnchorRef 包含 `anchorId` 和 Anchor `contentDigest`。`rangeDigest` 覆盖该范围的 sequence 和 event-hash 对的规范有序列表。terminal EvidenceRef 必须等于其最后一对和签名时的当前 Ledger terminal。一个非 genesis Anchor 从先前 Anchor 的最后 sequence 加一开始，并绑定 `previousAnchorRef`；范围不能重叠、跳过、fork 或跨 ledger。

对于 `tiangong.evidence-anchor/v1`，签名输入是省略 `signature` 和 `contentDigest` 后的 JCS 字节的 SHA-256 digest；签名是对那些 digest 字节的 Ed25519。`contentDigest` 随后覆盖除自身字段外的完整签名记录。签名编码是无 padding 的 base64url。另一个算法要求新的 Anchor schema 和已审核验证器；算法协商不从记录接受。

trust-root 存储包含 allowlist 的公钥、有效性 epoch、rotation 链接和 compromise/revocation 事实，对模型和普通 Worker 不可访问。私钥留在 Anchor 服务中。Rotation 要求一个 out-of-band 配置的 trust root 或一个由当前可信密钥加管理 Evidence 授权的过渡。Compromise 处理识别最后外部可信的 Anchor frontier。该 frontier 之后的 Anchor 无效；当安全截止不可知时，高风险消费是不确定的并 fail closed。Rotation 永不重写更早的 Anchor 或 Evidence。

Anchor 服务在精确 EventDefinition 和授权安全 Recorder 下记录有界的 `evidence.anchor.recorded`、`anchor-key.rotated` 和 `anchor-key.compromised` 管理事件。记录 Evidence 绑定 AnchorRef、ledger 范围、服务和密钥引用以及可信时间，不进入 Anchor 签名循环。签名验证不依赖那个更晚事件，而审计和密钥状态 projection 需要它。

一个 Anchor 保护可信签名后的链完整性和连续性。它不证明 Recorder 真相、外部效果结果、pre-genesis 完整性，或不证明一个没有授权 Recorder 捕获的动作的缺失。Evidence 不被自动删除。

Anchor checkpoint 和物理 segment rotation 是分离的：

- 一个关键边界同步地在活跃 tail 上签名一个小的 terminal checkpoint；
- segment rotation、export 和 archival 可以异步运行；
- Result 密封不需等待大文件 rotation；
- Result 验收要求相关完成和记录事件被可信 Anchor 覆盖。

以下使用要求 anchored Evidence：正式 Completion 通过、Leader 或 Human 验收、高风险 Artifact 消费、Work 终止、Operation 审批或对账，以及正式 Evidence export。Agent Concern 可以只作为临时观察读取未 anchored 的活跃 tail。

一个可信活跃时钟提供 `recordedAt`，但 sequence 仍是排序权威。时间 checker 只用于真正过期的事实。如果时钟健康未知，时间 checker 返回 `indeterminate`。

### 18.1 Evidence 不变量

1. 只有可信 Recorder 追加 Evidence。
2. 事件权威按事件类型和 Recorder 检查。
3. 事件不可变且 append-only。
4. 读取和追加验证链；篡改永不静默截断或修复。
5. 相同事件 key 配相同事实 replay；不同事实冲突。
6. Sequence gap、fork、无效 anchor、未知事件类型和 schema 不匹配 fail closed。
7. Sequence，而非墙上时钟时间，决定顺序。
8. 工具 proposal、开始、完成、replay、rollback 和不确定性保持不同事实。
9. Evidence 永不存储凭证、无界日志或原始受保护 payload。
10. Rotation 和 retention 保留链连续性和验证材料。
11. Anchor 验证解析精确 schema、服务、密钥、算法、范围、先前 Anchor、签名和当前 compromise 事实。
12. 缺失、fork、不可信或 compromise 歧义的 Anchor 状态对所有要求 anchoring 的使用 fail closed。

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

| 字段 | 合同原因 |
| --- | --- |
| `schema` | Pin 住 Manifest 解释和 digest 规则。 |
| `artifactId` | 提供稳定的交付身份和外部映射。 |
| `artifactSchemaRef` | 选择语义解析和确定性验证。 |
| `payload` | 绑定媒体类型、字节长度和精确交付字节。 |
| `provenanceEvidenceRefs` | 证明 payload 的可信物化或捕获。 |
| `handlingPolicyRef` | Pin 住分类、访问、export、retention 和销毁规则。 |
| `contentDigest` | 给 Result 一个不可变 Manifest 身份。 |

Manifest digest 和 payload digest 是不同的。前者保护语义包装和 provenance；后者保护交付字节。不同 Artifact 可以合法引用相同 payload。

一个 ArtifactRef 包含 `artifactId` 和 Manifest `contentDigest`。物理存储位置由 Artifact Store 作为以 payload digest 为键的可变机器状态维护；它不是 Artifact 身份的一部分。复合 Artifact 使用一个规范 payload manifest，传递性地绑定其成员。

Artifact 排除 actor 和时间、通用 Work 或 Task 字段、存储路径或 URL、内联 payload、可变状态、revision、重复摘要或 claim、Evidence 正文、通用 lineage metadata、直接 Operation 和 Approval 字段，以及扩展 bag。

### 19.1 Provenance 序列

```text
可信 input/工具/Runner 边界
  -> payload 写入内容存储
  -> 验证 digest 和字节长度
  -> artifact.materialized Evidence
  -> 引用更早物化 Evidence 的 Artifact Manifest
  -> 引用 Manifest digest 的 artifact.recorded Evidence
```

`artifact.recorded` 不包含在 Artifact 自身的 provenance 中，因为那会创建 digest 循环。正式验证遵循反向 Evidence 绑定。

Artifact 有效性要求有效的 Manifest 和 payload、可解析的 Artifact schema、来自授权 Recorder 的 anchored provenance、匹配的物化描述符、反向记录 Evidence，以及允许请求使用的 handling 策略。这证明来源和字节身份，不证明语义质量。

### 19.2 Artifact 不变量

1. Manifest 和 payload 不可变。
2. 一个 artifact ID 映射到一个 Manifest digest。
3. 相同 payload 可以跨不同 Artifact 去重。
4. Payload 在 Manifest 密封前完全写入、同步和验证。
5. Provenance 只引用更早 Evidence。
6. Payload 读取重新验证 digest 和字节长度。
7. 缺失或损坏 payload 使 Artifact 不可用；单独 Manifest 不能授权重新验证 claim。
8. 缺失反向记录 Evidence 将 Manifest 从可信 projection 排除。
9. Handling 策略在读取、模型 context、export、retention 和销毁边界执行。
10. 已验收 Result 引用建立 retention pin。Payload 删除使未来验证不可能，因此要求显式 guarded 销毁 Operation；它永不是静默的。
11. 拒绝或 Work 取消不自动删除 Artifact。
12. AI 产出的内容可以是 Artifact，但仍是带 claim 的输出。

ArtifactSchema 和 HandlingPolicy 是被引用的、不可变的、内容寻址的包。ArtifactSchema 提供确定性 payload 验证，永不运行任意模型或工具代码。HandlingPolicy 治理分类和生命周期，不改变 Artifact 身份或 provenance。

### 19.3 Retention 与销毁

RetentionPolicy 是一个严格 Policy 包，定义最低和最高 retention、已验收 Result 和审计 pin、法律和安全 hold、受保护 payload 处理、合格销毁权威和必需验证。它永不修改 Artifact 或 Evidence。

Payload 销毁是包 3 下的一个 Task-origin 维护 Operation。其 spec 绑定精确 Artifact 和 payload digest、存储 realm、当前 retention PolicyRef、完整 pin/hold frontier、预期物理状态和期望缺失。当任何已验收 Result、Evidence export、Operation 或 Approval 审计 horizon、不确定恢复、法律 hold、活跃检索 reader 或更严格的 HandlingPolicy 仍需要 payload 时，Guard 拒绝销毁。Human 或 standing policy 权威产出精确 Approval；retention 过期和缓存删除都不是隐式授权。

成功要求一个 OperationReceipt 和来自精确存储 Adapter 的机器证明缺失或密码擦除 postcondition。Manifest、销毁 Operation、Approval、Receipt 和 Evidence 在其审计策略下保留，并使后续 payload 读取作为不可用失败，而非假装 Artifact 从未存在。可重建非权威索引的缓存驱逐不是权威 Artifact 销毁。

## 20. CompletionPolicy 合同

CompletionPolicy 是一个内容寻址的机器认证合同。它不是 Skill、Prompt、工作流或语义审查者。

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

| 字段 | 合同原因 |
| --- | --- |
| `schema` | Pin 住策略解释。 |
| `policyId` | 提供稳定 registry 身份。 |
| `version` | 支持显式审核和升级。 |
| `kernelRef` | 防止 Kernel 变更静默改变既有 Task。 |
| `outcomeChecks` | 给 completed、blocked 和 failed 不同最低合同。 |
| `contentDigest` | 让 Task 绑定精确已解析策略。 |

每个 outcome 分支是显式的，即使它在 Kernel 之外不加检查。这防止 blocked 或 failed outcome 成为逃生口。

每个 Checker 引用绑定代码身份和版本。其参数符合 Checker 的严格参数 schema；它们不是任意 payload。已解析策略是平坦的，不含通用布尔表达式 DSL。

CompletionPolicy 排除工作流步骤、Prompt 或 Skill 文本、基于模型的 checker、任意脚本、警告、可变启用标志、actor 和时间、自由格式 metadata、Human 审批、语义质量分和恢复工作流。建议性检查属于 Concern。

## 21. Checker 合同

Checker 是一个代码拥有的、确定性的、无副作用的函数，作用于 Task、Result candidate、Work projection、Evidence、Artifact、TaskRun 和已验证参数的不可变快照。它不调用模型、执行工具、修改状态或读取未声明的可变全局状态。

它返回：

```text
verdict: pass | fail | indeterminate
reasonCode
subjectRefs
EvidenceRefs
```

`indeterminate` fail closed。诊断文本是有界的、脱敏的，从稳定原因码派生。Concern 和 Skill 解释恢复；Checker 不成为方法论引擎。

组合是固定的：

```text
所有 Kernel Checker 通过
AND
所选 outcome 的所有 Checker 通过
```

Checker 不消费彼此的输出。如果两个检查要求有序状态，它们形成一个已审核 Checker。这防止评估顺序改变 verdict。

### 21.1 强制 Kernel Checker

版本化的 Completion Kernel 总是执行：

- candidate schema 和 digest 完整性；
- Task、TaskRun 和已认证提交者绑定；
- 精确 Artifact 和 Evidence 引用完整性；
- Evidence 链、Anchor、事件权威和事实 schema 验证；
- Evidence subject 和 digest 绑定到当前 Task 和输出；
- Artifact payload、schema、provenance、记录和 handling 验证；
- Finding Evidence 子集验证；
- completed、blocked 和 failed outcome 一致性；
- 包 3 提供 Operation 事实后的终态效果安全。

一个 blocked Checker 可以验证机器事实，如缺失依赖、Gate 拒绝、保留输出和无活效果。它不能证明 Agent 已尝试每个合理方法的语义断言。Leader 决定 blocker 是否合理。

策略可选 Checker 包括必需 Artifact schema、必需 Evidence 事件、payload schema、命令退出结果、subject digest 绑定、环境绑定、时间新鲜度、独立生产者、测试结果、测试覆盖、部署 receipt 和 Approval receipt。包 3 和 5 提供相应领域事实；实现注册已审核的、代码拥有的 Checker 模块。

## 22. Completion 执行

框架规范化 Result candidate 并计算密封 Result 将收到的相同 digest。它解析精确 Task、CompletionPolicy、Kernel、Checker 实现、Artifact 集、Evidence 集和不可变 frontier。

一个失败或不确定的尝试记录有界 `completion.checked` Evidence，带 candidate digest、策略和实现 digest、Checker 原因码和 Evidence frontier。它不创建 Result。Agent 继续、提交有效 blocked 或 failed candidate，或达到其执行预算并接收框架产出的 failed Result。

一个通过的尝试原子地密封：

```text
Result
+ completion.checked(pass)
+ result.recorded
+ Evidence outbox
```

活跃 ledger tail 随后被同步 Anchor-checkpoint。Segment rotation 不阻塞此路径。

一个通过事件绑定 candidate/Result digest、outcome、CompletionPolicy、Kernel、Checker 结果、Evidence frontier、verdict 和可选 `validUntil`。记录和完成事件不包含在 Result.evidenceRefs 中，因为那会形成 digest 循环。

历史 anchored 通过 Evidence 保持为历史事实，即使可执行 Checker 包后来变得不可用。要求当前计算的重新评估、carry-forward 或待处理验收在精确实现无法加载时 fail closed。不可变 Checker 包和 registry manifest 应为适用审计和重新评估 horizon 保留，但包丢失不重写已记录的历史决策。

重复失败检查保持为 Evidence。它们可以被 rotated、archived 并总结为 Artifact 用于可观测性，但不被自动删除或语义折叠。

## 23. 新鲜度

新鲜度是相对 subject、策略、环境和时间的谓词；它永不是 Evidence 或 Artifact 上的可变标志。

- 结构新鲜度要求精确 subject 和 payload digest。
- Scope 新鲜度比较 Task WorkRef 与当前 Work 并使用包 1 carry-forward 规则。
- 策略新鲜度在需要处绑定 CompletionPolicy、Kernel、Checker、Team 和环境策略 digest。
- 时间新鲜度只用于真正过期的事实，并使用可信后端完成时间或 ledger 时间。
- 因果新鲜度要求在精确物化 Artifact 或环境状态之后并绑定到它的 Evidence。

时钟健康不确定性使时间检查不确定。Sequence 仍是排序权威。

Leader 验收重新验证 anchored 通过、策略适用性、`validUntil`、Artifact 可用性、scope 关系和更晚 Operation 不确定性。一个密封 Result 永不接收额外 Evidence。如果其固定 Evidence 不再适用，Leader 创建新的验证 Task 和 Result。

## 24. 捕获边界

Evidence 由可信 wrapper 和 adapter 自动发出，包括协调 port、工具 wrapper、Runner broker、Artifact Store、Approval 服务、部署 adapter，以及浏览器或外部服务 adapter。模型不接收通用 append-Evidence 工具。

小的安全事实进入 Evidence。后续检查需要的完整输出进入 Artifact Store。敏感重启材料留在受保护 payload 存储中，只由 digest 引用。无界低价值日志被总结和限定，而非复制进 Evidence。

## 25. 包 2 恢复与并发

恢复验证 Ledger genesis、Anchor、segment 范围、链 hash、活跃 tail、event-key 唯一性、事件和事实 schema、Recorder 权威和 EvidenceRef 索引。Gap、fork、冲突 event key、无效 Anchor 和未知类型 fail closed。

Artifact 恢复验证 Manifest digest、schema 和 handling 引用、provenance、反向记录 Evidence 和 payload 位置索引。Payload 在访问时重新哈希。可用性是 Projection，不是 Manifest 字段。

Completion 恢复从 Evidence 重建所有尝试和通过证明。缺失策略或实现使必需的重新评估不确定。它不抹除 anchored 历史事件。

多记录写入使用 write-ahead intent、不可变记录、Evidence outbox 和 commit marker。没有完整 commit 的记录不可见。恢复可以完成一个精确持久 outbox，但永不问模型该动作是否可能完成。

Evidence 追加使用按 Work 的锁或对 terminal hash 的 compare-and-swap。Payload 发布使用临时写入、同步、digest 验证和原子内容寻址发布。相同 payload 字节去重；digest 碰撞或不匹配是安全失败。Artifact ID 和 Task Result 提交拒绝最后写者胜冲突。

Completion 运行在 Task、candidate digest、策略、Artifact、Evidence、frontier 和 TaskRun 的固定快照上。新的并发 Evidence 不进入既有 candidate。最终密封重新检查没有 Result 或终态冲突被并发提交。

一个 Work 的并发 TaskRun 只串行化短的 Ledger 追加，并保留精确 TaskRun subject 和 fencing epoch；其模型、工具和输出工作保持并行。不同 Work ledger 没有发明的全局顺序。管理容量观察是时间新鲜的机器事实。缺失、过期、冲突、链无效或未授权的容量 Evidence 不能扩大执行，而是将受影响维度收窄为不可用，直到存在有效观察。Anchoring 遵循与每个其他管理 ledger 相同的使用规则。

## 26. 包 2 truth table

| 场景 | 决策 |
| --- | --- |
| 授权 Recorder 发出有效事件事实 | 允许 |
| Agent 选择 Recorder、sequence 或时间 | 拒绝 |
| Recorder 发出未授权或未知事件类型 | 拒绝 |
| 相同事件 key 和事实 replay | replay 既有 EvidenceRef |
| 相同事件 key 配不同事实 | 冲突并 fail closed |
| 链 gap、fork、hash 不匹配或无效 Anchor | fail closed |
| 有效但未 anchored 的活跃事件 | 仅临时 |
| 无完成 Evidence 的工具 proposal | 不证明执行 |
| 有效 payload、schema、provenance 和 handling 策略 | 密封 Artifact |
| Payload digest 不匹配或缺失 provenance | 拒绝 |
| 无反向记录 Evidence 的 Manifest | 从可信 projection 排除 |
| 相同 Artifact ID 和 digest replay | replay 成功 |
| 相同 Artifact ID 配不同 digest | 冲突 |
| 不同 Artifact 共享相同 payload | 允许 |
| Payload 移动且仍可按 digest 验证 | 允许 |
| Payload 缺失或损坏 | 不可用；不能重新验证 |
| AI 报告有有效 provenance | 证明产出，不证明语义正确性 |
| Kernel 和 outcome Checker 全通过 | 密封 Result |
| 任何 Checker 失败或不确定 | 不密封 |
| Evidence 属于另一个 Task 或 revision | 失败 |
| Blocked candidate 满足机器最低 | 密封 blocked Result；Leader 判断 blocker 语义 |
| Failed candidate 缺失失败 Evidence | 失败 |
| 策略或实现 digest 与 Task 不匹配 | fail closed |
| 通过 Evidence 在验收前过期 | 拒绝验收；创建新验证 Task |
| Result 已密封且新 Evidence 出现 | 不修改 Result |
| Completion 失败尝试累积 | 保留、rotate、archive 并可选总结；不自动删除 |
| 历史 anchored 通过存在但实现包不可用 | 保留历史事实；当前重新评估不确定 |
| Result 记录存在但无已提交完成和记录 Evidence | 从 projection 排除 |
| 恢复发现无 Manifest 的 payload | 孤立 payload，非 Artifact |

## 27. 包 3：外部效果与授权

包 3 控制 Task 隔离 workspace 之外的持久效果：

```text
Task 或 HumanInteraction -> Operation -> 精确 Approval -> Gate allow
                         -> 执行 Evidence -> receipt Artifact
```

Operation 覆盖外部、共享、公开、昂贵、安全敏感或不可逆效果，如 push、publish、deploy、云 mutation、数据库写、外部通知、工单 mutation、密钥 rotation、生产命令、资源删除和权威 Artifact payload 销毁。读取、搜索、隔离 workspace 编辑、构建、测试、内部 Artifact 持久化、可重建缓存驱逐、Evidence 追加和只读对账不是 Operation。

效果边界由实际语义决定，不是工具名。把 `publish` 或 `deploy` 包在 shell 命令里不绕过 Operation 控制。

## 28. Operation 合同

Operation 是一个不可变的、可审批的、可幂等执行的外部效果 intent。它不是执行状态或工具调用日志。

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
  "specSchemaRef": {
    "schemaId": "tiangong.operation-schema/deploy",
    "version": "1",
    "contentDigest": "sha256"
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

| 字段 | 合同原因 |
| --- | --- |
| `schema` | Pin 住 Operation 信封语义。 |
| `operationId` | 提供稳定 journal、幂等和恢复身份。 |
| `origin` | 把效果 intent 绑定到其精确 Task 或 HumanInteraction 来源。 |
| `adapterRef` | Pin 住解释和执行 spec 的可信实现。 |
| `scope` | 绑定 workspace、租户、环境和其他权威边界。 |
| `specSchemaRef` | Pin 住 Adapter 解释的精确结构 schema。 |
| `spec` | 绑定精确目标、input、前置条件和期望效果。 |
| `effectPolicyRef` | Pin 住授权、风险、幂等、验证、重试、补偿和恢复规则。 |
| `contentDigest` | 让 Approval 和 Journal 绑定精确 Operation。 |

`spec.schema` 必须匹配精确不可变 `specSchemaRef`；该 schema 和 pinned Adapter allowlist 定义代码拥有的 Operation 类型。两者都不解析可变最新版本。spec 永不含任意 shell 命令。凭证和原始受保护 payload 不进入 Operation 或 Evidence。当重启需要此类材料时，模型不可访问的受保护存储持有 payload，Operation 只记录其 digest。

Operation 排除可变状态、Approval 引用、actor 和时间、幂等 key、attempt、执行结果、rollback 状态、任意原始命令、凭证、原始受保护 payload、自由风险标签、面向 Human 的审批叙述、metadata 和扩展。

### 28.1 Operation 不变量

1. Operation 不可变；任何目标、input、前置条件或期望效果变更创建新 Operation。
2. 一个 operation ID 映射到一个 digest。
3. 只有 pinned 授权 Adapter 可以执行 pinned Operation schema。
4. Origin kind 是代码拥有的：普通效果绑定 Task；正式 Human 交付绑定 HumanInteraction。不存在其他隐式系统 origin。
5. Task-origin scope 必须被 Agent capability、Task 执行策略和 ResolvedWorkPolicy 一起允许。Interaction-origin 交付必须被 Leader 协调 capability 加已解析 Human、报告、受众、channel 和效果策略允许。
6. 效果策略由代码解析，不能被模型弱化。
7. `operation.recorded` 证明密封 intent，不是执行。
8. 每个实际执行对相同 Operation digest 有精确 Approval。
9. 一个 Operation 有一个稳定外部幂等身份。
10. 不确定结果阻断自动重试。
11. Result 拒绝或 Work 取消永不抹除真实效果。
12. 一个新 Operation attempt 要求 origin Work revision 和精确 Approval Work revision 是当前的。它还要求一个开启的 Work，除了代码拥有的、策略授权的 Interaction-origin 终态或恢复 `inform` 交付。先前 attempt 保持为历史事实，但 revision 使旧 intent 的未来重试无效。

## 29. OperationProposal Artifact

一个 Prepare Task 密封 Operation 并产出 typed OperationProposal Artifact。其 payload 无内层身份或 content digest：

```json
{
  "schema": "tiangong.operation-proposal/v1",
  "operationRef": {
    "operationId": "operation-123",
    "contentDigest": "sha256"
  },
  "safeSummary": {
    "target": "orders-api pre-production",
    "effect": "promote the exact image Artifact"
  },
  "inputRefs": [],
  "configurationRefs": [],
  "environmentRef": {
    "environmentId": "pre-production",
    "contentDigest": "sha256"
  },
  "risk": {
    "riskClass": "high",
    "maximumCostMinorUnits": 1000,
    "currency": "USD"
  },
  "failureImpact": {
    "summary": "The target may remain unavailable until recovery completes.",
    "affectedScopeRefs": []
  },
  "preconditionRefs": [],
  "verificationPlanRef": {
    "artifactId": "operation-verification-plan-123",
    "contentDigest": "sha256"
  },
  "recoveryPlanRef": {
    "artifactId": "operation-recovery-plan-123",
    "contentDigest": "sha256"
  },
  "compensationPlanRef": null
}
```

精确 Artifact schema 绑定 OperationRef、有界安全摘要、精确 input、配置和环境、策略派生风险和最高成本、前置条件、验证计划、失败影响，以及恢复和可选补偿计划。Input、配置、scope、验证、恢复和补偿引用精确解析，必须被 Operation 和 EffectPolicy 许可。Failure-impact 和摘要叙述是有界 Claim，供审核，不能改变 Operation 语义。原始受保护 payload 和凭证被排除。

Human 授权呈现从 Operation、EffectPolicy 和 Proposal 确定性地生成。Approval 绑定 Operation digest、Proposal Artifact digest 和呈现 digest，因此 Leader 叙述不能在审核后替代另一个效果。

## 30. Approval 合同

Approval 是一个不可变授权授予。它不证明执行或语义 Result 验收。

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

| 字段 | 合同原因 |
| --- | --- |
| `schema` | Pin 住 Approval 信封。 |
| `approvalId` | 提供稳定消费和撤销身份。 |
| `grant` | 定义精确或有界权威、Work scope、限制和有效性。 |
| `basisRefs` | 绑定策略、Human 呈现和已认证答案 evidence。 |
| `contentDigest` | 让 Gate 和 Journal 绑定精确授予。 |

已认证授予者和可信时间由 `approval.recorded` Evidence 记录，而非复制进 Approval。

Approval 排除自报告授予者和时间、可变状态、已消费或使用计数字段、revoked 标志、Operation 结果、Leader 叙述、原始 Human 消息、任意 scope 表达式、可重用 bearer token、metadata 和扩展。

### 30.1 Grant 种类

- `exact-human` 在已认证 Human 授权后绑定一个 Operation 和当前 Work。
- `bounded-human` 绑定严格 Operation schema、目标、环境、计数、成本和有效性限制。它不能直接执行。
- `exact-derived` 原子地为 一个 Operation 消费有界权威，不能扩展父权威。
- `exact-policy` 记录一个特定 Operation 被 pinned standing EffectPolicy 允许。

每个实际执行使用一个精确 grant。有界 Human 和 standing 策略权威永不被直接传给 Adapter。

### 30.2 Approval 不变量

1. 只有可信 Authorization 边界创建 Approval。
2. Human grant 要求已认证 Human 和被展示的精确呈现。
3. 精确 Approval 绑定一个 Operation 身份和当前 Work revision。
4. 有界权威不能执行，每个派生 grant 原子消费配额。
5. 策略派生精确 Approval pin 住当时使用的策略版本。
6. 过期或有效撤销的 Approval 不能开始或重试执行。
7. 执行开始后的过期不阻止完成记录或对账。
8. Approval 首次使用分配和 Operation Journal 开始是原子的；相同 Operation 重试重新验证精确 grant，不授权另一个 Operation。
9. Human 拒绝不创建 Approval。
10. 撤销是一个新的 `revoke-approval` CoordinationDecision，永不抹除已开始的执行。
11. Approval、Proposal 和权威 Evidence 在 Operation 审计 horizon 内保留。

包 3 用 `revoke-approval` 扩展 CoordinationDecision，其 subject 是 `approval` 和 `target-work`。撤销停止未消费或未来权威；它不制造一个进行中或已完成效果从未发生的 claim。

## 31. Task 与授权流程

精确 Human 授权使用分离的 Task：

```text
Prepare Task
  -> Operation + OperationProposal Artifact + completed Result
Leader
  -> authorize interaction
  -> 已认证 exact-human Approval + anchored Evidence
Execute Task
  -> input 包含 OperationRef 和 ApprovalRef
  -> Gate -> 效果 -> receipt Artifact -> Result
```

一个 Task 永不为 Human 审批挂起。

Standing 策略和有界预授权不要求逐 Operation Human 往返：

```text
具体 Operation
  -> 策略或有界 scope 检查
  -> exact-policy 或 exact-derived Approval
  -> 执行
```

如果需要意外 Human grant，当前 Task 密封 Operation 和 Proposal，返回 blocked Result 而不执行，并结束。Leader 请求授权并创建新 Execute Task。

## 32. Gate 层

Gate 是代码，不是 Agent。它按顺序检查：

1. **Schema 与完整性** —— Operation、Approval、Registry、digest、引用和敏感数据有效性。
2. **Capability** —— 对 Task origin，派发、assignee、Agent capability 和 Task 策略；对 HumanInteraction origin，Leader 和可信交付运行时 capability；两种情况都解析 scope、workspace、channel 和环境。
3. **效果策略** —— 目标、风险、成本、数据分类、授权模式、验证和补偿要求。
4. **Approval** —— 精确 grant、anchored 权威 Evidence、Operation 和 Work 匹配、过期、撤销、父 scope、配额和审批者权威。
5. **幂等与恢复** —— 完成 replay、执行中冲突、不确定对账要求和受保护 payload 可用性。
6. **前置条件** —— 执行前即时的当前目标状态、input、配置、环境、租约和执行计划 digest。

Gate 返回 `allow`、`deny`、`approval-required` 或 `reconcile-required` 并记录严格 `gate.decided` Evidence。Approval-required 永不挂起 Task 或 Matrix turn。已变更的前置条件通常要求新 Operation，而非修改旧 Operation。

## 33. 效果执行协议

效果生命周期是一个小的代码拥有的安全协议，不是 Team 工作流。操作视图从 Journal 和 Evidence 派生：

```text
recorded -> authorized -> execution-started
  -> succeeded
  -> failed-no-effect
  -> partial-effect
  -> uncertain
  -> compensated 或 recovery-required
```

执行顺序是：

```text
Operation 和 Anchor
-> 精确 Approval 和 Anchor
-> Gate allow
-> 原子 Approval 首次使用分配或相同 Operation 重试验证 + Journal 开始
-> 持久且 anchored execution.started
-> 后端调用
-> receipt 和 postcondition 验证
-> 终态 Evidence
-> OperationReceipt Artifact
```

成功要求可信后端 receipt 和已验证 postcondition。仅 HTTP 成功或模型文本不足。失败只在 Adapter 证明无外部效果发生时为 `failed-no-effect`。超时、开始后进程丢失、不可验证 receipt、Journal/后端冲突或不支持幂等默认为不确定。

## 34. 以 Operation 为中心的幂等与 Journal

稳定 key 独立于模型 session 和 turn：

```text
idempotencyKey = digest("sha256", jcs("tiangong-jcs/v1", {
  schema: "tiangong.operation-idempotency/v1",
  operationId,
  operationDigest
}))
```

完成 replay 返回已保存的安全 Receipt，不调用后端。Started without terminal 不确定。重试只在特权对账证明 `not-applied` 且当前策略和 Approval 仍允许时被允许。任何 spec 变更创建新 Operation 和 Approval。

代码拥有的 Operation Journal 存储不可变 Operation 绑定、幂等 key、受保护 payload digest 和 append-only attempt。每个 attempt 绑定其精确 ApprovalRef、授权 TaskRun 或可信系统执行者、调用、持久开始和终态事实、安全 replay Receipt 和对账事实。Journal 是机器状态，不是 Evidence 或模型可写 Artifact。它跨进程串行化、加载时验证、hash 保护，并由 outbox 与 Evidence 协调。不确定条目保留恢复材料，永不自动清理。

## 35. 补偿与对账

一个外部 rollback 本身是一个外部效果，因此是一个新 Operation，有自己的 EffectPolicy、精确 Approval、Evidence 和 Receipt。原始 Operation 保持为历史事实。只有本地临时清理可以保持为内部 Adapter 生命周期动作。

正向审批可以单独授权一个精确补偿 Operation，或 standing 紧急策略可以派生一个。否则在失败后请求 Human 授权。

对账是模型不可访问的特权服务或 CLI。它使用 OperationRef、幂等 key、目标和 receipt 查询后端状态，并记录 `applied`、`not-applied`、`partially-applied` 或 `still-uncertain`。只读对账不是 Operation。任何纠正性 mutation 是新 Operation。

- applied：验证 postcondition 并记录成功；
- not applied：只在策略和 Approval 保持有效时允许相同 key 重试；
- partially applied：创建补偿或恢复 Operation；
- still uncertain：保持 recovery-required 并拒绝重试。

## 36. Result 与 Completion 绑定

Execute Task Result 引用一个 OperationReceipt Artifact 和执行、对账或补偿 Evidence；Result 不添加 Operation 字段。Receipt 是一个 typed Artifact payload，无内层身份或 content digest：

```json
{
  "schema": "tiangong.operation-receipt/v1",
  "operationRef": {
    "operationId": "operation-123",
    "contentDigest": "sha256"
  },
  "approvalRef": {
    "approvalId": "approval-123",
    "contentDigest": "sha256"
  },
  "adapterRef": {
    "adapterId": "deployment-adapter",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "idempotencyKeyDigest": "sha256",
  "journalTerminal": {
    "kind": "execution",
    "attemptId": "attempt-1",
    "reconciliationId": null,
    "eventType": "execution-succeeded",
    "journalSequence": 2,
    "journalHash": "sha256"
  },
  "attemptEvidenceRefs": [
    {
      "ledgerId": "work:work-123",
      "sequence": 90,
      "hash": "sha256"
    },
    {
      "ledgerId": "work:work-123",
      "sequence": 91,
      "hash": "sha256"
    }
  ],
  "outcome": "succeeded",
  "backendReceiptRef": {
    "artifactId": "backend-receipt-123",
    "contentDigest": "sha256"
  },
  "postcondition": {
    "verdict": "verified",
    "observedStateDigest": "sha256",
    "checkerRef": {
      "implementationId": "postcondition/deployment-state",
      "version": "1",
      "implementationDigest": "sha256"
    },
    "evidenceRefs": [
      {
        "ledgerId": "work:work-123",
        "sequence": 92,
        "hash": "sha256"
      }
    ]
  }
}
```

`journalTerminal` 是一个严格的执行或对账 union，在 Receipt 密封前绑定精确 attempt、可选对账身份、终态事件类型、sequence 和 hash。更晚的 `receipt-recorded` Journal 事件绑定密封 Receipt Artifact，因此不能从其 payload 引用。Attempt 和 postcondition EvidenceRef 必须解析到相同 Operation、attempt 或对账、Adapter、目标、环境和已认证执行边界。

Outcome 是对 `succeeded`、`failed-no-effect`、`partial-effect` 和 `uncertain` 的严格判别 union；每个分支定义必需和禁止的后端 receipt、postcondition 和对账字段。更晚的对账发布一个新 Receipt Artifact，绑定其新 Journal terminal，永不修改更早 Receipt。补偿是一个分离 Operation，有自己的 Approval 和 Receipt 加 `operation.compensation.linked` Evidence；它是派生的原始 Operation 处置，不是 OperationReceipt outcome 或插入旧 Receipt 的未来引用。Receipt 通过 Operation 和观察到的事实绑定精确目标和环境。后端原始响应在 retention 许可时是分离的有界 Artifact。只有验证的成功满足 completed 效果要求。

包 2 `terminal-effect-safety` 检查与 candidate Task 关联的所有 Task-origin Operation。Work 关闭单独检查其 Task 或 HumanInteraction origin 属于该 Work 的每个 Operation：

- completed 要求精确 Approval、验证成功、Receipt Artifact，且无执行中、partial 或不确定效果；
- blocked 允许记录但未执行的 Operation 和 Proposal，无执行开始；
- failed 允许已知无效果失败、显式 partial 恢复、补偿或披露不确定性。

一个不确定的已开始 Operation 不能被软化为 blocked。一个 failed Result 可以真实保留不确定性，但 Work 不能在恢复达到允许终态条件前成功完成。Work 可以改为以显式 recovery-required 条件失败。该终态 Decision 不关闭其 Evidence Ledger 或 Journal：更晚对账事实追加而不改变 failed Decision，而任何纠正性 mutation 由分离的恢复或事故 Work 协调。

## 37. 包 3 命令与 Guard

| 命令 | 确定性 Guard 与输出 |
| --- | --- |
| `record_operation` | 验证精确 Task 或 HumanInteraction origin、对应 capability 和已解析策略、严格 spec、Adapter、scope、EffectPolicy provenance、input 引用、前置条件和密钥排除；写 Operation 和 Evidence。 |
| `request_authorization` | 要求 anchored Operation 和有效 Proposal；从机器字段生成呈现；记录请求 Evidence 并发送 Human authorize interaction，不挂起 Task。 |
| `record_exact_human_approval` | 认证 Human、匹配请求、Operation、Proposal、呈现、当前 Work、权威角色和有效性；写 Approval、Evidence 和 Anchor。 |
| `record_bounded_human_approval` | 要求严格有界 scope、有限限制、授权 Human 和显式生成呈现。 |
| `derive_exact_approval` | 证明具体 Operation 在 standing 或父权威内；原子消费配额；永不扩展 scope；写精确 Approval 和 Evidence。 |
| `execute_operation` | 运行所有 Gate 层；原子分配或重新验证精确 Approval 并开始 Journal attempt；在后端调用前持久开始。 |
| `replay_operation` | 要求验证终态成功和匹配 digest；返回已保存 Receipt，无后端调用。 |
| `reconcile_operation` | 只允许特权 reconciler 处理不确定或 partial Operation；执行只读验证查询并记录 Evidence。 |
| `create_compensation_operation` | 要求需要补偿的真实效果、兼容 schema 和策略、有效当前前置条件、有界影响和精确 Approval。 |
| `revoke_approval` | 追加 CoordinationDecision；对执行开始串行化；阻止未来权威而不抹除真实效果。 |

## 38. 包 3 Evidence

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

Approval 记录绑定已认证权威。Gate allow 绑定精确 Operation 和 Approval。执行开始在后端调用前持久。超时和异常永不暗示无效果失败。终态 Evidence 绑定验证的后端 Receipt 和 postcondition。Approval 和 execution-start frontier 在外部效果前 anchored。Evidence 不含凭证、原始受保护 payload 或无界后端响应。

## 39. 效果恢复与并发

重启时：

- recorded 但无 Journal 开始被 Tiangong 已知为未执行；
- 有效终态 Journal 和 Receipt 可以完成精确 Evidence outbox，无需另一次后端调用；
- begin without terminal 不确定；
- 有终态 Evidence 但缺失 Journal 要求验证后端 receipt 和特权对账，然后才能恢复；
- 受保护 payload 在 pending、执行中或不确定时保留。

一个 Operation key 串行化执行。并发调用观察执行中、replay 终态 Receipt 或收到 reconcile-required。有界配额使用 CAS；已开始 Operation 即使后来失败也消费配额。

Approval 撤销和执行开始共享一个线性化点。撤销先则拒绝执行；开始先则效果已开始，撤销只限制未来使用。Work revision 和执行开始同样有序。先提交的 revision 使旧权威无效。如果执行先开始，revision 看到活跃效果；当 Operation 执行中或不确定时，普通 Work revision 被拒绝。紧急响应用分离的恢复或事故 Work，而非改变活跃 Operation 的含义。

## 40. 包 3 truth table

| 场景 | 决策 |
| --- | --- |
| 隔离读取、编辑、构建或测试 | 普通工具执行 |
| Push、publish、部署、外部写、消息或删除 | 要求 Operation |
| Shell 命令试图隐藏外部效果 | 拒绝原始命令路径 |
| 未知 Operation schema、Adapter 不匹配或 spec 含密钥 | 拒绝 |
| 精确 Human Approval 匹配 Operation 和当前 Work | 有资格 Gate |
| Human 审核后 Operation 变更 | Approval 不适用 |
| Standing 策略覆盖具体 Operation | 派生 exact-policy Approval |
| 有界 grant 覆盖 Operation 且配额可用 | 派生 exact-derived Approval |
| 有界 grant 直接传给 Adapter | 拒绝 |
| Operation 超出有界 scope、成本、时间或目标 | 拒绝并请求新权威 |
| Human 拒绝或未认证 Leader 声称同意 | 无 Approval |
| Task 试图等待 Human | 拒绝；密封 blocked Result 并返回 Leader |
| 所有 Gate 层通过 | 开始一个幂等执行 |
| Approval 缺失 | approval-required；无效果 |
| Operation 不确定 | reconcile-required；无重试 |
| 目标前置条件变更 | 拒绝；通常创建新 Operation |
| 后端成功且 postcondition 验证 | succeeded |
| 后端效果前失败 | failed-no-effect |
| 请求发送后超时或 receipt 无法验证 | uncertain |
| 后端部分应用效果 | partial；恢复或补偿 |
| 完成 Operation 再次被调用 | replay 已保存 Receipt |
| 对账证明未应用且权威保持有效 | 允许相同 key 重试 |
| 对账证明已应用 | 验证并记录成功 |
| 对账保持不确定 | recovery-required |
| 外部 rollback 是隐藏回调 | 拒绝目标设计 |
| 分离的补偿 Operation 有精确 Approval | 允许 |
| Completed Result 有不确定或 partial Operation | Completion 失败 |
| Blocked Result 无执行开始且有有效 Proposal | 有资格 blocked 检查 |
| Failed Result 显式保留不确定 Evidence | 可密封 failed；Work 不能完成 |
| Failed Work 后来收到对账 Evidence | 追加恢复事实；不重写终态 Decision |
| 重启后有 Journal 开始但无终态 | uncertain |
| 两个并发执行 | 一个效果；其他等待、replay 或对账 |
| Approval 撤销在开始前胜出 | 拒绝执行 |
| 开始在撤销前胜出 | 执行事实保留 |
| Work revision 在开始前胜出 | 旧 Approval 无效 |
| 开始在 revision 前胜出 | revision 看到活跃效果，通常拒绝 |
| 相同 operation ID 配不同 digest | 冲突并 fail closed |

## 41. 包 4：组织与行为塑造

包 4 定义谁属于一个 Team、哪个 Agent 定义由 Worker 运行、它被允许做什么，以及指令、Skill、检索到的知识和 Concern 如何塑造自主行为。权限保持在 Prompt 内容之外。

包 4 添加 TeamDefinition 作为必需的不可变 roster 记录。没有它，Work.teamRef 和 Task.assigneeRef 没有精确来源用于 Leader 身份、成员、Worker 绑定或 AgentDefinition 版本。

## 42. TeamDefinition 合同

```json
{
  "schema": "tiangong.team-definition/v1",
  "teamId": "team-1",
  "leaderMemberId": "member-leader",
  "platformTeamBinding": {
    "provider": "agentteams",
    "teamId": "agentteams-team-1",
    "generationDigest": "sha256"
  },
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

| 字段 | 合同原因 |
| --- | --- |
| `schema` | Pin 住 roster 和成员绑定语义。 |
| `teamId` | 提供稳定 Tiangong Team 身份。 |
| `leaderMemberId` | 精确标识唯一 Leader，不推断角色名。 |
| `platformTeamBinding` | Pin 住已认证平台 Team 和精确观察到的 roster generation。 |
| `members` | 把每个已准入 Worker generation 绑定到精确 AgentDefinition。 |
| `teamPolicyRef` | Pin 住 Team 默认值和可配置策略边界。 |
| `contentDigest` | 让 Work 绑定精确 roster 快照。 |

一个 Team 恰好一个 Leader 和任意数量已批准专业成员。成员和 Worker 身份唯一。Leader 定义必须包含协调 capability。Kernel 没有固定 Designer、Implementor、Assessor 或 Operator 枚举。

`platformTeamBinding.generationDigest` 由已认证平台 Adapter 在精确 Team 身份和观察到的 roster/资源 generation 上产出。如果平台不暴露原生 generation，Adapter 密封一个精确 roster 快照 Artifact 并从中派生 digest。平台存在是活事实；Tiangong 准入仍是这个不可变 TeamDefinition。不匹配、缺失 Worker 或未证明平台 generation 拒绝新派发。

多个成员可以绑定相同精确 AgentDefinition，同时各自绑定不同精确 Worker。这些预绑定副本是水平专业容量的首选初始形式；AgentDefinition 身份不是运行时锁。调度器不能静默添加、替换或重定向 Worker。副本或 roster 变更创建新 TeamDefinition，既有 Work 只通过 Work revision 采纳它。

TeamDefinition 不可变。Roster 或 TeamPolicy 变更产出新 digest。既有 Work 只通过新 Work revision 采纳它。旧 Task 绑定保持为历史事实。安全撤销可以阻止派发或执行，不重写旧 TeamDefinition。

TeamDefinition 排除可变 presence 或健康、Work 和 Task 引用、actor 和时间、可变平台容器或 Matrix 细节、权限内容、Skill 内容、工作流、固定专业角色名、metadata 和扩展。

## 43. AgentDefinition 合同

AgentDefinition 打包稳定的职责指令、机器 capability 和允许的方法，同时保持其权威分离。

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

| 字段 | 合同原因 |
| --- | --- |
| `schema` | Pin 住完整 Agent 定义。 |
| `agentDefinitionId` | 提供稳定 Catalog 身份。 |
| `version` | 支持显式已审核演进。 |
| `responsibilityRef` | Pin 住专业职责、边界和判断原则。 |
| `capabilityPolicyRef` | 独立于指令 pin 住机器执行的权限。 |
| `skillRefs` | 为一个专业内的多样工作提供已批准方法集。 |
| `contentDigest` | 让 Team 和 Task 绑定精确定义。 |

SOUL 不是独立领域对象。既有 SOUL 文档可以是职责 Artifact。它塑造专业行为，但不能注册工具、授予路径或环境、授权 Operation、覆盖 Gate 或决定 Completion。

AgentDefinition 排除 Worker 和 Team 身份、Work 和 Task 状态、模型/provider、工具名、凭证、选定 Skill 状态、Concern 状态、检索结果、记录、可变启用标志、metadata 和扩展。

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

Capability 引用是代码拥有的授予，如团队协调、仓库读、隔离修改、隔离测试、Artifact 创建、Operation 准备或精确效果执行。未声明 capability 被拒绝。

有效权限是一个交集：

```text
Control Kernel
AND TeamPolicy 上限
AND Agent CapabilityPolicy
AND Task ExecutionPolicy
AND 活 EnvironmentPolicy
```

每层可以收窄，无一可以扩展另一层。Skill、RAG、Task 叙述和模型输出不授予 capability。Standing 效果授权不暗示 Agent 有执行该效果的 capability。

CapabilityPolicy 排除 Prompt 和 SOUL、Skill 引用、凭证、任意工具 glob、默认允许、运行时状态、模型身份、metadata 和扩展。

## 45. TeamPolicy 合同

TeamPolicy 组合版本化默认值和有界可配置策略模块。它不是 Control Kernel、工作流、roster、权限 union 或 Prompt。

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
      "slot": "execution-concurrency",
      "policyRef": {
        "policyId": "execution-concurrency/standard-work",
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

| 字段 | 合同原因 |
| --- | --- |
| `schema` | Pin 住 TeamPolicy 组合语义。 |
| `policyId` | 提供稳定策略身份。 |
| `version` | 支持显式 Team 策略演进。 |
| `controlKernelRef` | 防止 Kernel 变更静默改变既有 Team。 |
| `moduleBindings` | 选择严格代码已知的默认值和可配置模块。 |
| `contentDigest` | 让 Team pin 住解析 Work 策略的精确默认值。 |

代码拥有有限 slot 目录，包括 task control、执行并发、资源预算、completion、work closure、质量基线、效果授权、环境访问、知识访问、Concern 选择、Human 交互、报告和 retention。每个 slot 至多一个已解析 PolicyRef 和带默认值与有界覆盖范围的严格 schema。这是策略组合，不是工作流或表达式 DSL。

Work 创建把 Team 默认值加允许 Work 覆盖解析为 Work.policyRef 引用的不可变 ResolvedWorkPolicy。省略值在哈希前物化。覆盖不能突破 Kernel 下限。TeamPolicy 更新不追溯改变 Work；采纳要求 Work revision。

TeamPolicy 排除阶段、固定角色列表、Agent 工具授予、Skill 内容、知识内容、Concern 评估器代码、任意规则 DSL、Prompt 片段、可变覆盖、metadata 和扩展。

### 45.1 执行并发与团队调度器策略

`execution-concurrency` slot 物化可归因于一个 Work 的不可变上限。其严格模块 schema 是：

```json
{
  "schema": "tiangong.execution-concurrency-policy/v1",
  "policyId": "execution-concurrency/standard-work",
  "version": "1",
  "workLimits": {
    "maxConcurrentTaskRunsPerWork": 4,
    "defaultMaxConcurrentTaskRunsPerMemberForWork": 1,
    "memberLimits": []
  },
  "resourceLeasePolicyRef": {
    "policyId": "resource-lease/default",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

一个 `memberLimits` 条目恰好有 `memberId` 和 `maxConcurrentTaskRunsForWork`。条目可以在已审核 TeamPolicy 范围内高于或低于同包默认值。每个成员 ID 唯一，必须解析到 Work revision 绑定的精确 TeamDefinition；重复、悬空或冲突条目 fail closed。每个值保持受 Work 最大值和活的团队与 Worker 容量约束。Kernel 固定每个 Work 一个当前 Leader-turn 租约，因此没有可配置的 `maxConcurrentLeaderTurnsPerWork`。

团队全局容量不从某个 Work 的 ResolvedWorkPolicy 复制，因为并发 Work 可以绑定不同 TeamPolicy 版本。一个不可变管理 TeamSchedulerPolicy 由稳定团队身份选择：

```json
{
  "schema": "tiangong.team-scheduler-policy/v1",
  "policyId": "team-scheduler/team-1",
  "version": "1",
  "teamId": "team-1",
  "limits": {
    "maxConcurrentLeaderTurnsPerTeam": 1,
    "maxConcurrentTaskRunsPerTeam": 8,
    "maxConcurrentTaskRunsPerWorker": 1
  },
  "fairnessPolicyRef": {
    "policyId": "scheduler-fairness/weighted-fifo",
    "version": "1",
    "contentDigest": "sha256"
  },
  "capacityAdapterRefs": [
    {
      "adapterId": "team-runtime-capacity",
      "version": "1",
      "implementationDigest": "sha256"
    }
  ],
  "contentDigest": "sha256"
}
```

当前 TeamSchedulerPolicy 映射和活 Capacity Adapter 观察是命名空间限定的管理事实，不是 Work 权威。派发 Evidence 绑定精确 SchedulerPolicy、容量 generation 和使用的观察。策略更新可以立即为安全收窄新派发，不隐式取消运行中 TaskRun；增加只放宽 Team 侧约束，永不将 Work 扩展到其不可变 ResolvedWorkPolicy 之外。FairnessPolicy 是代码拥有的、严格的，只可以使用有界已检查权威的优先级输入。它不能解释任意模型紧迫性。FairnessPolicy 和 ResourceLeasePolicy 是通过第 83 节支撑 Policy Registry 解析的被引用 Policy 包；每个有不可变已审核条目和严格代码拥有 schema。

```text
有效并发 = min(
  不可变 Work 和成员上限,
  活的团队和 Worker 上限,
  新鲜 provider 和 Runner 容量,
  CPU、内存、Workspace 和存储容量,
  外部配额和成本或 token 预算,
  兼容资源租约,
  独立有用工作数量
)
```

`maxOpenWorksPerTeam` 不属于任一策略。SchedulerPolicy 和容量状态可以延迟执行，但不能拒绝或语义修改一个本可准入的 Work。队列、slot、租约、当前策略映射和容量是不可变 Policy 和 Evidence 事实上的可变机器 Projection，不是业务记录。

## 46. Skill 合同

Skill 是一个批准的方法包，对一个或多个兼容 Agent 定义可用。它既不改变 profession，也不授予权限。

```json
{
  "schema": "tiangong.skill/v1",
  "skillId": "regression-test-selection",
  "version": "1",
  "selectionDescription": "Select an evidence-backed regression set from impact analysis and core tests.",
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

| 字段 | 合同原因 |
| --- | --- |
| `schema` | Pin 住 Skill 包解释。 |
| `skillId` | 提供稳定方法身份。 |
| `version` | 支持已审核方法演进。 |
| `selectionDescription` | 从允许集中启用 Task 相关选择。 |
| `instructionRef` | Pin 住精确方法指令。 |
| `resourceRefs` | Pin 住脚本、模板、引用和资产。 |
| `requiredCapabilityRefs` | 声明兼容性前置条件，不授予它们。 |
| `contentDigest` | 让 Context Evidence 把精确加载方法绑定到 TaskRun。 |

专业 Skill 教一个 Agent 如何执行工作。Leader 协调 Skill 教 Leader 如何分解、委托、审核和报告经典多 Agent 模式。协调 Skill 仍只通过 Leader 工具和 Guard 行动。

Task 不绑定强制 Skill 列表。运行时使用 TaskSpec 提示、选择描述和 context 从 AgentDefinition 选择子集，Context Evidence 记录针对 TaskRun 的精确加载 digest。Agent 可以在 Task 期间加载另一个允许 Skill。如果一个方法必须被机器执行，它成为 Checker 或 Gate，而非 Skill 名要求。

Skill 排除工具权威语义、角色切换、Practice 或 PracticeRun、工作流状态、Completion verdict、Approval 覆盖、任意运行时安装、私有依赖、密钥、可变进度、metadata 和扩展。捆绑脚本保持供应链输入，只通过 Capability、Task 策略、Gate 和 Evidence 边界执行。

## 47. 知识与检索合同

Tiangong 把检索当作一个受约束的知识运行时，不是第二真相、权威或编排平面。知识源首先作为带 provenance 的 Artifact 存在。搜索索引、embedding、sparse term、生成的摘要、排序分数和物理后端状态是可重建的派生数据。精确源 Artifact 和 slice digest 保持权威。

检索到的字节是不可信数据，绝不是系统指令。它们不能授予 Capability、授权 Operation、覆盖 Kernel、Work、Task、Policy、Gate、Approval、Skill 或 Completion，或证明一个 Claim 为真。检索材料的模型合成是 Claim 或 Artifact，不是 Evidence。没有要求说每个 Task 必须使用检索。

KnowledgeSourceSnapshot、KnowledgeIndexManifest 和 RetrievalBundle 是第 19 节下的 typed Artifact payload，而非新业务 Aggregate。它们的正式身份和 payload digest 只来自外层 Artifact Manifest；payload 不重复 Artifact ID 或 `contentDigest`。SourceSliceRef 是既有 ArtifactRef、严格 locator 和 digest 的有界 composite；它不是独立引用族。物理索引状态是可变 Projection/缓存，永不接收领域 RecordRef。

### 47.1 所有权与源生命周期

在第 2.9–2.10 节的全局所有权和威胁边界下，Tiangong 拥有知识 schema、源准入和 promotion Guard、KnowledgeAccessPolicy、Adapter allowlist、检索预算、Bundle 密封、Context 准入、引用检查、Evidence 事件、Recorder allowlist、恢复和评测 gate。AgentTeams 只提供为活跃部署档位验证的已认证平台身份和存储集成保证。存储、索引、embedding、reranking 和模型 provider 不拥有 Tiangong 权威，不能发出可信 Tiangong Evidence。

代码拥有的源类型目录可以准入精确仓库快照、架构和接口文档、已接受需求、SystemMap、TestDefinition、TestSet、TestPlan、已接受 TestRun 摘要、已批准事故和 runbook、组织规则，以及显式晋升的 Result 或 Finding。源类型不确立真相；每个源保留其自身 Artifact 和 Claim 语义。

一个可信 Source Capture Recorder 解析已认证 scope 和 baseline，执行路径、大小、类型、分类、handling 和 retention 限制，密封源 Artifact 和 KnowledgeSourceSnapshot，并记录有界 Evidence。一个仓库源绑定不可变 commit、tree 或等价 baseline；它永不就地索引移动的 TaskRun Workspace。当前可变 Workspace 字节通过授权的直接工具和其自身 Evidence 检查。一个密封的新源或 patch 只能进入更晚的显式快照和索引 generation。

没有模型输出、Result、Finding、对话摘要、生成的 runbook 或检索合成，仅因为它为一个 Task 产出或被验收，就成为可重用的 Team、租户或组织知识。Promotion 使用分离的管理 KnowledgePromotionPolicy 和确定性 Guard，验证合格 schema 和 provenance、精确目标 scope 和分类、必需的独立或 Human 审核 Evidence、未解决 Finding、效果和撤销缺失、retention 和受众适用性，以及可信 Recorder 权威。例如：

```json
{
  "schema": "tiangong.knowledge-promotion-policy/v1",
  "policyId": "knowledge-promotion/governed-technical-material",
  "version": "1",
  "eligibleSourceKinds": [
    "architecture-document",
    "accepted-result",
    "incident-record",
    "approved-runbook"
  ],
  "eligibleArtifactSchemaRefs": [
    {
      "schemaId": "artifact-schema/technical-document",
      "version": "1",
      "contentDigest": "sha256"
    },
    {
      "schemaId": "artifact-schema/accepted-result-export",
      "version": "1",
      "contentDigest": "sha256"
    }
  ],
  "targetScopeKinds": ["work", "team", "tenant"],
  "modelAuthoredDisposition": "independent-review-required",
  "requiredCheckerRefs": [
    {
      "implementationId": "knowledge-promotion/provenance-checker",
      "version": "1",
      "implementationDigest": "sha256"
    }
  ],
  "reviewAuthorityPolicyRef": {
    "policyId": "knowledge-review/technical-material",
    "version": "1",
    "contentDigest": "sha256"
  },
  "handlingPolicyRef": {
    "policyId": "handling/internal-source",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

KnowledgePromotionPolicy 是一个管理 Policy 包，不是 ResolvedWorkPolicy slot。`knowledge-source.promoted` 不同于源创建、Result 验收和 Work 验收。不引入固定 Knowledge Curator 角色；actor 必须拥有精确管理 capability 和权威。

源纠正创建新 Artifact 和快照。撤销是一个新的管理事实，阻止新检索，不重写旧源或历史 Bundle。物理索引删除是缓存维护，不是历史擦除。受保护 payload 删除仍由 RetentionPolicy、法律 hold、Artifact pin 和显式 Evidence 治理。

### 47.2 KnowledgeSourceSnapshot 与 SourceSliceRef

一个 KnowledgeSourceSnapshot 绑定一个精确已准入源集：

```json
{
  "schema": "tiangong.knowledge-source-snapshot/v1",
  "scope": {
    "kind": "work",
    "ref": {
      "workId": "work-123",
      "revision": 2,
      "contentDigest": "sha256"
    }
  },
  "sourceKind": "repository-snapshot",
  "sourceArtifactRefs": [
    {
      "artifactId": "repository-snapshot-123",
      "contentDigest": "sha256"
    }
  ],
  "classification": "internal",
  "handlingPolicyRef": {
    "policyId": "handling/internal-source",
    "version": "1",
    "contentDigest": "sha256"
  },
  "captureImplementationRef": {
    "implementationId": "knowledge-source-capture/git",
    "version": "1",
    "implementationDigest": "sha256"
  }
}
```

外层 ArtifactRef，如 artifact ID `knowledge-source-snapshot-123` 加 Manifest digest，是快照的正式身份。`scope` 是对精确平台、租户、Team、Work 或公共供应链引用的严格判别 union。裸 scope ID 无效。源类型、分类和 handling 使用有限严格目录。Actor 和可信时间保持为 Evidence。

一个 SourceSliceRef 指向一个精确源 Artifact：

```json
{
  "sourceSnapshotRef": {
    "artifactId": "knowledge-source-snapshot-123",
    "contentDigest": "sha256"
  },
  "sourceArtifactRef": {
    "artifactId": "repository-snapshot-123",
    "contentDigest": "sha256"
  },
  "locator": {
    "kind": "source-line-range",
    "path": "worker/agent/runtime.mjs",
    "startLine": 120,
    "endLine": 178,
    "symbol": "Runtime.execute"
  },
  "sliceDigest": "sha256"
}
```

Locator 是对源行范围、语法节点、文档章节、JSON pointer、表区域或整个有界 Artifact 的代码拥有判别 union。路径规范化拒绝绝对路径、traversal、歧义 Unicode、symlink 逃逸和替代编码。locator 必须重现匹配 `sliceDigest` 的字节。Slice metadata、sparse term、向量和摘要继承源分类。

### 47.3 索引构建与激活

一个 Knowledge Index Builder 通过确定性、allowlist 的 parser 和 chunker 消费精确源快照。结构感知切片先于固定大小 fallback。Parser 输出永不执行源代码、文档宏或嵌入 payload。不支持、歧义、递归、过大、加密、畸形、symlink 逃逸或二进制输入被拒绝或作为带稳定原因的不可检索 Artifact 捕获。

每个逻辑点身份从源快照 digest、源 Artifact digest、locator、slice digest 和精确 parser/chunker generation 派生。生成的标题或摘要（如果被索引）标记为 Claim 派生，永不作为被引用源返回。一次构建产出 KnowledgeIndexManifest：

```json
{
  "schema": "tiangong.knowledge-index-manifest/v1",
  "indexId": "knowledge-index-team-1",
  "generation": 7,
  "securityRealmRef": {
    "policyId": "knowledge-realm/team-1",
    "version": "1",
    "contentDigest": "sha256"
  },
  "sourceSnapshotRefs": [
    {
      "artifactId": "knowledge-source-snapshot-123",
      "contentDigest": "sha256"
    }
  ],
  "backendRef": {
    "implementationId": "knowledge-index/qdrant",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "parserRefs": [
    {
      "implementationId": "knowledge-parser/tree-sitter-javascript",
      "version": "1",
      "implementationDigest": "sha256"
    }
  ],
  "chunkerRef": {
    "implementationId": "knowledge-chunker/structural",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "sparseEncoderRef": {
    "implementationId": "knowledge-sparse/bm25",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "embeddingRef": {
    "implementationId": "knowledge-embedding/default",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "metadataSchemaRef": {
    "schemaId": "knowledge-index-metadata",
    "version": "1",
    "contentDigest": "sha256"
  },
  "pointCount": 2400,
  "pointSetDigest": "sha256"
}
```

`indexId` 和 `generation` 是逻辑激活坐标，不是 Artifact 身份。外层 KnowledgeIndexManifest ArtifactRef 是精确 manifest 身份。`securityRealmRef` 是一个权威 PolicyRef。`embeddingRef` 可以为 null（用于纯词法 generation）。`pointSetDigest` 覆盖逻辑点身份、精确源 slice、索引 metadata 和编码器输出 digest 的规范排序 manifest；它不哈希后端的非确定性物理 ANN 图。

构建完成不激活索引。可信 Index Manager 代码在追加 `knowledge-index.activated` 前验证源资格、点 manifest、后端 generation、策略、撤销和有界测试集。当前映射是按精确安全 realm 和目的的 CAS 控制管理 Projection。并发构建可以完成，但只有一个赢得激活。Reader pin 一个 generation；退役等待 pinned reader 和 retention。

一个重建只在精确 manifest 输入和逻辑 `pointSetDigest` 复现时可以重用相同 generation。否则它创建并验证新 generation。索引丢失永不丢失源权威。

### 47.4 KnowledgeAccessPolicy

KnowledgeAccessPolicy 是物化进 ResolvedWorkPolicy 的 `knowledge-access` TeamPolicy slot。它是严格的，不能含 Prompt 文本或任意过滤表达式。一个代表性包是：

```json
{
  "schema": "tiangong.knowledge-access-policy/v1",
  "policyId": "knowledge-access/internal",
  "version": "1",
  "sourceAccess": {
    "allowedSourceKinds": [
      "repository-snapshot",
      "architecture-document",
      "system-map",
      "approved-runbook"
    ],
    "allowedScopeKinds": ["work", "team", "tenant", "public"],
    "allowDirectCrossWorkSources": false,
    "maximumClassification": "internal"
  },
  "retrieval": {
    "defaultRequirement": "optional",
    "allowedModes": ["exact", "sparse", "dense", "rerank"],
    "queryRewrite": "disabled",
    "maxQueryBytes": 4096,
    "maxCandidatesPerChannel": 50,
    "maxReturnedSlices": 12,
    "maxSourceBytes": 65536,
    "maxContextTokens": 8192,
    "maxLatencyMs": 5000,
    "maxRetries": 1
  },
  "processing": {
    "indexBackendRefs": [
      {
        "implementationId": "knowledge-index/qdrant",
        "version": "1",
        "implementationDigest": "sha256"
      }
    ],
    "embeddingDisposition": "local-only",
    "embeddingAdapterRefs": [
      {
        "implementationId": "knowledge-embedding/default",
        "version": "1",
        "implementationDigest": "sha256"
      }
    ],
    "rerankerAdapterRefs": [],
    "externalDestinationRefs": []
  },
  "freshnessPolicyRef": {
    "policyId": "knowledge-freshness/baseline-bound",
    "version": "1",
    "contentDigest": "sha256"
  },
  "handlingPolicyRef": {
    "policyId": "handling/internal-source",
    "version": "1",
    "contentDigest": "sha256"
  },
  "retentionPolicyRef": {
    "policyId": "retention/retrieval-bundle-default",
    "version": "1",
    "contentDigest": "sha256"
  },
  "contentDigest": "sha256"
}
```

具体 schema 物化允许的源类型和精确 scope、最高分类、Work/Team/租户/公共组合规则、源和索引新鲜度、精确词法/dense/reranking 处置和 Adapter 引用、本地或 allowlist 的外部目的地、查询/candidate/slice/byte/token/延迟/成本和重试预算、查询改写处置、受保护数据 retention，以及由 Task ExecutionPolicy 收窄的 `required`、`optional` 或 `forbidden` 行为。

跨 Work 内容默认拒绝。Team 或租户内容要求显式准入的源快照和匹配的 handling 与受众策略。一个 TeamWorkIndex 不是内容访问绕过。KnowledgeAccessPolicy 不授予仓库、存储、网络、工具、capability、Approval 或效果权威。

KnowledgePromotionPolicy 和 KnowledgeRealmPolicy 是管理包，不是 ResolvedWorkPolicy slot。KnowledgeRealmPolicy 拥有精确硬安全命名空间和当前索引目的映射语义；它不含源字节或业务状态。

### 47.5 检索 subject、算法与 Bundle

检索 subject 是代码拥有的判别 union。成员调用绑定一个精确 TaskRunRef。Leader 调用绑定精确 WorkRef、Leader 成员、AgentDefinition 和 `leader-turn.started` EvidenceRef。当前 fencing epoch 有意是活 Guard 和 Evidence 事实，而非不可变 subject 身份。这在创建 LeaderRun 或 CoordinationTurn 之外关闭 Leader 检索。严格 Leader 变体是：

```json
{
  "kind": "leader-turn",
  "workRef": {
    "workId": "work-123",
    "revision": 2,
    "contentDigest": "sha256"
  },
  "leaderMemberId": "member-leader",
  "agentDefinitionRef": {
    "agentDefinitionId": "delivery-leader",
    "version": "1",
    "contentDigest": "sha256"
  },
  "turnStartedEvidenceRef": {
    "ledgerId": "work:work-123",
    "sequence": 42,
    "hash": "sha256"
  }
}
```

`leaderMemberId` 只在 WorkRef 绑定的精确 TeamDefinition 内解析。请求 Guard 和检索/Context Evidence 额外验证活 epoch。

受保护算法是：

```text
精确 TaskRun 或 fenced Leader-turn subject + 受保护查询
-> 验证 subject、epoch、capability、预算和要求
-> 解析精确 KnowledgeAccessPolicy、HandlingPolicy 和活撤销
-> 选择精确活跃索引 generation
-> 应用硬安全 realm 和 metadata 前置过滤
-> 收集精确结构、sparse 词法和可选 dense candidate
-> 执行确定性有界融合和可选精确 reranking
-> 重新验证每个源、slice digest、分类和访问
-> 应用确定性的多样性和权威保留的 token packing
-> 密封 RetrievalBundle 并追加 knowledge.retrieved
-> 重新检查撤销并把 Bundle 准入精确 Context Assembly
```

安全过滤在 candidate 检索前和源获取与 Context 使用前各发生一次。仅后置过滤不足。当启用 dense 检索时，精确标识符、路径、符号、错误、策略和测试名 channel 保持可用。分数是具有规范有限表示的观察，不是可比较真相。

RAG 补充而非取代授权的仓库读取、搜索和检查工具。直接工具对当前可变 Workspace 状态具有权威。直接 fallback 使用精确源授权并记录其自身 Artifact/Evidence 事实；它永不静默表示为索引结果。模型生成的查询或改写保持 Claim 派生输入，不能改变源 scope 或策略。Evidence 通常存储查询 digest、字节计数和稳定请求身份，而非原始查询文本。

一个 RetrievalBundle 只记录实际准入 Context 的 slice：

```json
{
  "schema": "tiangong.retrieval-bundle/v1",
  "subject": {
    "kind": "task-run",
    "taskRunRef": {
      "runId": "run-123",
      "contentDigest": "sha256"
    }
  },
  "requestDigest": "sha256",
  "knowledgePolicyRef": {
    "policyId": "knowledge-access/internal",
    "version": "1",
    "contentDigest": "sha256"
  },
  "indexManifestRefs": [
    {
      "artifactId": "knowledge-index-manifest-team-1-generation-7",
      "contentDigest": "sha256"
    }
  ],
  "retrieverRef": {
    "implementationId": "knowledge-retriever/hybrid",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "fusionRef": {
    "implementationId": "knowledge-fusion/rrf",
    "version": "1",
    "implementationDigest": "sha256"
  },
  "rerankerRef": null,
  "slices": [
    {
      "sourceSnapshotRef": {
        "artifactId": "knowledge-source-snapshot-123",
        "contentDigest": "sha256"
      },
      "sourceArtifactRef": {
        "artifactId": "repository-snapshot-123",
        "contentDigest": "sha256"
      },
      "locator": {
        "kind": "source-line-range",
        "path": "worker/agent/runtime.mjs",
        "startLine": 120,
        "endLine": 178,
        "symbol": "Runtime.execute"
      },
      "sliceDigest": "sha256",
      "channelRanks": {
        "exact": null,
        "sparse": 3,
        "dense": 1,
        "fused": 1,
        "reranked": null
      }
    }
  ],
  "packing": {
    "tokenizerRef": {
      "implementationId": "tokenizer/model-context",
      "version": "1",
      "implementationDigest": "sha256"
    },
    "sliceCount": 1,
    "sourceBytes": 2400,
    "contextTokens": 620,
    "truncated": false
  }
}
```

外层 RetrievalBundle ArtifactRef 是其唯一正式身份。Bundle payload 绑定有序 slice、精确 locator 和 digest、策略、索引 manifest、检索/融合/reranking 实现和 packing。Actor、可信时间、provider 结果、延迟、fencing epoch 和 EvidenceRef 保持为 Evidence 事实，当复制它们会重复权威或形成 digest 循环时。

运行时从代码拥有 schema、精确 subject、Context Assembly 调用身份、调用序号、请求 digest、PolicyRef 和 pinned manifest 派生稳定调用 key。相同 key 和事实 replay 精确 Bundle；相同 key 配不同事实冲突。新调用可以产出新 Bundle，因为 ANN 或 provider 观察可能不同。恢复复用密封 Bundle，永不声称 Context 不变而重新运行检索。

一个引用是 Claim 到 SourceSliceRef 的链接。一个 Checker 可以验证源和快照存在、locator 和 digest、subject 访问、已准入 Bundle 或分离的授权工具访问，以及结构新鲜度。它证明源身份和访问，不证明解释或结论。

### 47.6 安全、效果、新鲜度与失败

纵深防御要求精确 principal、Team、Work 和检索 subject；硬安全 realm 分离；强制前置过滤；candidate 后源和 slice 重新验证；精确 Artifact 获取；模型不可访问凭证；以及零容忍的跨租户、跨 Team、跨 Work 和分类泄漏测试。Prompt-injection 检测可以标注数据，但不是安全边界。检索到的指令永不改变工具 schema 或 Gate。

Embedding、sparse term、查询和排序 trace、生成的摘要、索引 payload 和 Bundle 继承源或查询敏感度。Evidence 和遥测只包含有界身份、digest、计数和稳定码。原始受保护源、查询、向量、sparse term、Prompt、策略禁止的路径、模型响应或凭证被排除。

外部 embedding 或 reranking 是披露和计量调用，要求 allowlist 的 Adapter、精确目的地、HandlingPolicy、预算、journal 和 Evidence。用一个 provider 做模型推理的许可永不暗示用它做 embedding 或 reranking 的许可。EffectPolicy 分类实际披露、成本、retention 和 provider 语义。当包 3 适用时，pinned standing 或有界包络内的常规 Task-origin 调用为每个执行身份或有界 batch 物化一个具体 Operation 和 `exact-policy` 或 `exact-derived` Approval，无需 Human 往返。配额消费是原子的。新目的地、区域、模型、retention 行为、分类边界或高成本包络要求新有界或 `exact-human` 权威，并遵循父 blocked Result/新 Task 流程。

Operation origin 保持关闭。一个 Leader turn 不能获取隐式系统 origin Operation；它使用允许的本地或非 Operation Adapter，或通过正式 Task 委托外部准备。需要 Operation 的管理索引构建同样使用正式维护 Work/Task。Batch 限制不能隐藏更广披露或成本。重试不能静默改变 provider、区域、模型或 retention 条款；不确定效果或成本遵循 Journal 对账。

新鲜度是结构先于时间。仓库知识必须匹配精确 Work 或 Task baseline。变更源创建新快照和 slice digest。活源和安全撤销对旧 Bundle 检查。时间新鲜度只在策略声明真实过期且可信时钟健康已知处适用。

跨 Work promotion 和索引激活要求其治理管理 Evidence 在使用前 Anchored。撤销或隔离在其可信持久追加可见后立即收窄使用，并同步 checkpoint。它与 Context commit 线性化：撤销先则拒绝 Context；Context commit 先则保持为历史事实，但所有更晚检索和 Context 使用被拒绝。撤销永不重写历史 Bundle。

一个活跃索引只可以在有界策略窗口内滞后。一个必需的更新源导致精确源 fallback 或检索不可用，绝不 stale 替代。源 digest 不匹配隔离 generation 并 fail closed。必需的 TaskRun 检索失败密封框架 failed Result。必需的 Leader 检索失败中止该精确 turn。可选失败只在精确 subject 策略下记录遗漏继续；禁止检索被拒绝。

### 47.7 技术与评测边界

运行时暴露窄的 Tiangong 拥有 port：

```text
KnowledgeSourcePort
KnowledgeParserPort
KnowledgeIndexBuilder
KnowledgeIndexPort
EmbeddingAdapter
RerankerAdapter
RetrievalBundleSealer
ContextAssembler
```

一个通用 RAG 库可以是非权威 helper，但不能拥有 Policy、源准入、TaskRun 或 Leader 身份、Artifact 密封、Evidence、Context 权威或恢复。检索不证明 Kafka、工作流引擎、图数据库、新业务 Aggregate 或第二真相 store 的正当性。

技术晋升要求版本化的公共或合成评测语料库和机器捕获结果；私有源材料永不作为评测 fixture 提交。确定性检查覆盖规范 digest、parser 和 locator 可重现性、畸形/归档/symlink/traversal 拒绝、scope 和分类拒绝、前置和后置过滤执行、stale 索引撤销、event-key replay、激活 CAS、Bundle/context outbox 恢复、TaskRun 和 Leader fencing、密钥排除、索引丢失/重建和词法 fallback。

质量评测测量预期 slice 召回、MRR 或 nDCG、精确标识符和路径检索、多语言和改写需求、引用有效性和支持覆盖、stale 源拒绝、多样性、Context 利用率、延迟、资源、provider 调用和成本。dense 或 reranked 检索只在它实质上击败结构/词法基线足以证明增加风险和运维面时才被晋升。安全晋升要求在确定性对抗案例中零观察到的未授权 scope/分类泄漏，以及检索指令无权威扩展。

脱敏 OpenTelemetry 可以记录源捕获持续时间和结果、parser 和 chunk 计数、索引 generation 和点计数、每 channel 检索延迟和 candidate 计数、Bundle slice 和 token 计数、缓存/重建/拒绝码，以及 provider 结果。它排除原始源、查询、向量、sparse term、Prompt、Bundle payload、无界路径、模型响应和凭证。遥测永不授权检索或证明源真相。

## 48. Concern 合同

Concern 是从当前事实派生的前瞻性建议性指导。它不授予权限、阻止动作、决定 Completion 或要求验收。Agent 和 Team Concern 使用分离的评估器和输入模型，但共享一个小的显示信封。

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
  "guidance": "Verification evidence predates the latest materialized output.",
  "suggestedActions": ["rerun-relevant-verification"],
  "snapshotDigest": "sha256"
}
```

State 是 `active`、`drift` 或 `resolved`；severity 是 `info` 或 `warning`。没有 critical severity。必须阻断的条件是 Gate 或 Completion 规则。建议动作仍通过 Agent 或 Leader 判断和 Guard。

Agent Concern 读取一个 Task、TaskRun、选定 Skill、工具 Evidence、Artifact、completion 尝试和预算。Team Concern 读取 Work、Task、Result、Decision、Finding、Operation、Approval、预算、测试和环境。其评估器逻辑不被强制进一个通用 schema。

TeamPolicy 选择启用定义和有界阈值；它不拥有评估器逻辑。Concern 可以检查临时活跃 tail Evidence，但标注其基础强度。`concern.presented` 证明指导被展示，不证明指导正确。重复 drift 可以证明新 Checker 或 Gate。Human 默认不接收原始 Concern；Leader 把相关条件转换成 inform、decide 或 authorize 交互。

Concern 排除阻断或权限标志、直接 Task/Decision/Approval 或 Operation 创建、通用模型评估器、可变确认、工作流转移、原始遥测、metadata 和扩展。

## 49. Context 组装

每个模型 turn 按权威顺序组装精确引用：

```text
Control Kernel 和工具 schema
Agent Capability 边界
Agent 职责指令
Work 和当前 Task 合同（当存在时）
选定 Skill
当前 ConcernView
有序 RetrievalBundle
对话和 subject 本地 Claim 叙述
```

低层不能改变高层权威。Prompt 把 Skill 标记为方法、Concern 标记为建议、检索 slice 标记为限定的不可信引用数据。源文本不能注入系统、工具、Policy、Approval 或授权指令。必需的高权威内容永不为了保留检索文本而被截断。如果预算无法容纳必需权威和最低必需知识，组装失败而非静默丢弃权威。

对于一个 TaskRun，`agent.context.assembled` 绑定精确 TaskRun 和当前 fencing epoch；Work 和 Task；AgentDefinition 和职责；选定 Skill；Concern 快照；有序 RetrievalBundle；已解析策略；系统 Prompt 和工具 schema digest；模型、运行时、tokenizer 和 ContextAssembler ImplementationRef；受保护对话摘要 ArtifactRef（当存在时）；输入预算、packing 和截断决策；以及最终 Context digest。它包含引用和 digest，不是完整 Prompt、查询、源或密钥。

Leader 是唯一拥有协调 capability 和相关协调 Skill 及 Team Concern 视图的团队成员。它决定语义下一步动作和 Human 沟通，但不能绕过 Gate、Completion、Approval、Catalog 或 Capability 边界。

一个 Leader turn 为恰好一个 Work 和当前 fencing epoch 组装。它包含精确 Work head、ResolvedWorkPolicy、已验收 Result、当前协调 Projection、Team Concern 快照、精确 Evidence frontier、Leader 和 AgentDefinition、`leader-turn.started` EvidenceRef、运行时和模型身份、有序 Leader-subject RetrievalBundle，以及只有策略过滤的跨 Work 资源或公平性 Projection。它永不接收另一个 Work 的机密内容或全局可变记录。`leader.context.assembled` 记录相同权威、packing、实现和最终 Context digest。epoch 被实时验证并记录在 Evidence 中；这不创建 LeaderRun 或 CoordinationTurn Aggregate。模型响应保持为 Claim。

Context packing 对精确输入是确定性的。撤销和 Context commit 在第 47 节下线性化。相同精确 Context Assembly 调用 replay 既有事件和 Bundle 引用；冲突输入冲突。重启加载精确 Bundle 和 Context 引用，而非检索最新内容作为等价替代。

一个可重建 TeamWorkIndex 可以暴露开启和终态 WorkRef、当前 head、等待 Leader 关注、TaskRun 计数、预算、规范化资源 claim、执行中或不确定 Operation，以及策略可见的公平性输入。它不拥有状态、不创建 Portfolio aggregate、不授权协调、不作为知识内容绕过，或不暴露超出 HandlingPolicy 的内容。

## 50. 包 4 命令与 Guard

| 命令 | 确定性 Guard |
| --- | --- |
| `register_agent_definition` | 管理/代码拥有条目；有效职责、Capability、Skill 和供应链引用；无隐藏权限或私有依赖。 |
| `register_team_definition` | 有效 Worker 身份；唯一成员和 Worker 绑定；恰好一个协调能力 Leader；有效 TeamPolicy；重复 AgentDefinition 只通过不同精确成员和 Worker 允许。 |
| `register_team_policy` | 有效 Kernel；包含执行并发的唯一已知 slot；严格模块 schema；无 Kernel 弱化。 |
| `register_team_scheduler_policy` | 管理权威；精确稳定团队身份；严格限制和 FairnessPolicy；allowlist 的 Capacity Adapter；无 Work 语义。 |
| `select_team_scheduler_policy` | 可信 Policy Registry 权威；稳定团队身份的精确不可变策略；CAS 当前选择 generation；记录管理 Evidence。 |
| `resolve_work_policy` | 物化默认值；只允许有界覆盖；针对精确 TeamDefinition 解析每个并发成员；发出不可变已解析策略。 |
| `capture_knowledge_source` | 已认证源 Adapter；精确 scope 和 baseline；允许的类型、路径、大小、分类、handling、retention 和 parser 处置。 |
| `promote_knowledge_source` | 精确不可变源；管理 capability；精确 KnowledgePromotionPolicy；必需审核 Evidence；无禁止的仅模型 provenance 或活撤销。 |
| `revoke_knowledge_source` | 管理权威；精确源快照；稳定原因；持久管理 Evidence；立即阻止活使用。 |
| `build_knowledge_index` | 精确已准入快照；allowlist 的 parser、chunker、后端、编码器和资源预算；无撤销源。 |
| `activate_knowledge_index` | 有效 manifest 和 point-set digest；精确 realm 和目的；验证通过；当前 generation CAS；跨 Work 使用前 Anchored 管理权威。 |
| `quarantine_knowledge_index` | 可信完整性或安全权威；精确 generation 和稳定原因；在进一步使用前 fence 当前选择。 |
| `retire_knowledge_index` | 精确非活跃 generation；无禁止的 pinned 使用；保留 retention 和恢复材料。 |
| `create_task` | 扩展包 1：assignee 属于精确 Work Team；定义未撤销；Task 策略是 capability 子集。 |
| `retrieve_knowledge` | 精确 TaskRun 或当前 Work 范围 Leader turn 和 epoch；capability 和精确 Work 策略；授权源 scope；新鲜 pinned manifest；有界查询、处理目的地、成本和输出。 |
| `seal_retrieval_bundle` | 稳定精确调用；所有准入 slice 由源、locator、digest、分类、访问和撤销重新验证；严格排序和 packing 事实。 |
| `assemble_agent_context` | 精确 TaskRun 或当前 Leader-turn subject 和 epoch；只允许 Skill、Bundle 和 Concern 快照；当前撤销；HandlingPolicy；权威保留的确定性 packing。 |
| `load_skill` | Skill 在 AgentDefinition allowlist、未撤销、capability 兼容且资源有效。 |
| `evaluate_concerns` | 有效定义和实现；匹配 scope；只读事实；无副作用。 |
| `update_team_roster` | 创建新 TeamDefinition；永不修改旧的；当前 Work 通过 revision 采纳。 |
| `revoke_agent_or_skill` | 管理权威和已记录撤销；阻止新使用；安全终止受影响的高风险执行。 |

## 51. 包 4 Evidence、恢复与并发

定义、Team、Policy、Skill、Concern、知识、检索和 Context 事实使用精确 digest，而非完整敏感指令、源字节、查询、向量、Prompt 或凭证。Skill 加载不证明方法合规；`knowledge.retrieved` 不证明源真相或模型使用；`agent.context.assembled` 不证明模型遵循或理解其 Context；Concern-presented 不证明 drift。

管理知识 ledger 是第 18 节管理 ledger 家族的命名空间限定成员。它们复用其信封、genesis、anchoring、retention、Recorder 和 fail-closed 规则。必需事件含义包括：

| 事件类型 | 最低有界事实 |
| --- | --- |
| `knowledge-source.captured` | 精确快照、scope、分类、捕获实现、策略和 payload digest |
| `knowledge-source.promoted` | 快照、promotion 策略、审核/权威 EvidenceRef、目标可见性 scope |
| `knowledge-source.revoked` | 精确快照、权威、稳定原因、replacement（当存在时） |
| `knowledge-index.built` | 精确 manifest、源快照、builder、后端 generation、点计数和 point-set digest |
| `knowledge-index.activated` | realm、目的、先前和选定 generation、CAS generation、权威和验证 EvidenceRef |
| `knowledge-index.quarantined` | 精确 generation、稳定完整性/安全原因、当前选择 fencing 结果 |
| `knowledge-index.retired` | 精确 generation、replacement 或稳定原因、retention 处置 |
| `knowledge.retrieval-requested` | 精确 TaskRun 或 Leader subject、当前 epoch、请求 digest、策略、有界目的和限制 |
| `knowledge.retrieval-denied` | 请求 EvidenceRef、稳定策略或可用性原因、无原始查询 |
| `knowledge.retrieved` | 请求、Bundle、pinned manifest、精确实现、源 scope 摘要和当前 epoch |
| `agent.context.assembled` | 第 49 节的精确 TaskRun Context 引用和 digest |
| `leader.context.assembled` | 第 49 节的精确 Work 范围 Leader Context 引用和 digest |

Source Capture Recorder 拥有捕获；Knowledge Policy/Registry Recorder 拥有 promotion 和撤销；Index Builder Recorder 拥有构建；Index Manager Recorder 拥有激活、隔离和退役；Retrieval Recorder 拥有请求、拒绝和检索；Agent Runtime Context Recorder 拥有 Context 事件。Adapter、模型、物理索引、Skill、Agent 和原始工具循环消息不能发出这些权威事件。

Catalog 和知识 Policy 记录是不可变的、内容寻址的、已审核的、公共依赖安全的，并可被新管理事实撤销。新版本不撤销旧版本。安全或源撤销按适用阻止新派发、Skill 加载、检索、Context commit、工具使用或 Operation，不重写历史事实。

恢复验证 Catalog 和撤销状态、TeamDefinition 和唯一 Leader、Work team 绑定、Task assignee AgentDefinition、TaskRun 或 Leader-turn subject 和当前 epoch、精确源快照和 slice、活跃或历史 pinned KnowledgeIndexManifest、RetrievalBundle、选定 Skill、Context 事件和受保护 payload 可用性。ConcernView 被重新计算。运行时永不从记录猜测加载 Skill 或知识，永不为精确绑定替代最新源、策略、manifest、模型或 Bundle。

检索请求、Bundle 发布和 Evidence 使用持久 outbox。一个有不确定 Bundle 发布的持久事件完成精确发布；一个无 Context 事件的持久 Bundle 恢复或中止该精确组装。相同调用 replay 既有 Bundle。缺失必需恢复材料使 TaskRun 失败或中止 Leader turn。Qdrant 或另一个索引缓存可以从精确源和 manifest 重建；digest 不匹配隔离 generation。并发 reader 在构建、激活 CAS、退役和撤销独立进行时 pin 一个 generation。

一个 TaskRun 的查询、token 预算、取消、Bundle 和 Context 不能被另一个 Run 计费或重用。一个 Leader turn 的查询、预算、Bundle 和 Context 不能被另一个 Work 或 epoch 重用。Stale owner 不能密封 Bundle 或追加检索/Context Evidence。共享索引、provider、CPU、内存、存储和成本容量来自可信 Capacity Adapter。索引构建使用有界配额或分离资源池，不能饿死当前授权检索。Agent 创作的紧迫性无索引或检索优先权威。已知必需检索不可用可以延迟未派发 Task，但不创建 TaskRun 或 blocked Result；派发后容量丢失遵循精确 required、optional 或 forbidden 语义。

Catalog 更新和活跃索引映射使用 CAS。Work 保持精确 Team 和 ResolvedWorkPolicy digest。并发相同 Skill 加载和检索调用 replay。Concern 评估器保持纯粹和可重复。撤销对派发、检索、Context 和工具调用线性化。

TeamSchedulerPolicy 记录不可变，而稳定团队身份的管理当前映射是 CAS 控制和 Evidence 支持的。调度器在派发前恢复精确策略、新鲜 Capacity Adapter Evidence、slot 和租约 generation，以及 Work 本地预留。未知、过期、冲突或未授权容量事实把容量收窄为不可用；它们永不扩大它。一个 Work 的旧并发策略即使活 Team 策略变更也仍是其上限。

## 52. 包 4 truth table

| 场景 | 决策 |
| --- | --- |
| Team 有一个 Leader 和任意已批准专业人员 | 允许 |
| Team 无 Leader 或多个 Leader | 拒绝 |
| 定义新安全、数据或测试 Agent | 通过已批准 AgentDefinition 允许 |
| Kernel 要求原始五个角色名 | 拒绝目标设计 |
| 一个 Worker 在一个 Team 中绑定到两个成员 | 拒绝 |
| 不同精确 Worker 绑定相同 AgentDefinition | 允许水平副本 |
| 调度器静默创建或替换 Worker | 拒绝 |
| Work 无 revision 采纳新 roster | 拒绝 |
| Work revision 显式采纳新 TeamDefinition | 允许 |
| Task assignee 不在精确 Work Team 中 | 拒绝 |
| Task assignee 定义被安全撤销 | 拒绝派发 |
| 每个 capability 层允许一个动作 | 有资格工具 Gate |
| Skill 声明一个不在 Agent capability 中的工具 | 拒绝 |
| Task 要求比 Agent 更多的权限 | 拒绝 |
| Task 收窄 Agent capability | 允许 |
| 存在 standing deploy 授权但 Agent 缺 deploy capability | 拒绝 |
| 职责叙述说部署是必需的 | 无授权效果 |
| 加载已批准兼容 Skill | 允许 |
| Leader 加载协调 Skill | 允许；所有协调仍被 guarded |
| Skill 试图角色或权限切换 | 拒绝/无效果 |
| Skill 脚本调用工具 | 应用完整 Capability、Task、Gate 和 Evidence 控制 |
| 运行时安装未审核 Skill | 拒绝 |
| 必需机器行为必须被执行 | 实现 Checker 或 Gate，非 Skill 名检查 |
| RetrievalBundle 有精确源、slice、manifest、实现、策略、subject 和 packing digest | 有资格作为不可信数据注入 context |
| 检索结果缺源 provenance | 拒绝正式 Bundle |
| 检索内容含指令注入 | 作为不可信数据处理，无权威效果 |
| 检索到的策略文档与当前 PolicyRef 冲突 | 当前机器 Policy 胜；源保持为数据 |
| Agent 缺源分类访问 | 拒绝检索 |
| RAG 内容的模型摘要 | Claim 或 Artifact，非 Evidence 或可重用知识 |
| 已验收 Result 被提议用于未来检索 | 要求分离 KnowledgePromotionPolicy Guard |
| 源纠正发生 | 创建新源 Artifact 和快照；永不修改旧的 |
| 撤销在 Context commit 前胜出 | 拒绝 Context 使用 |
| Context commit 在撤销前胜出 | 保留历史组装；拒绝更晚检索和 Context 使用 |
| 物理索引点缺有效源 Artifact 或 slice digest | 拒绝并隔离 generation |
| 相同检索调用 replay | 返回精确既有 Bundle |
| 新 ANN 调用返回另一个顺序 | 密封新 Bundle；不声称等价 |
| 必需 TaskRun 检索不可用 | 密封框架 failed Result；不发明源 |
| 必需 Leader 检索不可用 | 用 Evidence 中止精确 turn；不发明源 |
| 可选检索不可用 | 只在精确 subject 策略下记录遗漏继续 |
| 精确 subject 禁止检索 | 拒绝命令和 Context 包含 |
| 当前 fenced Leader 为精确 Work 检索 | 在 Capability 和 Work 策略内允许；不创建 LeaderRun |
| Leader 检索缺当前 turn Evidence 或 epoch | 拒绝 |
| 外部 embedding 目的地对该分类不被允许 | 拒绝 egress |
| Dense/reranked 检索增加质量但泄漏 scope | 拒绝实现晋升 |
| 向量数据库被当作源真相 | 拒绝实现 |
| Agent Concern 读取 Task 事实 | 允许 |
| Team Concern 读取 Work projection | 允许 |
| 一个通用评估器被强制跨两个 scope | 拒绝设计 |
| Concern 建议重跑测试 | 仅建议 |
| Concern 说阻断而 Gate 允许 | Concern 无阻断权威 |
| Concern 条件消失 | 解决或移除 Projection |
| Concern 反复识别必须阻断风险 | 把不变量晋升为 Checker 或 Gate |
| TeamPolicy 选择已知严格模块 | 允许 |
| TeamPolicy 嵌入工作流 DSL 或 Prompt | 拒绝 |
| Work 覆盖保持在允许范围内 | 解析不可变 ResolvedWorkPolicy |
| `memberLimits` 引用重复或非 Team 成员 | 拒绝解析并 fail closed |
| 一个 Work 策略声称团队全局 slot 计数 | 作为全局权威忽略；使用活 Team SchedulerPolicy |
| Team 容量降到 Work 上限以下 | 活容量收窄执行 |
| 模型声称更多容量或紧迫性 | 无调度权威 |
| Work 覆盖弱化 Kernel | 拒绝 |
| TeamPolicy 更新 | 不追溯改变 Work |
| 重启恢复精确 context digest | 允许 |
| 重启从记录猜测 Skill 或 RAG | 拒绝 |

## 53. 包 5：质量与环境

包 5 通过绑定精确测试、subject、配置、数据、环境状态和机器执行事实，使一个测试 claim 有意义。

```text
SystemMap -> ImpactAssessment -> TestPlan -> TestRun(s)
          -> QualityAssessment -> Completion 或 Promotion Gate
```

除了权威 EnvironmentDefinition 和版本化 QualityPolicy，包 5 有八个核心严格 Artifact schema：SystemMap、ImpactAssessment、TestDefinition、TestSet、TestPlan、EnvironmentSnapshot、TestRun 和 QualityAssessment。可选面向 Human 的 TestReport 是普通 typed Artifact。这复用 Artifact 身份、provenance、handling 和 retention，而非创建平行 store。

## 54. EnvironmentDefinition 合同

EnvironmentDefinition 是不可变环境身份和控制策略，不是当前运行时状态。

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

| 字段 | 合同原因 |
| --- | --- |
| `schema` | Pin 住环境定义语义。 |
| `environmentId` | 提供稳定环境身份。 |
| `environmentClass` | 选择代码拥有的风险和验证语义。 |
| `adapterRef` | Pin 住可信环境观察者和控制器。 |
| `environmentPolicyRef` | Pin 住访问、配置、数据、网络、测试、清理和生命周期规则。 |
| `contentDigest` | 让 Operation、TestPlan 和 Snapshot 绑定精确定义。 |

基类是 `isolated-runner`、`preview`、`integration`、`pre-production`、`production-canary` 和 `production`。类是风险分类，不是强制 promotion 序列。Team 可以定义多个或省略类；QualityPolicy 和 EffectPolicy 决定哪些是必需的。

EnvironmentDefinition 排除 endpoint、凭证、当前 Artifact、配置、数据、状态、健康、actor、时间、工作流阶段、角色名、metadata 和扩展。

## 55. EnvironmentSnapshot Artifact

一个命名环境可能变更。因此 TestRun 绑定时间点的起止 EnvironmentSnapshot Artifact，而非单独环境 ID。

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

StateManifest 使用类特定严格 schema，绑定已部署 subject Artifact、配置、依赖、Runner 或容器镜像、容器配置、网络策略、数据边界、fixture、环境策略、资源所有权、租约或 generation、观察到的健康和相关 Operation receipt。

Snapshot 只由可信 Environment Adapter 用 `environment.snapshot.captured` provenance 发出。它不含凭证或 endpoint。环境变更创建另一个 Snapshot。测试捕获起止；未授权 generation 或关键状态 drift 使 run 不确定。StateManifest 有 `observed`、`absent` 或 `unavailable` 的严格观察结果。临时销毁使用机器证明缺失的结束 Snapshot。如果运行后观察无法完成，一个 unavailable 结束 Snapshot 绑定失败观察 Evidence，不发明状态，TestRun 不确定。一个 unavailable 开始 Snapshot 永不允许执行。

## 56. TestRun Artifact

TestRun 是一个终态机器执行 Artifact，不是 Assessor 叙述或退出码。

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

Artifact provenance 绑定持久测试开始、Runner 身份和镜像、执行计划、精确测试定义、subject、配置、数据和环境、用例结果、清理、结束 Snapshot 和聚合结果。

Outcome 是 `passed`、`failed` 或 `indeterminate`。Passed 要求所有强制用例和 oracle、稳定授权环境状态、成功清理和可验证 Evidence。断言或清理失败是 failed。Runner 中断、harness 失败、不可验证环境、未授权 drift、不完整用例结果或不确定清理是 indeterminate。只有 passed 满足质量义务。

TestRun 排除 actor 和时间、可变状态、叙述报告、原始日志、单独退出码、TestSet 重复、裸环境 ID、最新版本引用、重试计数、百分比通过、metadata 和扩展。每次重试是新的 TestRun Artifact，永不覆盖先前失败。

## 57. 测试数据边界

每个 TestRun 绑定一个 TestDataBoundary Artifact，包括当它显式不使用持久数据时。它定义源和快照、合成、掩码或生产派生状态、分类、允许访问和写入、唯一测试身份、拥有资源、清理策略、预期终态和禁止数据。

生产敏感数据默认拒绝。测试只清理它们拥有的资源。清理失败保持 run 为红。

## 58. TestDefinition 与 TestSet Artifact

TestDefinition 绑定稳定身份和版本、系统级别、质量维度、精确覆盖 subject、可执行和 oracle Artifact、环境和数据要求，以及副作用策略。

级别是 `static`、`unit`、`component`、`contract`、`integration`、`scenario` 和 `post-deploy`。功能、安全、性能、兼容性、数据迁移、韧性、可观测性和可访问性等质量维度与级别正交。Regression 是选择目的，不是级别。

测试实现或 oracle 变更创建新定义。定义不授予权限或决定 Core 成员资格。

TestSet 是一个不可变精确集合：

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

QualityPolicy 标识策展的 Core TestSet。增加覆盖通常需要质量验收。移除、禁用、跳过、更弱 oracle 或更弱环境要求独立评估，对高风险要求 Human decide。历史集合保持不可变。

Regression 选择是动态的：

```text
Core TestSet
+ 直接受影响 subject 测试
+ 传递 impact 路径测试
+ 当前 Finding 重现测试
+ 相关历史风险测试
+ QualityPolicy 要求
+ 对未知边界的保守扩展
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

QualityPolicy 控制 Core 集合、impact 和选择要求、级别和维度、环境矩阵、独立执行、新鲜度、flaky 和重试处理、清理、已接受 gap 权威和 promotion 要求。它使用严格代码拥有的规则 slot，不规定 Team 工作流。

## 60. SystemMap Artifact

SystemMap 是对精确源快照的证据支持、显式不完整的理解。一个 SubjectRef 有稳定系统和 subject 身份加版本特定 subject digest。

SystemMap payload 绑定系统定义、源快照、extractor 集、subject 和关系 shard，以及已知 gap。Shard 防止单体图记录。基 subject 包括仓库、模块、服务、API、事件、schema、数据存储、部署单元、业务 journey、外部依赖、测试和环境。

关系绑定精确源和目标 Subject、关系类型、基础类型、基础引用，以及仅对推断的 confidence。提取关系来自可信导入、路由、OpenAPI、schema、migration、构建、部署和测试分析，携带机器 Evidence。推断关系来自文档、历史、AI 分析或专家 claim，携带源 Artifact 和显式高、中、低 confidence。Confidence 不是证明。

Map 输入变更创建新 Artifact。确定性和推断边保持不同。已知 gap 不能被擦除以暗示完整性。图索引是可重建 projection。

## 61. ImpactAssessment Artifact

ImpactAssessment 消费当前 Work、SystemMap、输入 Artifact、可选 Finding 引用和精确 ImpactPolicy。Finding 引用使用包 1 定义的精确 Result digest 加 JSON Pointer；它们永不发明独立 Finding ID。Assessment 记录确定性 seed Subject、受影响 Subject、关系路径、环境影响、candidate 测试和显式未知。

该过程冻结源 Artifact 和 Map，提取确定性差异，通过代码拥有的关系规则传播，通过 AI/RAG 添加源支持的语义 candidate，保留动态和未知边界，映射既有测试，派生环境影响，并接收独立质量审核。

需求、代码变更和 Finding 使用相同机制；没有 Bug 分类。直接、传播和推断 impact 保持不同。每个传播有路径或基础。未知永不被表示为无 impact。输入、Map、策略或 Work scope 变更使 Assessment 对新版本不适用。Assessment 推荐测试但不能证明计划充分性。

## 62. TestPlan Artifact

TestPlan 绑定当前 Work、subject Artifact、SystemMap、已接受 ImpactAssessment、QualityPolicy、显式义务、选定精确测试和环境、基础引用和覆盖 gap。

每个义务命名受影响 Subject、必需级别和质量维度、TestDefinition、EnvironmentDefinition 和选择基础。Core TestSet 是强制的。每个直接 impact 和高风险传递 impact 有覆盖或显式 gap。高风险 gap 要求策略授权的 Human decide。Plan 是专业 Claim，只通过已接受 Task Result 变得合格。

任何 subject Artifact、ImpactAssessment、Map、TestDefinition、Core TestSet、QualityPolicy 或环境要求变更使 Plan stale。TestPlan 表达义务，不编排 Agent 活动。

## 63. QualityAssessment Artifact

QualityAssessment 确定性地聚合一个已接受 TestPlan、精确 QualityPolicy 和 subject Artifact、TestRun 引用、每义务结果、Evidence frontier 和 verdict `satisfied`、`unsatisfied` 或 `indeterminate`。

每个强制义务要求一个新鲜通过 TestRun，带匹配 subject、测试、配置、数据和环境绑定。确定性评估器发现到其 Evidence frontier 为止的所有相关 TestRun 和 subject 绑定；列出引用不能隐藏合格失败或不确定 Run。更晚通过是新 Run，不抹除更早失败；重试和 flaky 策略决定如何处理两个事实。`quality.assessed` provenance 绑定评估器实现 digest。覆盖 gap 遵循显式策略和 Human 决策。

QualityAssessment 证明一个已接受 Plan 的执行，不证明 Plan 语义上全知。Promotion Gate 只消费新鲜满足的 Assessment。TestReport 是分离的 Human 解释，永不替代它。

## 64. 质量与环境执行

```text
已接受 TestPlan
-> 解析精确 TestDefinition
-> 分配或选择环境
-> 当策略要求时获取租约或 generation guard
-> 在该 guard 下捕获开始 EnvironmentSnapshot
-> 验证 subject、配置和数据绑定
-> 持久 test-run.started Evidence
-> 执行精确测试资产
-> 捕获用例结果
-> 清理拥有资源
-> 捕获结束 EnvironmentSnapshot
-> 验证授权状态转移且无 drift
-> 聚合结果
-> 密封 TestRun Artifact 和记录 Evidence
```

外部资源分配、数据 mutation 和清理是 Operation，在其效果边界要求处有精确 Approval。一个 run 永不从用户控制输入扩大清理。

首选多环境规则是构建一次并 promotion 相同不可变 Artifact。环境特定重建创建不同 Artifact，要求独立证明。隔离 Runner 中的 unit 成功不证明集成、pre-production、canary 或生产行为；每个 QualityPolicy 义务绑定它有意义的环境。

## 65. 包 5 命令与 Guard

| 命令 | 确定性 Guard |
| --- | --- |
| `register_environment_definition` | 管理权威；有效 Adapter 和策略；合法类；无 endpoint 或密钥。 |
| `capture_environment_snapshot` | 可信 Adapter；精确定义；匹配 StateManifest 和 Evidence；无隐藏凭证。 |
| `record_system_map` | 精确源快照和 ExtractorSet；提取和推断关系分离；已知 gap 保留。 |
| `record_impact_assessment` | 当前 Work 和精确 Artifact、Map 和策略引用；每个 impact 有路径或基础；未知显式。 |
| `record_test_definition` | 有效可执行、oracle、环境、数据、副作用和 subject 引用；无权限 claim。 |
| `record_test_set` | 有效唯一成员和治理；Core 弱化有所需独立和 Human 决策。 |
| `record_test_plan` | 当前精确 subject；已接受 Impact；来自 ResolvedWorkPolicy 的 QualityPolicy 和环境 provenance；强制 Core 义务；显式 gap。 |
| `execute_test_run` | 已接受 Plan；精确 TestDefinition；预留唯一 TestRun Artifact 身份和 attempt key；授权环境、数据和配置；可信 Runner 和租约。 |
| `record_test_run` | 有效起止 Snapshot、用例结果、清理、Evidence 和一致聚合结果。 |
| `assess_quality` | 已接受 Plan；新鲜精确 Run；确定性每义务结果；无选择性隐藏失败。 |
| `promote_artifact` | 包 3 Operation，要求精确 Artifact 和新鲜满足 QualityAssessment。 |

## 66. 包 5 Evidence、新鲜度、恢复与并发

必需事件包括 SystemMap 提取和丰富、impact 评估、TestDefinition、TestSet 和 TestPlan 记录、环境快照和租约、测试开始、每用例完成、清理开始和终态结果、测试完成和记录，以及质量评估。Evidence 绑定 Runner 镜像、策略、执行计划、fixture、subject、配置、数据、环境、用例和清理事实。原始日志是 Artifact；叙述报告不是执行 Evidence。

新鲜度是精确和关系的：

- Map 绑定源快照和 extractor；
- Impact 绑定 Map、输入、策略、Finding 和 Work scope；
- Plan 绑定 subject、Impact、Map、测试、Core 集合、QualityPolicy 和环境要求；
- Run 绑定 Plan、测试、subject、起止环境状态、配置、数据和 Runner 策略；
- QualityAssessment 绑定 Plan、Run、策略、Evidence frontier 和 subject。

任何相关 digest 或显式时间要求变更要求新 Assessment、Plan 或 Run；不写可变 stale 字段。

Map、测试、集合、计划、run 和评估不可变。Catalog-head 和 Core-set 更新使用 CAS。环境执行使用 generation 或租约，并标记未授权并发 drift 为不确定。开始前，运行时预留绑定到 Task、Plan、定义和执行绑定的唯一 TestRun Artifact ID 和 attempt key。相同预留 key 的 replay 返回其已保存结果；重试预留新 Artifact ID 和 key，保留先前 Run。开始后 Runner 丢失密封不确定 TestRun 并执行拥有清理或对账。

QualityAssessment 使用固定 frontier。并发 Run 不进入既有 Assessment。恢复验证精确 Artifact、Evidence、Runner、Snapshot、资源和清理；它永不从记录或部分输出猜测通过。

## 67. 包 5 truth table

| 场景 | 决策 |
| --- | --- |
| TestRun 只记录环境 ID | 拒绝 |
| TestRun 绑定精确起止 Snapshot、subject、config 和数据 | 有资格验证 |
| 相同 EnvironmentDefinition 运行另一个 Artifact 或配置 | 旧 Run 不适用 |
| 测试期间环境 generation 未授权变更 | indeterminate |
| 断言通过但清理失败 | failed |
| Runner 或环境结果不可知 | indeterminate |
| 报告说通过但无 TestRun Artifact 和 Evidence | 不证明通过 |
| 提取关系有机器 Evidence | 记录为提取 |
| AI 关系有源和 confidence | 记录为推断 claim |
| AI 关系无基础 | 拒绝正式关系 |
| Map 有已知 gap | 有效但不完整 |
| 输入或 Map 变更 | 旧 Impact 和依赖 Plan stale |
| 未知 impact 被表示为无 impact | 拒绝 |
| Core 测试全部包含 | 满足 Core 最低 |
| AI 移除强制 Core 测试以降低成本 | 拒绝 |
| 直接 impact 有测试或显式 gap | 有资格 Plan 审核 |
| 高风险未知既无测试也无 gap | 拒绝 |
| 测试或 oracle 在 Core 中被弱化 | 要求受治理新版本和决策 |
| 所有用例、oracle、清理和环境检查通过 | Run passed |
| 一个 oracle 失败 | Run failed |
| 只有聚合退出码 | TestRun 不足 |
| 失败后重试 | 新 Run；保留两个事实 |
| QualityAssessment 隐藏更早失败 | 拒绝 |
| 所有强制义务有新鲜匹配通过 Run | satisfied |
| 强制义务失败 | unsatisfied |
| 强制义务不可验证 | indeterminate |
| Promotion 绑定新鲜满足 Assessment 和精确 Artifact | 有资格包 3 Gate |
| 相同 Artifact digest 通过多环境 promotion | 可追溯证据链 |
| 环境重建创建另一个 Artifact | 要求新验证 |
| Unit 成功被呈现为 pre-production 场景证明 | 拒绝 |
| 环境类被用作固定工作流阶段 | 拒绝设计 |

## 68. 运行时闭合

运行时闭合定义包 1–5 已要求的四个记录：TaskRun、HumanInteraction、ResolvedWorkPolicy 和 Operation Journal。它不添加业务工作流层。

```text
ResolvedWorkPolicy
        |
Work -> Task -> TaskRun -> context、工具、completion -> Result
        |
Leader -> HumanInteraction -> HumanResponse -> Decision 或 Approval
        |
Operation -> Operation Journal -> 幂等效果与恢复
```

## 69. TaskRun 合同

TaskRun 是一个已派发 Task 的不可变运行时绑定。一个已派发 Task 恰好一个 TaskRun。派发预留、`task.dispatched` 和 TaskRun 开启是一个原子或恢复等价边界；一个等待容量的 Task 没有 TaskRun。进程重启只在其精确 Task、运行时、Workspace 和 Context 引用可重建时恢复相同 Run。否则框架密封 failed Result，Leader 可以创建 replacement Task。

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

| 字段 | 合同原因 |
| --- | --- |
| `schema` | Pin 住运行时绑定语义。 |
| `runId` | 绑定 Evidence、Context、工具和预算事件。 |
| `taskRef` | Pin 住精确不可变委托。 |
| `runtimeRef` | Pin 住可信运行时实现和策略。 |
| `workspaceBindingRef` | Pin 住 baseline、挂载、隔离、cwd 和 Runner 环境。 |
| `contentDigest` | 防止静默绑定变更。 |

WorkspaceBinding 是一个严格 Artifact，绑定源 baseline、所有权、允许和拒绝挂载、cwd、EnvironmentDefinition、隔离、网络、fixture、scratch 和输出位置，以及清理策略。它不含凭证。

Task 仍是 Work、assignee、ExecutionPolicy 和 CompletionPolicy 的单一来源。实际模型身份、Skill、RetrievalBundle、Concern、Prompt digest、工具调用、预算消费、Operation 和 completion 尝试是绑定到 TaskRun 的动态 Evidence 或 Artifact 事实。它们不是可变 TaskRun 字段。

TaskRun 排除状态、阶段、assignee 副本、Work 副本、Skill 和检索状态、Concern 状态、当前模型、预算计数器、ResultRef、当前工具、记录、思维链、actor、时间、metadata 和扩展。

## 70. TaskRun 不变量与 context

- 一个未派发 Task 没有 TaskRun；
- 一个已派发 Task 至多一个，且一旦执行开始恰好一个；
- 已认证 Worker 和平台 generation 必须匹配通过 Task WorkRef 解析的精确 MemberRef、workerRef 和 AgentDefinitionRef；
- 运行时和 Workspace 必须满足 Task ExecutionPolicy；
- TaskRun 永不等待 Human 输入；
- TaskRun 无业务阶段；
- 每个 Context Assembly 记录精确 digest；
- Skill、RAG、Concern 或模型变更不修改 TaskRun；
- Task ExecutionPolicy 把检索收窄为 `required`、`optional` 或 `forbidden`；必需检索失败密封框架 failed Result；
- RetrievalBundle subject 必须等于 TaskRun，且每次检索和 Context 追加必须验证当前 fencing epoch；
- 执行预算从 Task 策略解析；
- 预算耗尽密封框架 failed Result；
- 终态权威来自 Result 和 Evidence，不是 Run 状态；
- 恢复使用 Task、Artifact、Evidence、Journal 和精确 Context 引用；
- 缺失或撤销的必需材料失败而非静默改变执行身份；
- 外部效果不确定性在 Task 终态处理前对账；
- replacement 创建新 Task，不是旧 Task 的另一个 Run；
- 每个活 TaskRun 有分离的模型 Session、Context 状态、Workspace 和 cwd、挂载命名空间、工具调用和本地 journal 状态、Operation 所有权和 Journal attempt 引用、Evidence subject、Artifact 输出命名空间、token 和成本预算、取消 scope、Completion 状态和 RecoveryContext；
- 取消、耗尽、fencing 或恢复一个 Run 不能终止、计费、恢复或完成另一个 Run；
- 一个 Work Ledger 可以共享，但每次追加绑定精确 TaskRun 和当前 fencing epoch；
- 一个 Worker 只在精确 Work、Team 和 RuntimePolicy 限制、Worker 容量和运行时实现都允许该计数时可以拥有多个活 Run；
- 否则高于每个 Worker 一个的并发 fail closed。

每个模型 turn 有一个逻辑 Context Snapshot，绑定 TaskRun、AgentDefinition、职责、选定 Skill、Work 和 Task、有序 RetrievalBundle、Concern 快照、已解析策略 digest、实际模型/运行时、系统 Prompt digest、确定性 packing 事实和可选受保护对话摘要 Artifact。`agent.context.assembled` Evidence 事件记录这些引用和 digest。对话摘要是 HandlingPolicy 下的 Claim Artifact；隐藏模型推理既不要求也不存储。

检索调用身份绑定 TaskRun、Context 调用、调用序号、请求 digest、PolicyRef 和 pinned manifest。相同调用 replay 其精确 Bundle；另一个调用可以产出另一个 Bundle。一个 Run 不能重用或被计费另一个 Run 的查询、Bundle、Context、预算、取消或 provider 调用。

重启时运行时读取 Task 和 TaskRun，解析精确 AgentDefinition、Skill、源和策略撤销、RetrievalBundle 和 Context 事件，重新计算当前 Concern，并从 Artifact 和 Evidence 构建机器事实 RecoveryContext。它只在所有必需绑定验证且无工具、检索或 Operation 不确定性未解决时继续相同 Run。它永不在声称相同 Context 时重新运行检索或选择最新内容。新执行 owner 只在先前 owner 被 fenced 后为相同 runId 接收更高租约 epoch。

绑定到一个 AgentDefinition 的多个精确 Worker 提供首选的第一水平扩展模式，每个 Worker 一个活跃 TaskRun。同 Worker 多 Run 保持禁用，直到确定性测试证明上面每个可变轴跨执行、取消、崩溃和恢复是 run 范围的。

## 71. HumanInteraction 合同

HumanInteraction 是 Leader 与 Human 的不可变正式交互合同。它永不含更晚响应或可变等待状态。

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

| 字段 | 合同原因 |
| --- | --- |
| `schema` | Pin 住交互信封。 |
| `interactionId` | 关联交付、响应和去重。 |
| `workRef` | Pin 住讨论的 scope revision。 |
| `semantics` | 权威区分 inform、decide 和 authorize。 |
| `purpose` | 提供非权威显示和路由标签。 |
| `audienceRef` | Pin 住有资格接收和回答的 principal 或策略角色。 |
| `presentationRef` | Pin 住 Human 看到的精确内容，包括附件 manifest。 |
| `basisRefs` | Pin 住相关 Result、Artifact、Finding、Decision 或 Operation。 |
| `responseContract` | 定义是否以及如何接受响应。 |
| `contentDigest` | 防止替换问题、选项或呈现。 |

`inform` 不需要响应，覆盖进度、风险、质量、文件交付、恢复和最终报告。`decide` 请求语义判断，如 scope、设计、test-plan、已知 gap 或最终验收。`authorize` 请求机器权限，绑定精确 Operation 或有界 grant 提议。Decide 永不替代 authorize。

HumanInteraction 排除可变状态、响应、发送者、时间、原始可变消息、可变附件、Task 所有权、Approval、CoordinationDecision、自由格式语义、基于 purpose 的权威和扩展字段。Presentation Artifact 在 Interaction 前密封，必须不引用该 Interaction digest，避免 digest 循环。交付是 Operation；Interaction 本身不声称成功交付。

## 72. HumanResponse Artifact 与交互不变量

一个已认证 Human 响应是带 `human-response.captured` provenance 的严格 HumanResponse Artifact。Decision payload 是：

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

Authorization payload 是：

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

Schema 有效的自由格式响应内容是分离的精确 ArtifactRef，而非内联无界文本。Authorization 只在响应合同显式允许时可以绑定严格有界 grant 提议而非 Operation。

Response 是 CoordinationDecision 或 Approval 的基础，但本身不是。消费原子地记录 `human-response.consumed` 与创建的 Decision、Work revision 或 Approval。Inform 响应是普通新 Human 输入，而非原始 Interaction 的修改。

- 只有 Leader 或可信系统边界创建正式交互；
- 专业成员不直接与 Human 正式交互；
- 没有 Task 等待响应；
- Interaction、Presentation 和 Response 不可变；
- 实际响应者必须满足 AudiencePolicy；
- 有效响应要求精确 Interaction、Presentation、受众和 channel 的可信交付或呈现 Evidence；
- 响应绑定精确 Interaction digest 且必须满足类型、cardinality 和有效性窗口；
- decide 和 authorize 不可互换；
- authorization 绑定精确效果 intent 和已查看呈现；
- 有效 authorize 交互外的自由格式同意不是 Approval；
- 相同响应 replay 幂等；
- 不同响应不能覆盖已消费的单次响应；
- 变更的 Human intent 创建新 Interaction、Response 和 Decision；
- 过期或旧 Work 响应不能直接产生当前权威；
- Work 终止后，只允许策略授权的终态或恢复 `inform` 交付；decide 或 authorize 从新 Work 开始；
- 原始 Human 内容是 Claim Artifact，而认证和收据是 Evidence；
- 交付是使用精确 standing 或有界通信权威的 Interaction-origin Operation，不能依赖同一未交付 Interaction 请求的 authorization；
- 静默报告偏好永不抑制 decide、authorize 或恢复异常交互。

## 73. Human 报告策略

ProgressReport 是一个 `inform` HumanInteraction。最终和恢复报告可以在 Work 终止后在窄终态 inform 例外下交付；它们追加 Evidence，永不重开或修订 Work。必需触发器是策略要求的初始理解、decide 或 authorize 请求、实质 scope 或计划变更、高风险 Finding、blocked 或 recovery-required 状态、实质质量结论和最终完成。里程碑报告可以跟随已接受关键 Result、重要 Artifact、主要分支完成、实质风险或预算变更和 QualityAssessment。

心跳只在 Work 保持活跃、策略间隔流逝、存在新事实、Human 不在静默模式且无更高优先级 Interaction 取代时合格。报告 projection 的 digest 抑制重复报告。报告陈述变更事实、确认完成、当前焦点、下一步、风险和不确定性、必需 Human 动作，以及精确 Result、Artifact 和 Quality 引用。它们不暴露思维链或原始日志。

## 74. ResolvedWorkPolicy 合同

ResolvedWorkPolicy 是 TeamPolicy 默认值和合法 Work 覆盖的完整不可变展开。运行时在 Work 创建后永不咨询可变当前默认值。

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
      "slot": "execution-concurrency",
      "policyRef": {
        "policyId": "execution-concurrency/work-123-r2",
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

所有强制 slot 在 Work 创建时物化，无运行时继承或隐式默认值。Slot 包括 task control、执行并发、执行预算、completion、work closure、capability、质量、效果、环境、知识、Concern、Human 交互、报告、retention，以及任何其他 Kernel 强制的策略。Slot 名和解析规则是代码拥有的。

解析是精确 Kernel、TeamPolicy、模块和覆盖输入上的确定性纯函数。它在采纳它的 Work revision 前完成；覆盖基础不能依赖该目标 Work digest，避免 digest 循环。覆盖保持在 TeamPolicy 范围内，不能弱化 Kernel。任何实质变更创建新 ResolvedWorkPolicy。采纳它的 Work 创建新 Work revision；既有 Work、Task、Result 和 Operation 事实保留旧策略语义。策略不含工作流、Prompt、任意代码或扩展 bag。`work-policy.resolved` Evidence 绑定输入和输出 digest。

跨包策略 provenance 是强制的：

- Work.teamRef 解析一个 TeamDefinition，其 teamPolicyRef 恰好等于 ResolvedWorkPolicy 的 sourceTeamPolicyRef；
- TeamPolicy 和 ResolvedWorkPolicy 绑定相同 Control Kernel；
- Task ExecutionPolicy 和 CompletionPolicy 从已解析 Task 和 completion 模块选择或有效收窄；
- ExecutionConcurrencyPolicy 只含不可变 Work 和成员上限，每个成员限制针对精确 Work TeamDefinition 解析；
- Operation EffectPolicy 从已解析效果模块选择；
- TestPlan QualityPolicy 和允许环境从已解析质量和环境模块选择；
- Human 受众、交互、报告和授权策略来自已解析 Human 和效果模块；
- Handling、KnowledgeAccessPolicy、retention 和 Concern 策略使用对应已解析 slot；KnowledgePromotionPolicy 和 KnowledgeRealmPolicy 保持管理，永不作为 Work slot 解析。

活 TeamSchedulerPolicy、Worker 可用性和 Capacity Adapter 事实在派发时重新验证，只能收窄已解析 Work 上限。它们不被复制进 ResolvedWorkPolicy，不能追溯扩大它。

一个下游记录不能仅因为某策略在 Catalog 中有效就选择无关或更弱策略。Work 创建和 revision 原子地重新检查这个完整 provenance 链。

## 75. Operation Journal 绑定

Operation Journal 是用于幂等、replay 和恢复的机器协调状态。Evidence 是可审计观察链。Journal 和 Evidence 分离但通过持久 outbox 链接。

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

| 字段 | 合同原因 |
| --- | --- |
| `operationRef` | Pin 住精确效果 intent。 |
| `idempotencyKey` | 给执行、replay 和恢复一个稳定身份。 |
| `requestDigest` | 防止请求替代。 |
| `protectedPayloadDigest` | 让恢复验证不可访问的敏感材料。 |
| `contentDigest` | 防止绑定 mutation。 |

Approval 在每次 attempt 上绑定，而非复制进 Journal 绑定。对账重试只在其 grant 和当前策略仍允许相同 Operation attempt 时重用精确 Approval，或可能要求新精确 Approval。Operation 和幂等 key 保持不变。

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

`eventKey` 从 Operation、事件类型、attempt 或对账身份和逻辑阶段确定性派生。相同 key 和内容 replay；相同 key 配不同内容冲突。第一个事件使用 `digest("sha256", jcs("tiangong-jcs/v1", JournalBinding))` 作为其 genesis previous hash，每个事件 hash 在不含 `hash` 的事件上使用相同 digest 合同。

事件类型是 `prepared`、`execution-started`、`execution-succeeded`、`execution-failed-no-effect`、`execution-partial`、`execution-uncertain`、`reconciliation-started`、`reconciliation-applied`、`reconciliation-not-applied`、`reconciliation-partial`、`reconciliation-uncertain`、`receipt-recorded`、`replay-served`、`protected-payload-released` 和 `compacted`。每个有严格代码拥有事实 schema。

Operation projection 从这个 append-only 的每 Operation hash chain 派生。Journal actor 和可信时间是 Evidence，receipt 是 Artifact，密钥或原始后端响应永不进入 Journal 事实。

## 77. Operation Journal 不变量

- 一个 Operation 至多一个绑定；
- 绑定不可变且事件序列连续且 hash 链接；
- 相同 eventKey 和内容幂等 replay；相同 key 配不同内容冲突；
- Approval 验证、首次使用分配或相同 Operation 重试验证，以及 `execution-started` 是一个线性化事务或恢复等价协议；
- 每个后端 attempt 绑定精确 Approval 和调用，加上授权 TaskRun 执行者或 Interaction-origin 交付允许的可信系统运行时执行者；
- 所有 attempt 保留 Operation 幂等 key；
- started without terminal 投影不确定；
- 不确定在对账前阻断另一个 attempt；
- 只有 reconciliation-not-applied 可以使重试合格；
- 重试有新 attempt 身份、当前 Work Operation 和对该 attempt 有效的精确 Approval；
- succeeded replay 返回已保存 Receipt，无后端执行；
- 终态 Receipt 是 Artifact，非原始 Journal payload；
- Journal 到 Evidence 发布使用持久 outbox；
- 损坏 fail closed；
- 结果不确定时受保护 payload 保留；
- payload 释放是 Journal 和 Evidence 事实；
- 显式 compaction 只在终态摘要、Anchor、retention 和无恢复依赖后允许，且必须保留连续性和 replay 证明；
- 模型不能读或修改 Journal。

## 78. 运行时组合

Ingress 组合是：

```text
接收已认证 channel 身份和有界内容 digest
-> 评估精确平台或租户 IngressPolicy
-> replay 先前准入，用持久管理 Evidence 拒绝，
   或预留 Work ledger 并原子记录新 Work
```

Agent 运行时组合是：

```text
合格未派发 Task
-> 调度器应用公平性、Work 上限、活容量和资源 Guard
-> 预留精确 slot 和 Workspace；原子派发并打开 TaskRun
-> 在精确 subject 和策略下执行 required/optional/forbidden 检索
-> 密封或 replay 精确 RetrievalBundle
-> 组装精确 run 范围 context
-> 自主模型 turn
-> 工具 Guard、Evidence 和 Artifact 捕获
-> 重新计算 Agent Concern
-> Result candidate
-> 确定性 Completion Check
   -> 在 Task 内继续，或密封 completed/blocked/failed Result
-> 终止 TaskRun、fence 执行并释放租约
```

Leader 组合是：

```text
获取一个 Work 范围 turn 租约和 fencing epoch
-> 当需要或有用时执行授权 Leader-subject 检索
-> 组装精确 Work context、Evidence frontier、Bundle 和策略过滤 Team 视图
-> 选择语义协调动作
-> 通过 epoch 验证和 Work-head CAS 提交
-> 创建或 supersede Task、验收或拒绝 Result
-> 需要时创建 HumanInteraction
-> 为 scope 变更创建 Work revision
-> 当目标解决时终止 Work
-> 完成或中止 turn Evidence 并释放租约
```

调度器组合是：

```text
跨 Work 投影合格不可变 Task
-> 用代码拥有 FairnessPolicy 排序
-> 将 Work 上限与活团队、Worker、provider、Runner、预算、
   Workspace 和资源容量求交
-> 原子预留、派发并打开一个 TaskRun
-> 容量不可用时保持 Task 未派发并确定性重试
```

Human 组合是：

```text
密封 HumanInteraction
-> 交付 Operation
-> Human 查看精确 Presentation
-> 已认证 HumanResponse Artifact 和 Evidence
-> 作为 CoordinationDecision、Work revision 或 Approval 消费一次
```

这些组合解释信任边界。它们不是工作流图，不规定 Leader 的专业策略。调度器重试是机器协调，永不要求持久 DispatchIntent 或 Leader 轮询。

## 79. 运行时闭合命令与 Guard

| 命令 | 确定性 Guard |
| --- | --- |
| `admit_human_request` | 可信 Ingress Recorder；精确 IngressPolicy 和 channel 身份；确定性关联和 replay；有界 Claim Artifact；执行饱和不是准入拒绝。 |
| `begin_leader_turn` | 精确 Team Leader 和 Work head；无当前 Work turn 租约；任何先前 owner fenced；Team Leader slot 可用；签发下一个单调 epoch 和固定 Evidence frontier。 |
| `complete_leader_turn` | 当前租约 owner 和 epoch；绑定已提交记录 EvidenceRef 或显式无命令完成；只在 owner fencing 后释放。 |
| `record_capacity_observation` | 精确 allowlist Capacity Adapter 和 metric；严格 scope、unit、值、generation、有效性和管理 ledger。 |
| `reserve_dispatch_capacity` | 合格 Task；精确当前 Work 策略和活 SchedulerPolicy；新鲜容量 Evidence；公平性资格；兼容资源 claim；原子预留所有 slot。 |
| `open_task_run` | 相同原子派发事务；无 Run 或 Result；当前 slot 和执行 epoch；精确运行时和 Workspace；Worker 匹配 assignee。 |
| `assemble_context` | 精确 TaskRun 或当前 Leader-turn subject 和 epoch；有效 AgentDefinition、Skill、Bundle、Concern 和策略引用；活源和安全撤销；HandlingPolicy；确定性权威保留 packing；无来自另一个 Work、Run 或 turn 的可变状态。 |
| `resume_task_run` | 精确 Run；先前 owner fenced；当前更高 epoch；无终态 Result；Context 可重建；无未解决效果不确定性；预算允许。 |
| `terminate_task_run` | Result 密封或框架 failed Result 密封；无隐藏活跃执行；在 slot 和租约释放前 fence owner。 |
| `acquire_resource_lease` | 规范化内部资源身份；兼容当前所有权；精确策略、TaskRun、generation、epoch 和过期。 |
| `release_resource_lease` | 精确当前 owner 或可信恢复管理器；旧 owner fenced；释放 Evidence 持久。 |
| `record_human_interaction` | Leader 或可信边界；当前 Work；Human、受众、报告和效果策略 provenance 有效；匹配语义和合同；有效 Presentation 和基础。 |
| `deliver_human_interaction` | 包 3 Operation；精确 Interaction；去重；channel 和受众已授权。 |
| `capture_human_response` | 已认证 Human；精确 Interaction 和可信呈现/交付 Evidence；有效受众、channel、合同和时间；密封 Response Artifact 和 Evidence。 |
| `consume_human_response` | 有效未消费响应；语义匹配；原子创建 Decision、Work revision 或 Approval。 |
| `resolve_work_policy` | 精确 TeamPolicy 和 Kernel；所有默认值物化；覆盖已授权且在范围内。 |
| `open_operation_journal` | 有效 Operation、请求和 payload digest；缺失或相同 replay。 |
| `begin_operation_attempt` | Origin 和精确 TaskRun 或可信系统执行者匹配；精确有效 Approval；无活跃或不确定 attempt；前置条件通过；原子分配首次使用或验证相同 Operation 重试并开始。 |
| `append_operation_terminal` | 可信 Adapter；匹配 attempt；一致 Receipt 和事实；持久 Evidence outbox。 |
| `reconcile_operation_journal` | 特权 Reconciler；不确定或 partial Operation；严格结果 schema。 |
| `compact_operation_journal` | 终态、保留且 Anchored；无恢复依赖；连续性证明保留。 |

## 80. 运行时闭合 Evidence

必需事件包括 `human-request.received`、`human-request.admitted`、`human-request.replayed`、`human-request.admission-denied`、`leader-turn.started`、`leader.context.assembled`、`leader-turn.completed`、`leader-turn.aborted`、`capacity.observed`、`team-scheduler-policy.selected`、`scheduler.slot-reserved`、`scheduler.capacity-unavailable`、`scheduler.slot-released`、`scheduler.lease-suspect`、`scheduler.lease-reconciled`、`workspace.binding-prepared`、`workspace.resource-lease-acquired`、`workspace.resource-lease-released`、`task-run.opened`、`task-run.resumed`、`task-run.budget-exhausted`、`task-run.terminated`、`knowledge.retrieval-requested`、`knowledge.retrieval-denied`、`knowledge.retrieved`、`agent.context.assembled`、`human-interaction.recorded`、`human-interaction.delivered`、`human-response.captured`、`human-response.consumed`、`human-response.rejected`、`work-policy.resolved`、`operation-journal.opened`、`operation-payload.released` 和 `operation-journal.compacted`。包 3 的 `operation.execution.*`、`operation.reconciliation.*` 和 `operation.receipt.recorded` Evidence 额外绑定 Journal sequence 和 attempt 身份；运行时闭合不创建重复执行事件含义。

Recorder allowlist 按事件含义不相交：Ingress Recorder 拥有 `human-request.*`；Leader Runtime Recorder 拥有 Leader-turn 和 Leader-context 事件；精确 Capacity Adapter 拥有 `capacity.observed`；管理 Policy Registry Recorder 拥有 `team-scheduler-policy.selected`；Knowledge Source、Policy、Index Builder、Index Manager 和 Retrieval Recorder 只拥有其第 51 节事件族；Team Scheduler Recorder 拥有 `scheduler.*`；Workspace 或 Runner Manager Recorder 拥有 `workspace.*`；Agent Runtime Recorder 拥有 TaskRun 和 Agent-context 事件。Recorder 不能冒充另一个边界。每个调度和 Workspace 事件绑定当前 fencing epoch。事件 schema 含有界引用、digest、generation、unit、值和稳定原因码，从不含队列 dump、Prompt、记录、凭证或私有跨 Work 内容。

TaskRun 事件绑定精确 Task。Context 事件含引用和 digest，不含复制的密钥。Human 交付绑定精确 Presentation；响应 Evidence 绑定已认证 Human；消费绑定结果 Decision、Work revision 或 Approval。Journal 和 Evidence outbox 恢复而不暴露受保护 payload、凭证、隐藏推理或原始敏感 Prompt。

## 81. 运行时闭合恢复与并发

TaskRun 开启使用 Task 和 Work-head CAS 加当前调度器和执行 fencing epoch。Slot 预留、派发 Evidence 和 TaskRun 开启是一个带持久 Evidence outbox 的事务或 write-ahead 协议。恢复必须要么完成精确派发，要么证明它不可见并释放 fenced 预留；它永不创建另一个派发权威。相同绑定 replay，另一个 TaskRun 绑定冲突。

Result 密封和 Run 终止协调。精确可恢复 Run 只在旧 owner fenced 后在当前 epoch 下使用相同 runId。缺失 context、撤销权威、未对账工具结果、耗尽预算或不可 fence 的先前执行密封 failed Result，而非创建另一个 Run。调度器 slot、Workspace、资源租约、工具状态、预算、取消、Artifact 密封、Completion 和 RecoveryContext 保持按 runId 和 epoch 隔离。

Leader-turn 恢复 fence 或转移 Work 范围租约，递增其 epoch，读取当前不可变事实，并重新规划。它永不从隐藏模型状态恢复权威。协调命令即使在租约健康时仍执行 Work-head CAS。Stale Leader 和 TaskRun epoch 不能追加可信 Evidence、密封 Artifact 或 Result、开始 TaskRun 拥有的 Operation，或释放当前租约。

团队调度器恢复重建其精确当前 SchedulerPolicy、FairnessPolicy、新鲜 Capacity Adapter 观察、预留、TaskRun 和租约 generation。未知或过期容量收窄派发资格。一个 Work 不能提供团队全局限制。更低活限制立即阻断新派发，不暗示取消运行中 TaskRun；更高限制不能超过每个 Work 的不可变上限。调度器队列恢复从记录派生合格 Task，永不 replay 分离的 DispatchIntent。

Workspace 恢复证明旧进程或容器在重用前 fenced。并行 WorkspaceBinding 可以共享一个不可变 baseline，但不能共享可变 cwd 或挂载。内部资源租约对账 owner generation 和 epoch；外部共享效果继续使用 Operation Journal 对账。

Ingress 恢复验证管理 Ledger、精确 IngressPolicy、channel-message 身份、payload digest 和原始准入结果。精确 replay 返回先前 WorkRef；饱和永不导致第二个 Work 或已接受输入丢失。

未完成 Human 交互从交付和响应 Evidence 投影。已捕获未消费响应被确定性消费。相同响应 replay；冲突或过期响应不能覆盖权威。一个 Work revision 重新验证未完成交互适用性。

ResolvedWorkPolicy 解析是确定性和内容寻址的。并发相同解析去重。TeamPolicy 更新不影响已解析 Work。Work revision CAS 决定采纳。TeamSchedulerPolicy 选择和容量是活管理约束，保持在已解析 Work 权威之外。

知识恢复重建精确源快照、活撤销、manifest generation、Bundle 调用 key、持久 outbox 和 Context 事件。Reader 保持 pin 在一个激活 generation；重建和激活 CAS 不能修改其 Bundle。源 digest 不匹配隔离 generation。缺失必需源或受保护查询材料使精确恢复失败；索引缓存丢失从 manifest 和源重建或保持不可用。Stale TaskRun 或 Leader epoch 不能发布 Bundle 或 Context 事实。撤销和 Context commit 共享第 47 节线性化规则。

Operation Journal 使用每 Operation CAS 或串行化。Approval 撤销和 attempt 开始共享线性化边界。只有一个 attempt 活跃；replay 永不调用后端。Journal compaction 与读取和对账串行化。从备份恢复尊重终态墓碑，永不复活受保护 payload 或完成效果。

## 82. 运行时闭合 truth table

| 场景 | 决策 |
| --- | --- |
| 已认证可准入请求到达但无执行 slot | 记录 Work 并延迟执行 |
| 精确 ingress message replay | 返回原始准入和 WorkRef |
| Ingress 拒绝缺精确 Policy 或可信 Evidence | fail closed |
| 相同 Leader 为不同 Work 开启隔离 turn | 在 Team 限制内允许 |
| 第二个 Leader turn 针对一个 Work | 当前租约存在时拒绝 |
| Stale Leader epoch 尝试命令 | 即使模型输出否则有效也拒绝 |
| 未派发 Task 开启 Run | 拒绝 |
| 已派发 Task 开启第一个精确 Run | 允许 |
| 相同 Task 和 Run 绑定 replay | 幂等 |
| 相同 Task 开启不同 Run | 冲突 |
| 合格 Task 缺容量 | 无 Run；保持未派发 |
| 崩溃后 slot 预留存在但派发不可见 | 恢复精确事务或 fence 并释放；永不发明 Run |
| Worker 与 assignee 不同 | 拒绝 |
| Workspace baseline 与 Task input 不同 | 拒绝 |
| 两个 Run 共享可变 Session、Workspace、工具状态、预算或取消 | 拒绝运行时实现 |
| 不同精确 Worker 使用相同 AgentDefinition | 在 Team 和 Work 限制内允许 |
| 一个 Worker 限制为一且有活 Run | 另一个合格 Task 保持未派发 |
| 同 Worker 有多个 Run 且完全验证隔离和策略允许 | 允许 |
| TaskRun 等待 Human | 拒绝；密封 blocked Result |
| 精确 Context 可重建且旧 epoch fenced | 在当前 epoch 下恢复相同 Run |
| 旧执行可能仍密封可信输出 | 不释放容量或恢复 replacement owner |
| 恢复需要记录猜测 | 拒绝恢复 |
| 必需 Skill、Artifact 或权威被撤销 | 使 Run 和 Task 失败 |
| 必需 TaskRun 检索不可用 | 框架 failed Result；永不发明知识 |
| 必需 Leader 检索不可用 | 用 Evidence 中止精确 Leader turn |
| 可选检索不可用 | 只在精确策略允许且记录遗漏时继续 |
| 检索 subject 或 epoch 与当前执行不同 | 拒绝 |
| 精确检索调用崩溃后 replay | 返回既有 Bundle 并恢复其 outbox |
| 物理索引缓存丢失 | 从精确 manifest/源重建或保持不可用 |
| 源撤销在 Context commit 前胜出 | 拒绝 Context 使用 |
| Context commit 在撤销前胜出 | 保留历史；拒绝更晚使用 |
| 预算耗尽 | 框架 failed Result |
| 工具调用跟随终态 Result | 拒绝 |
| Leader 发送进度或文件交付 | inform |
| Human 审核 scope、设计、测试或验收 | decide |
| Human 授予外部效果许可 | authorize |
| Decide 响应被用作 Operation authorization | 拒绝 |
| Presentation 和提议 Operation 不同 | 拒绝 Approval |
| 无授权交付 Recorder 和收据 Evidence 记录精确 Presentation 交付 | 拒绝响应权威 |
| 响应者不满足 AudiencePolicy | 拒绝 |
| 相同 HumanResponse replay | 幂等 |
| 已消费单次响应收到冲突 | 不覆盖；创建新交互 |
| 静默模式面对 authorize 或恢复异常 | 仍通知 |
| 相同进度 projection 重复 | 抑制 |
| 已解析策略完全物化合法输入 | 允许 |
| 运行时读取可变当前默认值 | 拒绝 |
| 覆盖弱化 Kernel | 拒绝 |
| TeamPolicy 更新 | 旧 Work 不变 |
| Team 活容量减少 | 立即收窄新派发；不推断取消 |
| Team 活容量增加 | 只允许到每个不可变 Work 上限 |
| 容量观察过期、未知或由错误 Recorder 发出 | 受影响容量不可用；fail closed |
| 调度器改变 assignee 或 Task 内容 | 拒绝 |
| Work 采纳另一个策略 | 新 Work revision |
| 相同 Operation 和绑定 replay | 幂等 |
| 相同 Operation 有不同请求 digest | 冲突 |
| 有效 Approval 且无活跃 attempt | 开始 |
| Started 无终态事件 | uncertain |
| 不确定 attempt 直接重试 | 拒绝 |
| 对账证明未应用 | 重试可变合格 |
| 重试有新的有效精确 Approval | 允许 |
| Succeeded Operation 再次调用 | replay Receipt |
| 终态 Journal 缺已发布 Evidence | 确定性地交付 outbox |
| Journal、Evidence 和后端冲突 | 对账 |
| 受保护 payload 在不确定时被删除 | 拒绝 |
| 损坏 Journal 被自动截断 | 拒绝并 fail closed |

## 83. 引用闭合与支撑 registry

本架构中无引用隐式创建另一个业务 aggregate。每个精确内容引用属于五个闭合族之一：

- 一个领域 RecordRef，含稳定身份字段和 content digest，包括 AnchorRef；
- 一个 ArtifactRef，含 artifact ID 和 Manifest digest；
- 一个 PolicyRef，含 policy ID、版本和 content digest；
- 一个 ImplementationRef，含实现身份、适用时版本和实现 digest；
- 一个 SchemaRef，含 schema ID、版本和 content digest。

EvidenceRef 是定义的 ledger、sequence 和 hash 元组。MemberRef 是只通过精确 Work TeamDefinition 解析的有界 composite，绑定成员 ID 加成员条目 digest；它不是新内容引用族。已认证 principal 引用和平台 Team/Worker 绑定由已认证平台边界解析，不是模型创作的内容引用。CommandDefinitionRef、EventDefinitionRef、CheckerRef、AdapterRef 和 RecorderRef 是特化的 ImplementationRef。EventDefinition 绑定精确 Event 事实 SchemaRef 和权威规则。

Policy 包包括平台或租户管理 IngressPolicy；管理 TeamSchedulerPolicy、FairnessPolicy、KnowledgePromotionPolicy 和 KnowledgeRealmPolicy；ResourceLeasePolicy；TaskExecutionPolicy；执行并发、closure、效果、环境、质量、handling、KnowledgeAccessPolicy、Human 交互、报告、retention 和其他有限 TeamPolicy slot。KnowledgeAccessPolicy 是 `knowledge-access` TeamPolicy slot，物化进 ResolvedWorkPolicy。IngressPolicy、TeamSchedulerPolicy、KnowledgePromotionPolicy 和 KnowledgeRealmPolicy 不是 ResolvedWorkPolicy slot；准入、派发、源 promotion、索引选择、检索和 Context Evidence 在适用处绑定其精确活管理事实。

管理 Policy 形成一个治理家族，即使其运维 scope 不同。IngressPolicy 范围限定为精确平台或租户 ingress 边界，每个准入决策在该 scope 的 ingress ledger 中记录精确 PolicyRef。TeamSchedulerPolicy 范围限定为稳定团队身份，其当前选择是 CAS 控制并记录在对应管理策略 ledger 中。KnowledgePromotionPolicy 范围限定为精确源和目标可见性类。KnowledgeRealmPolicy 范围限定为硬平台、租户、Team、Work 或公共供应链 realm，控制 CAS 选择的索引目的，不成为内容权威。注册、审核、版本化、scope 绑定、适用时选择和撤销要求已认证管理权威、不可变 catalog 条目、严格 schema 和授权 Recorder Evidence。新版本或选择永不重写更早决策；撤销在每个相关准入、派发、context、工具、Gate 和恢复边界实时检查。管理 Policy 不能授予 Work 语义、Agent capability、Approval 或 Completion 权威。

实现包包括 Kernel、Checker、Capacity 和效果 Adapter、Team Scheduler、Workspace 或 Runner Manager、Ingress 和其他 Recorder、Knowledge Source/Parser/Index/Retrieval/Embedding/Reranking/Context Adapter 和服务、Concern 评估器、SystemMap extractor、运行时和 schema 验证器。每个包有不可变已审核 catalog 条目、严格代码拥有 schema、公共供应链 provenance 和撤销事实。它不能含 Prompt 控制的权限表达式或通用规则 bag。

ArtifactSchema、事件事实 schema、Operation spec schema、响应合同、环境状态 schema 和知识源 locator/metadata schema 使用 SchemaRef 和已审核验证器实现；schema 身份和可执行验证器身份不可互换。SourceSliceRef 保持 ArtifactRef、locator 和 digest 的严格 composite，而非新引用族。Human 受众和审批角色定义是权威策略包。凭证、签名密钥和受保护 payload 记录留在模型不可访问安全存储内，只在合同要求处由安全身份或 digest 引用。

一个消费命令在每个引用 registry 种类、严格 schema、验证器、权威规则和撤销检查存在前被禁用。未知、缺失、冲突或撤销引用解析 fail closed。具体 catalog 内容是实现交付物，但它们不能引入新协调动作、扩展权限、改变 digest 语义或弱化任何包 1–5 或运行时闭合不变量。

## 84. 延迟实现合同

实现规划覆盖 AgentTeams adapter、存储拓扑、Matrix、Runner 和环境后端、测试框架、SystemMap extractor、CI、smoke 场景、模型 provider failover、session 后端、物理事务策略、用户界面、具体 catalog 内容和仓库 migration。

并发实现额外要求跨 Work 的通用合格 Task 调度、Work-head 和派发 CAS、TeamSchedulerPolicy 和 Capacity Adapter、FairnessPolicy、单调 fencing、run 范围 Session 和 Context、隔离 WorkspaceBinding、ResourceLeasePolicy、精确 Worker 副本绑定、并发 Evidence 追加、容量和租约恢复，以及垂直 smoke 场景。固定的 `design`、`implement`、`assess` 和 `release` Task-kind 转移路径是实现基线，不是目标权威，必须被移除而非包装在通用工作流层中。

第一方 `software-change-delivery` profile 作为配置而非 Kernel 法则保留当前产品价值。其 TeamDefinition 可以绑定 Leader、Designer、Implementor、Assessor 和 Operator AgentDefinition，而策略和确定性 Checker 强制 Artifact 生产者不能满足自己的独立评估要求、评估和 promotion 绑定相同不可变 Artifact、promotion 要求新鲜满足的 QualityAssessment、高风险权威不能自批，以及 rollback 验证精确先前状态和恢复 postcondition。其垂直 smoke 在不要求一个固定 Task 顺序的情况下证明这些约束。

知识实现垂直推进：

1. **合同基线** —— 严格 schema、内存 KnowledgeIndexPort、确定性源切片、Bundle 密封、Context 和 Evidence、公共或合成泄漏 fixture，以及无向量依赖。
2. **结构与词法检索** —— pinned 公共 Qdrant 客户端、自托管硬 realm 后端、精确标识符/路径/符号、sparse term、激活 CAS、重建、撤销、恢复和容量控制。
3. **Dense 检索与 reranking** —— 本地或显式批准的 Adapter 只在评估证明阶段 2 的实质增益且精确模型、服务、资源、安全和 egress 合同被 pinned 时添加。
4. **受治理组织知识** —— 批准的文档、事故、runbook 和 Policy Adapter 加 promotion、撤销、时间新鲜度、retention 和反馈中毒控制。

Tree-sitter 是初始结构感知代码 parser，自托管 Qdrant 是初始可替换混合索引后端。`BAAI/bge-m3` 和 `BAAI/bge-reranker-v2-m3` 是评测候选，不是已接受依赖，直到精确 revision 通过质量、资源、供应链、许可证和安全 Gate。软件和运行时依赖要求 OSI 批准的商业兼容许可证；初始模型和 tokenizer artifact 要求 MIT、Apache-2.0 或另一个显式批准的允许公共再分发、修改和商业使用且无 field-of-use 限制的 OSI 许可证。非商业、仅研究、仅评测、source-unavailable 或自定义可接受使用条款被拒绝。许可证身份和文本针对精确 pinned revision 验证；模型卡标签或更早发布的许可证不足。

一个知识垂直 smoke 必须证明源捕获、精确 slice 和 Bundle、检索和 Context Evidence、分类拒绝、prompt-injection 非权威、Bundle replay、崩溃/outbox 恢复、源撤销、索引丢失重建、fencing 和清理。这个目标在那些合同和检查存在前不被描述为已实现。

一个保守的初始部署使用每个 Team 一个活 Leader-turn slot、每个 Team 四到八个 TaskRun slot、每个 Work 两到四个 TaskRun，以及每个 Worker 一个活 TaskRun。多个预绑定精确 Worker 可以共享一个 AgentDefinition。同 Worker 多 Run 保持禁用，直到确定性测试证明 Session、Workspace、工具、Evidence、Artifact、预算、取消、Completion、fencing、崩溃恢复和按 TaskRun 的 Operation 隔离。这些值是安全起点，不是架构常量，只从可信 provider、Runner、内存、存储、成本、冲突和恢复测量调优。

在一个延迟技术成为依赖前，一个 ADR pin 住其精确公共实现、版本或 revision、digest、许可证证据、部署档位、可替换 Port、容量限制、威胁假设、rollback 和验证结果。本节中的名称是目标默认值或评测候选，不是绕过该 ADR 和依赖审核的许可。

合同闭合稳定后，可执行 JSON Schema、EventDefinition 和规范化 fixture 移至机器验证的 `schemas/` 目录，而技术选择移至 `adrs/`。根架构保持唯一规范性 manifest，pin 住每个规范模块 digest。物理文档拆分只在链接、引用闭合、重复权威和跨模块不变量检查下发生；将同一规范合同复制到多个文件是被禁止的。

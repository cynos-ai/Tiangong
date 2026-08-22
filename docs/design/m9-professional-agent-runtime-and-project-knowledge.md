# M9 专业 Agent Runtime、Skills 2.0 与项目知识

> 状态：已接受设计；尚未实现。
>
> 本文定义 M9 的目标合同和 clean-cut 修改方案。文中的目录、Schema、工具、控制逻辑、存储与测试均不代表当前 runtime 已经具备对应能力。M9 实施完成并取得直接机器验证前，现有实现仍是唯一可声明的事实。

## 1. 摘要

M9 在继续开放外部写入之前，先稳定 Tiangong 的可信执行与专业 Agent 基础。它先隔离 Worker control domain 与 Agent execution domain，闭合 ToolResult/Result/Checkpoint 的原子协议，再把六个 Agent 重构为独立维护的专业 Package；随后交付精炼项目记忆、共享 lexical retrieval 和按需 Task 调试视图。

M9 采用以下核心决定：

1. 不构建角色专用镜像；使用一个通用 control image，并允许一个同样通用、无控制资产的 execution image/rootfs。镜像数量与物理形态服从攻击合同，不作为产品角色或权限边界。
2. 每个 Agent 独立拥有 `AGENTS.md`、`SOUL.md`、Product Skills 和 controls；runtime helper、类型、Schema 与测试工具可以共享。
3. `AGENTS.md` 是不可写、可验证且 fail-closed 加载的角色主控；`SOUL.md` 只定义专业立场和表达风格，Skill 只定义按需加载的高内聚专业方法。
4. 不引入 Practice、Task kind、固定角色流水线、Team DAG 或 Team 级 Checkpoint。
5. Concern 只做低频过程提醒；Gate 只在固定 OpenClaw 能同步阻断的边界检查机器事实；工具后的观察先闭合 ToolResult，再由下一动作 Gate 或提交 Checkpoint 阻断。
6. 一个 Task 可以按实际需要使用多个有序 SkillUse；每个 Task attempt 或 Leader scope 最多同时打开 64 个 SkillUse，SkillUse 不跨 attempt/claim/Leader authority scope。scope replacement 将 open selections 标记 `interrupted` 并要求重新选择，不建立独立 SkillUse ledger。
7. 每个 Skill 具有 SemVer、内容摘要、受限 JSON Schema 结算合同、调用条件、依赖、失败处理和行为评测；Schema 不假装验证专业 prose 质量。
8. 所有允许暴露给模型的顶层工具都必须生成最小、工具专属的 ToolResult；引用和未引用 ToolResult 都有 ingest、恢复、幂等与有界 retention 协议。
9. MemberConfig 精确引用 deployment-owned RuntimeCapabilityBinding；M9-A 从其执行子集和 AgentTeams workload generation 派生 ExecutionBinding，M9-C 从其数据子集计算检索准入。
10. admission 显式分为 Task-scoped member execution 与 Work-scoped Leader coordination：前者必须有 ExecutionBinding/claim，可使用 workspace/Task Skill/submit-result；后者不需要 Task claim，只能使用 coordination 与无 workspace 脚本的 Leader Skill tools。Package-specific Skill settlement 验证留在 Worker controls，Coordination 只验证通用 envelope/identity/idempotency。
11. Tiangong CoordinationStore/PostgreSQL 是 Task claim/lease、writerRoot lock、Result/cancel race 和 cancel command phase 的唯一事务权威；Worker control runtime 只是 claimant/supervisor，AgentTeams/deployment 只提供 workload generation、prepared workspace 和 runtime binding。
12. M9-A 复用 M8 correlation 字段，并增加 executionAttempt 代次、`leaderScopeId` 和物理 OpenClaw session 到逻辑 Task/Work scope 的映射；只增加关联字段和可恢复 Attempt/LeaderScope boundaries，不建立第二份事实库或状态机。
13. Agent 通过 `tiangong_submit_result` 提交带 `reportedOutcome` 的 Result Candidate；提交临界区冻结新工具和后台进程，在一次受控协议中完成 Checkpoint、ToolResult ingest 和正式 Result 原子创建。
14. 完整 Task 调试由 Coordination facts、远端 OpenClaw session transcript、ToolResults、持久 Concern markers 和可选 AgentLoop spans 组成派生视图；attempt 关联属于 M9-A，Concern markers 属于 M9-B，UI/导出属于 M9-D。
15. 项目核心记忆只使用 Git 项目根目录的一份精炼 `PROJECT.md`。Architect 形成 Candidate；Developer local Commit 只是 delivery candidate，只有 authenticated deployment/admin principal 通过 expected-revision CAS 推进 ProjectBinding 后才能激活记忆和索引。
16. M9 项目检索只支持 allowlist Markdown、版本化 tokenizer、标题感知切片、PostgreSQL 全文检索、精确来源和 generation；PDF/HTML/OCR、pgvector、Embedding、hybrid ranking 和 shared-storage canonical memory 后移。
17. M9 按 A/B/C/D 四个内部阶段实施。M9-A 与 M9-B 验收通过即解除 M10 的架构前置；M9-C 或 M9-D 延期不成为 M10 的设计依赖。
18. 当前规划中的 Operation、精确 Human Approval、外部执行与恢复仍属于 M10；Task cancel command 是 M9-A 本地执行恢复，不是 M10 外部效果恢复。

## 2. 背景与当前缺口

当前 Worker 已经具备六个版本化 Agent Package、Skill allowlist、`tiangong_use_skill`、OpenClaw 工具锁、工具前 admission、基础 ToolResult 捕获和 Result 提交路径。这些能力证明了 Package 选择和工具边界可以运行，但尚未形成完整的专业执行合同。

主要缺口是：

- 六个 Agent 仍从全局 `worker/skills/` 共享方法包，角色方法和版本所有权不清晰；
- 当前 Worker 把 control plugin、全部 Package、session/control state 和 Agent 发起的 Bash 放在同一可读进程/文件系统边界，`workspaceOnly` 不能限制 `exec`，控制凭据隔离尚未成立；
- Agent Package 的 `instructions.md` 内容较薄，且当前通过 `before_prompt_build` 动态 prepend，尚未证明始终进入最终模型输入或加载失败时阻止模型调用；
- Skill 目前只有触发与行为样例，没有机器可验证的输入输出合同；
- 当前 ToolResult 主要记录工具名、结果形状和长度；Worker-local spool 与 Coordination 提交没有定义未引用记录的 ingest、崩溃恢复和冲突协议；
- 当前 Coordination API 使用共享 bearer 并信任请求 body 中的 actor，成员身份尚未绑定到控制通道，且凭据可能进入 Agent 可观察环境；
- OpenClaw 已保存 session transcript，M8 AgentLoop 已有 correlation 字段，但当前缺少 executionAttempt 代次、物理 session 到逻辑 Task 的稳定映射和按 Task 导出；
- 当前成员在 `agent_end` 后根据自然语言自动构造 Result，无法保证正式 Result 已通过专业检查，也没有闭合 submit call 自身 pending 与事务崩溃窗口；
- Concern、Gate 和 Checkpoint 尚未形成 Agent 专属、代码拥有且可测试的统一执行链；
- 项目理解没有一份类似 `PROJECT.md` 的精炼长期记忆；当前也未显式分开管理 workspace/writable roots 的 ExecutionBinding 与管理 repository/source revision/knowledge realm 的 ProjectBinding；
- allowlist Markdown、Runbook 和审核后经验尚无共享、可追溯、可重建的 lexical index；
- 现有产品测试主要证明包结构、触发文件和 runtime 选择，没有充分证明专业流程的成功、阻塞、失败和证据质量。

这些缺口位于外部 Operation/Approval 的上游。如果先开放外部副作用，后续升级 Result、ToolResult、Gate 和 Agent Package 会重新触碰授权预览、执行 Evidence、恢复和关单边界。因此 M9 先完成专业 runtime 和项目知识基础。

## 3. 目标与非目标

### 3.1 目标

M9 应交付：

- 角色无关 control image 与可选通用 execution image/rootfs 之间可攻击验证的安全域隔离；
- MemberConfig 对 deployment-owned RuntimeCapabilityBinding 的版本化精确引用，以及派生的 ExecutionBinding/effective data scope；
- Task-scoped member execution 与无 Task claim、无 workspace execution 的 Work-scoped Leader coordination 两条 admission 路径；
- Tiangong CoordinationStore/PostgreSQL 权威拥有的 execution claim/lease、writerRoot lock 和可恢复 cancel command；
- 成员/workload generation 绑定的控制通道和不进入 execution domain 的控制凭据；
- 六个自成体系、可独立维护和版本化的 Agent Package；
- 运行时 Package 选择、不可写 controller bootstrap 与当前 Package Skill 资源隔离；
- 可移植且符合 Agent Skills 规范的 Skill 包；
- 只约束有界结算字段的 Skill 输入、输出、调用、失败、依赖、版本、评测和回滚合同；
- 每个试点 Agent 少量、确定性的 Concern、Gate 和 Checkpoint；
- 对所有顶层工具无遗漏的 ToolResult 捕获及高价值工具的语义提取；
- 有界、脱敏、可说明截断方式的最小 ToolResult，以及未引用记录的 batch ingest、崩溃恢复和 retention；
- Work/Task/executionAttempt/Leader scope 到 Member/session/turn/toolCall 的稳定关联字段和可恢复 Attempt/LeaderScope boundaries；
- stale principal、Worker replacement、双 writer、Result/cancel 的 claim/lease 竞态控制；
- 成员绑定、冻结执行、Checkpoint 前置且事务闭合的正式 Result 提交；
- 与 ExecutionBinding 分离的最小、部署拥有 ProjectBinding；
- Git 根目录 `PROJECT.md` 的 Candidate、Developer materialization、维护和读取规则；
- allowlist Markdown、版本化中英 tokenizer、增量 PostgreSQL FTS、精确来源、generation 和失效处理；
- 从已有直接来源派生、operator-only 的 Task 调试视图；
- Architect 与 Developer 纵切试点，以及六个 Agent 的最终 clean-cut 迁移；
- 结构、合同、控制、行为和真实集成的分层验证。

### 3.2 非目标

M9 不实现：

- Task kind、PlanStep、固定角色阶段、Team DAG 或工作流状态机；
- Team 级专业 Checkpoint 或逐 Task Leader 接受对象；
- 在线 Skill 安装、Skill 市场、执行中热更新或模型自行修改受信 Skill；
- Prompt、Skill、Concern、RAG 或 ToolResult 授权；
- 外部写 Operation、精确 Human Approval、部署、生产灰度、回滚或恢复；
- PDF、HTML、OCR、pgvector、Embedding、hybrid reranking 或未经治理的文档披露；
- shared-storage canonical `PROJECT.md`；
- 全量源码索引、全量聊天索引或全量 ToolResult 检索索引；
- 把非 Developer 角色的普通工作区工具承诺为通用严格只读；它们依靠隔离工作区、exact target 和无发布权限保护交付链；
- 记录或展示模型 provider 未公开的隐藏 Chain of Thought；
- 将模型生成摘要提升为项目事实；
- 用设计文档、测试计划或模型评审代替运行时机器验证。

## 4. 术语与事实边界

| 术语 | 含义 |
|---|---|
| Control Domain | 持有身份、凭据、OpenClaw session、Package controller、controls 和 ToolResult spool 的受信 Worker 运行域。 |
| Execution Domain | Agent 发起文件、命令和进程操作的无控制凭据 prepared environment，只暴露 ExecutionBinding 授权的 workspace 与当前 Package 必要 Skill 资源。 |
| RuntimeCapabilityBinding | deployment-owned、被 MemberConfig 精确引用的版本化能力投影，提供 prepared workspace、路径、网络、资源和 data scope；模型 prose 不能修改或扩大。 |
| ExecutionBinding | M9-A 从当前 MemberConfig 引用的 RuntimeCapabilityBinding 执行子集与 AgentTeams workload generation 派生的执行投影；不承载项目知识来源。 |
| Execution Claim/Lease | Tiangong CoordinationStore/PostgreSQL 权威拥有的 Task/attempt 运行时所有权；保证每 Task 一个 active owner、每 writer root 一个 writer，并与 Result/cancel 串行竞争。 |
| Work-scoped Leader Coordination | authenticated Human 消息已创建 Work/session、但不要求 Task 的 Leader 模型路径；只开放 coordination 与 Leader Skill tools，不开放 workspace execution。 |
| Agent Package | 一个专业 Agent 的受信、版本化运行包，包含主控、风格、私有 Product Skills 和 controls。 |
| Agent Controller | Package 内通过不可写 bootstrap/system context 始终加载的 `AGENTS.md`，定义职责、边界、总体循环和 Skill 路由。 |
| Skill | Agent 私有、按需加载的专业方法包，不授予工具或权限。 |
| SkillUse | 对一个确切 Skill 版本的一次选择；Task-scoped 选择由正式 Result 结算，Work-scoped Leader 选择由后续 accepted typed coordination action/ToolResult 结算，不新增独立 ledger。 |
| ExecutionAttempt | 同一 Task 的一次物理执行代次，只用于 correlation、恢复和诊断，不是 Task 状态或新的权威工作流对象。 |
| Concern | 根据当前 Work、可选 Task 和工具事实产生的低频、非阻断专业提醒；已发出状态以 scope-aware 持久 marker 去重和调试。 |
| Gate | 在固定 runtime 可同步阻断的动作边界执行的确定性控制；工具后的事实由下一动作 Gate 或提交 Checkpoint 消费。 |
| Checkpoint | 正式提交前对剩余专业完整性的检查；不重复已经由 Gate 确定保证的事实。 |
| Result Candidate | Agent 准备提交但尚未成为产品事实的结构化参数。 |
| Result | Checkpoint 通过后由 CoordinationStore 持久化的 Task 最终报告；其中 `reportedOutcome` 是 Agent 声明，不是 Kernel 判定的成功状态。 |
| ToolResult | 一个顶层工具实际观察到的有界机器事实。它只证明该工具观察到什么。 |
| Task Debug View | 从 Coordination、远端 OpenClaw transcript、ToolResults、Concern markers 和可选 AgentLoop spans 按需生成的非权威调试视图。 |
| ProjectBinding | M9-C 部署拥有、非工作流的项目投影，稳定绑定 `projectBindingId`、repository、exact source revision、knowledge realm 和来源策略；不授予 workspace 写权限。 |
| Project Memory | Git 项目根目录中一份精炼、项目特有、长期稳定的 `PROJECT.md`。 |
| Knowledge Source | ProjectBinding allowlist 允许进入检索的 Git Markdown 来源。 |
| RAG Index | 从 Knowledge Source 派生的 PostgreSQL 全文与元数据索引，可删除和重建。 |
| Retrieval Result | 带精确来源、版本、范围和索引 generation 的检索切片；不是授权或机器 Evidence。 |

必须始终区分：

- Human 或 Leader 的协调；
- ExecutionBinding 与 claim/lease 的当前机器权限/ownership；
- Agent 的 Result 声明；
- ToolResult 的机器观察；
- Task Debug View 的派生诊断投影；
- Git、数据库、外部系统等直接状态；
- 项目记忆中的审核后综合事实；
- RAG 返回的来源切片；
- 模型生成的解释和推断。

任何后一层 prose 都不能扩大前一层的机器权限。

## 5. 总体架构

```text
AgentTeams identity + current Team/MemberConfig/RuntimeCapabilityBinding
                              │
                ┌─────────────┴──────────────┐
                ▼                            ▼
 Work-scoped Leader coordination      Task-scoped member execution
 Work + leaderScopeId/expected epoch    Task + ExecutionBinding + claim
 no workspace execution               prepared workspace allowed
 coordination + Leader Skills         Task Skills + workspace + submit
                │                            │
                └─────────────┬──────────────┘
                              ▼
                    Tiangong control domain
     ┌───────────────────┼────────────────────────┐
     │                   │                        │
     ▼                   ▼                        ▼
immutable Agent      Professional          Tool observation
bootstrap/package    Controls              pending ledger + spool
     │             Concern/Gate/                  │
AGENTS.md + SOUL.md   Checkpoint                   ├─ bounded batch ingest
Agent-private Skills      │                        └─ Result inline ingest
     │                    │                                │
     └──────────────┬─────┘                                ▼
                    ▼                       CoordinationStore / PostgreSQL
            OpenClaw model loop             claim/writer/Result/cancel authority
                    │                                      │
           Task path only: workspace tools                 │
                    │                                      │
                    ▼                                      │
      credential-free execution domain                     │
      authorized workspace + current Skill resources       │
                    │                                      │
                    └──────── ToolResults ──────────────────┘
                                   │
                          Task path only
                                   ▼
                         tiangong_submit_result
                         freeze → Checkpoint
                         → transactional ingest/Result

ProjectBinding + active PROJECT.md ─► bounded project context
principal ∩ effective MemberConfig data scope
          ∩ ProjectBinding realm ───► Markdown / tokenizer / FTS retrieval

Task Debug View ◄─────────────────── Coordination + remote transcript
                                     + ToolResults + Concern markers
                                     + optional AgentLoop spans
```

控制域和执行域是强制安全边界，不因位于同一镜像或宿主而合并：

- Package controller、controls、凭据、session/runtime state 和 ToolResult spool 位于 Agent 发起的 `exec/process` 不可读取的控制域；
- execution domain 只能获得 ExecutionBinding 授权的 workspace、显式工具能力和当前 Package 允许执行的 Skill 资源；
- 项目 workspace 的 `AGENTS.md` 仍是项目操作规则，不替代 Package 的角色主控；
- ExecutionBinding 和 claim/lease 参与 capability 计算；ProjectBinding、项目记忆和检索只约束 source/realm，不授予执行或写入能力；
- “非 root”和“清理少量环境变量”只是加固措施，不能代替攻击性隔离验收。

## 6. 通用镜像、ExecutionBinding 与 Agent Package 2.0

### 6.1 不构建角色专用镜像

Tiangong 构建一个角色无关的通用 control image，其中包含六个受信 Agent Package。容器激活时根据当前 AgentTeams 身份、MemberConfig 和 Agent Package binding 选择一个 Package：

```text
tiangong control image
└─ /opt/tiangong-worker/agent-packages/
   ├─ leader/
   ├─ architect/
   ├─ challenger/
   ├─ developer/
   ├─ reviewer/
   └─ tester/

optional generic execution image/rootfs
└─ no control credentials, packages, controls or session state
```

“不共享 Skill”表示：

- 所有权不共享；
- 源文件和版本不共享；
- 模型可见性不共享；
- Skill ID 解析在当前 Package 内完成；
- Agent Package 只锁定自己的 Skills；
- 一个 Agent 的 Skill 变更不自动改变另一个 Agent。

M9 不构建 Leader/Architect 等角色专用镜像。execution domain 可以使用 control image 内的受限 sandbox，也可以使用一个同样角色无关、无控制资产的 execution image/rootfs 或 AgentTeams prepared container。镜像数量和物理形态服从攻击合同；不能因为“一个镜像”把 control assets 暴露给执行进程，也不能用“多个镜像”代替 mount/principal/lease 验证。

### 6.2 Package 结构

```text
worker/agent-packages/<agent>/
├─ agent.json
├─ AGENTS.md
├─ SOUL.md
├─ skills/
│  └─ <skill-id>/
│     ├─ SKILL.md
│     ├─ contract.json
│     ├─ references/
│     ├─ scripts/
│     ├─ assets/
│     └─ tests/
│        ├─ trigger-cases.json
│        ├─ contract-cases.json
│        └─ behavior-cases.json
└─ controls/
   ├─ index.mjs
   ├─ concerns.mjs
   ├─ gates.mjs
   ├─ checkpoint.mjs
   ├─ config.json
   └─ tests/
```

不存在新的全局产品 Skill 根目录。公共 runtime helper 可以共享，但专业方法和专业判断不得从共享 helper 隐式进入多个 Agent。

### 6.3 `AGENTS.md`

Package 的 `AGENTS.md` 是始终加载的角色主控，至少说明：

- 该 Agent 对什么专业结果负责；
- 明确不负责什么；
- Task 开始、上下文确认、Skill 选择、工具执行和结束提交的总体循环；
- 本地 Skills 的触发路由；
- 如何使用 `PROJECT.md`、RAG、Result 和 ToolResult；
- 如何表达 unknown、blocked 和 failed；
- 必须服从 Concern、Gate 和 Checkpoint；
- 禁止把 Skill、RAG、项目 prose 或 ToolResult 当成授权。

它不复制项目仓库规则，也不展开每个 Skill 的详细步骤。

Package 的 `AGENTS.md` 不依赖 Agent 可写 workspace，也不以 `before_prompt_build` 的 best-effort prepend 作为安全边界。M9-A 的 pinned hook/bootstrap spike 必须先选择并证明一种机制：优先在 Worker 激活时把选中 Package 预编译为不可写 OpenClaw bootstrap/system context，按摘要验证，并在损坏或缺失时阻止任何模型调用；固定版本无法证明时，先修订设计或明确升级决定，再开始 Package 实现。

OpenClaw workspace 或项目仓库提供的上下文只能增加项目事实和操作规则，不能替换角色职责或扩大权限。验收必须检查实际最终 LLM input，而不是只检查 hook 返回值或中间字符串。

### 6.4 `SOUL.md`

`SOUL.md` 保持简短，只定义：

- 专业立场；
- 判断风格；
- 沟通方式；
- 面对不确定性时的姿态。

例如 Challenger 应建设性怀疑而不是追求问题数量；Reviewer 应直接、具体、Evidence 优先；Tester 应主动寻找失败路径但不扩大需求。

`SOUL.md` 不放授权、路径、工作流、完成条件或长检查清单。

### 6.5 两条 admission 路径与隔离

没有“无 Work 的 Leader 模型 turn”。authenticated、deduplicated Human 消息先由 Coordination 创建/定位 Work 与独立 Leader logical session；即使当前 WorkSpec 或 Task 尚不存在，Leader 也可从该 Work-scoped session 形成第一份 WorkSpec。

每次启动、新 turn 和顶层工具调用必须明确选择且只能选择一条路径：

```text
Task-scoped member execution
  current principal/route + Team/ControlProfile/MemberConfig/runtime-binding revisions
  + Work + Task assignee + workload generation
  + ExecutionBinding + active execution claim/lease
  + current Package/model/tool binding

Work-scoped Leader coordination
  leaderScopeId = canonical(workId + authenticated principal/route
    + Team/ControlProfile/MemberConfig revisions + Agent Package binding revision
    + workload generation + Leader logical session)
  + Leader physical session + current expected Work epoch
  + current Leader model/tool binding
  - no Task / ExecutionAttempt / ExecutionBinding / execution claim
```

Task-scoped 路径适用于任何 ordinary Task assignee，允许当前 Package 的 Task Skills、knowledge reads、workspace tools 和 `tiangong_submit_result`。Work-scoped Leader 路径只允许有界 coordination tools 与当前 Leader Package 中标记为 `settlement: coordination-action` 的纯方法 Skill；禁止 `read/write/edit/exec/process`、workspace/repository/knowledge retrieval、Task Result submit 和带 workspace 脚本的 Skill。需要项目读取或本地执行时，Leader 必须创建 ordinary Task 并走 Task-scoped 路径，不能临时为 Work session 伪造 Task/claim。

Leader session 只用于 turn 串行与 correlation，不单独授予 authority；`leaderScopeId` 封闭绑定 current principal/route、Team/ControlProfile/MemberConfig revisions、Agent Package binding revision、workload generation、Work 和 Leader logical session。Work epoch 是每个 action 的 optimistic-concurrency precondition，不进入 scope identity。两条路径的 pending ledger、ToolResult 必填字段、SkillUse 结算和 ingest 校验不同，不能用可选字段把一条路径降格为另一条。只向模型投影选中 Package 的主控、风格和对应路径允许的 Skill catalog/tool surface。Package 解析、摘要检查、controller bootstrap、当前配置或 control 加载失败时必须在模型调用前 fail closed。

### 6.6 Execution domain 安全合同

Agent 发起的 `read/write/edit/exec/process` 必须在 prepared execution domain 内执行。该域：

- 没有 Coordination、Matrix、模型 provider、AgentTeams control 或 AgentLoop exporter 凭据；
- 看不到 controls、OpenClaw session state、ToolResult spool、其他 Agent Package 或宿主控制 socket；
- 只挂载当前 ExecutionBinding 授权的 workspace/read-write roots、显式缓存/临时目录和当前 Package 所需的只读 Skill scripts/assets；
- 对进程树统一执行 cwd、mount、symlink、网络、资源、取消和清理约束；
- 不能通过父目录遍历、符号链接、`/proc`、后台进程、子 shell 或进程继承越界。

M9-A 必须把现有镜像机器探测固化为公开、合成、确定性的回归测试。测试直接从 Agent 可调用的 `exec/process` 攻击边界，而不是只检查配置：

- 读取普通环境和 `/proc/self/environ`、`/proc/1/environ`、可枚举的 `/proc/*/environ`，均不能获得控制凭据；
- 直接读取 controls、session state、spool 和其他 Package 路径失败；
- `..`、绝对路径、symlink/hardlink、rename race 和绑定目录外 cwd 不能逃逸；
- 后台进程、poll/log、派生子进程和取消后的残留进程不能在边界外继续访问；
- 当前 Package Skill 资源可读，其他 Package Skill 资源不可读；
- 授权 workspace 内允许的读写按角色实际 workspace binding 成功。

单纯切换非 root、drop capabilities 或删除已知环境变量不能满足本合同。测试必须使用合成 canary token 和 canary control files，失败时不得把真实 secret 打入日志。

### 6.7 RuntimeCapabilityBinding、ExecutionBinding 与 claim/lease 权威

M9-A 将 MemberConfig 提升为精确引用 deployment-owned RuntimeCapabilityBinding 的版本化合同；目标字段至少包含：

```json
{
  "memberId": "member",
  "revision": 7,
  "runtimeCapabilityBindingRef": {
    "bindingId": "member-runtime-binding",
    "revision": 3
  }
}
```

对应 binding 是有界受信配置：

```json
{
  "bindingId": "member-runtime-binding",
  "revision": 3,
  "teamId": "team",
  "memberId": "member",
  "enabled": true,
  "workspaceBindingRef": "prepared-workspace-ref",
  "readableRoots": ["workspace"],
  "writableRoots": ["writer-root"],
  "networkScopeRef": "member-network-scope",
  "resourceProfileRef": "bounded-profile",
  "dataScope": {
    "projectBindingIds": ["stable-project-binding"],
    "knowledgeRealms": ["team-project"],
    "sourceClassifications": ["internal-project"]
  }
}
```

所有数组、标识和 revision 都有 Schema 上限且禁止未知字段。`dataScope` 不是 Prompt 或 Task 字段。AgentTeams/deployment 提供当前 workload generation、prepared workspace 和该 binding projection；MemberConfig 锁定 exact binding revision。任一 MemberConfig/binding disable、revision mismatch 或撤销都使旧 turn、工具、检索和 claim stale。

ExecutionBinding 只物化 binding 的执行子集，并加入当前 AgentTeams workload generation：

```json
{
  "memberId": "member",
  "memberRevision": 7,
  "runtimeCapabilityBindingId": "member-runtime-binding",
  "runtimeCapabilityBindingRevision": 3,
  "workloadGeneration": 12,
  "workspaceBindingRef": "prepared-workspace-ref",
  "readableRoots": ["workspace"],
  "writableRoots": ["writer-root"],
  "networkScopeRef": "member-network-scope",
  "resourceProfileRef": "bounded-profile"
}
```

它不包含 `projectBindingId`、knowledge realm 或检索来源。M9-C 的 effective MemberConfig data scope 从同一 exact MemberConfig/binding 的数据子集取得，但不能反向授予 workspace 能力。激活、新 turn 和每个 workspace tool call 都将实际 mount/cwd/network/process profile 与当前 ExecutionBinding 对账。

Tiangong CoordinationStore/PostgreSQL 是 claim/lease、Task、writerRoot lock、Result/cancel race 和 cancellation command phase 的唯一事务权威。AgentTeams/deployment 的 workload/binding 是受信输入，但不保存 Tiangong claim；Worker control runtime 只是 claimant、lease client 和 process supervisor，本地缓存不能延长、恢复或替代 PostgreSQL lease 真相。

开始 Task execution 前，Worker control runtime 必须通过 CoordinationStore 原子取得 claim/lease。PostgreSQL 用 active Task 与 active writerRoot 唯一约束串行化，claim identity 至少绑定：

```text
executionClaimId
+ taskId + executionAttemptId
+ controlProfileRevision + memberConfigRevision + runtimeCapabilityBindingRevision
+ workloadGeneration + workspaceBindingRef + writerRoot
+ authenticated assignee principal
```

lease record 另含单调 `claimRevision`、作为 writer fencing token 的 `leaseEpoch`、server-issued `acquiredAt/expiresAt` 和可选 `revokedAt/reasonCode`。`executionClaimId/leaseEpoch` 在一次 ownership grant 内稳定；renewal 只 CAS 推进 `claimRevision/expiresAt`，reacquire 必须创建新的 claim ID 和更大的 lease epoch。PostgreSQL 时间是 expiry 权威，Worker 本地时钟不能延长 lease。

合同：

- claim 只可授予当前 Task assignee、current ControlProfile、enabled MemberConfig、exact RuntimeCapabilityBinding、当前 workload generation 和匹配 ExecutionBinding 的 execution principal；credential 值不进入 claim record；
- 同一 Task 最多一个 active execution claim；同一 `writerRoot` 最多一个 active writer，两个 Task、attempt 或 Worker 不能同时持有；
- claim acquisition、renewal、revoke、Result submit 和 cancel 在同一 CoordinationStore 事务边界按 claim revision/lease epoch 串行化；lease expiry 只撤销继续执行能力，不伪造 Task cancellation 或 Result；同一 claim 的 renewal 保留 attempt，claim 终止后的任何 reacquire 必须创建新的 executionAttemptId、claim ID 和更大 lease epoch；
- 每个 Task-scoped 新 turn、tool/process start、process poll/kill、ToolResult admission 和 Result submit 都重验 claim、配置 revisions、workload generation、principal 与 ExecutionBinding；
- Worker replacement 先推进 workload generation，再由 CoordinationStore revoke/fence 旧 claim。旧 Worker、旧 principal、旧 claim/epoch 或迟到 tool call 一律 stale-denied，即使其本地进程仍存活；
- claim 丢失或续租失败立即进入 revoke/freeze，禁止新动作，并触发完整进程树终止与 writer root 对账；
- writer root 只在进程树确认终止、没有 active write/tool 且 spool 已保存必要终态后释放；释放失败保持 fenced，不能授予第二 writer。

Result 与 cancel 是同一 PostgreSQL Task/claim revision 上的原子竞争者。Result 只能由 claim 绑定的 assignee execution principal 提交；cancel 只能由 current authenticated Leader principal 发起。Result 事务若先提交，claim 被退休且 cancel 冲突；cancel 的第一事务若先 fence claim，任何 Result 都 stale-denied。

Task cancellation 是 M9-A 的本地多阶段可恢复命令，不是 M10 Operation：

```text
authenticated cancel command + actor-scoped requestId
→ transaction 1: serialize with Result, create/replay command, revoke/fence claim
→ deny new turn/tool/process/renewal and keep writerRoot fenced
→ kill and confirm the complete process tree
→ close terminal/unknown ToolResults to trusted spool and reconcile ingest
→ verify writerRoot quiesced, release active writer ownership
→ transaction 2: create Task cancellation fact, retire claim/fence atomically
```

尚无 active claim 的 queued Task 也走同一命令：transaction 1 原子确认没有 Result/claim/writer/pending execution 并建立 Task cancellation fence，process/records/writer phases 只能由这些直接空集事实推进，不能因“可能未启动”直接伪造 cancelled。

bounded command replay row 只允许 `fenced → process-quiesced → records-closed → writer-released → cancelled` 单向 phase，并对同一 Task 强制最多一个 active cancel command。`writer-released` 只证明物理进程与 workspace 已 quiesced；PostgreSQL authoritative writerRoot fence 仍保留到 transaction 2 与 cancellation fact 一起退休。transaction 1 先验证调用携带的 expected Work epoch；后续 phase 用 `taskId + requestId + expected phase + expected claimRevision-or-null` CAS，不把 session 或旧 Work epoch 当作恢复权威。transaction 2 再锁定 current Work projection、重验 Task 无 Result 并原子追加 cancellation fact/epoch update。Worker supervisor 报告进程/根目录观察；Worker 丢失时，受信 recovery controller 从 current phase 继续，不能恢复模型执行。多阶段取消不保持 Leader model turn 或 execution process 存活；调用可返回 current phase，后续由同 requestId 查询/重放。

相同 requestId 重放返回当前 phase 或既有 cancellation fact；不同 requestId 在 active command 存在时冲突，不能启动第二取消。进程终止、terminal spool、ingest reconciliation、writer quiescence 或最终事务失败时，UI/Kernel 只能报告 `cancellation-pending/recovery-required`，不能报告 cancelled；claim/root fence 保持且 Task 不得被重新领取。transaction 2 提交 cancellation fact 后才可退休 fence，此后 cancellation fact 永久阻止 Task/claim 恢复，不会产生解除 fence 后悄然继续的窗口。incomplete command row 不得因普通 retention 删除；terminal row 至少保留到 actor-scoped command replay window 结束，之后可清理，但 Work timeline 中的 cancellation fact 保留。command replay row 是有界基础设施恢复状态，不是第二 Task 状态机或业务 ledger。

## 7. Skills 2.0

### 7.1 Skill 职责

Skill 只回答“如何专业地完成一个高内聚动作”。它不定义：

- Agent 身份；
- 文件系统或网络能力；
- 外部系统凭据；
- Task 的机器权限；
- Operation 或 Approval；
- 固定 Team 流程；
- Checkpoint 的强制执行代码。

同一 Agent 内应避免职责重叠。Skill 应完成一个有意义的专业动作，而不是按文件类型或单个命令拆分。

### 7.2 Agent Skills 兼容包

`SKILL.md` 继续遵循公开 Agent Skills 规范：

```yaml
---
name: project-onboarding
description: Understand an existing project and establish evidence-backed project context. Use when entering an unfamiliar repository or rebuilding stale project memory.
license: Apache-2.0
metadata:
  source: tiangong
  version: 1.0.0
---
```

`allowed-tools` 只能作为可移植性元数据，不能被 Tiangong 当成授权。

公开 Agent Skills 规范允许额外文件。M9 增加顶层 `contract.json`，并更新 Tiangong package validator 的允许项和摘要计算。

### 7.3 `contract.json`

示意合同：

```json
{
  "schemaVersion": 1,
  "skillId": "project-onboarding",
  "skillVersion": "1.0.0",
  "purpose": "Establish durable, evidence-backed understanding of an existing project.",
  "inputSchema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": ["projectRef", "sourceRevision", "objective"],
    "properties": {
      "projectRef": {"type": "string", "maxLength": 256},
      "sourceRevision": {"type": "string", "maxLength": 256},
      "objective": {"type": "string", "maxLength": 2048},
      "existingMemoryRef": {"type": ["string", "null"], "maxLength": 512}
    },
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "required": ["status", "content", "sourceRefs", "unknowns"],
    "properties": {
      "status": {"enum": ["succeeded", "blocked", "failed"]},
      "content": {"type": "string", "maxLength": 8192},
      "sourceRefs": {
        "type": "array",
        "maxItems": 64,
        "items": {"type": "string", "maxLength": 512}
      },
      "unknowns": {
        "type": "array",
        "maxItems": 32,
        "items": {"type": "string", "maxLength": 1024}
      }
    },
    "additionalProperties": false
  },
  "activation": {
    "requiresExplicitTaskObjective": true
  },
  "toolDependencies": ["read", "exec", "tiangong_search_project_knowledge"],
  "sideEffects": "project-memory-candidate-only",
  "failureModes": [
    "project-source-unavailable",
    "source-revision-mismatch",
    "insufficient-reading-coverage",
    "conflicting-project-facts"
  ]
}
```

要求：

- `skillId`、`skillVersion` 必须与目录和 `SKILL.md` metadata 一致；
- validator 只实现公开声明的 JSON Schema 子集，并限制 Schema 总字节、嵌套深度、属性数、数组长度、字符串长度和正则复杂度；
- 禁止 remote `$ref`、递归引用、运行时代码、未知 format 和可能造成不受控资源消耗的关键字；本地可复用定义只能来自同一受信 contract 且计入摘要；
- 输入传递引用、目标和有界参数，不传递凭据或无限正文；
- 输出 Schema 只约束 `status`、专业正文容器、source/tool/artifact refs、unknowns 和限制等结算字段，不用大量伪结构字段假装机器能够验证专业内容质量；
- `toolDependencies` 用于兼容性和行为验证，不扩大当前工具表面；
- `sideEffects` 是文档和测试合同，真实写入仍由工具、Gate 和 execution boundary 控制。

专业内容是否充分由直接 ToolResults、窄 Checkpoint 结构要求和模型行为评测共同证明。不能因为一个 `maxLength` 字符串通过 Schema 就声称 onboarding、根因分析或架构方案质量已经合格。

### 7.4 版本和锁定

Skill 使用 SemVer：

- Major：输入输出或调用语义不兼容；
- Minor：向后兼容地增加能力或可选输出；
- Patch：修复说明、控制配套或测试，不改变合同。

Agent Package 精确锁定：

```text
skillId + skillVersion + skillContentDigest
```

运行记录同时保留 Agent Package 版本。runtime 不解析浮动版本，不执行热更新。回滚通过选择一个已审核、已构建并锁定旧 Skill 的 Agent Package 完成。

内容摘要是受信包供应链身份，不是业务 Artifact 或外部授权身份。

### 7.5 Task 与 Work-scoped Leader SkillUse

`tiangong_use_skill` 的 admission scope 由 control runtime 注入，模型不能在参数中选择或扩大。两条路径都只在当前 Package catalog 中解析 exact Skill、校验版本摘要和 input Schema、创建有界 `skillUseId` 并记录选择 ToolResult，但结算事实不同。

Task-scoped member execution 可以使用多个有序 SkillUse：

```text
Task
├─ SkillUse 1: bug-triage@1.0.0
├─ SkillUse 2: test-driven-development@1.1.0
└─ SkillUse 3: regression-verification@1.0.0
```

`tiangong_use_skill` 接收：

```json
{
  "skillId": "bug-triage",
  "trigger": "The assigned defect needs root-cause classification before modification.",
  "input": {}
}
```

Task SkillUse selection ToolResult 必须带 Task/attempt/claim identity。Result Candidate 说明每个已选择 `skillUseId` 的 status 和 output；专业 Checkpoint 校验 output Schema、直接引用和未结 SkillUse。正式 Result 是 Task SkillUse status/output 的唯一结算事实。

Work-scoped Leader coordination 没有 Task Result。Leader Package 只有在 Skill contract 声明 `settlement: "coordination-action"`、列出允许的 typed action kinds，且 Skill 不包含需要 workspace/execution domain 的 script 时，才可在该路径选择 Skill。选择 ToolResult 绑定受信 runtime 签发的 `leaderScopeId`、turn 和 `workEpochAtSelection`，但省略 Task/attempt/claim/ExecutionBinding 字段。

`leaderScopeId = digest("leader-scope-v1", canonicalTuple)`；`canonicalTuple` 是以下 authority identity，不是模型输入：

```text
workId
+ authenticated principalId + principalRouteRef
+ teamRevision + controlProfileRevision + memberConfigRevision
+ agentPackageBindingRevision
+ workloadGeneration
+ leaderSessionRef
```

任一 authority identity 字段变化都终止旧 Leader scope。control runtime 或 recovery controller 必须在新 Leader turn 前，把旧 scope 的 replacement/terminal boundary 持久化并确认 ingest，再打开新 `leaderScopeId`；旧 scope 不能继续选 Skill、结算或发起 action。Work epoch 不属于 `leaderScopeId`：`workEpochAtSelection` 只保存选择时 provenance。accepted action 必须携带 current `expectedWorkEpoch`；同一 scope 内 Work epoch 因成员 Result 或其他已接受事实推进时，Worker 可以在重新读取 current Work、重验 Skill 专业前置和 action output 后，使用旧 selection 发起带 current epoch 的 action。stale expected epoch 被拒绝且不结算；Worker 在同一 scope 重读后必须使用反映新 canonical request 的新 requestId 重试，selection 保持 open 而不会永久悬空。

下一次被 CoordinationStore 接受的 typed Leader action 必须在其有界请求中携带结算：

```json
{
  "expectedWorkEpoch": 4,
  "skillUseSettlements": [
    {
      "skillUseId": "leader-skill-use",
      "selectionToolResultId": "leader-use-skill-tool-result",
      "skillId": "work-decomposition",
      "skillVersion": "1.0.0",
      "skillContentDigest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "status": "succeeded | blocked | failed",
      "output": {}
    }
  ]
}
```

`skillUseSettlements` 是 typed command envelope 的有界结算 metadata，不写入 WorkSpec/TaskSpec 字段，也不授予 action authority；Work timeline action 只保存必要 settlement refs/status/output。

Worker Leader action control 在调用 Coordination 前加载当前 Package contract，并 fail closed 验证 Package/Skill version 与 digest、typed action kind allowlist、Skill output Schema 和专业前置条件。它只向 Coordination 发送已经通过 Worker control 的 bounded settlement envelope。

CoordinationStore 不加载 Agent Package 或 Skill contract，也不重新判断专业 output。它在同一 action transaction 中只执行通用验证：按 `selectionToolResultId` 载入 selection ToolResult；比较 action 中的 `skillUseId/skillId/skillVersion/skillContentDigest` 与 selection 记录完全一致；验证 bounded settlement envelope、`succeeded | blocked | failed` enum、大小和 refs；验证相同 Work、current `leaderScopeId`/actor/route/authority revisions、action 的 `expectedWorkEpoch` 等于 current Work epoch，以及 accepted action ownership；并保证每个 `skillUseId` 最多被一个 accepted action 结算及 requestId 幂等。它不要求 `expectedWorkEpoch == workEpochAtSelection`。Coordination 接受只证明通用 actor/ownership/引用/一次性结算合同成立，不证明专业输出充分。

accepted `update-work-spec`、`publish-plan`、`create-task`、`cancel-task`、`complete-work` 或 `stop-work` 的 Work timeline fact 与 coordination ToolResult 共同构成唯一结算事实；action ToolResult 引用 selection `skillUseId/toolResultId`。被通用 envelope、epoch、actor 或 ownership 检查拒绝的 action 不结算 SkillUse；`cancel-task` 的 transaction 1/pending phases 也不结算：初始 tool call 只闭合一个报告 current phase 的 ToolResult，canonical settlement request 随 bounded cancel command 保存；只有 transaction 2 cancellation fact 与 server-side terminal receipt 可原子结算。相同 action requestId 重放返回同一结算，不重复创建。

SkillUse 的 scope 生命周期是恢复合同，不是新的业务 ledger：

- 每个 Task attempt scope 和 `leaderScopeId` 最多同时存在 64 个 open SkillUses。control runtime 在 per-scope lock 内以 selection minus formal settlement/boundary 直接事实计数并串行创建 selection；`tiangong_use_skill` admission 在第 65 个 record 创建前 fail closed。已结算 Leader SkillUse 不再计入 open 数，boundary 因而最多携带 64 个 `skillUseId`；
- Task SkillUse 只属于创建它的 `executionAttemptId + executionClaimId + leaseEpoch`。claim 丢失、Worker replacement 或 crash recovery 终止该 scope 时，terminal/revoked/crashed AttemptBoundaryRecord 以唯一 diagnostic disposition `interrupted` 列出仍打开的 `skillUseId`；它不是 `succeeded | blocked | failed` 正式结算；
- claim 终止后重新领取必须创建新的 `executionAttemptId`、claim ID 和 lease epoch，并重新选择所需 Skill。当前 Task Result 只结算和引用当前 attempt/claim 的 SkillUses/ToolResults；
- Work-scoped Leader SkillUse 只属于创建它的 `leaderScopeId`。principal/route、`teamRevision/controlProfileRevision/memberConfigRevision`、`agentPackageBindingRevision`、workload generation 或 Leader logical session 任一变化时，受信 control/recovery runtime 写 `LeaderScopeBoundaryRecord(replaced|terminal)`，以唯一 diagnostic disposition `interrupted` 终止旧 scope 的 open SkillUses；新 Leader scope 必须重新选择；
- `interrupted` 只有一个确定性机器转换：scope boundary 创建时，将该 scope 所有尚无正式 Result 或 accepted action settlement 的 SkillUses 以 `skillUseId + disposition + reasonCode` 列入 boundary。`reasonCode` 来自有界机器事件 enum（claim lost、worker/authority/session replaced、crash recovery 或 terminal scope）；已正式结算的 SkillUse 不列入，M9 只定义这一种未结 diagnostic disposition；
- Work complete/stop 只要求 current active Leader scope 没有未结 SkillUse。历史 interrupted selections 进入调试视图和 Work retention，不阻塞关单，也不能成为专业输出或 accepted action settlement；
- M9 不提供跨 attempt/claim/Leader scope 的 ToolResult 或 SkillUse carry-forward。需要旧事实时必须重新观察；已进入 Work timeline、正式 Result 或 exact ContentRef 的独立直接事实仍按其自身合同使用，但不会把旧 SkillUse 变成已结算。

两类 SkillUse 都不建立独立表或 ledger：selection、scope boundary、Task Result 或 accepted Leader typed action 是直接事实。Worker 崩溃后从这些事实重建 current-scope 未结集合；不能用聊天记忆或 controller prose 声称已经结算。

### 7.6 评测材料

每个 Skill 至少包含：

- 正例、负例、歧义和相邻 Skill 的 trigger truth table；
- input/output 合同正例和拒绝样例；
- success、blocked、failed 和 cleanup 行为案例；
- 至少一个机器可观察成功路径；
- 至少一个 Evidence 不足路径；
- 对有副作用脚本的路径、输入、超时、清理和供应链测试。

模型敏感评测不能替代确定性 Schema 和 Gate 测试，也不应在不受控环境中成为每次提交的硬 Gate。

### 7.7 ADR-M9-001：Product Skill 源码所有权

**状态：** Accepted for M9 design

**上下文：** 当前全局 `worker/skills/` 允许多个专业角色解析同一 Product Skill。精确版本和摘要可以阻止静默升级，但不能消除专业方法所有权、角色语义和行为评测的耦合。另一方面，完全复制实质相同的 Skill 也可能造成维护漂移。

**决定：**

- Product Skill 由一个 Agent Package 私有拥有，运行时只从当前 Package catalog 解析并精确锁定；
- runtime helper、类型、Schema validator、确定性 parser 和测试工具可以作为普通代码共享；
- 共享 helper 不得包含角色专业步骤、触发路由、Checkpoint 结论或以代码形式隐藏的 Product Skill；
- 一个 Package 的 Product Skill 变更不自动改变另一个 Package 的行为。

**被考虑的备选：**

1. **构建期共享 Skill 源码，运行时由各 Package 独立锁定版本与摘要。** 该方案不会引入运行时全局解析，能减少完全相同源码的复制；当前不采用，因为首批 Skills 需要先证明角色边界和独立演进，过早抽取容易把表面相似的方法固化成跨角色合同。
2. **运行时全局 Skill registry。** 不采用，因为它恢复了全局 resolution 和跨 Package 可见性，扩大错误配置与升级耦合。
3. **Package 私有 Product Skills。** 采用；用共享普通代码降低非专业重复。

**后果：** 首批实现允许少量文本和测试重复，换取清晰所有权、触发边界和回滚单位。构建产物必须验证只有当前 Package catalog 被激活，execution domain 也只能读取当前 Package 被允许的 Skill scripts/assets。

**重新评估触发：** 当两个或更多 Package 出现经过行为测试证明实质相同、连续演进仍保持同一合同的 Product Skill 时，必须重新评估“构建期共享源码、运行时独立锁定”方案。重新评估不得自动恢复运行时全局 registry，并应通过新的 ADR 记录迁移、摘要、发布和回滚影响。

## 8. Professional Controls

### 8.1 所有权

Professional Controls 属于 Agent Package，而不是 Skill。原因是：

- 同名或相似方法在不同角色下可能有不同交付责任；
- Skill 可能被错误触发，但权限和完成底线不能随 Skill prose 改变；
- controls 是受信代码，需要版本锁、测试和 fail-closed 行为；
- workspace Skill、用户文档和 RAG 不能注册控制代码。

共享 runtime 只提供窄接口和生命周期，不提供通用规则 DSL。每个 Agent 的专业判断由其 Package 内代码实现。

概念接口：

```js
evaluateConcerns(context, toolResults)
evaluatePreToolGate(context, proposedToolCall)
observeToolResult(context, toolResult)
checkCompletion(context, resultCandidate, skillUses, toolResults)
```

`observeToolResult` 只更新受信观察状态，不能声称撤销已经发生的工具动作。需要阻断的后置事实由下一次同步 `evaluatePreToolGate` 或 `tiangong_submit_result` Checkpoint 消费。最终接口必须服从 M9-A pinned hook spike，不得把 observation-only hook 包装成 fail-closed Gate。

参与 fail-closed 决定的 Gate/Checkpoint 必须实现为纯、有界、确定性的同步函数；如果需要隔离不受信 parser 或较重计算，只能运行在无共享可变状态的 worker thread/isolate 中，并设置硬 CPU/内存/时间上限。timeout、worker crash、返回畸形或读取越界输入都按稳定错误 fail closed。强制 controls 不得在临界区执行任意网络、文件系统扫描、模型调用或无界 async I/O。

`config.json` 只保存启用项、有界阈值和稳定提示文案，不表达授权公式或任意可执行规则。

首批控制预算：Architect 和 Developer 试点各最多 1 个 Concern、2 个确定性 Gate 和 1 个 Checkpoint；其他角色迁移时遵循同一默认上限。超出上限必须由失败回归、明确威胁或无法合并的机器边界证明必要性。Gate 禁止判断“根因是否充分”“方案是否专业”等语义质量。

### 8.2 Concern

Concern 的目标是在仍有机会调整时提供短提示，不做最终裁决。

规则：

- 只在少数阶段型节点重新计算；
- 必须基于当前 Work、可选 Task、对应 scope 的 SkillUse 和已捕获 ToolResult；
- 同一事实状态下通过持久 marker 去重；
- 提示简短、可执行且不重复完整 Skill；
- 不阻断工具；
- 不作为 Result 成功条件；
- 重启后从直接事实重算，并结合可恢复 marker 避免重复注入，不依赖聊天记忆。

适合的节点包括：

- 第一轮项目探索完成后；
- 第一次产品修改前；
- 形成根因候选后；
- 测试执行前；
- 准备提交 Result 前。

每次实际注入产生一个有界 `ConcernMarker`：

```text
scopeIdentity = task executionAttemptId | work-leader(leaderScopeId)
concernMarkerId = stable(executionScope + scopeIdentity + package/control version + concernId + stateFingerprint)
```

marker 至少保存 `executionScope`、Work、concern identity/version、state fingerprint、injection turn、时间和有界 reason code；Task scope 必须保存 executionAttemptId，Work-scoped Leader 必须保存 `leaderScopeId` 与 `workEpochAtInjection` provenance 且禁止 claim 占位字段。它不复制长 Prompt 或敏感内容，先写入可恢复 control spool；Task marker 按 attempt diagnostic retention ingest，Leader marker 至少保留到 Work retention。Worker 重启后仍可去重，M9-D 只按原 scope 展示 Concern 在哪里影响了执行，不把 Leader marker 归到某个 Task。Marker 是诊断/去重事实，不是 Task 状态、阻断条件或新的 Concern 业务对象。

Concern 在工具结果进入下一次模型上下文前注入。具体使用 `after_tool_call`、`tool_result_persist` 或其他 OpenClaw hook，必须针对镜像固定的 OpenClaw 版本验证调用顺序和失败语义；不能根据最新文档假设 pinned runtime 已具备某个 hook。

### 8.3 Gate

Gate 只处理代码可以稳定确定，并且不立即阻止会造成越界、状态污染或永久失去终检依据的问题。

Gate 可检查：

- 当前 admission scope、Agent、Work、Session 与对应的 Team/ControlProfile/MemberConfig/runtime-binding revisions；
- Task-scoped 路径的 Task、ExecutionAttempt、ExecutionBinding 和 active claim/lease；
- Work-scoped Leader 路径的 current `leaderScopeId` authority identity、typed action `expectedWorkEpoch` 和 coordination-only tool surface；
- Task 已取消、已提交 Result、principal/workload generation stale、execution claim 已失效或 submit freeze 已进入；
- 工具是否属于当前 Package 有效工具表面；
- 请求路径、cwd 和 exact target ref 是否位于授权 workspace binding；
- 当前角色是否拥有 Commit/publish 工具；非 Developer 的本地修改不能进入交付链；
- Developer 首次修改前是否存在要求的前置 SkillUse/baseline ToolResult identity，但不判断根因 prose 是否正确；
- Tester 的计划、版本和环境是否具有确切冻结 ref；
- 最终验证后是否又发生修改，使旧验证 generation 失效；
- ToolResult capture、control state、spool ingest 或 ownership 是否不可用。

Gate 不尝试通过 shell 文本推断任意子进程的全部系统调用，也不把普通 workspace 工具承诺为通用严格只读。真实路径、凭据、网络、进程和 control-state 隔离由 prepared execution boundary 强制；Reviewer/Tester 等角色通过独立可重置 workspace、exact target 和无交付发布权限保护权威交付链。

### 8.4 Checkpoint

`CheckpointInvoker` 只用于 Task-scoped Result submit；Work-scoped Leader action 使用第 8.5 节的 typed-action controls，不伪造 Result Checkpoint。M9-A 先交付稳定的 `CheckpointInvoker` 调用接口和一个合成、确定性 baseline Checkpoint。它只验证 Result Schema、refs 可解析、ToolResults/attempt/principal ownership、active claim、pending/process/spool 状态和 submit freeze，不判断任何角色专业质量。该合成实现仅用于闭合提交协议和确定性测试。

M9-B 保持同一接口，按当前 Task assignee Agent Package 加载专业 Checkpoint。专业 Checkpoint 只检查 Gate 无法替代的最终专业完整性：

- Skill outputs 是否符合合同；
- 必要交付物和 ToolResult 是否存在且属于当前 Task/Agent；
- 关键读取、测试或审核是否覆盖了声明范围；
- 最后修改之后是否有最终验证；
- Result 是否区分事实、推断、限制和 unknown；
- blocked/failed 是否说明原因、尝试、恢复条件和未获得 Evidence；
- 是否存在未结 SkillUse、未结束进程或 capture gap；
- 各角色的专业输出是否达到最低结构和 Evidence 要求。

Gate 已经确定保证的角色、路径、权限和直接前置条件不在专业 Checkpoint 中重复扫描。Checkpoint 对 Gate 结果只检查当前 control version、ControlProfile/MemberConfig/runtime-binding revisions、ExecutionBinding/claim ID/lease epoch 和 capture 完整性。M9-A baseline 通过不得被表述为专业完成；M9-B professional Checkpoint timeout/error 按前述有界执行合同 fail closed。

### 8.5 Leader 控制

Leader 的常规协调走 Work-scoped admission，不提交 Task Result，也不取得 Task claim。它的专业控制和 Skill settlement 绑定到自身 typed coordination action：

- 形成 WorkSpec 前检查实质歧义和 `doneWhen`，并结算对应 requirement-clarification SkillUse；
- 发布 Plan 或创建 Task 前检查来源、当前 WorkSpec、objective、assignee、inputs 和完成条件，并结算对应 decomposition SkillUse；
- `complete-work`/`stop-work` 前形成对 `doneWhen`、直接 Results/ToolResults 和限制的有界综合，结算 result-synthesis 与任何仍打开的 Leader SkillUse。

Worker Leader action Gate 从当前 Package 加载 contract，验证 current `leaderScopeId` 全部 authority revisions、重新读取的 Work、action `expectedWorkEpoch`、typed action allowlist、Skill version/digest、selection 和 output Schema/专业前置；CoordinationStore 不加载 Package contract，只对 accepted action 验证通用 settlement envelope、actor/ownership/refs/idempotency，并写 Work timeline fact 与 ToolResult，不把专业内容提升为 Kernel 判定。被拒绝的动作不会结算 SkillUse。需要 workspace/project retrieval 的 Leader 工作必须委托 ordinary Task；这些规则不新增 Team Checkpoint、CoordinationDecision 或固定流程。

## 9. Tool Observation Runtime 与 ToolResult 2.0

### 9.1 职责与保证范围

ToolResult 是完成检查和产品审计所需的直接工具观察，不承担整段 Task 调试轨迹。M9 保证：

> 每个经 Tiangong 允许、暴露给模型并通过 OpenClaw 顶层工具表面发起的调用，都有一个可闭合的 ToolResult。

范围至少包括：

- `read`、`write`、`edit`、`exec`、`process`；
- 所有 `tiangong_*` coordination 工具；
- Skill、知识检索和 Result 提交工具；
- 后续显式加入工具锁的本地 Tool 或 Adapter。

这不等于仅靠工具 hook 可以知道任意 shell 脚本内部的每一次系统调用。未知命令仍记录 cwd、脱敏命令、exit 和有界 stdout/stderr；无法确认的内部读取、写入或网络效果保持 unknown。需要成为关键完成依据的动作应使用可观察工具、结构化 reporter 或后续受控 Adapter。

### 9.2 最小公共 Envelope

ToolResult 只使用一个扁平、稳定的公共 Envelope；`request` 和 `result` 是按工具类型验证的有界联合结构：

```json
{
  "version": 2,
  "toolResultId": "stable-id",
  "toolCallId": "openclaw-call-id",
  "executionScope": "task",
  "workId": "...",
  "taskId": "...",
  "executionAttemptId": "...",
  "executionClaimId": "...",
  "claimRevisionAtStart": 12,
  "leaseEpochAtStart": 4,
  "workloadGeneration": 12,
  "controlProfileRevision": 5,
  "memberConfigRevision": 7,
  "runtimeCapabilityBindingId": "member-runtime-binding",
  "runtimeCapabilityBindingRevision": 3,
  "workspaceBindingRef": "...",
  "writerRootRef": "...",
  "principalId": "...",
  "actorId": "...",
  "sessionRef": "...",
  "openclawSessionId": "...",
  "turnId": "...",
  "tool": "exec",
  "request": {},
  "outcome": "success",
  "result": {},
  "truncated": null,
  "outputRef": null,
  "startedAt": "...",
  "completedAt": "..."
}
```

`executionScope` 只有 `task | work-leader`。所有 Task-scoped 顶层工具，包括 coordination、Skill、retrieval 和 submit，都必须具有 Work/Task/ExecutionAttempt/session/turn、ControlProfile/MemberConfig revisions、`runtimeCapabilityBindingId/runtimeCapabilityBindingRevision` 以及 `executionClaimId/claimRevisionAtStart/leaseEpochAtStart`；workspace 工具还必须有 ExecutionBinding refs。`executionClaimId + leaseEpochAtStart` 精确区分同一 workload/attempt 内的 revoke/reacquire，`claimRevisionAtStart` 记录工具 admission 时通过的 PostgreSQL claim revision。

Work-scoped Leader coordination ToolResult 必须具有 `leaderScopeId` 及其 Work、authenticated principal/route、Team/ControlProfile/MemberConfig revisions、Agent Package binding revision、workload generation 和 `leaderSessionRef` identity；`openclawSessionId` 仅作 physical correlation，不进入 scope digest。record 同时保存 `workEpochAtStart`、turn 和 toolCall，`executionScope` 为 `work-leader`。Skill selection Adapter 另把同一值保存为 `workEpochAtSelection` provenance；typed action request 必须携带独立的 current `expectedWorkEpoch`：

```json
{
  "version": 2,
  "toolResultId": "stable-id",
  "toolCallId": "openclaw-call-id",
  "executionScope": "work-leader",
  "workId": "...",
  "leaderScopeId": "trusted-scope-id",
  "workEpochAtStart": 3,
  "workloadGeneration": 12,
  "teamRevision": 4,
  "controlProfileRevision": 5,
  "memberConfigRevision": 7,
  "agentPackageBindingRevision": 2,
  "principalId": "...",
  "principalRouteRef": "...",
  "actorId": "...",
  "leaderSessionRef": "leader-work-session",
  "openclawSessionId": "...",
  "turnId": "...",
  "tool": "tiangong_update_work_spec",
  "request": {},
  "outcome": "success",
  "result": {},
  "truncated": null,
  "outputRef": null,
  "startedAt": "...",
  "completedAt": "..."
}
```

它必须省略 Task/attempt/claim/ExecutionBinding/writerRoot 字段，而不是使用伪造占位 ID。Schema 以 `executionScope` 使用两个封闭字段集合，不能接受任意可选混合形态。`leaderScopeId` 必须由其 identity fields 重算一致；`workEpochAtStart/workEpochAtSelection` 不参与该摘要。

公共 Envelope 不保存：

- Adapter 实现 ID 或版本；
- 每条调用重复的 Gate policy 版本；
- 通用 `summary/metrics/keySlices` 容器；
- 为调试准备的模型、Prompt、Package 或 Skill 全量上下文。

这些内容属于 Task Debug View 或实现代码，不应扩大 ToolResult 业务 Schema。Gate 拒绝通过 `outcome: "denied"` 和有界 reason code 表达。

Schema 必须有界、脱敏并使用现有产品事实身份。不得为 ToolResult 再包一层通用 Evidence 对象或 hash-chain ledger。

### 9.3 Pending call ledger

`before_tool_call` 先按 admission scope 建立有界调用身份，再执行 Gate：

```text
Task-scoped:
  principal + ControlProfile/MemberConfig/runtime-binding revisions + workload generation
  + ExecutionBinding + executionClaimId/claimRevisionAtStart/leaseEpochAtStart
  + work + task + executionAttempt + logical/physical session
  + turn + toolCallId + normalized tool identity

Work-scoped Leader:
  leaderScopeId + work + principal/route + Team/ControlProfile/MemberConfig revisions
  + Agent Package binding revision + workload generation + logical/physical Leader session
  + workEpochAtStart + turn + toolCallId + allowed coordination/Leader-Skill identity
  + typed action request 的 current expectedWorkEpoch（如适用）
```

Gate 允许时将其记为 pending 并调用工具；Gate 拒绝时直接以 denied ToolResult 闭合。工具执行后的成功、错误、超时或取消由结果 hook 闭合。同一调用重复投递必须幂等；同一调用产生冲突结果必须 fail closed。Work-scoped identity 不能进入 workspace wrapper，Task-scoped identity 缺 claim fields 时也不能降级为 Leader path。

Task Result Checkpoint 发现以下任一情况时不能提交 `reportedOutcome: "succeeded"` 的 Result：

- pending call 未闭合；
- ToolResult capture store 不可用；
- toolCallId、principal、`executionClaimId/claimRevisionAtStart/leaseEpochAtStart`、ExecutionBinding 或 Task ownership 缺失；
- OpenClaw 上游截断了决定性内容且没有可读完整报告；
- 后台 process 仍未终止；
- 同一 call identity 存在冲突结果。

### 9.4 Generic capture 与工具 Adapter

Generic capture 对所有工具必选，只负责公共 Envelope、ownership、outcome 和有界 fallback。工具 Adapter 只负责：

- 规范化和脱敏 `request`；
- 解析工具专属 `result`；
- 选择确定性的关键内容；
- 必要时产生 storage-owned `outputRef`。

首批 Adapter：read、write/edit、exec、process、coordination、skill-use、project-knowledge retrieval 和 result-submission。

`exec` recognizer 可以识别 Git、test、build、lint、typecheck、search/diagnostic 和 package/toolchain。无法可靠识别时使用 generic exec 结果，不能自动满足“测试通过”或“Commit 已创建”等语义 Checkpoint。Recognizer 和 Adapter 版本进入调试上下文或 Trace，不进入每条 ToolResult。

### 9.5 工具专属结构

`read` 示例：

```json
{
  "tool": "read",
  "request": {
    "path": "src/payment.ts",
    "offset": 100,
    "limit": 80
  },
  "outcome": "success",
  "result": {
    "startLine": 100,
    "endLine": 179,
    "complete": false,
    "content": "bounded source slice"
  },
  "truncated": null
}
```

`exec` 示例：

```json
{
  "tool": "exec",
  "request": {
    "cwd": "project-workspace",
    "command": "npm test"
  },
  "outcome": "error",
  "result": {
    "exitCode": 1,
    "stdoutExcerpt": "bounded test summary",
    "stderrExcerpt": "first decisive failures"
  },
  "outputRef": null,
  "truncated": {
    "stage": "projection",
    "strategy": "test-summary-and-first-failures",
    "omittedLines": 421
  }
}
```

最低工具事实：

| 类型 | `request` | `result` 与截取重点 |
|---|---|---|
| read | 规范化项目路径、offset/limit | 实际范围、完整性和请求范围内的有界原文 |
| search/rg/find | 查询、root、include/exclude | 命中数、代表命中、遗漏数和是否截断 |
| write/edit | 路径、操作类型、有界内容特征 | 成功/失败、修改规模；完整变化由后续 Git 事实证明 |
| test | cwd、规范化命令、目标范围 | exit、pass/fail/skip、失败用例和最终 summary |
| build/typecheck/lint | cwd、目标、配置 | exit、计数、首批唯一错误和最终 summary |
| Git status/diff/commit | repository/worktree、refs/path scope | HEAD、路径状态、stat、hunks 或 exact Commit |
| generic exec | cwd、脱敏命令 | exit、stdout/stderr 的 head、tail 和错误行 |
| process | processRef、动作 | running/exit/terminated 和增量日志 |
| RAG | 项目、查询范围、source filter | generation、source refs 和有界来源切片 |
| coordination | 对象 ID、expected epoch、动作 | revision、状态变化和稳定错误码 |
| submit result | Candidate 有界字段和 cited refs | Checkpoint pass/reject、缺口或正式 Result ref |

### 9.6 截取

`truncated` 为 `null` 或一个小型结构：

```json
{
  "stage": "producer | upstream | projection",
  "strategy": "head-tail-errors",
  "omittedLines": 421
}
```

- `producer`：命令或工具自身只产生部分结果；
- `upstream`：OpenClaw 在 Tiangong 捕获前已经截断；
- `projection`：Tiangong 获得更完整结果，但只保留确定性关键内容。

禁止统一使用无语义的字符串前缀截断。测试优先使用 JUnit XML、TAP、JSON reporter、coverage JSON 或项目结构化报告；普通日志使用工具 Adapter 选择 summary、首批决定性错误和必要尾部。模型总结可以进入 Result prose，但不能冒充 ToolResult。

大型决定性输出不塞进 ToolResult。只有经过 M9-A 前置确认、具有公开写入和 `canRead` 合同的 AgentTeams storage/ContentRef integration 才能生成版本化 `outputRef`。接口不可用时 `outputRef` 保持 `null`，不得退化为任意 workspace 绝对路径；如果决定性完整报告无法有界表达，Checkpoint 必须报告 Evidence 不足，或由 Developer 按项目策略把报告纳入 exact Commit。后端 checksum 只用于存储完整性，不能替代 exact Commit、Adapter reference 或 Result identity。

### 9.7 Ingest、恢复与 retention

```text
trusted Worker control spool
  pending calls + bounded ToolResults
  + AttemptBoundaryRecords + LeaderScopeBoundaryRecords + ConcernMarkers
                 │
                 ├─ periodic bounded batch ingest
                 └─ Result/Leader-action/scope-boundary inline ingest
                              │
                              ▼
                 PostgreSQL bounded execution records
                 attempt / Leader scope / Work / Result retention
                              │
                              ▼
                optional storage-owned outputRef
```

每个工具结果必须先在 control domain 同步、原子地闭合到本地 spool，再返回给模型或进入下一动作。执行域不能读取或修改 spool。固定 OpenClaw 是否能通过 `tool_result_persist` 满足这一顺序由 M9-A spike 决定；不能满足时必须在受信工具 wrapper/service 内闭合，不能退化为 `after_tool_call` best-effort 捕获。

未被 Result 或 accepted Leader action 引用的 ToolResult 也上传 PostgreSQL，以保证 Task failed、Leader/action 被拒绝、Agent 崩溃或忘记结算时仍可调试：

- 所有者是 control domain 中的 `ToolResultIngestor`，不是模型、Skill 或 execution process；
- 默认在 32 条记录或最迟 5 秒时 batch ingest，并在 Result submit、带 Leader SkillUse settlement 的 typed coordination action、ExecutionAttempt 终止、Leader scope replacement/terminal 和受控 Worker shutdown 前强制 flush；部署可降低批量和间隔，不能放宽硬上限；
- Task-scoped ingest 校验原 `executionClaimId/claimRevisionAtStart/leaseEpochAtStart`、ControlProfile/MemberConfig revisions、`runtimeCapabilityBindingId/runtimeCapabilityBindingRevision` 和 attempt。renewal 导致 current claim revision 增大不否定已 admission 的调用，但原 start revision 必须当时有效且 claim ID/lease epoch 相同；revoke/reacquire 不能复用旧 identity；
- Work-scoped Leader ingest 校验原 `leaderScopeId` 可由 Work、principal/route、Team/ControlProfile/MemberConfig revisions、Agent Package binding revision、workload generation 和 `leaderSessionRef` 重算，并验证 physical session、`workEpochAtStart/workEpochAtSelection` provenance 和 coordination-only generic tool surface；不要求也不允许 claim fields。与 typed action 一起提交的 Skill selection/settlement records 在 action transaction 内 inline upsert；
- 任一 Leader authority identity 变化时，受信 control runtime 必须先在 control spool 原子闭合旧 `LeaderScopeBoundaryRecord(replaced|terminal)`，列出最多 64 个 open SkillUses 的 `interrupted` dispositions，强制 ingest 并获得确认，然后才能打开新 scope 或接受新 Leader turn；
- claim 被 replacement/revoke 后，旧 principal 不能发起 ingest；只有受信 recovery controller 可按原 attempt/claim identity 重放已闭合 Task records。Leader scope 失效后同样只有 recovery controller 可保存旧 scope 已闭合 records、创建或重放其 boundary；旧 Leader 不能写 boundary、结算或发起新 action；
- PostgreSQL 对 ToolResult 使用稳定 `toolResultId`，对 boundary 使用稳定 `attemptBoundaryRecordId | leaderScopeBoundaryRecordId`，并以 canonical content digest 幂等 upsert；相同 ID/相同内容是 replay，相同 ID/不同内容是 conflict，隔离相关 attempt/scope 并 fail closed；
- Result submit 再携带所有 cited records。已 ingest 的相同记录只验证并提升 retention，未 ingest 的记录在 Result 事务内 upsert；
- 未引用 Task records 使用短期 attempt retention；被正式 Result 引用的 ToolResult 至少保留到所属 Work retention 结束。Leader SkillUse selection、accepted typed action settlement records、LeaderScopeBoundaryRecords 和 Work-scoped ConcernMarkers 同样至少保留到 Work retention 结束；ControlProfile 只能延长，不能缩短这些引用保留期。删除只能发生在 attempt/Leader scope/Work action 已终止、ingest 已确认、没有 pending、适用 retention 已到期且没有 Result/Leader action 引用之后。旧 Leader scope spool 未确认 boundary 与全部已闭合 records ingest 前不得清理。

Worker 崩溃恢复：

1. control runtime/recovery controller 在接受新 turn 或新 claim 前，先从 CoordinationStore 查询并恢复当前 workload/writerRoot 关联的 incomplete cancel commands，并比较本地 Leader scope identity 与 current authority revisions；
2. 若旧 Leader scope 已失效且没有 terminal boundary，只有 recovery controller 按旧 identity 创建稳定 `leaderScopeBoundaryRecordId`，把其最多 64 个 open SkillUses 标记 `interrupted`；
3. 扫描本地 spool，已闭合但未确认 ingest 的 ToolResult、AttemptBoundaryRecord、LeaderScopeBoundaryRecord 和 ConcernMarker 按原 ID/canonical digest batch replay；
4. pending call 先结合 OpenClaw transcript、tool service receipt 和 processRef 调和；
5. 能确定终态时正常闭合；无法确定是否执行或副作用是否完成时，在恢复截止点闭合为 `outcome: "unknown"`，保留 reason 和可用 refs，不删除或伪装成功；
6. 后台进程无法重新取得可信 ownership 时先终止并确认完整进程树，再闭合为 cancelled/unknown；
7. 推进 cancel command 的 process/records/writer phases；未到 transaction 2 不报告 cancelled，也不解除 PostgreSQL fence；
8. 所有恢复 records 和旧 Leader scope boundary 均确认 ingest、attempt/scope terminal，且相关 cancel phase 已提交或保持 recovery-required 后，才允许清理本地 spool 或接受对应新 Leader turn。

`pending` 是 spool 状态，不是可以无限保留的 ToolResult outcome。正常结果、拒绝、timeout/cancel、attempt 终止或崩溃恢复都会将其闭合；`unknown` 是不可静默覆盖的保守终态。后续迟到 receipt 只能作为同一 attempt 的关联诊断被展示，或通过新的显式工具调用产生新 ToolResult，不能改写已 ingest 的 unknown；任何同 ID 不同内容都进入冲突诊断并 fail closed。

Task assignee controls 可以读取 Task-local 详细 ToolResult；Leader controls 只能读取当前 Work 的 coordination/Leader-Skill records 和完成综合所需的成员 Result/ToolResult 小投影。模型、Web、AgentLoop 和其他 Agent 只获得各自需要的更小投影。凭据、Cookie、Token、私钥、无限正文、无限日志和控制面路径不得进入任何投影。

### 9.8 容量预算与耗尽

M9 按 canonical bounded projection 计量。单条、attempt/scope 和 Worker 是产品硬预算；ControlProfile 可在经过容量测试后降低或在产品上限内调整它们，但不能提高部署 PostgreSQL quota：

| 范围 | 产品硬上限 |
|---|---:|
| 单条 ToolResult | 64 KiB |
| 单 Attempt/Leader scope open SkillUses | 64；第 65 个 selection admission fail closed |
| 单条 Attempt/LeaderScope boundary | 64 KiB，最多 64 个 `interrupted` dispositions |
| 单 ExecutionAttempt 正常 execution records | 4,096 条或 16 MiB，先到者为准 |
| 单 ExecutionAttempt/Leader scope 应急保留区 | 64 条或 256 KiB，仅用于 boundary、pending 闭合、process kill、blocked/failed settlement 和 cancel |
| budget-exhausted terminal settlement calls | 每个 Task 或 Work 最多 3 个不同 requestId；相同 requestId replay 不重复计数 |
| 单 Worker control spool 正常 execution records | 16,384 条或 64 MiB，先到者为准 |
| 单 Worker spool 应急保留区 | 256 条或 1 MiB |
| PostgreSQL 普通 records/bytes | authenticated deployment quota，必须设置全局上限与每 Team hard partition |
| PostgreSQL emergency records/bytes | authenticated deployment reserve，必须设置每 Team floor，普通 ingest 不可消费 |

execution records 包括 ToolResults、AttemptBoundaryRecords、LeaderScopeBoundaryRecords 和 ConcernMarkers；boundary/marker 使用更小的固定 Schema。Task records 计入 attempt/spool/Team PG quota；LeaderScopeBoundaryRecords 计入 Worker spool、Team PG quota 和固定 emergency boundary reserve，但不伪造 ExecutionAttempt 计量。单条结果先执行工具专属确定性投影、截断和可选 `outputRef`；仍超过 64 KiB 时只在应急区闭合最小 error/unknown ToolResult，并把决定性内容缺失写入 reason。不能丢弃调用或把超限正文拆成无限多 ToolResults。

PostgreSQL quota 由 deployment/admin 配置拥有，不属于 ControlProfile。M9 第一版只实现静态 records/bytes global quota、静态 per-Team normal hard partition 和固定 per-Team emergency floor/总 reserve；validator 拒绝分区之和超过物理 quota。Team 不动态借用其他 partition 或 emergency floor，ControlProfile 也不能提高全局/Team 配额。M9 不建设动态权重、借用或公平调度器；quota revision、partition 和当前使用量只进入 operator 诊断。

达到任一 normal budget/quota 时进入 `tool-result-budget-exhausted`：

- 拒绝新模型工具、普通 process poll/log 和新后台进程；
- 继续允许 ToolResult ingest/recovery、现有 process tree 的 kill/terminal confirmation、Task cancel；
- Task path 不允许 succeeded，只允许最终提交一个 `reportedOutcome: "blocked" | "failed"` 的正式 Result；Work-scoped Leader 只允许必要 cancel actions 和一个通过 CloseGuard 的 `stop-work`，并把打开的 Leader SkillUses 结算为 blocked/failed；
- “一个”指一个成功提交的 Task Result 或 Work stop settlement，不是第一次调用尝试。Schema/Checkpoint/action reject 不消耗 settlement，但消耗一个新的 emergency requestId；同一 requestId 的 transport/replay 只返回同一结果。每个 Task 或 Work 最多 3 个不同 emergency settlement requestIds，仍未提交时只保留 operator cancellation/recovery；
- 使用预留应急区闭合已经 pending 的调用、Attempt/LeaderScope boundaries 和上述控制动作；
- 在 budget/retention reconciliation 前不得通过删除未 ingest、pending、被 Result/Leader action 引用或未到期记录解除耗尽。

PostgreSQL 普通 quota 耗尽时，Coordination 拒绝新的普通 execution-record ingest，Worker 进入同一耗尽模式；deployment/Team emergency reserve 继续接受 pending terminal、Attempt/LeaderScope boundary、process kill、cancel 和上述 bounded Task/Work terminal settlement。被 Result 或 accepted Leader action 引用的 ToolResults 至少保留到 Work retention 结束，不能由短期 attempt cleanup 删除。若该 Team emergency floor 也不可用，系统停止新 turn，保持 claim fenced，并只允许不依赖模型的 operator cancellation/recovery 路径；不得伪造 blocked Result。

测试必须覆盖每个层级的边界值、Team 静态 partition 隔离、quota revision、并发争用、reserved capacity、Work-retention promotion、Schema/action reject 后合法重试、相同 requestId replay、每 Task/Work 三个不同失败 requestIds 后终止、清理后恢复，以及 exhausted 状态下“禁新工具、允许 bounded blocked/failed settlement 与 cancel”。

### 9.9 后台进程

`exec` 启动后台进程不等于执行成功。后续 `process` poll、log、kill 和 exit 使用稳定 `processRef` 关联：

```text
exec: process-started
→ process: running
→ process: log-excerpt
→ process: exited(1)
```

Checkpoint 使用最终状态，并在任何进程仍活动时拒绝 Result。取消和预算终止必须停止完整进程树；仅记录 kill 请求不能证明进程已经消失。

### 9.10 ExecutionAttempt 与 correlation

M9-A 复用 M8 已有 Work、Task、Member、Session、turn、tool call、ToolResult 和 trace 字段，只补：

- `executionAttemptId`：一次物理执行代次的稳定随机 ID；
- `attemptNo`：同一 Task binding 内由 control spool 单调维护的诊断代次；
- `sessionRef`：Tiangong 逻辑 Task session；
- `openclawSessionId`：物理 OpenClaw session；
- `turnId` 和 `toolCallId` 的父子关联。

attempt 打开前，control runtime 先把有界 `AttemptBoundaryRecord(opened)` 原子写入可恢复受信 spool，至少包含 Task/attempt、member、workload generation、ExecutionBinding 与 runtime-capability-binding refs、`executionClaimId/claimRevision/leaseEpoch`、逻辑/物理 session 和时间。没有 opened record 不允许模型 turn 或工具执行。terminal/revoked/crashed 边界使用同一 attempt identity 追加记录；若存在未结 SkillUse，boundary 以唯一 `interrupted` disposition 和 reasonCode 保存最多 64 个 `skillUseId`，并在清理前 ingest 到 PostgreSQL attempt-retention projection。AgentLoop trace 只投影其 identity，不是唯一来源。

恢复时先读取 boundary records 与 claim/lease，再决定 replay、revoke、process termination 和新 attemptNo。claim 终止后重新领取总是打开新的 executionAttemptId/attemptNo；旧 attempt 不会被新 claim 重新激活。物理 session 可承载多个逻辑 Task 时，每个 turn 必须绑定唯一 active Task/attempt；无法唯一绑定时不得执行工具或提交 Result。

Work-scoped Leader coordination 不创建 ExecutionAttempt 或伪造 Task boundary；其关联由 `leaderScopeId`、Work、Leader logical/physical session、Work epoch provenance、turn/toolCall 和 Work-scoped ToolResult 直接表达。M9-A diagnostic-marker substrate 另提供有界 `LeaderScopeBoundaryRecord(opened|replaced|terminal)`。opened record 必须在该 scope 首个模型 turn 前持久化到受信 spool；replacement/terminal 还必须在后继 scope turn 前确认 ingest。稳定 `leaderScopeBoundaryRecordId = digest("leader-scope-boundary-v1" + leaderScopeId + boundaryKind)` 与 canonical content digest 绑定 `leaderScopeId` 及 Work、principal/route、Team/ControlProfile/MemberConfig revisions、Agent Package binding revision、workload generation、`leaderSessionRef`、physical session correlation 和时间。每个 scope 至多一个 opened record，`replaced | terminal` 通过 scope-state CAS 互斥且只能成功一个；终止记录保存旧 scope 最多 64 个 open SkillUses 的唯一 `interrupted` disposition。authority identity 任一变化时，旧 boundary 必须在新 turn 前持久化并确认 ingest；失效后只有 recovery controller 可写或重放。该记录至少保留到 Work retention 结束，只用于恢复、去重和调试，不是 Work 状态或 SkillUse ledger。

这些记录不创建新的权威 association table、Task 状态机或第二份 transcript。`attemptNo` 与 boundary records 只用于诊断、幂等 ingest、lease reconciliation 和恢复；Work/Task/Result 仍由 Coordination facts 定义。M9-D 只消费这些关联生成 UI/导出，不反向修改它们。

## 10. 受控 Result 提交

### 10.1 取消自然语言自动提交

M9 删除成员 `agent_end` 根据最后一条 assistant prose 自动构造 Result 的路径。自然语言回复不是正式完成动作。

成员通过显式工具提交：

```json
{
  "reportedOutcome": "succeeded",
  "summary": "...",
  "skillUses": [],
  "deliverableRefs": [],
  "toolResultRefs": [],
  "limitations": [],
  "memoryCandidates": []
}
```

`reportedOutcome`：

- `succeeded`：Agent 声明当前 Task 目标已经完成；
- `blocked`：Agent 声明存在当前 execution attempt 无法消除的外部前置缺口；
- `failed`：Agent 声明已执行但未达到目标，且当前 attempt 不应伪装继续成功。

它始终是 Agent 报告，不是 Kernel 判定的专业成功状态。Task 只投影为已有正式报告；Leader 结合 WorkSpec、直接 Results 和机器事实决定 Work 是否完成。Checkpoint 通过表示 Result 可以成为正式报告，不表示 `reportedOutcome` 必须是 succeeded。

### 10.2 提交顺序

```text
Agent forms Result Candidate
→ tiangong_submit_result(candidate)
→ require Task-scoped admission and bind authenticated assignee principal
  / Task / executionAttempt / workload generation / ExecutionBinding
  / executionClaimId / claimRevision / leaseEpoch
→ enter submit freeze: block new turns, tools, process starts and lease handoff
→ stop or reject on active background process; confirm process tree terminal
→ allow exactly one pending call: the current submit call
→ force ToolResult batch flush
→ validate bounded Result envelope
→ M9-B only: validate SkillUse settlement against current Package contracts
→ load cited ToolResult records and allowed outputRefs
→ invoke bounded Checkpoint in trusted control domain
   M9-A: synthetic schema/refs/pending/ownership baseline
   M9-B: current Package professional Checkpoint
→ recheck no active cancel-command fence / claim lease / principal
  / config revisions / workload generation / Task uniqueness
→ send Candidate + cited bounded ToolResult records over member-bound channel
→ one Coordination transaction:
     validate/upsert cited ToolResults
     establish retention
     create Result
     retire claim/release writer ownership
     close server-side submit ToolResult/receipt
→ after-hook capture may only replay the same terminal ToolResult idempotently
→ keep Task frozen after success; unfreeze after a rejected/failed submission
```

Checkpoint 拒绝时：

- 不调用正式 Result 事务；
- 返回有界缺口和稳定 reason code；
- 在 control spool 闭合并 batch ingest rejected submit ToolResult；
- 解除 submit freeze，Agent 可以继续取得直接事实或改为 truthful blocked/failed Candidate。

Agent 忘记调用提交工具时：

- 不创建 Result；
- attempt 记录未提交或中断；
- Task 保持可恢复；
- `agent_end` 只观察，不把 prose 提升为产品事实。

### 10.3 原子性、身份与竞态

Result 提交与 cancel command 的 transaction 1 在同一 PostgreSQL Task/claim revision 上原子竞争：Result 先提交则 cancel 冲突；cancel fence 先提交则 Result stale-denied，不等待最终 cancellation fact。Work-scoped Leader path 不能调用 submit。提交前还要确认：

- 当前 Task/ExecutionAttempt 持有唯一 active `executionClaimId`，principal、claim revision/lease epoch、ControlProfile/MemberConfig/runtime-binding revisions、workload generation、ExecutionBinding 和 writerRoot 均匹配；
- 除当前 submit call 外没有 pending call、运行中进程或未对账写入；writer ownership 仍由当前 claim fenced；
- cited ToolResults 和 SkillUses 只属于当前 Work/Task/executionAttempt/member、runtime capability binding 和同一 execution claim/lease epoch；旧 attempt 的 interrupted SkillUses/ToolResults 不能跨 claim 引用，canonical digest 无冲突；
- cited outputRefs 当前可解析；
- ToolResult capture/ingest 没有 gap；
- 最终验证 generation 晚于最后一次相关修改。

Coordination control endpoint 必须把认证 principal 绑定到当前 MemberConfig。服务端从 principal 推导 member/actor，不允许共享 team bearer 再信任 body 中可伪造的 `actorId`。凭据只存在 control domain，并由窄客户端使用；execution domain、模型上下文、ToolResult 和调试导出都不能获得它。

submit toolCallId、executionAttemptId 和 requestId 在进入临界区前确定。服务端使用同一 identity 在 Result 事务内关闭 submit ToolResult/receipt，因此进程在响应前崩溃也不会产生“Result 已创建但 submit 调用永远 pending”的空洞。OpenClaw 后置 hook 只允许提交相同 canonical 结果；不同结果是 conflict。

如果事务未提交，Result 和 server-side submit ToolResult 都不存在，Worker 根据确定性响应或恢复查询闭合 error/unknown 并解除 freeze。如果事务已提交但 Worker 未收到响应，使用 requestId 重放返回同一 Result 和 submit ToolResult，不重复创建。

M9-A 必须有专门的 freeze 回归：活动后台进程存在时提交被拒绝；终止路径杀死并确认整个进程树；freeze 期间新 turn/tool/process/lease handoff 被拒绝；合成 baseline Checkpoint/事务失败后可安全解除 freeze；成功后 claim 退休且任何后续 mutation 都被拒绝。Worker replacement、stale principal、第二 writer 和 cancel 同时到达必须各有最近竞态测试。不得只测试没有后台进程的顺利路径。

实现不得通过另建通用 Evidence/Checkpoint ledger 解决协议；正式 Result、cited ToolResults、server-side submit ToolResult/receipt 和现有 command replay facts 足以表达。

### 10.4 Kernel 边界

M9-A baseline Checkpoint 与 M9-B 专业 Checkpoint 都通过同一受信 `CheckpointInvoker` 执行；M9-A baseline 不是专业质量判断。Coordination Kernel 只继续验证：

- authenticated principal、admission scope、current config revisions、workload generation 和 actor binding；
- Task path 的 ExecutionBinding、active executionClaimId/leaseEpoch、Task ownership 和 uniqueness；
- Work-scoped Leader path 的 current `leaderScopeId` authority fields、action `expectedWorkEpoch` 与 coordination-only tool surface；
- settlement 的通用 bounded envelope、status enum、selection identity/version/digest 一致性、refs、一次性结算与 requestId idempotency；
- bounded Schema；
- stable refs；
- ToolResult ownership 和 retention；
- cancellation race。

Kernel 不加载 Agent Package/Skill contract，不执行 Package-specific action allowlist 或 Skill output Schema，也不编码“Developer 必须 TDD”“Reviewer 必须发现多少问题”等专业流程；这些 fail-closed 检查属于 Worker Package controls。Kernel 不依据 `reportedOutcome` 或 accepted Leader settlement 判断专业成功。Leader 仍负责 Work 语义完成；CloseGuard 仍只检查直接机器事实。

## 11. Task 调试与执行轨迹

### 11.1 职责分离

ToolResult 不承担完整调试。M9 组合以下现有或受信有界来源还原一个 Task：

```text
Coordination facts
  Work / Task / Result / timeline / logical sessionRef

M9-A/B recoverable diagnostics
  execution claim / Attempt + LeaderScope boundaries / Concern markers
  physical session / turn / toolCall

OpenClaw session transcript
  user/assistant messages / tool calls / tool results / compaction entries

Tiangong ToolResults
  有界、结构化、可用于 Checkpoint 的直接工具观察

AgentLoop spans（可选）
  turn / model / tool timing、usage、错误和关联 metadata
```

Task Debug View 是这些来源的派生视图或按需导出，不是新的产品权威、第二份 transcript 或通用 Evidence ledger。

### 11.2 当前基础与缺口

固定的 OpenClaw `2026.4.14` 已在每个 Agent 的 control state 中保存 session store 和 JSONL transcript，包含模型会话中的消息、tool calls 和 tool results。M8 已提供 Work、Task、Member、逻辑 Session、turn、Skill、ToolResult 与 AgentLoop 的部分 correlation 基础；M9-A 增加 executionAttempt 和物理 session 映射，并保证未引用 ToolResults 在失败或无 Result 时仍被 ingest。

M9-D 仍需提供：

- 从 `taskId` 和 executionAttempt 精确筛选相关远端 OpenClaw session/turn 边界的 operator 入口；
- 把 Coordination、transcript、PostgreSQL/恢复 spool ToolResults 和可选 spans 按时间组合的统一视图；
- 当前 Task 使用的 workload generation、ExecutionBinding、Agent Package、模型、工具表面、Skill 版本和可选 `projectBindingId/bindingRevision`；
- 明确的脱敏、大小、保留和导出策略。

物理 OpenClaw session 文件不能未经验证就假定与 Task 一对一。M9-D 只能消费 M9-A 已验证的关联字段；多 turn、恢复或共用物理 session 时必须按 Task/attempt 过滤。

OpenClaw 后续版本提供更完整的 trajectory export，但该能力晚于当前固定版本。M9 不为了调试功能捆绑 OpenClaw 升级，而是在现有 session transcript 和 Tiangong 关联基础上实现薄的 Task Debug View。

### 11.3 调试视图

第一版优先提供 operator-only CLI 或受限内部接口，而不是立即建设 Web 调试页面。operator 不直接挂载或猜测远端 Worker 文件路径；M9-D 定义只读 `TranscriptSource` 合同：

```text
readTranscript(operatorPrincipal,
               memberId,
               workloadGeneration,
               openclawSessionId,
               boundedRange)
```

Coordination diagnostics resolver 先从 M9-A attempt boundary 找到 member/workload/session，再通过 AgentTeams 提供的认证诊断传输访问：优先读取 active Worker control endpoint；Worker 已替换或离线时读取 AgentTeams 管理的 retained session-store adapter。两种实现都验证 operator principal、Team/data scope、workload generation 和 session ownership，执行有界 range、脱敏和审计；模型、execution domain 和普通 Web session 不能调用。若没有 active/retained source，导出明确标记 `transcriptUnavailable`，不能回退到宿主路径遍历或伪造完整轨迹。

概念入口：

```text
tiangong debug task <task-id>
```

输出可以是一个临时、脱敏、可清理的目录：

```text
task-debug-<task-id>/
├─ manifest.json
├─ summary.md
└─ timeline.jsonl
```

`manifest.json` 保存：

- Work/Task/ExecutionAttempt/Agent、executionClaimId/revision/leaseEpoch、workload generation 和逻辑、物理 Session identity；
- OpenClaw、ExecutionBinding、Agent Package、模型、工具表面和可选 `projectBindingId/bindingRevision`；
- 使用的 Skill ID/version/content digest；
- `PROJECT.md` revision 和 RAG generation；
- 来源、事件数量、截断和缺失项；
- 导出时间、模式和清理要求。

`timeline.jsonl` 按可用时间和父子关联投影：

- Task admission 和上下文准备；
- 模型可见消息；
- SkillUse；
- 带 `concernMarkerId` 的 Concern 注入；
- tool call 和 ToolResult；
- Gate denied ToolResult；
- model timeout/error/compaction；
- Result submit 尝试和 Checkpoint 缺口；
- 正式 Result，或 failed/crashed/unsubmitted attempt 的 terminal/unknown 状态；
- 未引用但已 ingest 的 ToolResults；
- opened/terminal/revoked AttemptBoundaryRecords、opened/replaced/terminal LeaderScopeBoundaryRecords、claim transitions 和 bounded cancel command phases；
- 可选 AgentLoop span references。

事件保留各自来源 identity。调试导出不能把近似时间排序伪装成一个新的权威全序。

### 11.4 调试级别

默认模式：

- 保存事件顺序、身份、状态和有界 ToolResult；
- 对 Prompt、消息和工具内容使用现有脱敏与大小限制；
- 大输出只给 `outputRef`；
- 不保存凭据、隐藏推理或任意原始环境变量；
- 使用有界 retention。

`isolated-test` 模式可以在合成或公开 fixture 中保留更完整的模型可见 Prompt、assistant 消息、tool arguments/results 和 AgentLoop content spans。它必须显式启用、短期保存、导出前再次脱敏，并在测试后验证清理。不得对私有仓库、客户数据或未审核 retention 的环境启用。

### 11.5 能与不能回答的问题

Task Debug View 应能回答：

- Agent 当时收到哪个 Task、主控、Skill、工具表面和项目上下文版本；
- 模型按什么顺序调用了哪些顶层工具；
- 每个调用返回成功、错误、拒绝、超时还是取消；
- Concern、Gate 和 Checkpoint 在哪里影响了执行；
- 为什么没有生成 Result，或 Result 引用了哪些直接事实；
- 哪些数据因为截断、采样、清理或上游缺失而 unknown。

它不能声称记录：

- 模型 provider 未公开的隐藏 Chain of Thought；
- 任意 shell 子进程的全部 syscall；
- AgentLoop 因采样或故障丢失的 spans；
- OpenClaw 在捕获前已经截断且没有 Artifact 的内容；
- 仅凭日志无法证明的外部效果。

调试视图用于诊断，不参与 Result Checkpoint、CloseGuard、授权或恢复判断。

## 12. ProjectBinding 与核心项目记忆

### 12.1 最小 ProjectBinding

ProjectBinding 是部署拥有、由 Tiangong 消费的受信投影，不是 Work/Task 子对象或新的项目工作流。概念结构：

```json
{
  "schemaVersion": 1,
  "projectBindingId": "stable-project-binding",
  "bindingRevision": 4,
  "teamId": "team",
  "repositoryId": "repository",
  "projectRoot": ".",
  "sourceRevision": "exact-commit",
  "knowledgeRealm": "team-project",
  "sourcePolicyRevision": 2,
  "updatedByPrincipalId": "deployment-admin",
  "updatedAt": "..."
}
```

要求：

- AgentTeams/deployment 提供 project/repository、knowledge realm 和来源策略 projection；ExecutionBinding 另行拥有 workspace/mount/writable roots，ProjectBinding 不复制或授予这些执行能力；
- 只有 authenticated deployment/admin principal 可用 `projectBindingId + expected bindingRevision` CAS 创建或推进 projection；模型、Skill、普通 Leader/Developer coordination tool 和 execution process 均无此接口；
- `updatedByPrincipalId/updatedAt` 记录配置推进主体与时间，但不保存 credential；同一 expected revision 的相同更新幂等，不同更新 conflict；
- `repositoryId + projectRoot + sourceRevision` 能定位当前项目 exact source，不能用 branch name 代替；
- `knowledgeRealm` 和 `sourcePolicyRevision` 在检索前 hard filter；
- binding revision 变化使旧 Task context、memory freshness 和 retrieval generation 显式 stale；
- ProjectBinding 不授予写入、Commit、检索来源扩大或外部效果权限。

缺失、冲突或无法把 `repositoryId + sourceRevision` 与当前 ExecutionBinding workspace 的实际 checkout 对账时，项目记忆与检索在 M9-C fail closed；该失败不扩大或缩小 ExecutionBinding。M9-A/B 不依赖 ProjectBinding，只使用 MemberConfig/ExecutionBinding 的 workspace ownership。

ProjectBinding advance 是显式 deployment configuration CAS，不由 Candidate、Commit、Result 或模型消息自动触发。若 AgentTeams/deployment 尚无公开、authenticated update 接口，M9-C 只能消费部署侧已经推进的只读 projection，并把 candidate 标记为等待 deployment activation；不得声称 Tiangong 自动发布。未来若允许模型请求该配置写入，必须作为 M10 之后另行设计的 Operation，而不能复用普通 coordination tool 偷渡。

### 12.2 `PROJECT.md` 定位

`PROJECT.md` 保存项目特有、稳定、重要且非显然的综合事实，例如：

- 产品目标和核心业务概念；
- 领域实体之间容易混淆的区别；
- 架构边界和长期不变量；
- 核心业务流程；
- 项目特有风险；
- 验证、发布和兼容策略摘要；
- 指向深入文档的链接。

它不保存：

- 目录树或 API 清单；
- 单个文件即可直接观察的配置；
- 一次性 Bug 症状；
- 原始日志和排障日记；
- Task 进度；
- 未经 Evidence 或用户确认的模型推断；
- 通用专业方法。

目标长度为 80–160 行；大型项目超过 220 行必须审计并把细节移入普通文档或知识库。

### 12.3 权威位置

M9 中每个项目最多只有一个 active canonical `PROJECT.md`：从当前 `projectBindingId + bindingRevision + sourceRevision` 精确读取的 Git 项目根目录文件。仅存在于其他 branch、worktree 或 Developer local Commit 中的文件都是 delivery candidate，不是 active Project Memory。

- 项目允许该文件且存在明确 onboarding/maintenance Task 时，可以形成 Candidate；
- 项目禁止新增该文件时，只保留 Result 中的 Candidate 和 limitation，M9 不创建 shared-storage 替代真相；
- AgentTeams shared-storage canonical memory 后移，未来引入前必须另行决定权威切换和导入/导出语义；
- Package 的 `AGENTS.md` 是角色主控，项目 `PROJECT.md` 是项目事实，项目自己的 `AGENTS.md` 继续保存项目操作规则，三者不能互相替代。

### 12.4 上下文加载

`PROJECT.md` 足够小，应在 Task 上下文准备时从当前 ProjectBinding exact revision 直接读取为 bounded project context，而不是要求 Agent 必须先通过检索。它也进入同 revision 的知识索引，以支持来源统一；索引不可用不能阻止读取已经由 ProjectBinding 激活的 canonical 文件。

Developer local Commit 不能自行改变 active memory。authenticated deployment/admin principal 只有在确认 candidate Commit 可读、repository/projectRoot 匹配、来源策略允许且 exact source revision 对账后，才可用 expected binding revision CAS 推进 `sourceRevision/bindingRevision`。旧 binding、未推进 candidate 或 workspace HEAD 漂移都标记 stale，Agent 必须用直接项目读取确认相关事实，不得把它们当成 active Project Memory。

### 12.5 创建

Architect 的 `project-onboarding` Skill：

```text
bind exact project/repository revision
→ read existing project rules and trusted docs
→ inspect architecture, tests, build and release boundaries
→ record ToolResult coverage and unknowns
→ draft Project Memory Candidate
→ Architect Checkpoint
→ submit Candidate in formal Result
→ optional Developer Task verifies exact Candidate and source revision
→ Developer writes PROJECT.md and creates exact local Commit delivery candidate
→ authenticated deployment/admin verifies repository/projectRoot/exact Commit
→ CAS advances projectBindingId expected bindingRevision/sourceRevision
→ activate PROJECT.md from that exact revision
→ build and activate index generation bound to the advanced binding
```

Architect 对 Project Memory 内容、来源和 Checkpoint 负责，但没有产品 repository 的 Commit/publish authority。首次创建或实质修改必须先由明确 Architect Task 形成 Candidate；若项目接受该文件，Leader 可以动态创建 Developer materialization Task，由 Developer 对 exact Candidate、当前 `projectBindingId`/source revision 和目标路径进行机械核对后写入并创建 local Commit delivery candidate。Developer 不得在没有新 Architect 审核的情况下实质改写 Candidate。

Commit 创建不是激活事实。模型、Architect、Developer、Skill 或普通 Leader tool 都不能自行推进 ProjectBinding；只有 authenticated deployment/admin CAS 成功后，Tiangong 才加载新 `PROJECT.md` 和构建对应 generation。没有公开 update 接口时系统停在 delivery candidate/awaiting activation，不运行隐式 reconciler。推进失败时旧 ProjectBinding/旧 memory 继续 active 并明确 stale 风险，candidate 不进入检索。

这不是 Kernel 固定流水线：项目已存在且无需变更时不创建 Developer Task；项目禁止文件时 Candidate 保留在 Result 中并明确非 canonical。缺少代码/受信文档直接事实的业务结论需要用户确认。

### 12.6 维护

其他 Agent 在 Result 中只能提交：

```json
{
  "topic": "verification",
  "claim": "Coordination transaction changes require the PostgreSQL integration suite.",
  "basisRefs": ["tool-result-ref", "repository-ref"],
  "reason": "Long-lived verification contract changed."
}
```

Architect 的 `project-memory-maintenance` Skill 决定候选应当：

- 形成 `PROJECT.md` 更新 Candidate，并在需要时交由 Developer 精确 materialize 为 local Commit delivery candidate，再等待 ProjectBinding 推进；
- 进入深入项目文档；
- 形成经验条目并进入 RAG；
- 成为通用 Skill 更新候选；
- 或保持在原 Result 中而不提升。

维护检查：

- 当前源 revision 和相关路径；
- 与已有记忆的重复或冲突；
- 事实是否长期稳定；
- 是否把推断写成事实；
- 是否应删除已经失效的旧条目；
- 是否泄漏敏感信息；
- 是否仍保持精炼。

## 13. Markdown 文档、经验与 Lexical Retrieval

### 13.1 源与索引分离

“存入 RAG”不是数据所有权模型。原始来源保持权威：

```text
allowlist Git Markdown / committed Markdown experience
                            │
                            ▼
                 parse headings and normalize
                            │
                            ▼
                   PostgreSQL FTS index
                            │
                            ▼
                 provenance-bearing slices
```

索引中的 chunk、term、rank 和 cache metadata 都是可重建派生状态。删除索引后必须能从 ProjectBinding 允许的 exact Git Sources 重建。M9 不解析 PDF/HTML/OCR，不创建 embedding 或 hybrid rank。

### 13.2 默认知识源

允许：

- committed `PROJECT.md`；
- allowlist 内的 Git Markdown 设计文档；
- Markdown ADR、Runbook、API 或业务规范；
- 已提交且被 allowlist 接受的 Markdown 测试、审核和场景报告；
- Architect 接受并由 Developer 提交的 Markdown 项目经验条目。

默认拒绝：

- `.env`、凭据、私钥和 secret 目录；
- Agent runtime/control state；
- 完整聊天正文；
- 原始无限 ToolResult；
- 未审核模型摘要；
- build、vendor、dependency cache 和生成目录；
- 非 Markdown、未提交或无法确定 exact revision 的来源；
- 整个源码仓库的无差别索引；
- 不属于当前 ProjectBinding 或 knowledge realm 的来源。

结构化 Work、Task、Result 和 ToolResult 可以继续按 ID、字段和时间查询，不等于必须向量化。

### 13.3 来源配置

示意：

```json
{
  "schemaVersion": 1,
  "projectBindingId": "project-binding-ref",
  "sources": [
    {
      "kind": "git",
      "include": [
        "PROJECT.md",
        "docs/**/*.md",
        "runbooks/**/*.md"
      ],
      "exclude": [
        "**/.env*",
        "**/node_modules/**",
        "**/dist/**",
        "**/secrets/**"
      ],
      "classification": "project-internal"
    }
  ]
}
```

来源配置绑定 `projectBindingId + bindingRevision + sourcePolicyRevision`，由部署或项目管理员确定。Agent 和 Skill 可以建议来源，但不能扩大 allowlist、classification 或 knowledge realm。M9 没有 corpus egress。

### 13.4 经验条目

经验使用有界 Markdown，至少说明：

```yaml
---
type: project-experience
status: accepted
scope: payment-retry
---
```

正文包含：

- Applies when；
- Observation/problem；
- Evidence-backed approach；
- Verification；
- Does not apply when；
- source refs；
- superseded/review 状态。

经验不是原始 Task 总结。只有说明适用和不适用边界、验证方式和来源的内容，才可被 Architect 形成 Candidate；进入共享检索前仍需 Developer 写入 allowlist Git Markdown 并创建 local Commit delivery candidate，随后由 ProjectBinding 推进到该 exact revision。

通用且跨项目稳定的方法应成为相应 Agent 的 Skill 更新候选，而不是永久隐藏在某个项目检索索引中。

### 13.5 切片

Markdown 使用标题感知切片：

- 保留标题层级；
- 表格和代码块尽量不拆；
- 普通 chunk 目标约 400–800 tokens；
- 相邻 chunk 只保留少量必要重叠；
- 小型经验条目可一文一片；
- 每个 chunk 保存 `projectBindingId`、binding revision、repository、source revision、path、heading、line range、classification、tokenizer identity 和 cache fingerprint。

cache fingerprint 只用于增量索引，不成为 Artifact、Result 或授权身份。非 Markdown 来源在 M9 返回稳定 unsupported-source 错误，不做隐式文本提取。

### 13.6 Tokenizer 合同

M9-C 固定公开、确定性的 `tiangong-fts-unicode-v1` tokenizer；它由 Tiangong indexer 在部署内生成有界 lexemes，PostgreSQL 只保存/查询对应 `tsvector/tsquery`，不依赖未声明的私有分词服务或 PG extension。source 与 query 必须使用同一实现和 digest：

- 仅为索引 token 做 Unicode NFKC 与 case-fold，不改写返回的原始 Markdown 和 line provenance；
- Latin/ASCII 字母数字与常见代码 identifier 按 word/segment 产生 lexeme，不做语言 stemming；
- 连续 Han 字符产生有界 unigram + overlapping bigram，英文标识符与中文相邻时两侧 token 都保留；
- heading、path 和 body 使用固定权重，权重配置计入 tokenizer digest；
- 每 chunk/query 有最大 code points、lexemes 和 Han n-grams，超限返回明确 truncation/coverage，不做无界 token expansion；
- source 与 query 均记录 `tokenizerId + version + digest + languageCoverage`。

必须有英文、简体中文、中英混排、中文加代码 identifier、标点/大小写和不支持语言 fixture。对需要词典分词但 v1 未支持的 script，结果使用 `mode: "lexical-degraded"` 和 `languageCoverage: "partial|unsupported"`，只做该 tokenizer 明确定义的 bounded literal/whitespace token match；不得伪称完整召回、自动调用外部分词服务或静默切换 tokenizer。

Tokenizer identity 是 generation identity 的组成部分。实现、Unicode normalizer、权重或 token limits 改变时必须构建新 generation，不能在原 generation 内混用 lexeme 语义。

### 13.7 检索

M9 目标固定为：

```text
authenticated principal scope
∩ current MemberConfig data scope
∩ ProjectBinding knowledge realm/source policy/exact revision
→ tokenizer-compatible PostgreSQL full-text retrieval
→ deterministic rank and duplicate control
→ bounded provenance-bearing Markdown slices
```

“authenticated principal scope”已包含 current AgentTeams identity/route 与 ControlProfile；“current MemberConfig data scope”特指 current MemberConfig 精确引用的 RuntimeCapabilityBinding 中 bounded `dataScope`，不是尚未定义的自由字段。服务端同时校验 ControlProfile/MemberConfig/binding revisions、member/team ownership、enabled 状态和 current principal route。检索准入在每次查询前计算交集，任一 principal、MemberConfig/binding revision、`projectBindingId`、realm 或 source policy stale/missing 都 fail closed，并将 data scope 与该 binding 的 network/egress scope 联合验证。Work-scoped Leader coordination 不开放 retrieval；需要检索时创建 Task。WorkSpec、Task、Skill、Prompt 或 query 文本不能扩大交集。ProjectBinding 不授予 workspace 读取，ExecutionBinding 也不能扩大 knowledge realm。

PostgreSQL FTS 提供多 Agent 共享 lexical index，索引后端不拥有 Tiangong 权威。每次结果明确 `mode: "lexical" | "lexical-degraded"`、tokenizer identity 和 language coverage；没有 vector fallback、伪 semantic score 或模型生成 rerank。

M9-C 必须建立公开 fixture 的 retrieval baseline，记录 lexical 命中、漏召和查询类型。只有 baseline 证明专业任务存在稳定、重要且无法通过 query rewrite、tokenizer、标题切片或 `PROJECT.md` 解决的召回缺口时，后续 ADR 才能评估 pgvector/local embedding。任何未来 embedding 仍不得自动获得 corpus egress。

### 13.8 增量索引与 generation

- 源 fingerprint 未变化：不重建；
- 文件修改：只替换对应 chunks；
- 文件删除或不再允许：删除对应 index entries；
- ProjectBinding 推进并核对 exact source revision：从新 binding 构建 `PROJECT.md` 和 Markdown slices；Developer Commit 本身不刷新 active index；
- 经验 superseded：旧 entry 从 active retrieval 中失效但来源历史仍可审核；
- generation identity 绑定 `projectBindingId + bindingRevision + sourceRevision + sourcePolicyRevision + tokenizerId/version/digest`；
- 完整 generation 构建成功且其 ProjectBinding 仍为 current 后原子切换 active generation；
- 构建失败时不激活候选 generation：若 ProjectBinding 未变化可继续使用上一完整 generation 并标记 index stale；若 `bindingRevision/sourceRevision/realm/sourcePolicy` 已推进，旧 generation 不再满足 hard filter，检索明确 unavailable，直到新 generation 成功；
- index 可被完全删除和重建。

索引更新不修改 Knowledge Source。

### 13.9 Retrieval ToolResult

`tiangong_search_project_knowledge` 返回：

```json
{
  "queryId": "...",
  "projectBindingId": "project-binding-ref",
  "bindingRevision": 4,
  "mode": "lexical",
  "tokenizer": {
    "id": "tiangong-fts-unicode-v1",
    "version": "1.0.0",
    "digest": "...",
    "languageCoverage": "full"
  },
  "indexGeneration": 12,
  "results": [
    {
      "sourceKind": "git-markdown",
      "sourcePath": "docs/payment/retry.md",
      "sourceRevision": "exact-revision",
      "heading": "Timeout Handling",
      "lineRange": {"start": 40, "end": 68},
      "content": "bounded slice",
      "rank": 0.87,
      "stale": false
    }
  ],
  "truncated": false
}
```

query raw text 和 source slices 遵守 classification 与日志边界。Telemetry 默认记录有界身份、数量、模式、耗时和稳定错误码，不记录受保护查询和全文。

Agent 必须判断检索是否足以支撑结论。RAG 不替代对当前可变 workspace 的授权 `read/search/git`；当代码版本或来源 freshness 不确定时必须直接检查。

## 14. 六个 Agent 的目标能力

下表是 M9 的初始边界，不是固定 Team 流程。Leader 根据 Work 动态创建普通 Task。

| Agent | Agent 私有 Skills（初始） | Concern 重点 | Gate 重点 | Checkpoint 重点 |
|---|---|---|---|---|
| Leader | requirement-clarification、work-decomposition、result-synthesis | WorkSpec 歧义、委托缺口、结论与事实脱节 | coordination actor、Work/epoch、Task/Plan 前置 | 自身候选 WorkSpec、Task、Plan 发布和关单综合的完整性 |
| Architect | project-onboarding、architecture-planning、plan-revision；M9-C 增加 project-memory-maintenance | 探索过浅、记忆过早固化、方案脱离项目事实 | exact ProjectBinding/source refs、无产品 Commit/publish authority | 项目覆盖、架构边界、风险、验证、unknown、source refs 和 memory Candidate |
| Challenger | plan-challenge、alternative-analysis | 猜测过多、只挑问题、缺少更小替代方案 | exact plan/source scope、无交付发布权限 | 事实、影响、置信度、替代方案、强项与不应修改部分 |
| Developer | bug-triage、test-driven-development、regression-verification | 根因不足、修改扩散、验证陈旧 | Task/workspace/path、前置事实 identity、最终验证 generation | 根因、差异、测试、Commit、限制和最后验证 |
| Reviewer | independent-code-review、test-result-review | Scope 不足、只看 diff 表面、缺少需求映射 | exact target Commit、隔离 workspace、无交付发布权限 | 精确目标、需求覆盖、结构化 findings、执行证据、dirty state 和未取得 Evidence |
| Tester | test-case-authoring、test-run-planning、test-execution | 计划/版本/环境未冻结、只测正常路径 | exact target/environment、资源 ownership、cleanup、无产品 Commit 发布 | 场景逐项结果、失败分类、决定性观察、cleanup 和覆盖缺口 |

Leader 的三个初始 Skills 均为 `settlement: coordination-action` 的 Work-scoped 纯方法 Skill，不包含 workspace script；其他五个角色的初始 Skills 默认是 Task-scoped。Skill 最终命名和边界通过 Architect/Developer 试点验证后固定。不得为了表格整齐而强制每个 Agent 拥有相同数量或相同粒度的 Skill。

## 15. 修改方案

### 15.1 Hook 语义、执行隔离与控制身份

修改或纳入验证范围：

- `worker/Dockerfile`
- `worker/bin/openclaw`
- `worker/plugin/index.mjs`
- OpenClaw 配置/bootstrap/preflight 路径
- workspace tool 执行/进程管理路径
- AgentTeams prepared environment 与 workspace binding 的公开接口
- `app/coordination/control-api.mjs`
- `app/coordination/postgres-store.mjs` claim/cancel/Result paths
- `worker/agent/team/coordination-contracts.mjs` 的 MemberConfig/RuntimeCapabilityBinding refs
- member runtime/ExecutionBinding deployment projection 与 validator
- `worker/agent/team/coordination-control-client.mjs`
- container/smoke attack fixtures

目标：

- 先验证 pinned OpenClaw hook/bootstrap 语义，再选择 controller、Gate 和 ToolResult capture 的实际接入点；
- 不构建角色专用镜像；通用 control image 保留身份、凭据、Package、controls、session 和 spool，可选通用 execution image/rootfs 只获得 ExecutionBinding workspace 与当前 Skill 资源；
- `read/write/edit/exec/process` 不能绕过 prepared execution environment；
- MemberConfig 精确引用 deployment-owned RuntimeCapabilityBinding，从其执行子集派生并逐动作核验 ExecutionBinding；
- admission 分为有 Task claim 的 member execution 和无 workspace/claim 的 Work-scoped Leader coordination；后者以包含全部 authority revisions 的 `leaderScopeId` admission，Work epoch 仅作为 action CAS；
- control API 使用 member/workload-bound principal，服务端推导 actor；
- 以 Tiangong CoordinationStore/PostgreSQL 作为 Task/attempt claim/lease、writerRoot lock、Result/cancel race 的唯一权威；
- 增加 workload generation fencing、Worker replacement revoke 和带 requestId/phase 的可恢复 cancellation command；
- 合成 canary token/path、`/proc`、symlink、父目录、后台进程和其他 Package 攻击成为回归；
- 不以 rootless 或环境变量过滤代替安全域证明。

### 15.2 Agent Package 与 Skills 2.0

修改：

- `worker/agent-packages/*/agent.json`
- `worker/agent-packages/*/instructions.md`
- `worker/agent/packages/loader.mjs`
- `worker/agent/skills/catalog.mjs`
- `worker/agent/skills/runtime.mjs`
- `worker/scripts/verify-openclaw-workspace-tools.mjs`
- `scripts/check-skills.mjs`

目标：

- `instructions.md` clean-cut 为 `AGENTS.md`，新增 `SOUL.md`；
- loader 从选中 Package 解析私有 Product Skills 和 controls；
- catalog 支持受限 `contract.json`、Package-local Skill ID 和完整摘要；
- runtime 只投影当前 Package catalog；
- `tiangong_use_skill` 校验 admission scope/input Schema、生成 `skillUseId` 并闭合选择 ToolResult；每个 Task attempt/Leader scope 最多 64 个 open SkillUses；
- Task SkillUse 由当前 attempt 的正式 Result 结算；Work-scoped Leader SkillUse 由当前 Leader scope 后续 accepted typed coordination action/ToolResult 结算；
- attempt/claim 或任一 Leader authority identity 变化时，把 open SkillUses 以唯一 `interrupted` diagnostic disposition 闭合；新 scope 必须重新选择，不做跨 scope carry-forward；
- 删除全局 Skill resolution 和跨 Agent lock，保留可审核的普通共享 helper。

### 15.3 Professional controls

新增：

- `worker/agent/controls/runtime.mjs`
- `worker/agent/controls/context.mjs`
- 各 Package 的 `controls/`

目标：

- 提供 concern、同步 pre-tool gate、tool observation 和 checkpoint 窄接口；
- 接口和 hook priority 服从 pinned spike 结论；
- controls 只从当前受信 Package 加载；Worker Leader action control 负责 Package/Skill version/digest、typed action allowlist、Skill output Schema 与专业前置，Coordination 只验通用 settlement envelope；
- enforcement control 为纯有界同步函数，或在带硬资源/时间限制的 worker thread/isolate 中执行；timeout/crash/malformed fail closed；
- Concern 注入写入有 identity 的可恢复持久 marker；
- 首批遵守 1 Concern / 1–2 Gate / 1 Checkpoint 预算；
- 不在 plugin entrypoint 堆积业务逻辑，不引入 Practice registry、语义 shell parser 或任意规则 DSL。

### 15.4 ToolResult、ExecutionAttempt 与 ingest

修改：

- `worker/agent/gates/tool-result-capture.mjs`
- `worker/agent/gates/tool-result-store.mjs`
- `worker/plugin/index.mjs`
- `worker/agent/packages/tool-groups.mjs`
- Coordination ToolResult batch ingest、Result inline ingest、projection 和 retention 路径
- M8 correlation attribute 与 tracing tests

新增：

- 按 `task | work-leader` 两套封闭身份的 pending call ledger，以及可恢复、可 ingest 的 Task ExecutionAttempt/LeaderScope boundary records；
- Task ToolResult 必填 `executionClaimId/claimRevisionAtStart/leaseEpochAtStart` 和 `runtimeCapabilityBindingId/runtimeCapabilityBindingRevision`；Work-scoped Leader ToolResult 必填可重算的 `leaderScopeId` 全部 identity fields 和 Work epoch provenance，禁止 claim 占位字段；
- terminal scope 对最多 64 个 open SkillUses 记录 `interrupted` diagnostic dispositions；Leader boundary 使用稳定 ID/canonical digest，计入 spool/Team PG/emergency quota，保留到 Work retention；
- Leader authority identity 改变或恢复时，由 current trusted control/recovery controller 在新 Leader turn 前持久化并确认旧 scope boundary ingest；
- logical Task/Work session 到 physical OpenClaw session/turn/toolCall 的关联字段；
- generic normalizer 和首批 read/write/edit/exec/process/coordination/skill/retrieval/result adapters；
- `ToolResultIngestor`、周期/终止/提交 flush、spool startup recovery；
- canonical digest replay/conflict 协议和 unknown terminal outcome；
- deterministic truncation helpers；
- 单条、单 attempt、Worker spool 产品硬预算，以及 deployment-owned PostgreSQL 静态 global quota、静态 per-Team partition 和固定 emergency floor；
- Work retention promotion 和 budget exhaustion 下禁新工具、允许 process kill/cancel/bounded blocked-or-failed settlement 的控制路径；
- 可选且需前置确认的 ContentRef writer。

当前只保存 result shape/length 的 v1 store clean-cut 为 v2。初始化阶段不保留双写、v1 reader 或迁移 shim；测试 fixture 同步更新。

### 15.5 Result V2 与原子提交

修改：

- `worker/agent/team/coordination-contracts.mjs`
- `worker/agent/team/member-coordination-hooks.mjs`
- Coordination submit endpoint/store/command replay；
- Result Web projection；
- CloseGuard 相关直接事实测试。

新增 `tiangong_submit_result`、submit freeze、成员绑定认证、active executionClaimId/revision/leaseEpoch validation、cited ToolResult records inline ingest、server-side submit ToolResult/receipt，以及与 Result transaction 1 原子竞争的 phased cancel command。删除 `agent_end` 自动 Result。Result Schema 增加 `reportedOutcome`、SkillUse outputs、limitations 和 memory candidates，同时保持 deliverable/tool refs 有界。

M9-A 只实现稳定 `CheckpointInvoker` 和合成 baseline Checkpoint（Schema/refs/pending/ownership/claim）；M9-B 再接入 Package 专业 Checkpoint。两者都不成为 Coordination Kernel 的通用质量判断器，也不新增独立 Team workflow state。

### 15.6 ProjectBinding、Project Memory 与 lexical retrieval

新增：

- deployment-owned ProjectBinding projection/validator；
- project-memory loader 和 Architect Candidate；
- Developer exact Candidate materialization 和 local Commit delivery-candidate 检查；
- authenticated deployment/admin principal 对 candidate Commit 的 exact revision expected-revision CAS 与激活；
- public update API 缺失时只消费只读 projection 并报告 awaiting activation；
- Git Markdown source allowlist；
- heading-aware Markdown parser/chunker；
- versioned `tiangong-fts-unicode-v1` tokenizer 与中英混排/unsupported-language fixture；
- PostgreSQL FTS index；
- principal ∩ effective MemberConfig RuntimeCapabilityBinding data scope ∩ ProjectBinding realm 的 lexical retrieval tool；
- 绑定 ProjectBinding/tokenizer identity 的 generation rebuild/activation；
- stale/source access checks。

M9 不新增 Architect repository publisher、shared-storage canonical memory、PDF/HTML/OCR parser、pgvector 或 embedding adapter。AgentTeams 继续拥有 workspace/storage integration；Tiangong 拥有 memory/knowledge Schema、来源准入、检索边界和产品投影。

### 15.7 Task 调试视图

M9-A 已建立 recoverable Attempt/LeaderScope boundaries、diagnostic-marker substrate、correlation 和失败 attempt/scope 的 ToolResult ingest；M9-B 在该 substrate 写入 Concern markers。M9-D 再新增：

- operator-only Task debug exporter；
- 通过 AgentTeams authenticated diagnostics transport 获取 active Worker 或 retained session-store 的远端 `TranscriptSource`；
- Coordination、remote session transcript、ToolResult、Concern marker 和可选 AgentLoop span 的来源 Adapter；
- `manifest.json`、`summary.md` 和 `timeline.jsonl` 的有界导出；
- 默认与 `isolated-test` 两种内容级别；
- 脱敏、大小、retention 和精确 cleanup 测试。

该功能只读取已有来源并生成临时派生材料，不新增第二份 durable transcript、Task 状态或调试事实库。导出路径位于 operator 控制的诊断区域，不能成为 Agent 普通工具的任意读取入口。

### 15.8 删除项

对应阶段完成时 clean-cut 删除：

- 共享 team bearer + body actor 信任路径；
- Agent execution process 可读 control state 的旧运行方式；
- `worker/skills/` 全局 Product Skill 根目录和跨 Agent Skill lock；
- `agent_end` 自动正式 Result；
- 只记录工具名和长度的 ToolResult v1；
- 仅验证 trigger/behavior 文件存在而不验证合同的旧测试假设；
- 被 immutable controller bootstrap 和 controls 完整替代的薄 instructions 路径。

## 16. M9-A/B/C/D 实施顺序与 stop line

M9 保留一个总体设计，但按四个可独立审核的内部阶段实施。每阶段对所替代路径 clean-cut，不保留长期双写或双事实。试点可以存在于开发分支和测试环境，不能把一半角色使用旧架构、一半角色使用新架构作为阶段完成状态。

### 16.1 M9-A：Trusted Execution & Atomic Submission

#### 第一步：串行 pinned OpenClaw spike

这是整个 M9 的第一项工作，必须独立完成和审核，不能与 execution、Package、controls 或 Result 实现并行。Spike 自身按 verification 成本递增分四层，上一层失败不得跳到下一层：

1. **源码/合同检查：** 对固定 OpenClaw `2026.4.14` 的实际 hook registry、runner、模型调用路径和类型做 source inspection，列出 `before_tool_call`、`tool_result_persist`、`before_prompt_build`、bootstrap 与 observation hooks 的调用点、await/block、throw/timeout、priority 和错误传播合同。
2. **容器内 hook runner + fake provider：** 在实际构建镜像中运行真实 hook runner，使用无外部网络的 fake provider 捕获最终 LLM request，并使用合成 tool 验证 block、结果持久化顺序、重放、上游截断、Prompt/bootstrap 位置和损坏行为。
3. **确定性集成：** 运行真实 Tiangong plugin、OpenClaw gateway/session path、合成 MemberConfig/RuntimeCapabilityBinding/ExecutionBinding/claim、Work-scoped Leader session、fake provider、fake coordination endpoint 和 disposable workspace，分别验证 Task 与 Leader turn 到 tool/spool/Result-or-typed-action 的完整确定性合同，不依赖 Matrix 时序或真实模型 prose。
4. **Basic Matrix turn：** 最后使用官方 Channel Plane、固定安全 fixture 和一次真实 member turn，只确认真实 Matrix 路由确实经过前 3 层已验证的 hook/bootstrap 路径；不使用 Basic turn 证明并发、授权、原子性或恢复。

四层共同验证：`before_tool_call` 是否同步阻断，`tool_result_persist` 能否在结果返回模型前可靠闭合，`before_prompt_build` 失败是否 fail open，immutable bootstrap 是否进入最终请求，以及 observation-only hook 不承担 fail-closed control。

Spike 必须产生逐层直接结果和明确接入决定。它只是研究/接入证据，不启用产品合同，也不让 M9-A 除 spike 条目外变绿。若任一基础假设不成立，先修订本设计并重新审核；不得一边保留不确定合同一边实现 workaround。OpenClaw 升级也必须作为单独决定，不由实现人员静默发生。

#### M9-A 实现

Spike 通过后按顺序实现：

1. versioned MemberConfig → RuntimeCapabilityBinding ref、派生 ExecutionBinding、member/workload principal，以及 Task-scoped/Work-scoped Leader 两条 admission；
2. 通用 control image + 可选通用 execution image/rootfs 的攻击性隔离测试；
3. CoordinationStore/PostgreSQL 权威的 Task/attempt claim/lease、writerRoot lock、Worker replacement revoke、reacquire 新 executionAttemptId 和双 writer 互斥；
4. actor-scoped requestId、bounded phases、startup resume 和 Result transaction race 闭合的 cancellation command；
5. 可恢复 AttemptBoundaryRecords、绑定完整 authority identity 的 LeaderScopeBoundaryRecords、logical/physical Task/Work session、turn/toolCall correlation 和供 M9-B 使用的 diagnostic-marker substrate；
6. ToolResult v2 两套 pending identity、claim identity、容量/quota、batch ingest、startup recovery 和首批 Adapter；
7. 稳定 `CheckpointInvoker` 与只验 Schema/refs/pending/ownership/claim 的合成 baseline Checkpoint；
8. `tiangong_submit_result` freeze、inline ingest、server-side submit ToolResult 和 Result/cancel transaction race；
9. 删除 `agent_end` 自动 Result 和共享 bearer actor 信任路径；
10. 以 stale principal、失败、崩溃、重放、budget exhaustion、active background process、Worker replacement 和 cancellation phase recovery 做 clean rerun。

M9-A 不能依赖 storage-owned `outputRef`，除非公开 ContentRef writer/reader 接口已通过前置合同测试。M9-A stop line 的可判定条件见第 20.1 节；未通过不得开始 M9-B 实现。

### 16.2 M9-B：Professional Agent Runtime

先建立受限 Skill/Result contract、immutable controller bootstrap、Package-local catalog 和 controls 窄接口，并在 Task-scoped 路径把 M9-A baseline Checkpoint 替换为同接口的 Package 专业 Checkpoint；Leader Work-scoped 路径接入 typed-action controls，再进行 Architect 与 Developer 试点：

- Architect：陌生项目读取覆盖、unknown 和架构输出；Project Memory Candidate 留到 M9-C；
- Developer：bug triage → TDD → regression 多 SkillUse、修改/验证 generation、Commit 和原子 Result；
- 两个试点各遵守首批 controls 数量预算；
- Leader Work-scoped Skills 只由 accepted typed coordination action/ToolResult 结算，Package-specific validation 留在 Worker controls，禁止 workspace execution 或伪造 Task Result；
- Task/Leader scope replacement 对 open SkillUses 写 `interrupted` boundary dispositions，新 scope 重新选择且不做 carry-forward；
- 行为评测与确定性 Gate/Checkpoint 测试分开报告。

试点稳定后一次性迁移 Leader、Challenger、Reviewer 和 Tester，删除全局 Product Skills、薄 instructions 和旧 catalog/runtime。M9-B 只有六个角色全部 clean-cut 且 controller 最终输入验证通过才完成。

### 16.3 M9-C：Project Memory & Lexical Retrieval

按顺序实现：

1. MemberConfig 精确引用的 RuntimeCapabilityBinding data scope，以及与 ExecutionBinding 分离的最小 ProjectBinding；
2. Git 根目录 `PROJECT.md` candidate loader/freshness；
3. Architect Candidate、Developer local Commit delivery candidate，以及 authenticated deployment/admin expected-revision CAS 推进；update API 缺失时只验证预先推进的只读 projection；
4. 只从 active ProjectBinding revision 激活 `PROJECT.md`；
5. Git Markdown allowlist、heading-aware chunks 和 versioned tokenizer；
6. principal ∩ effective MemberConfig RuntimeCapabilityBinding data scope ∩ ProjectBinding realm 的 PostgreSQL FTS；
7. generation/tokenizer binding 和 lexical retrieval baseline；
8. 中英混排、不支持语言降级、stale、撤销、跨 realm 泄漏和 index rebuild 测试。

M9-C 不包含 shared-storage memory、PDF/HTML/OCR、pgvector 或 embedding。它可以在 M9-A/B 后延期，不反向改变可信执行和专业 Result 合同。

### 16.4 M9-D：Task Debug View

M9-D 复用 M9-A recoverable Attempt/LeaderScope boundaries、correlation、unreferenced ToolResult ingest 与 M9-B Concern markers，通过 AgentTeams authenticated diagnostics transport 读取 active/retained remote OpenClaw transcript，并增加 operator-only exporter、脱敏 manifest/timeline、`isolated-test` 内容模式和 cleanup。它不新增事实库，也不参与 Result、CloseGuard 或授权。

M9-D 可以延期；M9-A 的失败 attempt 记录与 correlation 不能因此延期。

### 16.5 固定基线 clean rerun

各阶段完成自身 focused smoke。M9-B/C/D 汇合后，在一个可重置真实项目完成：

```text
PROJECT.md Candidate → Developer local Commit delivery candidate
→ authenticated deployment/admin ProjectBinding exact-revision advance
→ lexical index
→ planning/challenge
→ bug triage/development
→ review/testing
→ checkpointed Results
→ Task debug export
→ Leader completion
```

这条链路用于证明动态协作，不变成 Kernel 固定流水线。任何 cleanup、隔离、spool ingest 或 exact revision 对账失败保持红色。

## 17. 验证策略

### 17.1 Pinned OpenClaw spike

在任何 M9 实现前按四层执行：

1. 固定版本 source/type/contract inspection；
2. 实际容器内真实 hook runner + fake provider/synthetic tool；
3. 真实 plugin/gateway/session + fake provider/fake coordination/disposable workspace 的确定性集成；
4. 最后一个 Basic Matrix member turn 只确认官方 Channel Plane 经过已验证路径。

前 3 层直接验证 `before_tool_call` 的 await/block/throw/timeout/priority、`tool_result_persist` 相对工具/模型/transcript 的顺序与重放/崩溃、`before_prompt_build` 的失败语义和最终 request、immutable bootstrap 损坏行为，以及 observation-only hook 不承担同步安全结论。第 4 层不用于证明状态机、授权、并发或恢复。

测试必须检查 fake provider 收到的最终模型请求和 synthetic tool 是否真实执行，不能只 mock Tiangong handler。每层失败都停止后续层；Spike 结论经设计复核前，不并行开始实现。

### 17.2 Execution boundary 攻击测试

从模型可调用的 `exec/process` 运行合成攻击：

- 环境变量及 `/proc/self/environ`、`/proc/1/environ`、可枚举 `/proc/*/environ` 中没有 canary Coordination/control token；
- control files、session state、spool 和其他 Package canary 不可读；
- 绝对路径、`..`、symlink/hardlink、rename race、异常 cwd 和文件描述符继承不能逃逸；
- 后台进程、孙进程、poll/log、取消和 Worker 重启后不能残留越界访问；
- 只允许授权 workspace 与当前 Package Skill resources；
- execution process 无控制 endpoint、container socket 或宿主 metadata 能力。

同一 fixture 同时提供“ExecutionBinding 授权路径可用”的正例，避免用完全禁用工具伪装隔离。任何 secret canary 泄漏、路径逃逸或残留进程都使 M9-A 失败；rootless、capability drop 和 sanitized env 只能作为实现细节，不能替代这些观察。

另用确定性并发 fixture 验证 current MemberConfig/RuntimeCapabilityBinding revision、network/resource/data-scope binding 撤销，以及 PostgreSQL claim/lease：原子领取、每 Task 单 owner、每 writerRoot 单 writer、续租、lease expiry、Worker replacement 推进 workload generation、旧 principal/claim epoch/toolCall stale-denied、第二 writer 拒绝，以及 Result/cancel transaction 1 同 revision 竞争。

取消必须逐 phase 观察 authenticated requestId → transaction 1 fence → process-tree quiescence → terminal records closed/ingested → writer released → transaction 2 cancellation fact。同 requestId 在每个 crash 点继续，不重复 cancellation；不同 requestId 冲突；无 active claim 的 queued Task 只能以直接空集事实推进；任一步失败时 UI 未 cancelled、Task 不恢复且 writer root 仍 fenced。

### 17.3 Schema、Package 与 controls

验证：

- Agent Package shape、摘要和只激活当前 catalog；
- `AGENTS.md`、`SOUL.md`、Skill、contract、controls 完整性；
- SemVer、lock、ADR-M9-001 所允许的共享 helper 边界；
- JSON Schema 子集、remote `$ref` 拒绝、bytes/depth/regex/array 上限；
- Skill output 只验证结算字段，不把专业 prose Schema 通过当作质量通过；
- Task SkillUse → Result 与 Leader Work-scoped SkillUse → accepted typed coordination action/ToolResult 两种结算，拒绝 action、重放和关单场景不产生双结算；`cancel-task` transaction 1 不结算、transaction 2 只结算一次；
- 每个 Task attempt/Leader scope 第 65 个 SkillUse selection 被拒绝；63 个 open 时两个并发 selection 经 per-scope lock 只接受一个；claim/attempt 终止把旧 Task open SkillUses 标记唯一 `interrupted` disposition，reacquire 创建新 executionAttemptId 并重新选择；
- principal/route、`teamRevision/controlProfileRevision/memberConfigRevision`、`agentPackageBindingRevision`、workload generation 和 Leader logical session 逐项变化都会终止旧 `leaderScopeId`，旧 open SkillUses 进入 LeaderScopeBoundaryRecord，新 turn 只能使用新 scope；历史 disposition 不阻塞关单且不能跨 scope 引用；
- Work epoch 单独推进不改变 `leaderScopeId`：stale action 不结算，同一 scope 重读 current Work 并重验专业前置后可用原 selection、新 requestId 和 current `expectedWorkEpoch` 结算；
- Worker Package control 拒绝错误 Skill version/digest、typed action kind 和 output Schema；Coordination fixture 在不加载任何 Package contract 时只验证通用 envelope、selection identity 一致性、current leaderScope authority、current expected Work epoch、refs、唯一结算与 requestId replay；
- Work-scoped Leader tool surface 拒绝 workspace/retrieval/submit-result 和带脚本 Skill，首个 Human 消息创建 Work/session 后可在无 Task 情况形成 WorkSpec；
- controls 数量预算和 Package 间隔离；
- enforcement control 是纯有界同步函数，或受硬 timeout/resource 限制的 worker thread/isolate；
- OpenClaw pinned tool lock 与镜像实际工具一致。

每个 Gate 至少覆盖 allowed、denied 和最近的 race/replay/revocation。M9-A 合成 baseline Checkpoint 只覆盖 Schema/refs/pending/ownership/claim、三种 `reportedOutcome` 协议和 reject/unfreeze；M9-B 专业 Checkpoint 再覆盖 final verification stale、专业直接事实缺口和 Package 输出。两者 timeout/crash/malformed 都 fail closed。Concern 测试触发、非阻断、Task/Work-Leader 两种 `concernMarkerId` identity、持久去重和重启恢复。

### 17.4 ToolResult、恢复与原子提交

对每个顶层工具证明 generic capture，对首批 Adapter 验证参数脱敏、success/error/denied/timeout/cancel/unknown、三种截断、process 聚合、structured reporter 和 unknown command fallback。

必须覆盖：

- recoverable opened/terminal/revoked AttemptBoundaryRecords 在 Task 模型/清理前写入并 ingest；Work-scoped Leader 不伪造 attempt/claim；
- Task ToolResult 的 `executionClaimId/claimRevisionAtStart/leaseEpochAtStart` 与 `runtimeCapabilityBindingId/runtimeCapabilityBindingRevision` 必填并区分 revoke/reacquire；Leader ToolResult 必填可重算的 `leaderScopeId` identity fields 与 Work epoch provenance，claim/Task 字段必须缺失；
- closed record 先入 control spool，再返回模型；
- 32 条/5 秒 batch，以及 submit/attempt-terminal/Leader-scope-terminal/shutdown flush；
- 未引用 ToolResult 在 failed/crashed/unsubmitted Task 中仍可从 PostgreSQL 查询；
- 每个 Leader authority revision 变化或 crash recovery 都在新 Leader turn 前持久化并确认旧 LeaderScopeBoundaryRecord ingest；失效 principal 写入被拒绝，只有 recovery controller 可创建/重放旧 scope boundary；
- crash 后 replay closed records、reconcile pending、终止失去 ownership 的进程、写 SkillUse `interrupted` scope boundary 并闭合 unknown；
- ToolResult/boundary 使用稳定 ID；相同 ID/相同 canonical digest 幂等，相同 ID/不同内容 conflict/fail closed；
- cited records 在 Result 事务内 upsert 并提升 retention；LeaderScopeBoundaryRecords 无论是否被 action 引用都保留到 Work retention；
- 未确认旧 scope records/boundary ingest 前不清理 spool 或接受新 Leader turn；
- member-bound principal，伪造 body actor 被拒绝，execution domain 没有 bearer；
- cancel transaction 1 与 Result 的竞态、每个 command phase 崩溃恢复、same/different requestId replay 和 transaction 2 唯一 cancellation fact；
- response 前崩溃后使用 requestId 恢复同一 Result/submit ToolResult；
- 单条、单 attempt/scope、64 个 open SkillUse、spool 产品硬预算和 deployment PostgreSQL static global/per-Team partition quota、并发计量、Leader boundary emergency reserve 与 retention cleanup；
- Result/Leader action 引用 records 至少保留到 Work retention；
- 每种 budget exhausted 都拒绝新普通工具且拒绝 succeeded，同时允许 process kill/cancel、一个 Task blocked/failed Result 或一个 Work `stop-work` settlement；Schema/action reject 可在每 Task/Work 最多三个不同 requestIds 内重试，相同 requestId replay 不重复计数。

Freeze 专项必须覆盖 active background process：仍活动时 submit 拒绝；终止后确认完整进程树；freeze 中新 turn/tool/process/lease handoff 拒绝；合成 baseline 失败后解除 freeze；成功后 claim 退休且 mutation 永久拒绝。

### 17.5 Skill 与专业行为评测

至少对 Architect 和 Developer 运行受控模型样例，并比较：

- 是否选择正确 Skill 并满足受限 settlement contract；
- 是否取得决定性 ToolResult；
- 是否在 Gate 拒绝后安全调整；
- 是否能在 Checkpoint 缺口后补证；
- 是否如实报告 unknown/blocked；
- 是否避免把 retrieval 或模型 prose 当成当前代码事实。

模型评测结果与确定性测试分开报告；首批 Gate 不得通过 shell/文本正则判断专业语义充分性。

### 17.6 ProjectBinding、Memory 与 lexical retrieval

使用公开合成 fixture 验证：

- ExecutionBinding 只管 workspace/writable roots，ProjectBinding 只管 `projectBindingId`/repository/source revision/realm/source policy，互不授权；
- Architect 只能形成 Candidate，Developer 只创建 local Commit delivery candidate；
- candidate Commit 未被 authenticated deployment/admin expected-revision CAS 推进 ProjectBinding 前不激活 `PROJECT.md` 或 index；模型/Skill/Leader/Developer 调用全部拒绝；推进后 exact revision 对账才激活；
- public ProjectBinding update interface 缺失时只消费只读 projection、明确 awaiting activation 且不声称自动发布；
- 项目禁止 `PROJECT.md` 时不创建 shared-storage 替代；
- Markdown include/exclude、secret/private path 和非 Markdown 拒绝；
- heading-aware chunk、exact revision/path/heading/line provenance；
- `tiangong-fts-unicode-v1` tokenizer 的英文、中文、中英混排、代码 identifier、限额和 unsupported-language 显式降级；
- generation 绑定 `projectBindingId`/source policy/tokenizer identity；
- MemberConfig exact RuntimeCapabilityBinding ref、bounded dataScope/networkScopeRef 联合验证，以及 principal ∩ effective MemberConfig data scope ∩ ProjectBinding realm/source-policy 的准入正负、binding revision stale 与 revocation；
- PostgreSQL lexical expected source 和 baseline 漏召记录；
- stale source、generation 原子切换、删除/撤销和 index rebuild；
- project/realm/source-policy 泄漏拒绝；
- 原始 query/source 不进入不允许的 telemetry。

### 17.7 Task 调试视图

验证：

- 一个 Task/ExecutionAttempt 的 admission、turn、SkillUse、tool call、ToolResult、Checkpoint 和 Result 可关联；
- 多 turn、恢复和共用物理 session 时不会串入其他 Task；
- failed/crashed/unsubmitted Task 仍含 boundary records、Concern markers 和已 ingest ToolResults；
- operator CLI 通过 authenticated diagnostics resolver 从 active Worker 或 retained session-store 读取远端 transcript，不暴露给模型/Web/execution domain；
- 历史 attempt 使用 boundary 记录的 exact workload generation；generation 被替换、越权 operator、错误 session ownership 和远端不可用分别拒绝或明确标记；
- 缺失 transcript、ToolResult 或 AgentLoop span 时明确标记 unknown；
- 默认导出不包含凭据、原始环境变量、隐藏推理或无限内容；
- `isolated-test` 内容只在显式允许的合成 fixture 出现；
- 各来源保留 source identity，导出不参与 Result、CloseGuard 或授权；
- 导出目录和临时材料被精确清理。

### 17.8 集成与 smoke

按阶段和成本递增：

1. pinned hook spike 的 source → container fake-provider → deterministic integration → Basic Matrix 四层；
2. M9-A schema/unit/attack/container/focused smoke；
3. M9-B Package/controls/Architect/Developer focused smoke；
4. 六角色 clean-cut Basic；
5. M9-C Project Memory/lexical focused smoke；
6. M9-D debug export focused smoke；
7. fixed-baseline Full smoke 和 clean rerun。

任何 credential leak、cleanup、process-tree、spool ingest 或 source binding 失败保持红色。真实项目、模型内容和私有 Evidence 不进入公开仓库。

## 18. 对 M10 及后续的影响

### 18.1 M10 架构前置解除条件

原计划中的测试环境 Adapter、Operation 预览、精确 Approval、外部执行、对账、回滚和恢复属于 M10，不提前塞入 M9。

**写死的解除条件：M9-A 与 M9-B 的全部验收条件通过，即解除 M10 的架构前置。** 这表示可信 execution boundary、Task/Work-Leader 两条 admission、CoordinationStore 权威 claim/lease 与 cancel recovery、成员绑定认证、ToolResult/Result/Leader-Skill settlement、immutable controller、六 Package/Skills/controls clean-cut 已经成立。M10 可以在此后开始，不等待 M9-C 或 M9-D。

M9-C Project Memory/lexical retrieval 和 M9-D Task Debug View 延期只影响其自身产品排期，不构成 M10 的设计或实现依赖。M10 不得反向依赖 retrieval、`PROJECT.md`、debug exporter、PDF、embedding 或 shared-storage memory。项目管理仍可选择串行排期，但不能把偶然排期写成架构依赖。

### 18.2 Gate 分层

M10 增加独立 Effect Gate：

```text
Professional Gate (M9)
  admission scope / principal / current config revisions
  / Task claim + ExecutionBinding, or Leader leaderScopeId + expected Work epoch
  / role / path / evidence order / professional preconditions

Effect Gate (M10)
  Adapter / immutable Operation / policy / Approval / idempotency / recovery
```

两者可以使用同一 hook 调度基础，但不能合并成一个通用 JSON 规则袋。Professional Checkpoint 通过不授权外部效果。

### 18.3 Operation 输入

M10 可以直接引用：

- checkpointed Result 及其 `reportedOutcome` 声明；
- exact repository/Commit；
- 有范围和截断语义的 ToolResults；
- Reviewer/Tester Results；
- 已通过公开 writer/reader 合同验证的 storage-owned artifacts。

Operation 仍必须拥有自己的 immutable typed request 和忠实预览。它不能把 Result summary、PROJECT.md 或 RAG slice 当成 effect-defining authority。

### 18.4 后续 Embedding

M9 不实现任何 Embedding。M10 或更后续阶段若开放，必须明确：

- source classification；
- 目的地、区域、模型和 retention；
- 数据披露和费用策略；
- Adapter allowlist；
- 预算、审计和失败降级；
- 是否需要 standing policy 或精确 Human Approval。

使用某个 provider 做 LLM inference 不自动授权将项目 corpus 发给其 embedding 接口。

### 18.5 生产感知与修复

后续告警诊断可以检索项目经验和文档，但：

- 历史相似不证明当前根因；
- PROJECT.md 不替代实时系统观察；
- RAG 不创建修复权限；
- 外部成功仍由 Adapter postcondition 和 Operation event 证明。

M9 因此减少 M10 以后对自然语言解析和隐式上下文的依赖，但不削弱外部执行边界。

### 18.6 Canonical 文档同步 checklist

Canonical 同步按相关阶段完成，不允许本文与产品主设计长期矛盾。Skills 私有化、`reportedOutcome`、两条 admission 和执行/claim 权威必须在 M9-A/B 解除 M10 前同步；ProjectBinding 项在 M9-C 实现前同步，本身不构成 M10 前置：

- [ ] **Skills 私有化与结算：** 把“Skills 可跨专业角色复用”更新为 ADR-M9-001；Task SkillUse 由 current-attempt Result 结算，Work-scoped Leader SkillUse 由 current-scope accepted typed action/ToolResult 结算；每 scope 最多 64 个 open SkillUses，replacement 写唯一 `interrupted` boundary disposition；Package-specific validation 留在 Worker，不新增 ledger。
- [ ] **Leader admission：** Human message 先创建 Work/Leader session；`leaderScopeId` 绑定 Work/principal-route/Team-ControlProfile-MemberConfig revisions/Package binding/workload generation/logical session，Work epoch 只作 action CAS；无 Task 时只开放 coordination/Leader Skill tools，禁止 workspace/retrieval/submit-result，不伪造 Task claim。
- [ ] **`reportedOutcome`：** 更新 Result 合同，明确它是 Agent 声明，Task 只表示已有正式报告，Kernel/CloseGuard 不据此判断专业成功。
- [ ] **Runtime capability 与 claim 权威：** MemberConfig 精确引用 deployment-owned RuntimeCapabilityBinding；CoordinationStore/PostgreSQL 唯一拥有 claim/lease、writerRoot lock、Result/cancel race 和 phased cancel command。
- [ ] **ProjectBinding：** 增加 deployment-owned、非工作流的最小 `projectBindingId`/repository/exact source/realm/source-policy 绑定；只有 authenticated deployment/admin expected-revision CAS 可推进，接口缺失时只消费只读 projection。
- [ ] **执行隔离原则：** 把 prepared execution environment、ExecutionBinding、workload generation fencing 和取消 phase recovery 落实为 M9-A 已验证合同，并引用攻击性回归而不是配置声明。

预计至少核对并按需更新 [`product-mvp.zh.md`](product-mvp.zh.md) 与 [`evidence-backed-team-control.md`](evidence-backed-team-control.md)。Canonical 同步必须先于对应代码合同启用，不能与代码事实倒置。

以下原约定保持不变，也应在同步时避免误改：普通 workspace 工具不承诺所有非 Developer 角色通用严格只读；只有 Developer local Commit 能成为交付候选，Architect 只产生 Project Memory Candidate；Commit 仍需由 ProjectBinding exact-revision 推进后才激活项目记忆和索引。

## 19. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Package 私有 Skill 产生实质重复 | 普通 helper 可共享；按 ADR-M9-001 审计，两个以上实质相同 Skill 稳定演进时重评构建期源码共享、运行时独立锁定。 |
| `AGENTS.md` 过长挤占上下文 | 主控只保留职责和总体循环；细节放 Skill/reference；设置有界加载预算。 |
| Concern 造成噪声或重启后重复 | 少数阶段节点、持久 `concernMarkerId + stateFingerprint` 去重、不进入最终通过条件。 |
| Gate 变成脆弱 shell parser | shell 分析只做明显错误和 Evidence 分类；真实安全由 execution boundary 强制。 |
| M9-A baseline 被误当专业 Checkpoint | 同一 invoker 分层：A 只验 Schema/refs/pending/ownership/claim，B 才加载专业 Checkpoint；投影明确区分。 |
| Checkpoint 重复 Gate | 定义 control responsibility table；专业 Checkpoint 信任当前版本 Gate 事实，只检查剩余交付完整性。 |
| terminal settlement 死循环 | 返回稳定缺口码和有界重试；budget exhaustion 下每 Task/Work 最多三个新 requestIds，但只有成功 Task blocked/failed Result 或 Work stop 才消耗 settlement。 |
| Leader 无 Task 却被 claim 合同阻塞 | 独立 Work-scoped admission；只开放 coordination/纯方法 Leader Skills，accepted typed action 结算 SkillUse，workspace 工作必须创建 Task。 |
| Worker/Leader replacement 留下永久 open SkillUse | claim/Leader authority scope terminal boundary 以唯一 `interrupted` 结束最多 64 个旧 open selections；新 attempt/scope 必须重新选择，历史诊断不阻塞关单。 |
| Leader authority revision 改变但旧 scope 继续运行 | `leaderScopeId` 封闭全部 authority fields；新 turn 前由 current control/recovery controller 持久化并确认旧 boundary ingest。 |
| Work epoch 并发推进使旧 selection 永久悬空 | epoch 不进入 scope identity；stale action 不结算，同 scope 重读 current Work、重验专业前置并以新 requestId 携带 current expected epoch 后可重试。 |
| Leader boundary 仅在本地或耗尽时丢失 | 稳定 record ID/canonical digest、强制 ingest、Work retention、spool/Team PG/emergency reserve 计量；未确认前不清理或开启新 turn。 |
| Coordination 重新加载 Package contract | Package-specific version/allowlist/output Schema 留在 Worker control；Kernel 只验通用 settlement envelope 和 selection identity 一致性。 |
| claim 在 runtime service、Task 在 PG 形成 split authority | CoordinationStore/PostgreSQL 唯一拥有 claim/writer lock/Result/cancel；AgentTeams 提供 binding，Worker 仅 claimant/supervisor。 |
| stale Worker/双 writer 继续写 | claim/lease 绑定 workload generation、principal、workspaceBindingRef 和 writerRoot；逐动作重验，replacement 先撤权。 |
| submit freeze 卡死或遗留进程 | freeze 状态可恢复；失败时明确解除；active process tree 专项覆盖拒绝、终止、确认和重放。 |
| cancel 中途失败后 Task 错报 cancelled 或恢复 | requestId + 单向 command phases；transaction 1 fence，transaction 2 才写 cancellation fact；失败保持 fenced 并由 recovery controller 续跑。 |
| ToolResult 无法区分 revoke/reacquire 或 Leader authority replacement | Task records 强制 `executionClaimId/claimRevisionAtStart/leaseEpochAtStart`；Work-scoped records 强制可重算 `leaderScopeId` identity fields 并使用封闭无 claim Schema。 |
| ToolResult 输出或总量过大 | 单条/attempt/spool 产品硬预算、deployment/Team PG quota、应急 reserve、工具专属 excerpts 和可选受信 storage refs。 |
| ToolResult 截断丢失决定性内容 | 标记 upstream truncation；要求结构化 reporter 或完整 Artifact；未知不满足 Checkpoint。 |
| 任意脚本内部效果不可见 | 在工具专属 result 中保持 unknown；关键动作使用可观察工具/Adapter；不伪造 syscall 事实。 |
| 未引用 ToolResult ingest 增长 PostgreSQL | batch 有界、Team static quota isolation、attempt retention、Work-retention promotion 和清理前置条件；ControlProfile 不能提高 deployment quota。 |
| spool 崩溃后 pending 永久悬空 | 启动前 replay/reconcile；无法确定时在恢复截止点闭合 unknown；冲突 fail closed。 |
| Task correlation 变成第二状态机 | 可恢复 boundary records 只承载 attempt/session/turn/claim identity，不新增权威 Task association table。 |
| Task Debug View 变成第二份 transcript | 只按需读取并关联现有来源；导出是临时派生材料，不回写产品事实。 |
| 远端 transcript 读取扩大数据面 | operator-only TranscriptSource、principal/scope/session ownership 验证、active/retained 两种受限来源和明确 unavailable。 |
| 调试导出泄漏项目内容 | operator-only、默认脱敏和有界；完整内容只允许 `isolated-test`，并验证精确清理。 |
| PROJECT.md 变成任务日志或第二发布权威 | Architect Candidate、Developer local Commit 仅为 delivery candidate；只有 authenticated deployment/admin CAS ProjectBinding 后才 active。 |
| ProjectBinding update 偷渡模型驱动写入 | 模型/Skill/Leader/Developer 无 update tool；公开 deployment API 缺失时只消费 projection 并报告 awaiting activation。 |
| Lexical index 变成第二真相 | active ProjectBinding exact Git Markdown 权威、索引可重建、retrieval 带 provenance、直接工具优先。 |
| tokenizer 对中英混排静默漏召 | 固定 tokenizer identity、中英 fixture、generation 绑定和 unsupported-language 明确降级。 |
| MemberConfig data scope 只存在于 prose | MemberConfig 精确引用版本化 RuntimeCapabilityBinding；data/network/resource refs 进入 contract validator 和 stale/revocation fixture。 |
| 索引跨项目泄漏 | principal ∩ effective RuntimeCapabilityBinding data scope ∩ ProjectBinding realm/source policy，使用合成泄漏 fixture。 |
| M9 范围过大 | A/B/C/D stop line；A+B 解除 M10 前置，C/D 可延期且不反向污染。 |
| 与 OpenClaw hook 版本不一致 | M9 第一步串行验证 pinned 2026.4.14；结论不成立先改设计，不与实现并行。 |
| 镜像数量被误当成执行隔离 | 不构建角色镜像；control/execution 可同 rootfs 或两个通用 image，但一律以 Agent 发起的攻击回归验收。 |

## 20. 分阶段验收与 M9-A stop line

### 20.1 M9-A 验收：Trusted Execution & Atomic Submission

以下条件必须全部有直接机器证据，任何一项失败都保持 M9-A 红色并禁止开始 M9-B 实现：

1. pinned OpenClaw spike 已依次通过 source/contract、容器 hook runner + fake provider、包含 Task/Leader 两条 admission 的确定性集成和最后 Basic Matrix turn；每层只证明其合同。
2. 没有角色专用镜像；通用 control image 与可选通用 execution image/rootfs 的任一实际部署形态都通过相同攻击合同。
3. Agent 发起的 `exec/process` 读取普通环境、`/proc/self/environ`、`/proc/1/environ` 和可枚举 `/proc/*/environ`，均得不到合成 Coordination/control token。
4. `exec/process` 不能读取 controls、OpenClaw session state、ToolResult spool、其他 Agent Package 或 control socket/endpoint；父目录、symlink/hardlink、rename race、异常 cwd、文件描述符和后台/孙进程不能逃逸。
5. 同一攻击 fixture 证明 ExecutionBinding 授权 workspace 和当前 Skill resources 可用；不能通过禁用 `exec/process` 伪装通过。
6. MemberConfig 精确引用 deployment-owned RuntimeCapabilityBinding；ExecutionBinding 从其执行子集和 current workload generation 派生，实际 mount/roots/cwd/network/resource profile 在激活、new turn 和每个 workspace tool 边界对账，revision stale/revoke fail closed。
7. authenticated Human message 先创建/定位 Work 与 Leader session；无 Task 的 Work-scoped Leader turn 在 current workload generation 下可调用 coordination tools，但没有 ExecutionBinding/claim，workspace/retrieval/submit-result 全部 denied。Leader Skill settlement 留给 M9-B，不在 M9-A 声称完成。
8. Tiangong CoordinationStore/PostgreSQL 是 claim/lease、Task、writerRoot lock、Result/cancel race 和 cancel command phase 的唯一事务权威；AgentTeams 只提供 workload/binding，Worker 只是 claimant/supervisor。
9. claim/lease 原子绑定 `executionClaimId + task/attempt + config revisions + workload/workspace/writerRoot/principal`；每 Task 一个 active owner、每 writerRoot 一个 writer，claim 终止后的 reacquire 使用新 executionAttemptId、claim ID 和更大 lease epoch。
10. Worker replacement、lease expiry、续租失败和 stale principal 先撤权；旧 generation/claim epoch 的 turn/tool/process/ingest/submit 全部 stale-denied，writerRoot 未安全释放前不能授予第二 writer。
11. cancel 使用 authenticated actor-scoped requestId 和 `fenced → process-quiesced → records-closed → writer-released → cancelled` 单向 phases；每个 crash 点可继续，相同 requestId 幂等、不同 requestId 冲突，queued/unclaimed Task 以直接空集事实推进，最终事务前 UI 不得报告 cancelled 且 fence 不解除。
12. Result 与 cancel transaction 1 在同一 PostgreSQL Task/claim revision 原子竞争，双写者、迟到 Result/cancel 和 Worker replacement 最近竞态有确定性回归。
13. control endpoint 使用 member/workload-bound principal，服务端不信任 body actor；execution domain、模型上下文、ToolResult 和 debug projection 都没有 bearer。
14. 每个 Task execution 在模型/工具前持久化 recoverable opened AttemptBoundaryRecord，并能关联 execution claim、Member、逻辑/物理 session、turn、toolCall 和 ToolResult；claim 终止后新 attempt 不复用旧 boundary。Work-scoped Leader 使用绑定 Work/principal-route/Team-ControlProfile-MemberConfig revisions/Agent Package binding/workload generation/logical session 的独立 `leaderScopeId` 与稳定 LeaderScopeBoundaryRecord，不伪造 Attempt/claim。
15. Task ToolResult 必填 `executionClaimId/claimRevisionAtStart/leaseEpochAtStart` 和 `runtimeCapabilityBindingId/runtimeCapabilityBindingRevision`；Work-scoped Leader ToolResult 必填可重算 `leaderScopeId` 的全部 identity fields 和 Work epoch provenance，并使用封闭无 Task/claim Schema；所有允许的顶层工具在返回模型前闭合有界 record 到 control spool。
16. Task 与 Work-scoped records 都按 32 条/5 秒上限及 submit/typed-action/attempt-or-Leader-scope-terminal/shutdown 触发 ingest；任一 Leader authority identity 变化都在新 turn 前确认旧 boundary ingest，只有 recovery controller 可写失效 scope；LeaderScopeBoundaryRecord 至少保留到 Work retention，未确认前不得清理 spool。
17. 单条、attempt/scope、64 个 open SkillUse、Worker 产品硬预算和 deployment PostgreSQL static global/per-Team partition/fixed-emergency quota 有边界测试；Leader boundary 计入 spool/Team PG/emergency reserve。Result/Leader action 引用 records 和 LeaderScopeBoundaryRecords 至少保留到 Work retention。耗尽时禁新普通工具和 succeeded，仍允许 process kill、boundary、cancel 及一个成功 blocked/failed settlement；Schema/action reject 对每个 Task 或 Work 最多三个不同 requestIds，相同 requestId replay 不重复计数。
18. Worker restart 在接受新 turn 前按 boundary/claim/Leader authority identity replay closed records、补写并确认失效 Leader scope boundary、reconcile pending、恢复 incomplete cancel command、终止失去 ownership 的进程并闭合 unknown；稳定 ID/canonical digest replay 幂等、冲突 fail closed，cleanup 不删除 pending/未确认 boundary/引用/未到期 records。
19. M9-A 已提供稳定 `CheckpointInvoker` 和合成 deterministic baseline，只验证 Schema、refs、pending/process、ToolResult/attempt/principal/claim ownership；它不加载或声称专业 Checkpoint。
20. `tiangong_submit_result` 只允许 Task-scoped 当前 submit call pending；freeze、baseline reject/unfreeze、cited ToolResult/Work retention/Result/server-side receipt 原子事务、响应前崩溃重放和成功后 claim 退休均有回归。
21. `agent_end` 不再把 prose 创建为正式 Result；三个 `reportedOutcome` 都是 Agent 声明，Kernel/CloseGuard 不据此判断专业成功。
22. execution 隔离验收不以非 root、capability drop、环境变量过滤、目录权限或镜像数量声明代替攻击观察。

**M9-A stop line：** 第 1–22 条全部通过并提交直接机器事实供审核，才允许进入 M9-B。M9-A 失败时不得用 Prompt、Skill、Gate 或人工流程缓解安全边界。

### 20.2 M9-B 验收：Professional Agent Runtime

1. 通用 control image 可运行六个 Agent Package；模型与 execution domain 只看到当前 controller/soul/catalog/Skill resources，不新增角色镜像。
2. `AGENTS.md`/`SOUL.md` 通过 spike 选定的 immutable bootstrap/system 路径进入实际最终 LLM input；缺失、损坏或摘要错误时模型调用未发生。
3. 全局 Product Skill 根目录和跨 Agent lock 已删除，ADR-M9-001 的 Package 私有和共享 helper 边界有静态/运行时测试。
4. contract validator 限制 JSON Schema 子集和资源；output 只约束结算字段，不把 prose 形状当作专业质量。
5. 每个 Task attempt/Leader scope 最多 64 个 open SkillUses。Task Result 只结算 current attempt/claim SkillUses；claim 或任一 Leader authority identity 变化时，open SkillUses 由 Attempt/LeaderScope boundary 标记唯一 `interrupted` disposition，新 scope 重新选择。Work epoch 单独推进不结束 scope：同一 scope 重读 current Work 后可用原 selection、新 requestId 和 current expected epoch 结算。历史 dispositions 可调试但不阻塞关单、不能跨 scope 引用，且无独立 ledger。
6. M9-B 已在 Task-scoped 路径用同一 `CheckpointInvoker` 接入 assignee Package 专业 Checkpoint；Leader Worker control 验证 Package-specific version/digest、action allowlist、output Schema 和专业前置。Coordination 在不加载 Package contract 的情况下只验通用 settlement envelope、identity/actor/refs/唯一结算/idempotency；enforcement controls timeout/crash fail closed。
7. Architect、Developer 试点遵守 controls 数量预算并通过确定性与行为评测；Gate 不判断专业语义充分性；Concern 使用 Task/Work-Leader scope-aware 持久 marker 跨重启去重。
8. Leader、Challenger、Reviewer、Tester 已 clean-cut 迁移；Leader coordination path 无 workspace/Task claim，Leader Skills 无 execution scripts 且由 typed action 结算，没有长期混合 Package/Skill/control 架构。
9. `reportedOutcome`、直接 ToolResults、Result 和 CloseGuard 投影保持声明/观察/Kernel 事实分层，六角色 fixed-baseline Basic 和 clean rerun 通过。

**M10 解除点：** M9-A 第 1–22 条和 M9-B 第 1–9 条全部通过，即解除 M10 架构前置；M9-C/D 不在该判定中。

### 20.3 M9-C 验收：Project Memory & Lexical Retrieval

1. MemberConfig 精确引用 versioned RuntimeCapabilityBinding；其 bounded data/network/resource scopes 有 contract validator、stale/revision/revocation 测试。
2. ExecutionBinding 只管理 workspace/writable roots；最小 ProjectBinding 只管理 `projectBindingId`、repository/exact source revision、Team/realm/source policy，二者互不授予权限。
3. retrieval 准入严格等于 authenticated principal scope ∩ effective RuntimeCapabilityBinding data scope ∩ ProjectBinding realm/source policy，并联合检查 network/egress scope。
4. Architect 只能提交 Project Memory Candidate；Developer 只能 materialize 为 local Commit delivery candidate。
5. candidate Commit 未由 authenticated deployment/admin principal 使用 expected binding revision CAS 推进前，不激活 `PROJECT.md` 或索引；模型/Skill/Leader/Developer 均不能调用更新。
6. public ProjectBinding update interface 缺失时只消费部署侧只读 projection，并明确 awaiting activation，不声称 Tiangong 自动发布。
7. 项目禁止 `PROJECT.md` 时不产生 shared-storage 替代真相。
8. 只有 allowlist Git Markdown 进入 heading-aware PostgreSQL FTS；非 Markdown 明确拒绝。
9. `tiangong-fts-unicode-v1` tokenizer 通过英文、中文、中英混排、代码 identifier 和 unsupported-language 明确降级 fixture。
10. retrieval 返回 lexical/degraded mode、tokenizer identity、language coverage、exact revision/path/heading/line 和 generation；generation 的 stale、撤销、跨 realm 泄漏、原子切换、删除后重建和 baseline 通过。
11. 没有 PDF/HTML/OCR、pgvector、Embedding 或 hybrid 隐式路径。

### 20.4 M9-D 验收：Task Debug View

1. operator 能按 Task/ExecutionAttempt 或 Work/Leader scope 导出 Coordination、recoverable Attempt/LeaderScope boundaries、Concern markers、ToolResults、远端 OpenClaw transcript 和可选 AgentLoop spans。
2. remote transcript 只通过 authenticated diagnostics resolver 从 active Worker 或 retained session-store 获取；只接受 boundary 记录的 exact workload generation，越权/generation substitution/session mismatch 被拒绝，来源不可用明确标记。
3. failed、crashed、unsubmitted attempt 仍显示未引用但已 ingest 的 ToolResults、unknown/gap 和 interrupted SkillUses；历史 LeaderScope dispositions 保留原 scope，不串入当前 Task/Leader settlement。
4. 多 Task、多 turn、恢复和共用物理 session 不串线；各来源保留 identity 和不确定性。
5. 默认与 `isolated-test` 内容边界、retention 和精确 cleanup 通过，Debug View 不参与 Result、CloseGuard、授权或恢复事实写入。

### 20.5 M9 总体验收

M9-A/B/C/D 各自验收通过、canonical checklist 已完成、固定基线 Full smoke/clean rerun 通过，且没有 Operation/Approval 占位数据、私有依赖、凭据或私有运行材料时，M9 总体完成。C/D 延期可以让 M10 在 A+B 后开始，但不能把未完成项报告为已完成。

## 21. 合同审核清单

审核者应挑战以下合同是否可由直接机器事实判定：

1. pinned hook/bootstrap spike 是否严格按 source/contract → container fake-provider → deterministic integration → Basic Matrix 四层递增，并分别覆盖 Task/Leader admission；
2. 是否没有角色专用镜像，control/execution 使用一个或两个通用 image/rootfs 时都服从相同攻击合同；
3. execution boundary 是否从 Agent 可调用 `exec/process` 攻击 `/proc`、token、controls/session/spool、其他 Package、symlink/traversal 和后台进程，并同时证明授权路径可用；
4. Human message 是否先创建/定位 Work 与 Leader session，使 Leader 无 Task 时能协调但不能 workspace/retrieval/submit-result；
5. Task-scoped 与 Work-scoped Leader pending/ToolResult Schema 是否封闭分离，不能以可选字段或占位 ID 相互降级；
6. Leader SkillUse 是否由 accepted typed coordination action/ToolResult 结算；`leaderScopeId` 是否封闭全部 authority revisions，任一变化是否在新 turn 前确认旧 boundary ingest，并把最多 64 个 open SkillUses 标记唯一 `interrupted` disposition；Work epoch 单独推进时是否可重读后用 current expected epoch 结算；
7. MemberConfig 是否精确引用 versioned RuntimeCapabilityBinding，其 data/network/resource scope 是否有 validator 与 stale/revocation 合同；
8. ExecutionBinding 是否只物化执行能力，ProjectBinding 是否只控制 source revision/realm/source policy；
9. CoordinationStore/PostgreSQL 是否是 claim/lease、writerRoot lock、Result/cancel 和 command phase 的唯一事务权威，Worker 是否仅为 claimant/supervisor；
10. claim 是否具有 stable `executionClaimId`、monotonic revision/lease epoch，并防止双 owner、双 writer 和 revoke/reacquire 混淆；
11. Worker replacement、lease expiry 和 stale principal 是否先撤权并逐动作拒绝旧 generation/claim epoch；
12. cancel requestId/phase 是否能从每个 crash 点继续，最终事务前是否保持 fence 且不报告 cancelled；
13. Result 是否与 cancel transaction 1 在同一 PostgreSQL claim revision 原子竞争；
14. control principal 是否绑定 Member/workload，服务端是否仍可被 body actor 冒充，凭据是否真正不进入 execution domain；
15. `AGENTS.md` 是否进入实际最终 LLM input，损坏时模型调用是否确实未发生；
16. ADR-M9-001 是否如实记录构建期共享源码、运行时独立锁定备选；
17. Package-specific version/action allowlist/output Schema 是否只在 Worker control 执行，Coordination 是否不加载 Package contract 且只验证通用 settlement/identity/idempotency；两类 SkillUse 是否避免第三份 ledger；
18. enforcement controls 是否为纯有界同步函数或受限 worker/isolate，timeout/crash 是否 fail closed；
19. M9-A baseline Checkpoint 是否只验 Schema/refs/pending/ownership/claim，M9-B 专业 Checkpoint 是否通过同一 invoker 清晰替换；
20. Task AttemptBoundaryRecords 是否在模型/工具前可恢复持久化；LeaderScopeBoundaryRecord 是否使用稳定 ID/digest、只由 current control 或 recovery controller 写入、计入 spool/Team PG/emergency quota，并保留到 Work retention，且 Leader Work path 不伪造 attempt；
21. Concern 是否使用持久 marker 跨重启去重，并保持非阻断、非业务对象；
22. Task ToolResult 是否必填 claim identity 和 runtimeCapabilityBinding identity，Work Leader ToolResult 是否必填可重算的 leaderScope identity 且禁止 claim；未引用 records 与 scope boundaries 是否按明确 owner/frequency ingest；
23. 单条/attempt/spool 产品预算与 deployment static global/per-Team PG quota/fixed emergency reserve 是否可判定，ControlProfile 是否不能提高全局 quota；
24. Result/Leader action 引用 records 是否至少保留到 Work retention，budget exhausted 的一次 settlement/三次 requestId 语义是否明确；
25. spool 与 incomplete cancel command 的 startup recovery、pending → unknown、幂等 replay、conflict 和 cleanup 是否闭合；
26. submit freeze 是否覆盖后台进程、lease handoff、失败解冻和成功 claim 退休；
27. Result、cited ToolResults、retention、server-side receipt 与 command replay 是否没有事务空洞；
28. ToolResult Envelope 是否保持最小，ContentRef 不可用时是否避免 workspace path fallback；
29. Developer Commit 是否只为 candidate，ProjectBinding 是否只由 authenticated deployment/admin CAS 推进，update API 缺失时是否明确 awaiting activation；
30. retrieval 是否取 principal ∩ effective RuntimeCapabilityBinding data scope ∩ ProjectBinding realm，并绑定 tokenizer/generation；
31. Task Debug View 是否通过受限远端 TranscriptSource 读取 active/retained session，保留 source identity 且不回写权威事实；
32. M9-A+B 解除 M10 前置是否可判定，canonical checklist 和各阶段 clean-cut 是否没有隐性 C/D 依赖或长期双写。

## 22. 公开参考

- [Agent Skills specification](https://agentskills.io/specification)
- [OpenClaw Agent workspace](https://docs.openclaw.ai/concepts/agent-workspace)
- [OpenClaw system prompt](https://docs.openclaw.ai/concepts/system-prompt)
- [OpenClaw Skills](https://docs.openclaw.ai/tools/skills)
- [OpenClaw plugin hooks](https://docs.openclaw.ai/plugins/hooks)
- [OpenClaw v2026.4.14 session transcript paths](https://github.com/openclaw/openclaw/blob/v2026.4.14/src/config/sessions/paths.ts)
- [OpenClaw trajectory export integration](https://github.com/openclaw/openclaw/pull/72936)
- [OpenClaw memory overview](https://docs.openclaw.ai/concepts/memory)
- [OpenClaw memory search](https://docs.openclaw.ai/concepts/memory-search)
- [`product-mvp.zh.md`](product-mvp.zh.md)
- [`evidence-backed-team-control.md`](evidence-backed-team-control.md)
- [`../rules/implementation.md`](../rules/implementation.md)
- [`../rules/security-and-evidence.md`](../rules/security-and-evidence.md)
- [`../rules/verification.md`](../rules/verification.md)
- [`../rules/worker-runtime.md`](../rules/worker-runtime.md)

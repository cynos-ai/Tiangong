# Tiangong 第一版产品纵切

> 状态：产品 MVP 目标；尚未实现。
>
> 本文只定义公开、通用的第一版产品边界。它不包含比赛排期、私有项目、生产凭据或未公开运行材料。底层事实与安全合同以 [`evidence-backed-team-control.zh.md`](evidence-backed-team-control.zh.md) 为准。

## 1. 目标

第一版交付一条可运行的软件变更纵切：Human 在 Tiangong Web 的 Matrix Room 中提出目标，长期存在的专业 Agent 团队形成 WorkSpec 和共享 Plan，动态创建 Task，在受限本地工作区完成代码修改、测试、独立 review 和场景验证，最后以 Result、ToolResult 和可读取的交付物完成 Work。

第一版证明的是：

- AgentTeams 官方 Provider/Worker 配置与 OpenClaw built-in 可以承载真实专业协作；
- Tiangong 可以把对话、共享计划、委托、Agent 报告和机器观察分开呈现；
- 真实代码修改可以在没有 Push、部署或生产凭据的情况下完成和验证；
- 失败、等待和能力不足会被如实显示，不会被包装成成功。

第一版不证明生产部署、线上故障自动修复、长期记忆、完整预算治理或完整可观测平台已经完成。

## 2. 产品入口

### 2.1 对话优先

Web 使用单工作台，而不是先建设传统项目管理 Dashboard：

```text
左侧：Team / Room
中间：完整的 Matrix Room 对话
右侧：Work 历史 / 当前查看的 Work / Plan / Agent / Task / 事实 / 交付物
```

Matrix 是 Room、聊天和消息历史的唯一来源。Tiangong API 不在 PostgreSQL 复制第二份完整聊天记录，只保存消息引用、Work 关联和自己的产品事实。Agent 回复仍由 OpenClaw 通过 Matrix 发送，因此 Element 与 Tiangong Web 看到同一份 Room 对话。

### 2.2 Room 对话与 Work 路由

Room 是长期团队空间，Work 是其中一件具体事情，但 Work 不是聊天室分区。Human 无论使用 Tiangong Web 还是 Element，都只发送普通 Matrix 消息。

- Room 级 Leader 入口收到 Human 消息和开放 Work 的有界摘要；消息在完成归单前只进入不保存正文的持久待归单队列；
- Leader 判断这条消息是在继续某个开放 Work，还是应该创建新 Work；代码验证目标 Work 仍开放并属于同一 Team/Room；
- 关联已有 Work 时，只向该 Work 时间线追加 Matrix event 引用；新建时原子地创建 `workSpec: null` 的 Work 并绑定第一条 event 引用，之后再由 Leader 形成 WorkSpec；
- 关联有歧义时默认新建 Work，Leader 可以在继续行动前通过普通对话向 Human 确认；
- 完成关联后，Leader 恢复对应的独立 Work Session，或为新 Work 创建 Session；
- 右侧选择某个 Work 只改变事实查看范围，不影响 Human 下一条消息的路由。

Work 路由不修改 Human 消息正文，不给 Human event 增加 `workId` 或 Tiangong 自定义字段，也不要求使用 Matrix thread/reply。`roomId + eventId → workId` 是 Tiangong 内部的幂等引用关系，不是第二份聊天记录。

Leader 模型不可用时，消息仍显示在 Room 中，Web 同时显示待归单数量、最老等待时间和有界错误；恢复后按 Room 内稳定顺序重试。消息如果归错，Human 用普通消息纠正，Leader 通过受限命令原子更新当前关联，并在来源和目标 Work 留下 `message-association-corrected`。旧时间线不删除，Task、Result、ToolResult 和 Operation 不迁移；若来源 Work 已终止，则以纠正消息新建 Work，只引用旧事实。

### 2.3 Work 标题

每个 Work 有一个有界、非唯一的 `title`，用于列表、搜索和页面标题。Leader 可以自动生成或完善标题，Human 可以重命名，其他成员只读。

标题不是 Work ID、Session ID、授权输入、幂等键或遥测关联值，也不发送到可观测后端。

## 3. WorkSpec 与共享 Plan

### 3.1 WorkSpec

需求足够清楚时，Leader 直接形成 WorkSpec；只有目标、范围、约束或 `doneWhen` 存在实质歧义时，才通过普通 Matrix 对话向 Human 澄清。第一版不要求每个 WorkSpec 都经过人工确认卡片。

WorkSpec 回答“要达到什么结果”。Plan 回答“团队当前准备怎么做”。新 Work 的 `workSpec: null` 是合法中间态，Web 必须显示“需求待形成”；此时不能创建 Task 或执行 `complete-work`，但可以 `stop-work`。

### 3.2 Plan 的最小合同

软件开发、交付和其他多 Agent Work 维护一份当前 Plan。普通问答、简单研究或单次只读查询不强制生成 Plan。

Plan 本体是一份 Markdown ContentRef。Markdown 可以由 Skill 给出推荐结构，但 Kernel 不定义 Plan JSON schema、PlanStep、状态机或完成百分比。

```text
Work
├─ workSpec
└─ currentPlanRef → 不可变 Markdown
```

Plan 是共享指南，不是 Task 清单、授权来源或完成证明。Plan 中可以提到 Task，但执行状态永远来自 Task、Result、ToolResult 和 Operation。

### 3.3 Plan 作者与发布

- Architect 是 Plan 的主要作者和修订者；
- Challenger 只挑战 Plan，不承担代码 Review；
- Developer、Reviewer、Tester 等成员可以提出修改建议，但不能修改当前 Plan；
- Leader 可以做小型协调修改，也可以要求 Architect 修订；
- 只有 Leader 可以把一个候选 Markdown ContentRef 发布为 `currentPlanRef`；
- 改变 Human 目标、范围、约束或 `doneWhen` 时，必须先更新 WorkSpec，不能藏在 Plan 中。

初始 Plan 和实质性技术变化默认由 Challenger 重新挑战。候选 Plan 在挑战完成前只是普通交付物，不替换 `currentPlanRef`。Leader 判断“实质性”变化，Skill 提供方法指导，Kernel 不增加固定挑战阶段或 Plan Approval。

### 3.4 Plan 变化与 Task 上下文

已经发布的 Markdown 不原地修改。每次修订产生新的 ContentRef，Leader 发布后追加 `work-plan-changed`。历史来自 Work 时间线，不需要 Plan 表和版本状态机。

规划、研究和挑战 Task 可以在当前 Plan 产生前创建。创建执行 Task 时，Leader：

1. 组织与本 Task 有关的 Work 背景；
2. 选取当前 Plan 中相关的部分；
3. 写清 objective 和必要 constraints；
4. 把完整 Plan ContentRef 作为 input；
5. 不默认把整份 Markdown 塞入模型上下文。

同一 Work 的 Agent 可以按需读取完整当前 Plan，但它只是背景信息。Plan 更新不会悄悄改写已下发 Task；Leader 必须决定旧 Task 是否继续、取消或由新 Task 取代。

### 3.5 Work 完成与 CloseGuard

Result 是 Agent 的最终报告，不需要 Leader 再对每个 Task 生成 accept/block 决策。有 Result 的 Task 显示为 `reported`；无 Result 的 Task 必须由 Leader 安全取消并留下 `task-cancelled` 事实。

Leader 通过 `complete-work` 判断当前 WorkSpec 的 `doneWhen` 已满足，通过 `stop-work` 表示 Work 不再继续。`complete-work` 本身就是 Leader 的语义确认，不增加逐 Task 的“Leader 确认”对象。

在两个命令提交前，CloseGuard 直接检查机器事实：

- 当前操作者是 Leader，Work 仍开放；
- `complete-work` 有非空 WorkSpec；
- 每个 Task 都有 Result 或取消事实；
- 没有活跃 turn、进程树或写锁；
- 所有引用的交付物仍可读取。

第一版本地交付没有外部写 Operation/Approval，因此当前 CloseGuard 不维护或检查不存在的对象。后续开放 Adapter 和外部写时，Operation、精确 Approval、未知状态与恢复检查必须和真实数据模型及执行器同批引入。当前关单不能继续依赖 `accepted/blocked/cancelled` 和 CoordinationDecision。

## 4. Agent 模型

### 4.1 长期专业成员

第一版使用长期存在的专业 Worker，而不是为每个 Task 临时创建 Agent：

- Leader：理解目标、形成 WorkSpec、发布 Plan、动态委托、综合结果和完成 Work；
- Architect：在独立工作区理解项目、执行分析命令并生成或修订 Plan；
- Challenger：在独立工作区检查代码与测试事实，挑战 Plan 的假设、遗漏和风险；
- Developer：通过 OpenClaw built-in 在独立工作区修改代码、执行测试并创建本地 Commit；
- Reviewer：在独立工作区检查需求覆盖、代码质量和兼容风险，并执行必要命令；
- Tester：在独立工作区编写测试资料、执行命令并完成场景验证。

Researcher 和 Operator 是后续可配置成员。Researcher 只在需要外部研究时加入；Operator 在测试环境和生产外部操作开放后加入。

Worker 长期保留身份和专业能力。Room 级 Leader 入口只负责把普通 Human 消息路由到已有或新的 Work；完成路由后，每个 Work/Task 使用独立逻辑 Session。Session 可以释放或恢复，但不会成为 Work、Task 或产品事实的替代物。

### 4.2 通用 Worker runtime

第一版目标是一个通用 Worker runtime 镜像：

```text
tg-worker
├─ OpenClaw
├─ tiangong-control plugin
├─ 显式 coordination/workspace 工具组
├─ 公开第一方 Skills
└─ AgentTeams 官方 Provider/Model 接入
```

不同 Agent 由 AgentTeams 身份、Agent 包、MemberConfig 和 ControlProfile 配置。身份、职责、模型路线、Skill 和权限不能由镜像名称决定。

第一版六个专业成员都使用 OpenClaw built-in，初始默认模型为 `glm-5`。Provider、Provider credential 和 Worker model 由 AgentTeams 官方控制面管理；Agent 包只声明 `defaultModel`，不把它当成永久锁。Tiangong 将已认证 Worker 的当前 model 投影为新的 MemberConfig revision，并在部署、turn 和工具边界校验。管理员可以通过 AgentTeams 修改单个 Worker；Task、Prompt 或 Skill 不能切换 Provider/Model。只更新控制面期望值、但运行中 Worker 的 OpenClaw 配置尚未变化时，不得声称切模成功；完成 Worker 生命周期重建后必须产生新 revision，并使旧 Session/绑定失效。

能力不再通过 `capabilityProfile` 这种重复标签表达。Agent package 的显式 `toolGroups` 决定可见顶层工具，MemberConfig 的 `allowedSkills` 只缩小已安装 Skill 集合，部署配置负责工作区、可写路径、凭据、网络和外部副作用。Leader 使用 coordination + skill-runtime；Architect、Challenger、Developer、Reviewer、Tester 使用 skill-runtime + 固定 OpenClaw 版本验证过的 workspace 工具组。仓库中的机器可读工具锁是 allowlist 的单一来源，镜像合同必须从 pinned OpenClaw 的实际注册表或官方接口证明锁中工具仍存在；上游新增工具默认拒绝，不能静默扩大能力。不存在 Developer 专属 allow-all 或 Tester 的死声明。

五个专业成员的职责限制交付物和交付链位置，不被当成文件系统安全边界；工具层不承诺 Reviewer 等角色只读。路径、工作区归属、凭据、网络和外部副作用由部署代码强制。只有 Developer 本地 Commit 能进入交付链，其他成员的临时修改不得覆盖交付分支。

M7 已删除旧的角色专用镜像、固定五角色 registry、Codex/OpenCodex、native-runner、旧 Deployment/Approval/Operation 和 hash-chain Evidence 路径，不保留兼容层。PostgreSQL 是产品事实、Matrix admission 与 wake outbox 的唯一 runtime 权威；纯记录合同不包含持久化，Web 不回退到文件 store。

## 5. Skills

### 5.1 第一版边界

Skill 是可移植、版本化的专业方法，不是 Agent 身份或权限包。一个 Skill 可以被多个 Agent 预装和使用。

有效 Skill 集合为：

```text
Worker/Agent 包已安装 Skills ∩ MemberConfig.allowedSkills
```

Human/Admin 只在 Agent 配置时决定允许哪些 Skill，不参与每个 Task 的 Skill 调度。Leader 可以说明工作方法，但不能为 Task 安装或绕过 Skill 配置。Agent 根据 Task 和 Skill 触发说明自主选择，Web 只展示实际使用记录。

第一版不做在线安装、Skill 市场、Task 级 Skill 分配或执行中的热更新。找不到合适 Skill 时，Agent 报告能力缺口。

### 5.2 包结构

产品 Skills 使用可移植 Agent Skill 结构：

```text
skills/<skill-name>/
├─ SKILL.md
├─ scripts/       可选
├─ references/    可选
├─ assets/        可选
└─ tests/         触发与行为边界
```

Agent 包固定 Skill 版本和内容摘要。实际解析的 Skill 名称、版本、触发和调用元数据进入 Execution Record，后续可在 Web 和 AgentLoop 中关联，但不成为 Task 授权。

### 5.3 首批能力

第一版优先提供：

- 需求理解与动态委托；
- Work Plan 生成和修订；
- Plan 挑战；
- 测试先行实现；
- 独立代码 Review；
- 场景测试。

这些是方法默认值，不在 Kernel 中硬编码为固定执行顺序。

### 5.4 当前实现状态

当前开发分支已实现 M1/M2 底座，并正在 clean-cut 到上述执行合同：

- `worker/agent-packages/` 提供六个版本化 Agent 包，固定责任、runtime、初始 `defaultModel`、toolGroups、会话策略和 Skill digest lock；六个包均为 all-built-in，初始模型为 `glm-5`，五个专业成员共同使用 pinned OpenClaw workspace 工具锁；
- MemberConfig 当前已投影 revision、AgentTeams Worker 当前 model、Agent package 和 `allowedSkills`；部署入口正在改为读取 AgentTeams 生成的实际 OpenClaw model 配置并与 MemberConfig model 比较，不能假设 AgentTeams 一定投影 `AGENTTEAMS_MODEL` 环境变量；模型生命周期重建和旧 Session 失效仍需真实验证；
- Leader 每个 Work、其他成员每个 Task 使用独立逻辑 SessionRef；Session 仍不承担授权或产品事实；
- `worker/skills/` 预装六个可移植产品 Skill，每个包含触发正例、负例、歧义例以及 success/blocked/cleanup 行为案例；
- 有效 Skill 由代码计算 installed ∩ allowed，未安装、digest 不匹配、越权选择和配置漂移 fail closed；
- Agent 通过 `tiangong_use_skill` 自主选择已启用 Skill，ToolResult 只记录有界 Skill ID、版本、内容摘要和触发说明，不把 Skill 当作权限；
- M3 chat-first Web 已替代原始只读 console：Human 使用 Matrix 身份建立只驻留内存的 HttpOnly Web session，Room 历史、实时 sync、普通消息发送、分页、local echo 和失败状态都直接来自 Matrix；每次 API/SSE 更新重查 identity 和 bound-Room membership，撤销后 SSE 关闭；
- Web 左侧显示 Team/Room 与 Leader 待归单指标，中间显示完整 Matrix 对话，右侧显示 Room Work 历史和当前 Work 的 WorkSpec、Plan 引用/历史、Challenger Result、Agent/model/实际 Skill、Task/Result/ToolResult、交付物和 timeline；
- Work 选择只存在浏览器查看状态，发送 API 只接受普通正文和 Matrix transaction ID，显式拒绝 `workId` 等路由字段；Matrix token、密码和消息正文都不进入 PostgreSQL、URL 或浏览器持久存储；
- 第一版加密 Room 明确 fail closed；HTTPS 默认使用 Secure cookie，loopback HTTP 开发必须显式关闭该属性。

这不等于共同 workspace 工具合同、GLM 多步 canary、真实项目闭环或生产部署已经完成。

## 6. 真实项目本地交付

第一版面向由部署者提供、可重置的真实代码仓库。项目可以是私有的，但不能成为公开 Tiangong 的运行、构建、测试或发布依赖。

第一条产品闭环优先选择一个可稳定复现、有自动测试且改动范围小的软件 Bug：

```text
Human 请求
→ Leader 形成 WorkSpec
→ Architect 产出候选 Plan
→ Challenger 挑战
→ Leader 发布当前 Plan 并动态创建 Tasks
→ Developer/OpenClaw built-in 在独立工作区修改、测试并创建本地 Commit
→ Developer Commit 可读后，Reviewer 与 Tester 在各自独立工作区执行命令并验证
→ Leader 根据 WorkSpec.doneWhen、Results、ToolResults 和交付物完成 Work
```

边界：

- 仓库和演示分支可精确重置；
- 只产生本地分支、Commit、Diff、测试和报告；
- 不持有 Push、CI dispatch、部署或生产凭据；
- 私有源码、fixture 和运行材料不进入公开仓库；
- 失败时保留有界事实并安全停止；
- 首轮成功后从固定基线完成至少一次 clean rerun。

## 7. 第一版 Web 可见内容

Web 主工作台至少展示：

- Matrix 消息；
- Room 的待归单数量、最老等待时间和有界错误；
- Work 标题、WorkSpec、状态和时间线；
- `workSpec: null` 时明确显示“需求待形成”；
- 当前 Plan、候选版本和 Plan 历史；
- Architect Plan、Challenger 意见以及 Leader 发布的版本；
- 当前 Agent、模型和实际使用的 Skill；
- Task 与从事实投影出的粗粒度状态；
- Result 与 ToolResult；
- Commit、Diff、测试报告等交付物；
- 等待 Human、能力不足、取消和需要恢复等非成功状态。

第一版不展示模型隐藏思维，不伪造逐步推理，也不建设 Trace 瀑布图、成本看板或完整评测平台。

## 8. M8 AgentLoop 诊断接入

M8 已在默认关闭的前提下接入 AgentLoop，并保留以下稳定关联：

```text
workId / taskId / memberId / sessionRef / turnId / skillId / toolResultId
```

AgentLoop 是可替换的诊断后端。Worker 使用 OpenClaw/AgentLoop 插件将无凭据 OTLP HTTP/Protobuf 发送到独立 Collector，由 Collector 注入阿里云写入鉴权；Provider/model 仍由 AgentTeams 管理。Tiangong Web 只提供经固定官方域名和路径校验的“查看运行轨迹”入口，不复制控制台或 Trace 数据。

AgentLoop 可在明确批准的隔离测试中展示可见输入、可见回复、AgentTeams 当前 Provider/Model 标识、Skill、工具、Token、耗时和错误。模型未公开的隐藏 Chain of Thought 不得被声称为可见。Tiangong ToolResult 只补自己的有界机器事实。

Trace 可以采样、延迟或丢失，AgentLoop 不可用也不能影响 Work、Task、Result、ToolResult 或完成判断。内容采集默认关闭，当前只有显式 `isolated-test` 才允许启用；真实云端上报还必须使用仓库外轮换凭据并单独形成机器验证。详见 [`m8-agentloop-diagnostic-integration.md`](m8-agentloop-diagnostic-integration.md) 和 [`../observability.md`](../observability.md)。

## 9. 命名

产品、UI、文档和公共协议使用 `Tiangong` 全名。Docker、Compose、Kubernetes 等基础设施资源使用 `tg-` 前缀，例如 `tg-worker`、`tg-web`。环境变量、OpenClaw 插件 ID 和可观测 service name 保留 `TIANGONG_*` 或 `tiangong-*`，避免 `tg` 与其他系统缩写冲突。

## 10. MVP 验收

第一版只有在以下事实同时成立时才算完成：

1. Human 能在 Tiangong Web 中使用真实 Matrix Room 的普通消息发起和继续工作；
2. Leader 能把消息幂等地关联到已有 Work 或新建 Work，Human 不需要先选择 Work；
3. Leader 不可用时消息不会丢失或猜测归单，Web 能显示待归单数量、最老等待时间和有界错误；
4. 归错单后可以在不删除历史、不迁移 Task/Operation 的前提下纠正当前消息关联；
5. 左侧只按 Team/Room 导航，右侧 Work 选择只影响查看，不影响消息路由；
6. Work 关联不修改 Matrix 消息正文或要求 Tiangong 自定义 Human event 字段；
7. `workSpec: null` 能通过 API 和 Web 正常恢复并显示为“需求待形成”；
8. Leader 能形成 WorkSpec 和可读标题；
9. Architect 能产出 Markdown Plan，Challenger 能挑战，Leader 能发布和修订 `currentPlanRef`；
10. Leader 能根据 Plan 创建普通 Task，而 Kernel 没有固定角色阶段或 DAG；
11. Architect、Challenger、Developer、Reviewer 和 Tester 都能在各自隔离工作区使用合同允许的 OpenClaw built-in 文件与命令工具；
12. Developer 修改真实项目、执行修复前后测试并产生本地 Commit；只有 Commit 机器可读后才创建 Reviewer 和 Tester Task；
13. Reviewer 和 Tester 使用独立 Task、Session 和工作区执行检查并返回 Result；
14. Leader 不创建逐 Task CoordinationDecision，也能在 CloseGuard 检查通过后完成或停止 Work；
15. ToolResult 能显示修复前后测试、工具和提交事实；
16. Web 刷新和服务重启后仍能恢复 Matrix event 引用、Work 绑定和 Tiangong 产品事实；
17. 同一固定基线至少完成一次 clean rerun；
18. 没有 Push、部署、生产写入或私有项目材料进入公开仓库；
19. AgentLoop 不存在时，全部产品能力仍可使用。

## 11. 后续阶段

按风险逐级开放：

1. 测试环境 Adapter、Operation 预览、精确授权、部署、对账和回滚；
2. Human 授权的生产灰度、健康验证和止损；
3. 监控告警自动创建 Work，Agent 先只读诊断；
4. 自动生成修复分支和测试环境验证；
5. 最后才考虑对低风险、白名单问题开放生产自动修复。

生产 Bug 感知自动化和生产写入自动化是两件事，必须分阶段验收。

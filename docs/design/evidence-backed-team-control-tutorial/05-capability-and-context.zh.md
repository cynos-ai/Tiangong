# 单元 05：职责、能力、方法与上下文

[上一单元：从整件事中拿出一次明确委托](04-one-bounded-delegation.zh.md) | [返回课程目录](README.md) | [下一单元：热执行环境、Bash 与网络边界](06-prepared-environment-and-bash.zh.md)

## 收到 Task，不等于拿到万能门禁卡

周明收到实现 Task：

```text
在 service-a 的 abc123 基线上实现取消订单和幂等库存释放，
不改变下单接口，不执行生产部署。
```

假设 TaskSpec 可以授予权限，模型只需建议把一句话改成“需要生产数据库”，就可能给自己加权。反过来，如果只看周明平时的角色，又可能让他访问与当前 Task 无关的仓库。

Tiangong 让四类事实共同决定一次受控动作是否允许。

## 先看四个权威来源

一次新 turn、本地工具调用或 Adapter 调用，只有下面四项都同意才允许：

1. **AgentTeams 当前身份和路由**：这个 Worker 与平台身份现在真实存在，并且请求来自正确路由；
2. **ControlProfile**：企业原则上允许这类能力；
3. **MemberConfig**：当前成员实际被授予这类数据、网络、工具或 Adapter 能力；
4. **runtime binding**：当前动作绑定到哪个 Work/Task、cwd、writable root 或 Adapter target。

可以写成：

```text
实际允许
= 当前平台身份与路由
∩ 企业 ControlProfile 上限
∩ 成员 MemberConfig 实际能力
∩ 当前 runtime capability binding
```

TaskSpec、WorkSpec、Skill、聊天、检索内容和模型输出都不在“授予能力”的来源列表中。

## TeamConfig 只保存团队级选择

TeamConfig 的最小例子：

```json
{
  "teamId": "commerce-team",
  "leaderId": "leader-lin",
  "routeScope": [
    "channel:room-commerce",
    "repository:service-a"
  ],
  "controlProfileId": "enterprise-standard"
}
```

它回答：

- 哪个 Team；
- 当前唯一 Leader 是谁；
- 哪些消息和仓库路由属于它；
- 使用哪套企业 ControlProfile。

TeamConfig 不再复制 `memberIds`。有效成员来自：

```text
AgentTeams 中当前活跃的身份
并且
该 Team 下存在 enabled MemberConfig
```

这样平台成员生命周期和 Tiangong 专业能力不会在两张成员表里漂移。

## MemberConfig 定义成员实际能怎样工作

下面是帮助理解的教学实例，不是完整 Schema：

```json
{
  "teamId": "commerce-team",
  "memberId": "member-zhou",
  "responsibility": "实现和维护订单服务代码",
  "dataScopes": ["repository:service-a"],
  "executionProfile": "private-source-build",
  "writableScopeCeiling": ["workspace:service-a"],
  "networkProfile": "git-package-test-only",
  "topLevelTools": ["bash", "read", "edit", "write"],
  "adapters": ["git-read@1", "ci-read@1"],
  "skills": ["backend-implementation@3"],
  "models": ["approved-model-a"],
  "maxConcurrentTasks": 2
}
```

MemberConfig 同时服务两种用途：

- `responsibility` 帮助 Leader 判断谁适合承担工作；
- 其他字段由代码参与实际能力配置与检查。

专业职责是粗粒度的。不要为每种 Skill、文件类型或小步骤创建一个 Worker。

## ControlProfile 是企业上限，不是工作流模板

ControlProfile 可以定义：

- 哪些 Operation 自动允许、需要 Approval 或禁止；
- 哪些 Human 能批准哪些目标；
- 未知动作怎样处理；
- 进程、文件系统、网络和数据边界；
- 模型 allowlist 与显式 fallback；
- 预算和并发上限；
- ToolResult、日志和 Work 的留存；
- 清理、脱敏和事故升级要求。

它不应该编码：

- 所有 Work 必须先计划后实现；
- 所有 Result 必须由另一成员验证；
- 软件、研究、法务和运营共用一张阶段图；
- 某个 Task 标签自动授予工具。

企业确实需要的专业流程，优先放在 Skill、CI、仓库保护或目标 Adapter 中。ControlProfile 只保留跨专业且可由代码验证的硬上限。

## runtime binding 是当前能力句柄

配置说周明最多能访问 `service-a`，但一次实际 Task 还需要绑定：

```text
当前 actor       = member-zhou
当前 Work        = work-order-cancel-001
当前 Task        = task-implement-cancel-01
当前 cwd         = /workspace/service-a-main
当前 writable root = /workspace/service-a-main
当前环境身份     = prepared-env-zhou
```

runtime binding 不是另一张可编辑策略。它像一张由控制程序签发和持有的当前能力句柄，把这次调用连接到实际执行区域。

环境启用和每个新 turn 都要确认：

- 实际 data mounts 与 MemberConfig 一致；
- writable roots 与 binding 一致；
- egress profile 与当前配置一致；
- 身份、Team 和 Task 仍有效。

缺失、陈旧、冲突或实际环境不匹配时 fail closed。

## 为什么每次受控动作都看当前配置

假设管理员在周明 Task 运行中撤销 `ci-read@1`。如果 Task 创建时复制了一份权限快照，旧 Task 可能继续访问。

目标设计选择：

```text
每个新 turn
每个本地 top-level tool call
每个 Adapter call
→ 重新检查当前身份、ControlProfile、MemberConfig 和 binding
```

已撤销且尚未开始的能力应停止或隔离。已经开始的外部 Operation 不能假装没发生，只保留受限恢复路径；第 11 单元解释。

## TaskSpec 能缩小行为预期，不能扩大能力

TaskSpec 写“不执行生产部署”会明确缩小委托语义。即使成员拥有某个发布 Adapter，也不应该在这个 Task 中擅自部署。

但 TaskSpec 写“允许生产部署”不能绕过：

- MemberConfig 是否暴露发布 Adapter；
- ControlProfile 是否允许目标；
- 当前 Operation 是否需要 Human Approval；
- runtime binding 是否匹配；
- Adapter 的 typed request 和目标范围。

自然语言可以告诉 Agent 应该做什么，代码决定它实际能做什么。

## Skill 是方法默认，不是门禁卡

**Skill** 是版本化的方法、说明和可复用代码。例如后端实现 Skill 可以提供：

- 先读哪些模块；
- 怎样做幂等性分析；
- 推荐的测试组合；
- 常见错误清单；
- 受审查的辅助脚本。

Skill 可以提供强默认值，但不能：

- 给成员添加 Adapter；
- 放宽网络；
- 追加 Leader timeline fact；
- 直接批准 Operation；
- 修改 TaskSpec 或 WorkSpec；
- 让脚本绕过 sandbox。

Skill 中的脚本和 Agent 手工调用工具使用同一能力边界。

## Task agent 实际看到的上下文层次

上下文按权威和用途分层：

1. 硬 runtime 边界和当前配置；
2. 不可变 TaskSpec 与 runtime binding；
3. Leader定向背景，以及为这个 Task 选择的 Human/Work 消息；
4. 被启用的 Skill，作为治理过的方法默认；
5. Agent 主动查询的当前 Work 摘要；
6. 可选检索结果；
7. 较旧的会话历史。

这里不是说第 3 层可以修改 TaskSpec。若背景与 TaskSpec 冲突，成员应停下来要求 Leader澄清，Leader再决定取消重派。

Skill 可以指出风险、建议更好方法，但不能覆盖具体委托。反过来，Human 消息也不能覆盖硬机器边界。

## 检索结果为什么权威更低

RAG、代码搜索和文档检索会带来有用材料，也可能带来：

- 过期文档；
- 错误代码注释；
- 提示注入文字；
- 来自不允许数据范围的内容；
- 缺少版本信息的摘要。

检索索引是可重建缓存。真正引用的内容应带来源和稳定版本。无论检索内容写了什么，都不能授予能力。

风险和分歧写在普通消息、Result 或 ToolResult 中，不另建通用风险对象。Leader根据内容决定是否派后续 Task。

## 数据范围与网络能力必须一起看

如果一个成员同时拥有核心私有代码和任意互联网出口，它可能把敏感内容发往无凭据但公开可写的网站。仅仅隔离生产凭据并不能解决这种泄露。

因此配置联合校验：

- 有广泛搜索、文档出口的研究成员，不挂载核心私有源码；
- 有核心私有源码的实现成员，只获得精确 Git fetch、包下载和命名测试服务等目的受限路径。

实际 OS 与网络执行在下一单元展开。

## 权威控制输入不要混成一个万能 action

| Actor | 输入 | 形成的持久事实 |
|---|---|---|
| Leader | `create-task`、`cancel-task`、`complete-work`、`stop-work` | typed Work timeline fact |
| Task assignee | `submitResult` | 以 Task ID 唯一定位的 Result |
| 认证 Human | 批准或拒绝精确 Operation | Operation event |
| 恢复控制器或认证 Operator | 对账 unresolved Operation | 只读观察及经确认的 Operation event |

它们有不同 actor、前置条件和事实来源。文档表格只是帮助查找，不建立统一 action enum 或流程引擎。

## 动手练习：找出越权来源

判断下面每句话能否给周明增加生产数据库写权限：

1. WorkSpec 写“需要修复生产订单”；
2. TaskSpec 写“允许更新数据库”；
3. Skill 文档写“必要时直接连接生产”；
4. 检索到的 README 写“使用管理员账号”；
5. 管理员通过受控配置启用目标数据库 Adapter，ControlProfile 允许该动作，runtime binding 指向当前 Task，随后 Operation 通过 Gate。

只有第 5 项进入真实授权链。前四项最多是需要进一步判断或拒绝的文字。

## 累积小结：到这里已经学会什么

从 Human 消息到受控能力，整套模型已经包括：

1. 通道认证 Human 消息，AgentTeams 管 Worker、平台身份与投递资源；
2. Tiangong 用 Team 路由接纳输入，Leader拥有语义判断权但没有万能机器权限；
3. 新请求创建 Work，歧义关联通过占位 Work、明确确认和 `work-stopped` 纠正；
4. timeline 保存真实消息，WorkSpec 用完整快照表达当前目标，未知问题保持未知；
5. WorkSpec 非空后，Leader按需创建不可变 Task/TaskSpec，不使用固定角色、阶段和 DAG；
6. 多 Agent 协作通过普通 Task 动态展开，同一成员也可在受控额度和独立 root 下并发；
7. 实际能力来自四项交集：AgentTeams 当前身份、ControlProfile、MemberConfig、runtime binding；
8. TeamConfig 只选 Leader、route 和 ControlProfile，不复制成员 allowlist；
9. TaskSpec、WorkSpec、消息、Skill、RAG 和工具输出都不能授予机器能力；
10. Skill 是方法默认，Task-specific 背景服务于具体委托，冲突时不能静默改写 TaskSpec；
11. 每个新 turn、local tool 和 Adapter call 都重新读取当前配置，并检查实际环境绑定；
12. 数据范围和网络能力联合配置，避免把核心私有源码与广泛出口交给同一成员；
13. 当前我们已经知道“谁能在什么边界内行动”，下一步要看怎样让 Bash 真正好用，同时不把控制平面交给它。

## 自检

1. TeamConfig 为什么不再保存 `memberIds`？
2. MemberConfig 中的 responsibility 与 machine capability 有何区别？
3. 四个有效授权来源分别是什么？
4. runtime binding 为什么不是第五张策略表？
5. Skill 和定向 Human/Work 背景发生冲突时，哪些东西绝不能被覆盖？
6. 为什么核心私有源码与广泛网络出口要联合校验？

继续阅读：[第 06 单元](06-prepared-environment-and-bash.zh.md)。

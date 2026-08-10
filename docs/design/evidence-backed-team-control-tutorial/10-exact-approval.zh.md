# 单元 10：Human 批准的必须是精确动作

[上一单元：本地动作与外部写入](09-external-operation.zh.md) | [返回课程目录](README.md) | [下一单元：超时、未知结果与恢复](11-uncertainty-and-recovery.zh.md)

## 群里一句“可以”为什么不够

发布成员准备把 `service-a@def456` 部署到生产。林舟问：

> 取消订单已经在测试环境验证，可以上线吗？

陈晨回答：

> 可以。

人类可能结合上下文猜到双方谈的是生产，但机器仍无法确定：

- 哪个环境；
- 哪个 commit；
- 生产当前应处于哪个版本；
- 是否包含数据结构或数据内容变更；
- 失败时是否有立即补偿；
- preview 中实际展示了什么；
- Approval 多久有效；
- 陈晨是否是当前 ControlProfile 允许的 approver；
- 回复到达时 Operation 是否已过期或被取消。

普通聊天只能沟通，不能直接授权外部写入。

## 先创建生产 Operation

发布成员通过 `deploy@1` 创建：

```json
{
  "operationId": "op-deploy-production-124",
  "taskId": "task-release-cancel-01",
  "adapter": "deploy@1",
  "action": "deploy",
  "request": {
    "target": "production-a",
    "repositoryId": "service-a",
    "commit": "def456",
    "expectedCurrentVersion": "release-41"
  },
  "preview": "将 service-a 的 commit def456 部署到 production-a；仅当当前版本仍为 release-41 时执行。",
  "createdBy": "member-release",
  "createdAt": "2026-08-10T15:00:00Z"
}
```

ControlProfile 根据当前目标和 action 判断：需要 exact Human Approval。

## Human 应看见什么

runtime 发送实际有界 preview，而不是让模型临时写一段好听的摘要：

```text
准备执行
  部署 service-a

目标
  production-a

代码
  commit def456

执行前提
  当前生产版本必须仍为 release-41

授权对象
  op-deploy-production-124

有效期
  30 分钟
```

不同动作还应展示：

- SQL 或配置变化；
- 收件人与通知正文；
- 将删除的资源和数量；
- 制品精确版本；
- 立即补偿条件和目标状态；
- 其他会实质改变风险的 typed 字段。

如果无法把所有风险相关属性安全展示，就不能批准。

## Approval 是事件，不是独立对象

陈晨通过认证界面的“批准”动作后，系统直接向该 Operation 追加：

```json
{
  "eventType": "operation-approved",
  "operationId": "op-deploy-production-124",
  "actorId": "human-chen",
  "createdAt": "2026-08-10T15:08:00Z"
}
```

runtime 还保存实际 preview 的投递 metadata，例如通道消息身份和发送时间，用于回答 Human 当时看见什么。

目标设计不再建立另一份 Approval 业务对象。不可变 Operation 本身已经是精确授权对象；认证 event 只回答这个 Human 对它作了什么决定。

## exact 体现在哪里

Approval event 精确记录：

- 一个不可变 `operationId`；
- 当前认证 Human；
- 实际发送和存储的 bounded preview 及 delivery metadata；
- 发生批准这一时间点。

当前 approver policy 和有效期不会复制成另一份 policy snapshot。runtime 在处理 Human action 和真正执行前都读取当前 ControlProfile。因为 Operation 不可变，批准 `op-deploy-production-124` 不可能被拿去执行另一个 commit 或 target；任何效果字段变化都必须创建新 Operation 和新 Approval event。

## 普通消息为什么永远不能自动升级

即使陈晨在聊天中写：

> 我批准 op-deploy-production-124。

它仍然只是普通 Work message，除非通过受认证的 Approval action 入口处理。

原因是 Approval 入口还要代码确认：

- 平台身份；
- 当前 ControlProfile 的 approver 范围；
- Operation 是否仍 pending；
- preview 是否实际交付；
- 是否过期；
- Task 和 Work 是否仍允许继续；
- 是否与 rejection、cancellation 或 execution start 冲突。

自然语言本身不携带这些机器前置条件。

## pending 时 Task 怎样表现

Operation 等待 Human 时：

```text
Operation 已保存并发送 preview
→ Task UI 投影为 waiting approval
→ 释放当前模型调用和不需要的本地进程
→ Human 在模型循环外作决定
→ 同一 Task 恢复并收到有界工具结果
```

Task 不提交“blocked Result”，也不拆成“申请批准 Task”和“批准后执行 Task”。TaskSpec 没有变化，同一委托只是等待一个外部决定。

提醒可以有界、去重，并在到期前发送。提醒 timer 是基础设施状态，不是新的业务对象。

## Human 拒绝时怎样处理

陈晨点击拒绝，系统追加：

```text
operation-rejected
operation-not-executed
```

这项 Operation 到达“没有进入外部执行”的已知终态。它不会自动取消 Task，也不会创建失败 Result。

同一 Task 可以恢复，发布成员可能：

- 把拒绝原因告诉 Leader；
- 请求另一种方案；
- 创建目标不同的新 Operation；
- 由 Leader取消 Task。

旧 Operation 永远不修改，也不重新开启。

## Approval 过期或策略收紧

以下情况同样让 Operation 终止为 `operation-not-executed`：

- Approval 到期仍无人批准；
- ControlProfile 从允许收紧为拒绝；
- 当前 approver policy 不再认可该 Human；
- Task 在执行开始前被安全取消；
- 使用点 Gate 发现当前路径已经不允许。

这些都只终止 Operation，不自动终止 Task。

## 为什么批准后仍要再次检查

陈晨批准到实际执行之间，世界可能变化：

- 生产已由另一个团队更新为 `release-42`；
- 发布成员被撤销；
- ControlProfile 暂停生产部署；
- Approval 到期；
- Task 被取消；
- Adapter target 配置改变。

因此 runtime 在处理 Human action 时检查当前 policy，在真正执行前再次检查。

Approval 表示“Human 允许在这些精确条件下尝试”，不表示条件会冻结，也不证明执行成功。

## 并发竞态怎样处理

下面动作可能同时到达：

- approve；
- reject；
- expiry；
- Task cancellation；
- `operation-execution-started`。

它们必须在受控存储中串行竞争：

```text
not-executed 先提交
→ execution start 必须失败

execution-started 先提交
→ 不能再声称 not-executed
```

同一个 Operation 不会既“从未执行”又“已经开始”。

## 三种 Human 互动不要混淆

### 需求澄清

陈晨回答“开始拣货后不能取消”。这是普通 Work communication，帮助 Leader形成 WorkSpec。

### 精确 Operation Approval

陈晨批准 `op-deploy-production-124`。这是认证事件，只授权这一项不可变外部写入尝试。

### 客户验收或满意度

团队可以通过普通消息、Skill 或外部系统请求客户验收。但 Kernel 的 `complete-work`/`stop-work` 是 Leader内部语义决定，不要求建立通用 Human closure signature。

三者都可能由同一个 Human 完成，但机器意义完全不同。

## Approval 不能证明什么

`operation-approved` 不能证明：

- Adapter 已调用后端；
- 部署已开始；
- 部署成功；
- 生产正在运行目标 commit；
- Work 可以关闭。

它只证明：当前认证 Human 按当前策略对这项不可变 Operation 作出了允许尝试的决定。

外部效果由后续 Operation events 记录。

## 动手练习：判断哪条是真正授权

下面哪项可以授权生产部署？

1. 陈晨在群里说“可以上线”；
2. WorkSpec 写“上线前陈晨确认”；
3. 林舟 Result 写“用户已同意”；
4. 认证 Approval action 针对 `op-deploy-production-124`，实际 preview 已交付，policy 与有效期检查通过；
5. 三天后对已过期 Operation 回复“批准”。

只有第 4 项。第 1–3 项可以作为沟通背景，第 5 项必须拒绝。

## 累积小结：到这里已经学会什么

从需求到精确 Human 授权，完整链条是：

1. 通道只提供认证消息身份，AgentTeams 管平台资源，Tiangong 自己掌握专业授权；
2. Work 和 timeline 隔离整件事并保留消息、纠错和 Leader typed facts；
3. WorkSpec 是当前语义目标，不是权限或固定流程；TaskSpec 是一次不可变委托；
4. Leader动态派 Task，成员在 AgentTeams、ControlProfile、MemberConfig、runtime binding 的交集中行动；
5. prepared environment 让 Bash 可用但读不到控制/生产 credential，网络与数据范围联合限制；
6. ContentRef 标识稳定交付，Result 保存 assignee 的唯一终态报告，ToolResult 保存工具观察；
7. 外部写不能藏在 Bash 或 ToolResult 中，必须由版本化 Adapter创建不可变 Operation；
8. `operationId` 是唯一业务身份，所有效果字段都在 typed request 和实际 preview 中；
9. ControlProfile 在使用点决定自动允许、需要 exact Approval 或拒绝；
10. exact Approval 是认证 Human 针对一个不可变 Operation ID 的 event，不是聊天，也不是第二个 Approval 对象；
11. pending Approval 暂停同一 Task并释放资源，不创建 blocked Result或额外阶段；
12. rejection、expiry、执行前取消和失效策略把 Operation 终结为 `operation-not-executed`，Task仍可继续；
13. approve/reject/expiry/cancel/start 竞态必须串行，不能同时出现“未执行”和“已开始”；
14. Approval 只允许尝试，不证明外部执行或 Work 完成；
15. 下一步将处理最危险情况：已经开始调用外部系统，但结果无法确认。

## 自检

1. 实际 preview 为什么必须由 typed request 生成？
2. 为什么目标设计使用 Approval event 而不是独立 Approval 对象？
3. 普通聊天即使写了 Operation ID，为什么仍不能授权？
4. pending Approval 为什么不需要新 Task 或 Result？
5. rejection 与 expiry 对 Operation 和 Task 分别产生什么结果？
6. 为什么执行前必须重新检查当前 policy 和 target 前提？
7. Approval 能证明外部动作成功吗？

继续阅读：[第 11 单元](11-uncertainty-and-recovery.zh.md)。

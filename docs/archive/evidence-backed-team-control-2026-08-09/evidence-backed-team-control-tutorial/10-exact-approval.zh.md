# 单元 10：人批准的必须是即将执行的那一件事

[上一单元：本地修改与真正改变外部系统](09-external-operation.zh.md) | [返回课程目录](README.md) | [下一单元：请求超时后，为什么不能直接再试一次](11-uncertainty-and-recovery.zh.md)

## “可以上线”少了哪些信息

林舟在群里说：

> 取消订单已经验证通过，可以上线吗？

陈晨回复：

> 可以。

人类读上下文时也许知道双方在谈生产部署，但机器仍然无法安全确定：

- 是测试环境还是生产环境？
- 部署哪个 commit？
- 生产当前应该处于哪个版本？
- 是否包含数据库变化？
- 允许什么回滚？
- 批准多久有效？
- 陈晨是否是当前规则认可的批准者？
- Agent 后来有没有把参数换掉？

所以普通聊天只能作为沟通，不能直接成为外部执行授权。

## 先把机器执行单翻译成人能判断的内容

上一单元已经有一份结构化 Operation。Human 不应该阅读数据库内部字段猜风险，Adapter 应从经过类型校验的 Operation 生成一张安全预览：

```text
准备执行
  部署 service-a

目标
  production-a

代码
  commit 9ab73e...

执行前提
  当前生产版本必须仍是 release-41

预授权回滚
  触发条件满足时恢复 release-41

有效期
  批准后 30 分钟
```

预览应展示所有会实质改变风险的内容。对其他 Operation，它还可能显示：

- 收件人；
- 将被删除的资源列表和数量；
- 数据变更摘要；
- 精确制品版本；
- 经过受控展示的敏感字段。

如果关键风险信息无法通过授权界面展示，就不能声称 Human 作出了 exact Approval。

模型不能自己编写一段听起来安全的摘要来替代这些结构化字段。

## Human 实际批准的记录

Tiangong 把这种绑定精确外部操作的 Human 决定叫 **Approval**。陈晨通过受认证的批准动作提交后，记录可以是：

```json
{
  "approvalId": "approval-deploy-77",
  "operationId": "operation-deploy-55",
  "operationDigest": "sha256:a120...",
  "viewSchemaVersion": "deployment-approval/v1",
  "presentedView": {
    "action": "deploy",
    "environmentId": "production-a",
    "subjectCommit": "9ab73e...",
    "expectedCurrentVersion": "release-41",
    "rollbackVersion": "release-41"
  },
  "channelMessageId": "matrix-event-9300",
  "decision": "approved",
  "decidedBy": "human-chen",
  "decidedAt": "2026-08-10T15:10:00Z",
  "expiresAt": "2026-08-10T15:40:00Z"
}
```

## Approval 绑定哪几件事

### 绑定 Operation 身份

批准的是 `operation-deploy-55`，不是“所有部署”。

### 绑定 operation digest

目标、commit、前置条件、回滚范围或受保护 payload 任一变化，digest 都不同。旧 Approval 不能复用。

### 绑定被授权的人

`decidedBy` 来自经过平台认证的 Human 身份，Tiangong 再按当前 approver policy 判断陈晨是否有权批准 production-a。

### 绑定实际展示内容

系统保存预览所遵循的数据结构版本、负责把数据呈现成人类界面的程序版本（renderer version）、实际有界视图或安全 ContentRef，以及发送到消息通道的消息身份。

这使审计者能回答“Human 当时看见了什么”，而不把预览变成第二份授权对象。权威仍然是不可变 Operation 与其 digest。

### 绑定有效期

批准不是永久票据。过期后，即使 Operation 内容不变，也不能执行。

## pending Approval 时 Task 发生了什么

当前部署 Task 不需要提交 blocked Result，也不需要拆成“准备 Task”和“执行 Task”。

它会暂停在同一项待执行 Operation 上：

```text
Operation 已保存
→ Task 的界面状态显示 waiting_approval
→ 当前模型调用和 runner 资源释放
→ Human 在模型循环外作出批准或拒绝
→ 同一项 Operation 恢复或终止
```

真正的权威事实是 pending Operation。`waiting_approval` 只是界面根据它推导出的 Task 状态。

等待期间 TaskSpec 没有变化，仍然遵守一个 Task 最多一个 Result。

## 批准后为什么还要重新过 Gate

陈晨批准时生产是 `release-41`，但执行前可能发生：

- 另一个团队已经部署 `release-42`；
- 周明被移出 Team；
- ControlProfile 临时禁止生产部署；
- Approval 已过期；
- commit 的独立验证记录不可访问；
- 受保护 payload 被删除或 digest 不匹配。

Approval 表示 Human 对精确计划的许可，不表示世界从此冻结。

所以每次真正执行前，Gate 都重新检查当前权限、策略、目标状态、Task、验证和 Approval。前置状态不再匹配时，旧操作停止；需要重新形成新的 Operation 和新的 Approval。

## 拒绝、过期和撤销分别怎样处理

### Human 拒绝

Operation 在执行前终止。Task 不会自动变成 failed Result。Leader 可以选择其他办法、取消 Task 或结束 Work。

### Approval 过期

pending Operation 终止，迟到的批准命令被拒绝。Task 本身仍可继续寻找其他方案。

### 执行前撤销

已经批准但尚未开始的 Operation 可以被授权撤销。撤销与 `execution_started` 必须在同一个受控状态边界竞争：撤销先提交就不能开始；开始先提交就不能假装从未执行。

### Task 被取消

如果 Operation 仍在等待 Approval，取消 Task 与终止 pending Operation 在一个事务中完成，后来的批准会被拒绝。

如果 Operation 已经开始或结果 uncertain，不能直接取消 Task，必须先把外部影响处理到已知状态。

## 普通消息、关闭确认和 Approval 再辨析一次

| 内容 | 保存在哪里 | 能否直接授权外部操作 |
|---|---|---|
| “进度怎么样？” | Work 普通消息 | 不能 |
| “我认可当前目标，可以结束” | `human-confirmed` 时间线事件 | 不能授权工具，只能满足相应关闭条件 |
| “批准 operation-deploy-55 的 digest a120...” | Approval | 只能授权这项精确 Operation，并且仍需 Gate 通过 |

一句话在聊天中听起来越明确，不代表它自动获得更高机器权威。权威来自受认证命令、精确对象和代码校验。

## 一个常见误区：Approval 等于执行结果

陈晨批准只表示“允许尝试执行”。它不证明部署已经开始，更不证明部署成功。

后续至少还要区分：

```text
approved          Human 允许执行
execution_started 运行时已记录即将调用后端
succeeded         Adapter 确认目标达到预期状态
uncertain         可能产生效果，但无法确认
```

最后一种情况会在下一单元展开；到那里我们再正式解释为什么把它叫作 `uncertain`，以及系统为什么不能装作什么都没发生。

下一单元会专门处理最危险的分支：请求发出后超时，系统不知道生产到底有没有变化。

## 本单元自检

1. 为什么普通聊天里的“可以上线”不能直接授权部署？
2. 结构化预览必须展示哪些类型的信息？
3. Approval 为什么同时绑定 Operation 身份和 digest？
4. Human 批准后，Gate 为什么还要重新检查当前状态？
5. 等待批准为什么暂停同一个 Task，而不是提交 blocked Result？
6. Approval 能证明部署成功吗？

下一单元开始出现全课程第一批伪代码。我们会先用时间线和三种结果讲清楚，再把每一步翻译成很短的代码形状。

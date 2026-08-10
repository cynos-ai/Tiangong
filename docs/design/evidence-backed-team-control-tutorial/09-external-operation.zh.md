# 单元 09：本地动作与外部写入

[上一单元：机器实际看见了什么](08-tool-results-and-storage.zh.md) | [返回课程目录](README.md) | [下一单元：Human 批准的必须是精确动作](10-exact-approval.zh.md)

## 周明一直在改东西，为什么 push 和部署不同

周明在 prepared environment 中已经：

- 编辑文件；
- 安装依赖；
- 运行测试；
- 生成构建产物；
- 创建本地 commit。

这些修改被限制在成员自己的执行区域。写坏后可以丢弃 worktree，不会直接改变其他团队成员或生产用户看到的状态。

接下来团队可能要：

- push commit 到共享 Git；
- 创建或合并 PR；
- 发布包或镜像；
- 部署测试或生产；
- 修改共享数据库或配置；
- 发送外部通知；
- 更新工单；
- 轮换凭据。

这些动作越过本地隔离边界，需要另一套身份、授权、幂等和恢复合同。

## 先画出效果边界

```text
prepared execution environment 内部
  本地 edit/build/test/commit/cache
  失败影响局限于受控 writable root

共享或外部系统
  Git 写入、发布、部署、数据库写、通知、工单、生产配置
  失败可能对其他人持续可见
```

Tiangong 把“一项拟议的外部写入”叫 **Operation**。

不是所有网络调用都是 Operation：受控外部只读查询仍然是 read Adapter call。判断关键是它会不会改变共享或外部状态。

## 为什么 Bash 不能偷偷完成外部写入

如果 Bash 持有 Git push token、生产数据库密码或部署凭据，模型可以绕开所有结构化检查：

```bash
curl -X POST ...
git push ...
psql ...
```

因此执行域没有这些 credential，也没有通向任意外部写目标的 egress。外部写只能通过 control domain 中受控的 **Adapter**。

凭据隔离解决“有凭据写入”；进程树网络策略限制“不需要凭据也能产生的外部动作”；数据与出口能力分离降低残余泄露风险。

## Adapter 是外部系统的受控边界

一个 Adapter 至少负责：

- 稳定身份和版本；
- 校验 typed request 与 target；
- 检查当前成员的数据或动作范围；
- 把 credential 保留在 Agent 不可见的 control domain；
- 对 read 返回有界、脱敏观察；
- 对 write 创建不可变 Operation；
- 在报告安全终态前用代码确认后置状态；
- 提供特权只读 reconciliation 接口，以处理未知结果。

MCP 可以作为 Adapter 或本地工具的传输协议，但不会产生新的授权层。MCP server 若持有 credential 或能写外部状态，仍必须遵守 Adapter 与 Operation 规则。MCP 返回文本也只是输入，不能授予权限。

## 哪些是 read，哪些是 Operation

| 调用 | 通常分类 | 说明 |
|---|---|---|
| 查询某 commit 的 CI 状态 | Adapter read | 只读，但仍检查 identity、data scope、sanitization |
| 获取生产当前版本 | Adapter read | 只读；普通成员是否可见由 MemberConfig 决定 |
| push 共享分支 | Operation | 改变共享 Git |
| 合并 PR | Operation | 改变目标分支 |
| 发布镜像 | Operation | 创建共享制品 |
| 部署测试环境 | Operation | 改变外部环境，即使可能自动允许 |
| 部署生产环境 | Operation | 通常需要 exact Approval |
| 发外部消息 | Operation | 无凭据也可能产生不可撤回效果 |
| 本地 `npm test` | local tool | 只改隔离环境 |

未知外部写类型默认拒绝。模型不能把写动作自称成 read。

## 一份最小而完整的 Operation

林舟创建发布 Task后，发布成员请求部署测试环境：

```json
{
  "operationId": "op-deploy-staging-123",
  "taskId": "task-release-cancel-01",
  "adapter": "deploy@1",
  "action": "deploy",
  "request": {
    "target": "staging-a",
    "repositoryId": "service-a",
    "commit": "def456",
    "expectedCurrentVersion": "staging-41"
  },
  "preview": "将 service-a 的 commit def456 部署到 staging-a；执行前要求当前版本仍为 staging-41。",
  "createdBy": "member-release",
  "createdAt": "2026-08-10T14:00:00Z"
}
```

分组理解：

### `operationId`

这是该外部写入唯一业务身份。相同 ID 永远表示同一个不可变提议。

### `taskId`

说明哪一次正式委托提出它。Operation 不能漂浮在没有责任上下文的模型调用中。

### `adapter`

`deploy@1` 同时固定实现边界与请求解释版本。Adapter 升级不会在原地改变旧 Operation 含义。

### `action` 和 `request`

它们包含所有决定真实效果的 typed 字段：目标、commit、前置状态、查询或 mutation、配置、收件人、消息正文等。

### `preview`

这是风险相关字段的人可读展示。它不是模型自由发挥的摘要，而必须忠实来自 typed request。

### `createdBy/createdAt`

由受控 runtime 写入提出者和时间。

## Operation 创建后哪些内容不可变

下面内容都不能修改：

- Operation ID；
- Adapter 与版本；
- action；
- request 与 target；
- 风险相关 preview；
- createdBy 与 createdAt。

如果 commit、目标、SQL、配置或消息正文改变，就创建新 Operation。

目标设计直接把可信 CoordinationStore 中这份不可变记录作为授权对象，不再为同一内容增加另一套摘要身份。越少身份，越容易保证 Human 批准和后端执行谈论的是同一件事。

## 所有效果内容必须出现在 request 和 preview

假设模型请求发送通知。下列内容都决定风险：

- 收件人；
- 主题；
- 正文；
- 附件或链接；
- 发送渠道。

它们不能藏在 credential、环境变量、后取 payload 或 Adapter 内部默认中。若某个风险字段不能安全展示，就不能批准这项动作。

Credential 只用于向后端认证，不决定 action 和 target，也不进入：

- Operation；
- prompt；
- preview；
- Bash 环境；
- ToolResult；
- 普通诊断。

## 轮换 credential 时随机值怎么办

“生成新密码”看起来需要隐藏内容，但 approver 真正需要决定的是：

- 轮换哪个目标；
- 哪个 principal；
- 使用什么生成策略；
- 结果由哪个 secret manager 接管。

这些进入 request 和 preview。随机 secret 值由 Adapter 或外部 secret manager 生成，不由 Agent在隐藏字段中选择。这样隐藏值不会偷偷改变动作含义。

## 当前策略怎样分类 Operation

在使用点，ControlProfile 把不可变 Operation 分类为：

```text
自动允许
需要 exact Human Approval
拒绝
```

例如：

- 部署隔离测试环境可能自动允许；
- 部署 `production-a` 需要 Approval；
- 删除未知云账号直接拒绝。

“自动允许”不等于普通工具调用。它仍然：

- 有 Operation ID；
- 在调用前记录 started；
- 使用 backend idempotency key；
- 由 Adapter确认后置状态；
- 对超时进入不确定恢复路径。

Approval 只改变是否允许尝试，不改变安全执行协议。

## 同一次顶层调用重放怎么办

runtime 保存一条有限 replay row：

```text
认证 actor + 顶层 tool-call identity
→ op-deploy-staging-123
```

同一调用因响应丢失重放，返回同一 Operation ID，不创建第二项外部提议。replay row 是基础设施状态，不进入 Work 业务图。

如果后端支持幂等键，Adapter 使用 `operationId`。后端返回自己已经为同一 ID 保存的结果，是读取原结果，不是再次产生效果。

注意：Operation 创建幂等不等于 uncertain 后可以重放外部写。执行开始后的规则在第 11 单元讲。

## Operation 与 ToolResult 不要混淆

调用外部 Adapter 时，Agent最终会得到一个有界 tool result，告诉它当前发生了什么。但外部效果的权威历史是 Operation 和 append-only events。

```text
ToolResult
  给当前 Agent 看到的有界调用观察，可按规则留存。

Operation events
  外部写入的永久协调事实，不采样。
```

Agent不能用一段 ToolResult prose 替换 Operation 的真实状态。

## 动手练习：把部署请求写完整

请为生产部署写 typed request 和 preview，至少包含：

```text
target:
repository/commit:
expected current state:
任何健康条件或立即补偿条件:
实际展示 preview:
```

然后问：

- 有没有风险字段只存在模型脑中？
- preview 是否忠实包含所有效果字段？
- credential 是否被误当成 hidden request？
- 目标改变时是否错误复用旧 Operation？
- Bash 是否能绕过 Adapter完成同一写入？

## 累积小结：到这里已经学会什么

从一条消息到第一项外部写入提议，整套模型是：

1. Human、通道、AgentTeams、Worker、Agent 和 Leader各自承担不同责任；
2. Work 隔离整件事务，timeline 保留原始沟通和歧义纠错；
3. WorkSpec 是当前目标快照，不授予能力，缺少 Human答案时保持等待；
4. Leader按输入动态创建不可变 Task/TaskSpec，review、测试和发布只是普通 Task；
5. 当前权限来自 AgentTeams、ControlProfile、MemberConfig 与 runtime binding 的交集；
6. prepared environment 让成员高效使用 Bash，同时隔离控制凭据、生产 credential、宿主端点和不允许网络；
7. ContentRef 稳定标识交付内容，Result 是 Task 唯一终态报告，ToolResult 是工具的有界机器观察；
8. timeline、Result、ToolResult 和 Operation event 分别保存不同事实，不建立重复证据包装；
9. 本地 edit/build/test/commit 留在 sandbox；任何共享或外部写都必须通过有版本的 Adapter创建 Operation；
10. Operation 是不可变 typed request，`operationId` 是唯一业务身份；
11. 所有决定效果的 target、commit、mutation、配置、收件人和正文都必须进入 request 并忠实显示在 preview；
12. credential 只在 Adapter 中认证，不能成为隐藏动作内容；
13. ControlProfile 在使用点把 Operation 分为自动允许、需要 Approval 或拒绝；未知写默认拒绝；
14. 即使自动允许，Operation 仍要幂等、started-before-call、后置状态确认和不确定恢复；
15. 下一步将停在“需要 Human Approval”分支，解释人究竟批准什么。

## 自检

1. 本地 commit 与 Git push 为什么处在不同边界？
2. Adapter read 为什么不是 Operation，但仍需要哪些检查？
3. Operation 的最小字段和唯一业务身份是什么？
4. 为什么效果字段不能藏在 credential 或后取 payload 中？
5. 自动允许的 Operation 为什么仍需要完整执行与恢复协议？
6. replay row 与 Operation event 分别是什么层次？
7. ToolResult 为什么不能替代 Operation 外部效果历史？

继续阅读：[第 10 单元](10-exact-approval.zh.md)。

# 单元 09：本地修改与真正改变外部系统

[上一单元：谁决定接不接受，又怎样结束整件事](08-decisions-and-closure.zh.md) | [返回课程目录](README.md) | [下一单元：人批准的必须是即将执行的那一件事](10-exact-approval.zh.md)

## 周明一直在“改变东西”，为什么现在才特殊处理

周明在自己的工作区做过很多改变：编辑文件、生成构建产物、运行测试、创建本地 commit。

这些改变被限制在当前 Task 的隔离空间内。即使代码写坏了，也不会直接覆盖共享仓库或生产服务。

接下来团队希望：

- 把 commit 推送到共享 Git 仓库；
- 创建或合并拉取请求；
- 部署到测试环境；
- 最后部署到生产环境。

这些动作会改变其他人或外部系统能看到的状态，故障影响也不再局限于当前工作区。

## 先画出边界

```text
Task 的隔离工作区内部
  读取文件、编辑、构建、测试、本地 commit

共享或外部世界
  推送分支、合并 PR、发布制品、部署服务、
  修改数据库、发外部消息、删除云资源
```

从第一块越到第二块的动作，需要被系统作为一件独立、可授权、可重放和可恢复的事情管理。

Tiangong 把这种“可能改变 Task 隔离工作区之外的共享或外部状态”的受控动作叫 **Operation**。

## 哪些通常是 Operation

- 推送到共享 Git 仓库；
- 创建或合并拉取请求；
- 发布包或镜像；
- 部署或回滚服务；
- 修改共享数据库、配置、云资源或工单；
- 向企业边界外发送消息；
- 把 Agent 生成内容发布到共享知识库；
- 删除共享资源；
- 轮换凭据。

哪些目标算共享或外部，不由模型临时判断，而由部署配置和注册 Adapter 的 effect class 确定。

## 哪些通常不是 Operation

- 只读查询；
- 模型调用；
- 隔离工作区中的编辑、构建和测试；
- Tiangong 自己的内部记录写入；
- Work 内普通消息；
- 不产生外部修改的状态检查。

普通工具调用仍会受权限、超时和记录边界控制，只是不需要进入外部效果协议。

## 把“部署生产”写成一张执行单

按照案例，团队会先把同一 commit 部署到测试环境并验证，再考虑生产环境。两次部署都是外部操作，也会分别拥有自己的执行单。为了把最完整的控制字段一次讲清，下面先展开风险更高的生产执行单；测试环境的执行单结构相同，只是目标、规则判断和批准要求可能不同。

下面这张执行单比前面的对象长。第一次阅读时不用猜完所有字段，只先观察五组信息：它属于谁、通过什么接口、要改什么、敏感原文放在哪里，以及整张单据怎样防止被调包。JSON 后会按这五组逐项解释。

```json
{
  "operationId": "operation-deploy-55",
  "workId": "work-order-cancel-001",
  "taskId": "task-deploy-cancel-01",
  "invocationId": "invocation-tool-call-88",
  "adapterId": "deployment-adapter",
  "adapterVersion": "1",
  "action": "deploy",
  "target": {
    "environmentId": "production-a"
  },
  "parameters": {
    "subjectRef": {
      "kind": "git-commit",
      "repositoryId": "service-a",
      "commitSha": "9ab73e..."
    },
    "expectedCurrentVersion": "release-41",
    "rollbackVersion": "release-41"
  },
  "protectedPayloadRef": "protected-payload-55",
  "protectedPayloadDigest": "sha256:7d9a...",
  "operationDigest": "sha256:a120...",
  "requestedBy": "member-release",
  "createdAt": "2026-08-10T15:00:00Z"
}
```

## 第一组：它属于哪次工作和哪次工具调用

| 字段 | 含义 |
|---|---|
| `operationId` | 这项外部操作自己的稳定身份 |
| `workId` | 它属于哪一整件 Work |
| `taskId` | 哪一次正式委托提出它 |
| `invocationId` | 哪一次受控 Operation 工具调用创建它 |
| `requestedBy` | 哪个成员请求执行 |

`invocationId` 不是一整个模型回答的身份。一次模型回答可能包含多个工具调用，每个调用都有不同次序和身份。

运行时先保存“这是哪一次模型调用”，再给这次回答中的工具调用按出现顺序编号。这个顺序号在正式实现中叫 tool-call ordinal。模型调用身份、顺序号和当前 Task 一起推导出 `invocationId`。相同工具调用因网络重试再次到达时，会回到同一个 Operation；相同身份却带来不同内容时，系统报冲突。

系统不尝试猜两次真正独立的新请求在业务上是不是“差不多”。通用语义去重既不可靠，也不是这里的目标。

## 第二组：通过哪个受控接口做什么

| 字段 | 含义 |
|---|---|
| `adapterId` 与 `adapterVersion` | 哪个已注册 Adapter 负责解释和执行 |
| `action` | 精确动作类型，这里是 deploy |
| `target` | 要改变哪个受控目标，这里是 production-a |

模型不能把未知动作自称为“只读”。Adapter 和 ControlProfile 共同给出代码可识别的外部效果分类，正式文档称为 effect classification。

## 第三组：执行对象、前置状态和回滚范围

`parameters` 表示：

- 部署的精确 commit 是 `9ab73e...`；
- 只有生产当前版本仍为 `release-41` 才允许执行；
- 如果预先定义的触发条件出现，允许回到 `release-41`。

`expectedCurrentVersion` 很重要。Human 批准后，如果另一个团队已经把生产更新到 `release-42`，原操作不能继续按旧前提覆盖新状态。

## 第四组：为什么有受保护 payload

有些 Operation 包含不适合出现在模型、聊天或普通日志里的原始内容，例如敏感配置值或受限数据变更参数。后文把一项调用真正携带的这部分内容称为 payload，可以先理解成“载荷”或“随单内容”。

原始内容放入受限存储，Operation 只保存：

- `protectedPayloadRef`：去哪里取；
- `protectedPayloadDigest`：取回后应匹配哪一个指纹。

两个字段要么同时存在，要么同时不存在。运行时在授权和执行前都会重新取回并校验。

受保护 payload 是附属于 Operation 的存储内容，不是第二份授权对象。

## 第五组：operationDigest 是什么

可以把 operation digest 想成整张执行单的防调包封条。

它覆盖：

- 动作和目标；
- 非秘密参数；
- 精确 subject；
- 执行前提；
- 预授权回滚计划；
- Task、tool invocation 和工作区范围；
- Adapter 身份与版本；
- 受保护 payload 的引用与 digest。

任何这些内容变化，都会形成不同 digest。Human 批准旧 digest，不能被拿去执行新目标或新参数。

## 谁决定允许、要批准还是拒绝

对于已知 Operation 类型和目标，当前 ControlProfile 只返回三种结果之一：

| 决定 | 含义 |
|---|---|
| `auto_allowed` | 当前规则允许自动执行，但仍要记录、幂等和恢复 |
| `approval_required` | 必须由 Human 对这一项精确操作作出批准 |
| `denied` | 禁止执行 |

未知动作和未知目标一律 denied。

例如：

- 部署临时测试环境可能 auto allowed；
- 部署 production-a 需要 Human 对这项精确操作作出批准；
- 删除未经登记的云账号直接 denied。

是否需要批准与是否需要安全执行协议是两件事。即使 auto allowed，Operation 仍然要有稳定身份、执行前记录、结果确认和不确定状态处理。

## 执行前还要过一道硬门

Operation 创建后，不会因为模型已经选好动作就立刻执行。

执行前代码会重新检查：

- Operation 身份和 digest；
- 受保护 payload 是否匹配；
- 当前请求成员仍有权限；
- 当前 ControlProfile 是否仍允许；
- 目标和前置状态是否未变化；
- Task 与工作区是否仍有效；
- 如果是发布或部署代码，同一个 commit 是否已有合格独立验证；
- 需要 Human 批准时，批准是否确实对应当前这项操作、仍然有效且未过期。

这道执行前机器边界叫 **Gate**。

它和 ResultGuard、CloseGuard 的位置不同：

```text
ResultGuard：能不能创建这份终态交付
Gate：       能不能执行这项外部操作
CloseGuard： 能不能结束整件 Work
```

## 环境不是每次都要变成复杂业务对象

`production-a` 由部署配置识别。配置可以说明风险级别、允许的 Adapter、凭据引用、状态查询方式和支持的 Operation。

Tiangong 不要求每个测试环境、报告和知识对象都拥有一套通用领域模型。只有需要稳定交接或控制的边界才结构化。

## 本单元自检

1. 为什么本地编辑不是 Operation，推送共享仓库通常是？
2. `invocationId` 和 `operationId` 各自解决什么问题？
3. operation digest 为什么必须覆盖受保护 payload 的引用与 digest？
4. `auto_allowed` 为什么仍然需要幂等和恢复？
5. Gate、ResultGuard 和 CloseGuard 分别守在哪个位置？

下一单元会停在 `approval_required` 这条分支，仔细看 Human 到底看见什么、批准什么，以及为什么普通群聊中的“可以上线”仍然不够。

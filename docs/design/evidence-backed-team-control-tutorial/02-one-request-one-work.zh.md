# 单元 02：先给整件事一个稳定身份

[上一单元：一条消息怎样进入受控团队](01-message-to-team.zh.md) | [返回课程目录](README.md) | [下一单元：把模糊需求整理成当前目标](03-clarify-the-goal.zh.md)

## 如果只有聊天历史，会发生什么

林舟已经读到陈晨的取消订单需求。接下来几天，房间里还可能出现：

- 陈晨补充拣货规则；
- 周明报告实现进度；
- 另一个 Human 提问支付故障；
- 陈晨提出完全不同的退款需求；
- Worker 在保存后、回复前崩溃，平台重新投递原消息。

如果系统只有一段不断增长的聊天记录，它就要反复猜：哪些话属于同一件事？同一条消息是不是被处理了两次？新要求是在补充旧目标，还是在创建另一件事？

聊天房间解决的是投递，不是业务事务身份。

## 建立一个最小案卷

Tiangong 把一件可持续跟踪的完整事务叫 **Work**。

```text
Work = “这整件事”的稳定身份、当前投影和时间线入口。
```

收到没有明确旧 Work 关联的消息时，系统可以原子创建：

```json
{
  "workId": "work-order-cancel-001",
  "teamId": "commerce-team",
  "epoch": 1,
  "workSpec": null,
  "createdBy": "human-chen",
  "createdAt": "2026-08-10T09:00:00Z"
}
```

字段逐个读：

| 字段 | 当前含义 |
|---|---|
| `workId` | 以后所有相关消息、Task、Result 和 Operation 回到的稳定身份 |
| `teamId` | 当前由哪个 Team 负责 |
| `epoch` | 防止旧协调判断覆盖新事实的并发号码，后面详细讲 |
| `workSpec` | 当前整件事的目标说明；`null` 表示还没形成 |
| `createdBy/createdAt` | 入口 Human 和创建时间 |

Work 投影不复制原始消息。原消息进入 Work 的追加时间线：

```json
{
  "eventType": "human-message-received",
  "workId": "work-order-cancel-001",
  "platformMessageId": "message-9001",
  "actorId": "human-chen",
  "text": "给商城增加取消订单功能……",
  "createdAt": "2026-08-10T09:00:00Z"
}
```

创建 Work 和写入第一条消息必须一起成功。不能出现“有 Work 没有来源”，也不能出现“保存了消息却找不到所属 Work”。

## 为什么允许 `workSpec: null`

第一句话可能只是：

> 帮我把订单取消做一下。

系统若为了填满字段而猜出“允许哪些订单、恢复哪种库存、是否部署生产”，就是把模型推测伪装成 Human 事实。

更诚实的顺序是：

1. 先承认收到一件新事情；
2. 分配 `workId`；
3. 保留原始消息；
4. 让 `workSpec` 暂时为空；
5. 由 Leader 继续澄清。

当前 WorkSpec 为空时，代码禁止创建 Task。团队可以沟通，但不能把猜测变成正式委托。

## 同一条消息重放时怎么办

假设数据库已经保存 Work，但 Worker 在回复前断开。平台再次投递 `message-9001`。

入口以认证后的平台消息 ID 做幂等：

```text
第一次处理 message-9001
→ 创建 work-order-cancel-001 和第一条 timeline 记录

再次处理同一个 message-9001
→ 返回 work-order-cancel-001
→ 不创建第二个 Work
```

这里不需要模型判断两段文字是否“看起来相同”。稳定事件 ID 才是同一次输入的身份。

## 新消息怎样选择 Work

### 明确关联仍打开的 Work

陈晨在对应线程补充：

> 仓库开始拣货后也不能取消。

平台关联清楚，消息追加到原 Work。

### 没有清楚关联

陈晨另发：

> 退款失败需要自动重试。

即使都与订单相关，也默认创建新 Work。主题相似不能替代明确关联。

### 有多个可能对象

陈晨只说：

> 这个也改一下。

系统无法确定指向取消订单还是退款重试。安全默认仍是创建一个新的占位 Work，由 Leader 询问。

这个规则宁愿暂时多一个 Work，也不让两个目标、数据范围和权限背景被静默混合。

## 关联错了，怎样纠正

假设歧义消息创建了：

```text
work-ambiguous-002
workSpec = null
```

林舟询问后，陈晨确认它其实属于仍打开的 `work-order-cancel-001`。

Tiangong 不删除占位 Work，也不建立通用 merge。它执行三步：

1. 把原平台消息引用和陈晨的确认追加到旧 Work；
2. 给占位 Work 追加 `work-stopped`，理由明确写出正确 Work ID；
3. 占位 Work 从活跃视图消失，但历史保留。

```text
work-order-cancel-001
└─ 收到原 message-9015 的引用与确认

work-ambiguous-002
└─ work-stopped: “确认属于 work-order-cancel-001”
```

为什么不直接删？因为同一平台消息重放时，系统必须解释它曾经创建过什么、后来为何停止。删除会让重放和历史说明失去稳定答案。

为什么不 merge？因为如果占位 Work 已经产生 Task 或外部效果，自动搬运会把权限和责任混到另一件 Work。Leader 必须逐项处理，而不是让框架猜。

## Work 不是什么

### 不是房间

一个房间可以承载很多 Work，一件 Work 也可能跨多天消息。

### 不是需求正文

WorkSpec 才保存当前目标理解；Work 还连接时间线、Task、Result 和 Operation。

### 不是 Task

Work 表示整件事。一次“调查库存接口”或“实现取消逻辑”只是其中一次委托。

### 不是模型 session

session 可以释放、压缩或重建。Work 业务事实必须独立存在。

### 不是“已经开工”

有 Work 只表示系统承认并跟踪这件事。`workSpec: null` 时还不能派发 Task。

继续阅读：[第 03 单元](03-clarify-the-goal.zh.md)。

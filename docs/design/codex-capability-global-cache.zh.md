# Codex 能力探测的全局缓存合同

## 结论

Worker 不应在每次启动时都向模型发一次 Responses 探测。部署层提供一个
AgentTeams-owned 的共享状态路径，例如：

```text
/var/lib/tiangong-capabilities/codex.json
```

第一个遇到新指纹的 Worker 在受控锁内完成一次有界探测并写入该状态；后续
Worker 只读取缓存，不再访问模型探测接口。共享路径必须是部署层挂载的共享
卷，不能落在单个 Worker workspace，也不能让 Worker 直接持有 PostgreSQL
凭证。未来已有 CoordinationStore/PG 服务时，可以把同一合同换成数据库适配器，
不改变 Worker 侧字段。

## 缓存键与失效

缓存键是以下脱敏字段的 SHA-256：

```text
provider + model + credential-free baseUrl + detectorVersion
```

因此模型、provider、endpoint 或探测协议版本不变时复用原结果；任何一个变化
都会形成新键并只让第一个 Worker 重新探测。当前记录默认有效期为 24 小时，
过期后同样只允许一个持锁调用刷新。网络、鉴权、超时和畸形响应不写入可复用
的成功/不支持结论；它们保持启动失败，避免把临时故障缓存成 Chat-only。

## 记录内容

记录只包含 `schemaVersion`、`key`、指纹、`checkedAt`、`expiresAt`、
`outcome`、`reasonCode`、HTTP status、`transport`、provider、model 和
credential-free endpoint。禁止保存 provider key、Worker token、Authorization
header、请求文本、模型原文或 sidecar secret。bridge 记录只决定
`responses-via-chat-bridge`/`opencodex`；每个 Worker 仍需用自己的 ready receipt
取得实际 sidecar endpoint 并通过现有 readiness gate。

## 启动路径

1. Worker 读取共享缓存；命中同一指纹就直接使用 `native-responses` 或
   `responses-via-chat-bridge`。
2. 未命中时，在精确的 `.lock` 目录下重新读取一次；若其他 Worker 已完成，
   复用其结果，否则由当前 Worker 做一次 `POST /responses`、`max_output_tokens=1`
   的有界探测并写入缓存。
3. 只有明确的 404/405/415 或明确“不支持 Responses”的 400 才能选择 OpenCodex；
   探测结果为 bridge 后仍必须通过本 Worker 的 sidecar ready receipt。
4. 缺少共享缓存、锁超时、receipt 缺失或 route 不匹配均 fail-closed，不能静默
   切换 builtin、另一个模型或另一个凭证。

这会把启动开销从“每个 Worker 一次模型探测”降为“每个新模型/provider 指纹
一次探测 + 其余 Worker 一次本地共享状态读取”，同时保留 WebUI/Matrix 和现有
AgentTeams 凭证边界。

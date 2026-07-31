# Tiangong Agent Plane 基础设施实现合同：Reviewer v1

> **状态：** PR1–PR5 硬 Gate 通过；Journey canary 记录为模型 no-progress。
> **范围：** 在当前单 Worker 受控执行内核上，实现第一个可信专业角色：只读、显式文件范围、Evidence-backed 的 Reviewer。
> **保证等级：** `worker-local / static-review-only`。
> **不是：** 已实现能力说明、Team Work、独立 Candidate 验收、测试执行、PR/commit/diff 评审或发布承诺。
> **后续设计：** [`reviewer-next-action.md`](./reviewer-next-action.md) 是待实现的窄增量合同；在其完成验证前，本文的 Reviewer v1 ContextPack 与能力边界仍是当前事实。

## 0. 如何使用本文

本文是 Reviewer v1 的公开、自包含实现合同。实现者应只依赖本仓库、公开依赖及公开文档，不得把仓库外材料变成实现、测试、构建或运行依赖。

开始任一 PR 前必须：

1. 阅读根目录 `AGENTS.md`；
2. 阅读 `docs/rules/implementation.md`、`docs/rules/verification.md`、`docs/rules/security-and-evidence.md` 和 `docs/rules/worker-runtime.md`；
3. 阅读目标模块、调用方和测试，确认本文描述与当前代码仍一致；
4. 若本文与代码现状冲突，先记录差异并修订设计，不得静默猜测；
5. 先证明确定性合同，再运行真实 Matrix/Gateway smoke。

本文定义目标合同，不替代代码中的授权、幂等、路径、Evidence、恢复和清理检查。模型 prompt、Skill 和报告文本都不是安全边界。

---

## 1. 目标与执行摘要

Reviewer v1 建立以下最小闭环：

```text
用户向 Reviewer 提交显式文件评审请求
  → 模型调用 start_work，归纳 objective / criteria / files
  → runtime 创建 durable PracticeRun
  → Reviewer 只能读取最终 scope 中的文本文件
  → wrapper 将成功读取 Evidence 绑定到当前 runId
  → 模型调用 check_completion 提交结构化 review claim
  → checkpoint 交叉验证 claim、最终 scope 和机器 Evidence
  → pass：PracticeRun 进入 done，机器渲染报告和权威状态
  → fail：PracticeRun 保持 active，返回可恢复的缺口
  → 重启或 transcript reset 后从 PracticeRun 恢复，不从 transcript 猜状态
```

Reviewer v1 证明的是：

- 指定 Reviewer profile 被可信加载；
- Reviewer 没有 workspace 写能力；
- 某个 PracticeRun 的最终显式文件 scope 被完整读取；
- 读取对应确定的文件内容 digest 和行区间；
- 结构化评审 claim 通过了可确定验证的最低完成条件。

Reviewer v1 不证明：

- 模型的专业判断绝对正确；
- 测试、构建或运行时行为已经验证；
- 评审对象是某个不可变 commit、PR 或 Candidate；
- 结果经过独立团队验收；
- 模型对用户自然语言意图的归纳已经由用户确认。

---

## 2. 当前公开实现基线

当前 kernel runtime 使用固定 digest-bound profile、静态 methodology、read/write 顺序 wrapper 和 read-allow/write-approval Gate。transcript 位于 `sessions/<hash>/pi/`；Evidence、idempotency、pending payload 和 rollback 由统一 resolver 定位在独立顶层，reset 只删除 `pi/`。Reviewer image 已实现五工具面、scoped UTF-8 read、Evidence、checkpoint、ContextPack 和 machine status，并通过确定性、容器、Matrix Basic 与 Recovery Full。Journey no-progress 保持安全 active。official OpenClaw 拥有 Matrix；peer transport 不是 Team Work。

---

## 3. 冻结的不变量

### 3.1 事实分层

以下事实必须保持分离：

| 事实 | 含义 | 权威载体 |
|---|---|---|
| User request | 用户原始请求 | protected request payload + digest |
| Model-normalized plan | 模型归纳的 objective、criteria、scope | PracticeRun state，标记 `source=model_normalized` |
| Claim | 模型提交的结构化评审结论 | protected claim payload + digest |
| Machine state | run 的 revision/status/scope/checkpoint | PracticeRun append-only journal |
| Machine Evidence | Gate 与 backend 实际执行事实 | hash-chained Evidence |
| Diagnostic telemetry | 运行阶段和性能观测 | sanitized OTel；不得用于完成认证 |

模型 prose、claim 和 machine state 不能冒充 Machine Evidence。Evidence 也只能证明动作和稳定事实，不能证明评审结论的语义绝对正确。

### 3.2 Role Profile 是能力权威

- 每个 Reviewer image 固定一个 `/opt/tiangong-worker/profile.json`；
- 不通过 ENV、Worker 名称、prompt、Skill、Assignment 文本或 tool 参数选择/提升 role；
- profile 只能引用代码内封闭 registry 中的 ID；
- 未列出的能力默认 deny；
- profile 不能包含可执行模块路径；
- registry 隐藏工具和 backend/Gate 复核必须同时存在；
- 未知字段、未知 ID、缺文件、schema mismatch 或冲突全部 fail closed。

### 3.3 一个 session 最多一个 active PracticeRun

- `none → active → done|abandoned`；
- active 时再次 `start_work` 返回 `ACTIVE_RUN_EXISTS`；
- 新用户消息不会自动覆盖、合并或重新解释现有 run；
- objective 和 acceptance criteria 创建后不可变；
- run 绑定创建它的 authenticated actor；read 和所有后续 state transition 必须由同一 actor 发起；
- actor 不匹配时在模型循环前 fail closed，不注入 active ContextPack，也不暴露 runId、objective、criteria 或 scope；
- 新任务必须先完成或显式 abandon 旧 run；
- 旧 run Evidence 永不转移到新 run。

### 3.4 Scope 只增不减

- `scope.files` 在 `start_work` 创建；
- active run 可通过 `extend_scope(files[])` 追加文件；
- 禁止删除、替换或重排已有 scope；
- 每次扩展形成 `scope.revised` journal event；
- completion 始终基于最终 scope；
- scope 扩展不改变 objective 或 criteria；二者变化意味着新任务。

### 3.5 没有 active run 就不能读取 workspace

Reviewer 的 `read` 必须同时满足：

1. 有 active PracticeRun；
2. 调用路径属于当前最终 scope；
3. 路径通过 workspace、symlink、敏感路径、普通文件、文本和容量检查。

否则 Gate/backend fail closed。普通聊天可以不创建 Work，但只能得到 `direct-unverified` 结果，不能读取项目文件。

### 3.6 Evidence 必须由 runtime 绑定

- `start_work` 前的事件不计入 run；
- wrapper 自动把后续工具事件绑定到当前 `practiceRunId`；
- 模型不能提供、选择或伪造 Evidence ref；
- checkpoint 只消费链验证通过、绑定当前 run、Gate allow、backend success 的事件；
- event ref 使用 `sessionId + turnId + toolCallId + sequence + eventHash`；
- `operationDigest` 不能冒充文件内容 digest 或 Evidence event hash。

### 3.7 done 只能来自 checkpoint pass

- 模型文本不能推进 status；
- `check_completion` fail 时保持 active；
- 只有绑定当前 revision、claim digest 和 Evidence terminal hash 的 checkpoint pass 才能写入 done；
- `abandon_work` 只能进入 abandoned，不能伪装为成功；
- terminal run 不再接受 read、scope extension 或 completion mutation；
- `done` 只表示评审流程和 checkpoint 已终结，不等于 report outcome 为 `accept`；无法处理的 criterion 可产生 `done + blocked`。

### 3.8 Transcript 与业务状态物理分离

- transcript 只位于 `sessions/<session-hash>/pi/`；
- PracticeRun、claim、Evidence、idempotency、pending operation 和 rollback snapshot 位于与 `sessions/` 平级的独立顶层；
- transcript reset 只删除 `pi/`，删除或重建整个 `sessions/<session-hash>/` 也不得触及业务状态；
- restart/reset 后从 durable state 组装 ContextPack；
- 不从 transcript 重建授权、scope、checkpoint 或完成状态；
- 业务状态清理必须是另一项显式、可审计操作，不能借 transcript reset 实现。

### 3.9 状态必须对用户可见

普通模型 turn 的 TurnResult 必须带结构化 `workStatus`，并由 adapter 投影为最终机器状态块。模型不能设置或覆盖该状态。

### 3.10 首版保持顺序执行

Reviewer tools 全部 `executionMode="sequential"`。在并发 Gate、Evidence、PracticeRun CAS 和 idempotency 语义完成前，不启用 parallel tool execution。

---

## 4. Reviewer v1 范围

### 4.1 支持

- 用户给出或模型从当前请求归纳出的显式 workspace 文件列表；
- UTF-8 文本代码、配置和文档；
- 单 turn 或多 turn 静态评审；
- 同一 objective 下 append-only scope 扩展；
- 大文件按行分段读取；
- Worker restart 和 transcript reset 后恢复；
- 结构化 `accept / changes_requested / blocked` 报告；
- `done / active / abandoned / direct-unverified` 的机器可见状态。

### 4.2 不支持

- 目录、glob 或仓库自动枚举；
- `ls/find/grep`；
- git status、working-tree diff、staged diff、commit、branch range、PR；
- `bash`、测试、构建、lint 或程序执行；
- image、binary、PDF、Office 文档或视觉评审；
- workspace write、修复、文档更新或测试资产生成；
- waiting-for-user 状态和 `ask_user/resume_work`；
- 多 active work、自动任务切换或 NLP routing；
- Concern、Local Helper、search/fetch/browser/vision；
- Team Work、Coordinator、Assignment、Candidate、ResultEnvelope；
- Team-verified 或独立 Candidate freshness 保证；
- protected payload 自动过期或自动删除。

如果用户请求不在以上范围，模型应解释能力边界；代码只保证工具与结果类型不可越权，不保证模型能够正确语义分类所有自然语言任务。

---

## 5. Role Profile 合同

### 5.1 Reviewer profile

源文件建议放在：

```text
worker/role-profiles/reviewer.json
```

Reviewer image 构建时只把该文件复制为：

```text
/opt/tiangong-worker/profile.json
```

目标 schema：

```json
{
  "schemaVersion": 1,
  "roleId": "reviewer",
  "title": "Reviewer",
  "practiceIds": ["review"],
  "toolIds": [
    "start_work",
    "extend_scope",
    "read",
    "check_completion",
    "abandon_work"
  ],
  "gatePolicyId": "reviewer-v1",
  "roleSkillId": "reviewer-v1"
}
```

要求：exact-key 和受支持 version；有界 ASCII ID；数组非空、唯一、有上限；tool 禁止 write/edit/bash；所有 ID 完整匹配封闭 registry。loader 在模型 session/active registry 前校验并返回 frozen deep clone。profile digest 可用于诊断、容器验收和 Evidence 关联，不能由模型传入。

### 5.2 封闭 registries

建议职责：

```text
role registry
  roleId → allowed profile shape and backend role policy

tool registry
  toolId → code-owned wrapped ToolDefinition factory

practice registry
  practiceId → code-owned PracticeDefinition

gate policy registry
  gatePolicyId → code-owned authorization evaluator

role skill registry
  roleSkillId → image-owned, bounded methodology resource
```

Profile 只做选择，不加载任意代码或任意路径。

### 5.3 Reviewer backend truth table

| 动作 | 可见 | Gate | Backend |
|---|---:|---:|---:|
| start_work(review) | 是 | allow if no active run | validate/create journal |
| extend_scope | 是 | allow if active | append-only scope CAS |
| read scoped text file | 是 | allow if active + in scope | constrained read |
| check_completion | 是 | allow if active | run checkpoint |
| abandon_work | 是 | allow if active | terminal transition |
| write/edit/bash | 否 | deny | 不得存在可达 executor |
| Coordinator/Team transition | 否 | deny | 不得存在可达 executor |
| unknown tool | 否 | deny | fail closed |

---

## 6. Practice 合同

### 6.1 PracticeDefinition

PracticeDefinition 是代码对象，不是可写 workspace 配置：

```js
{
  id: "review",
  version: 1,
  supportedRoleIds: ["reviewer"],
  methodologySkillId: "review-v1",
  completionSchemaId: "review-claim-v1",
  checkpointIds: [
    "claim-schema-valid",
    "criteria-covered",
    "scope-matches-final",
    "scope-fully-read",
    "observation-targets-valid",
    "outcome-consistent",
    "static-review-limitation-recorded",
    "no-mutation-observed"
  ]
}
```

约束：

- practice definition 与 checkpoint 模块均来自 image 内代码；
- profile 只能按 ID 启用；
- methodology 是 advisory context，不授予权限；
- completion schema 和 checkpoint 有独立版本；
- v1 不实现 Concern runner；
- 不读取 workspace 中的 Skill、extension、prompt template 或 practice definition。

### 6.2 Role 和 methodology 内容

Role Skill 描述身份与能力边界，Practice methodology 描述静态评审方法。二者位于 image、由封闭 ID 引用，并校验 UTF-8、大小、普通文件、symlink 和 digest；不得包含凭据或授予权限，缺失或无效时 fail closed。

---

## 7. PracticeRun 权威状态

### 7.1 存储布局

固定布局：

```text
<worker-state-root>/
  sessions/<session-hash>/
    pi/                              # transcript only
  practice-runs/<session-hash>/
    events.jsonl                     # 权威 append-only journal
    snapshot.json                    # 可重建引用缓存，mode 600
    protected/
      requests/<digest>.json         # raw ingress，mode 600
      specs/<digest>.json            # objective/criteria，mode 600
      claims/<digest>.json           # claim/report，mode 600
      notes/<digest>.json            # abandonment summary，mode 600
  evidence/<session-hash>/
    events.jsonl
    events.jsonl.segment-...
  idempotency/<session-hash>/
    idempotency.jsonl
  pending-operations/<session-hash>/
  rollbacks/<session-hash>/
```

要求：

- `session-hash` 由已有稳定 session identity 派生，不能用模型输入构造路径；
- 五类业务状态顶层与 `sessions/` 平级，均保持 per-session 语义；
- 所有 runtime、retention、reconciliation 和 test caller 必须共用代码拥有的 state-path resolver，不得各自拼接布局；
- 布局改变不削弱 Evidence chain、approval、idempotency、pending payload、rollback 或 recovery 合同；
- AgentTeams pending payload 的 remote object path 随新固定本地路径同步更新并测试；
- 项目初始化采用 clean cut，不加入旧路径扫描、复制、迁移或 compatibility shim。

### 7.2 Materialized PracticeRun

从 journal 折叠得到的目标形态：

```json
{
  "schemaVersion": 1,
  "runId": "run-...",
  "sessionId": "...",
  "roleId": "reviewer",
  "profileDigest": "sha256:...",
  "practiceId": "review",
  "practiceVersion": 1,
  "status": "active",
  "revision": 2,
  "origin": {
    "actorId": "@user:example.test",
    "messageId": "$event",
    "requestDigest": "sha256:...",
    "requestPayloadRef": "requests/<digest>.json"
  },
  "objective": {
    "text": "Review the selected authentication files",
    "source": "model_normalized"
  },
  "acceptanceCriteria": [
    {
      "id": "criterion-1",
      "description": "Identify correctness and security risks",
      "source": "model_normalized"
    }
  ],
  "scope": {
    "revision": 2,
    "files": [
      "worker/agent/runtime.mjs",
      "worker/agent/tools/wrapper.mjs"
    ],
    "digest": "sha256:...",
    "source": "model_normalized"
  },
  "lastCheckpoint": null,
  "startedAt": "...",
  "updatedAt": "...",
  "finishedAt": null
}
```

要求：

- `runId` 由 runtime 生成；
- origin 必须包含非空、经过 Channel Plane 认证的 actor ID 和稳定 source message ID；缺失时拒绝创建 run；
- 后续 read/state-transition 的 actor 必须与 origin actor 精确匹配；
- criterion ID 由 runtime 按输入顺序生成，模型只提交描述；
- objective/criteria 创建后没有更新 API；
- scope path 使用 workspace-relative normalized path；
- scope digest 对 canonical ordered file array 计算；
- disk snapshot 只保存 journal-derived refs 和索引，不复制 objective、criteria、request 或 claim 文本；
- snapshot 不能覆盖 journal 权威；
- snapshot 缺失或不一致时，在 journal 完整验证后忽略并重建；journal 无效时才 fail closed；
- journal 损坏、partial record、hash/revision 不连续时 fail closed，不静默修复。

### 7.3 Journal record

公共字段至少包括：

```text
schemaVersion
sequence
runId
runRevision
stateEventId
eventType
invocationKey
actorId
sourceMessageId
payloadDigest
payload
previousHash
hash
timestamp
```

要求：

- canonical JSON；
- SHA-256 previous-hash chain；
- file lock 包围 reload/validate/append；
- append 后 fsync 文件；首次创建或替换 snapshot 时同步目录；
- `sequence` 是 session journal 顺序，`runRevision` 是 run CAS 版本；
- invocation index 拒绝同一 invocation identity 的不同 action digest；
- 同一 invocation replay 返回保存的安全结果，不重复追加事件。

### 7.4 Journal events

#### `run.started`

- 前置：没有 active run；
- payload：role/practice/profile digest、origin digest、run-spec digest/ref、初始 scope；
- objective/criteria 正文只存在于 protected run spec，不复制进 journal；
- 结果：status=`active`，revision=`1`。

#### `scope.revised`

- 前置：run active、expected revision 匹配；
- payload：新增文件、旧 scope digest、新 scope digest、source=`model_normalized`；
- 结果：scope append-only，revision + 1；
- 已有文件不能被新 invocation 再添加；原 invocation replay 除外。

#### `checkpoint.evaluated`

- 只用于未通过的 completion attempt；
- payload：claim digest、Evidence terminal hash、selected event refs、checkpoint reason codes；
- 结果：status 保持 active，revision + 1。

#### `run.completed`

- 是通过 checkpoint 与 terminal transition 的单一权威记录；
- payload 包含完整 checkpoint result、claim digest、Evidence terminal hash 和 selected event refs；
- 只有 `allSatisfied=true` 才合法；
- 结果：status=`done`、finishedAt 设置、revision + 1。

#### `run.abandoned`

- 前置：run active；
- payload：有界 reason code、summary digest/ref、source message ID；
- abandonment summary 正文只存在于 protected note，不复制进 journal；
- 结果：status=`abandoned`、finishedAt 设置、revision + 1。

### 7.5 状态转换表

| 当前状态 | 动作 | 结果 |
|---|---|---|
| none | start_work | active |
| none | extend/read/check/abandon | deny |
| active，actor mismatch | start/extend/read/check/abandon | `RUN_REQUESTER_MISMATCH`，模型循环前拒绝 |
| active | start_work | `ACTIVE_RUN_EXISTS` |
| active | extend_scope | active，scope revision + 1 |
| active | read(in-scope) | active，不改 run revision |
| active | read(out-of-scope) | deny |
| active | check_completion(fail) | active，记录 checkpoint.evaluated |
| active | check_completion(pass) | done，记录 run.completed |
| active | abandon_work | abandoned |
| done/abandoned | 针对旧 run 的 extend/read/check/abandon | deny |
| done/abandoned 且无其它 active run | start_work | 创建新 active run |

---

## 8. Protected payload

### 8.1 分类

- 原始 ingress prompt：potentially sensitive；
- 模型归纳的 objective/criteria 和 abandonment summary：potentially sensitive；
- completion claim/report：potentially sensitive；
- 这些正文不得进入 hash-chained Evidence、OTel、错误日志、journal payload 或文件名；
- journal 只保存 digest/ref、normalized scope、reason code 和状态推进所需的有界元数据。

### 8.2 写入合同

- 目录 mode `0700`，文件 mode `0600`；
- 文件名只使用 runtime 计算的 lowercase SHA-256 digest；
- payload envelope 必须含受支持的 kind/version，canonical payload digest 与引用必须一致；
- 使用临时文件 + fsync + atomic rename；
- 拒绝 symlink、非普通文件、权限无法收紧、digest mismatch 和 partial JSON；
- 写入后 journal 才能引用；未被 journal 引用的 crash orphan 不得被当作 Work state。

### 8.3 初始限制

集中定义并测试以下推荐上限：

```text
MAX_OBJECTIVE_BYTES=4KiB                 MAX_CRITERIA_COUNT=32
MAX_CRITERION_BYTES=2KiB                 MAX_SCOPE_FILES=64
MAX_SCOPE_PATH_BYTES=1KiB                MAX_SCOPE_TOTAL_PATH_BYTES=32KiB
MAX_FILE_BYTES=2MiB                      MAX_SCOPE_BYTES_AT_ADMISSION=16MiB
MAX_FILE_LINES=100000                    MAX_READ_SEGMENTS_PER_FILE=128
MAX_SELECTED_EVENT_REFS=2048             MAX_JOURNAL_RECORD_BYTES=1MiB
MAX_REQUEST_PAYLOAD_BYTES=256KiB         MAX_CLAIM_PAYLOAD_BYTES=256KiB
MAX_OBSERVATIONS=256                     MAX_CONTEXT_PACK_BYTES=64KiB
```

若 Matrix/OpenClaw 有更低公开限制，采用更低值并同步本文与测试。

### 8.4 Retention

Reviewer v1 不自动删除 request/spec/claim/note protected payload，terminal 后仍保留。未来 operator purge 必须显式指定 terminal run/payload，记录 actor、reason、digest 和结果，仅删除不再用于恢复的 payload，且绝不删除 PracticeRun journal/Evidence；该流程需独立测试，不属于 v1。

---

## 9. Tool 和 wrapper 合同

### 9.1 执行类别

将当前 `sideEffect` 二元概念演进为：

```text
read-only
state-transition
external-side-effect
```

| 类别 | 示例 | 人工审批 | Crash 后恢复 |
|---|---|---:|---|
| read-only | Reviewer read | 否 | 可重新读取；Evidence 只记录真实完成 |
| state-transition | start/extend/check/abandon | Reviewer v1 否 | 依据 journal 自动恢复/replay |
| external-side-effect | workspace write | 按现有策略 | outcome uncertain 时 operator reconciliation |

不得削弱当前 write 的审批、payload、rollback、idempotency 或 reconciliation 语义。

### 9.2 通用 state-transition 约束

- 仍记录 proposal、Gate decision、execution start 和 completion/replay；
- action digest 由代码对规范化参数、role/profile、run/revision 计算；
- operation builder 可读取 trusted invocation context，但写入 Evidence 的 operation 只能包含 digest、大小、版本和 normalized metadata，不能包含 raw request/claim/summary；
- `check_completion` 在写入自身 `tool.proposed` 前验证 Evidence chain并固化 terminal sequence/hash，action digest 绑定该边界；
- 幂等 identity 绑定 `sessionId + turnId + toolCallId + actionDigest`；
- journal event 保存 invocation identity 和安全 replay result；
- journal 已提交但 wrapper completion Evidence 未写入时，重启可记录“从 state event 恢复/重放”的新事实，不得伪造原 completion 时间；
- state journal 能证明本地状态迁移结果，因此不进入 external-side-effect 的 uncertain reconciliation；
- profile/Gate deny 发生在 backend 前；
- active run 存在时，runtime 在进入模型循环前校验当前 authenticated actor 与 origin actor；不匹配时返回稳定 control error；
- tool result 和错误必须有稳定 code，不泄露 payload。

### 9.3 `start_work`

模型参数：

```json
{
  "practiceId": "review",
  "objective": "...",
  "acceptanceCriteria": ["..."],
  "files": ["path/to/file"]
}
```

runtime 自动补充：

- 已认证且非空的 actor/message/turn/session；
- request digest 和 protected request ref；
- normalized objective/criteria 的 protected run-spec digest/ref；
- role/profile digest；
- generated run ID、criterion IDs、timestamps、revision；
- normalized file paths 和 scope digest。

失败码至少包括：

```text
AUTHENTICATED_ACTOR_REQUIRED
SOURCE_MESSAGE_ID_REQUIRED
RUN_REQUESTER_MISMATCH
ACTIVE_RUN_EXISTS
PRACTICE_NOT_ALLOWED
INVALID_OBJECTIVE
INVALID_CRITERIA
INVALID_SCOPE
SCOPE_LIMIT_EXCEEDED
PATH_OUTSIDE_WORKSPACE
PATH_NOT_REGULAR_FILE
SENSITIVE_PATH_DENIED
STATE_CORRUPTED
STALE_STATE
```

### 9.4 `extend_scope`

参数：

```json
{
  "files": ["additional/file.mjs"]
}
```

要求：

- machine context 提供 expected run/revision，模型不授予 revision 权威；
- 输入数组非空、唯一；
- 新 invocation 不能包含已经在 scope 中的文件；
- 先完成全部路径/容量验证，再一次性 append；
- 部分通过、部分失败时整体失败；
- 成功后同一 turn 的 TurnContext 立即更新；
- read Gate 随即只认新最终 scope；
- action source 绑定当前 ingress digest并标记 `model_normalized`。

失败码至少包括：

```text
ACTIVE_RUN_REQUIRED
RUN_NOT_ACTIVE
RUN_REQUESTER_MISMATCH
SCOPE_FILE_ALREADY_PRESENT
SCOPE_LIMIT_EXCEEDED
STALE_RUN_REVISION
INVALID_SCOPE
```

### 9.5 `read`

Reviewer read 仅支持当前 scope 内普通 UTF-8 文本文件。

请求沿用按行读取：

```json
{
  "path": "worker/agent/runtime.mjs",
  "offset": 1,
  "limit": 2000
}
```

backend 必须使用 fatal UTF-8 decoder 拒绝 replacement decoding，并基于实际返回内容所读取的同一份文件 Buffer 计算：

```text
fileDigest
fullFileBytes
fullFileLines
returnedLineStart
returnedLineEnd
returnedBytes
returnedLines
truncated
```

Evidence：

- operation metadata：normalized path、offset/limit、workspace scope、policy version；
- completion result metadata：上述 digest/size/range；
- 不保存文件正文；
- `fileDigest` 是文件内容版本，不是 operation digest；
- 分段读取同一目标必须使用相同 `fileDigest`；
- 文件在分段期间变化会使 checkpoint fail；
- 读取失败不计入完成 Evidence。

失败码至少包括：

```text
ACTIVE_RUN_REQUIRED
RUN_REQUESTER_MISMATCH
PATH_NOT_IN_PRACTICE_SCOPE
PATH_OUTSIDE_WORKSPACE
SYMLINK_DENIED
SENSITIVE_PATH_DENIED
PATH_NOT_REGULAR_FILE
BINARY_FILE_UNSUPPORTED
INVALID_UTF8
FILE_LIMIT_EXCEEDED
READ_RANGE_INVALID
```

### 9.6 `check_completion`

参数：

```json
{
  "completionClaim": {
    "criteriaResults": [],
    "scope": { "files": [] },
    "report": {}
  }
}
```

执行顺序：

1. wrapper preflight 要求 active run，且当前 authenticated actor 与 origin actor 匹配；
2. 在内存中严格校验 claim schema并计算 claim digest，raw claim 不进入 operation Evidence；
3. 在 `tool.proposed` 前验证 Evidence chain，固化 terminal sequence/hash；
4. 用 claim digest、run revision 和 Evidence boundary 计算 action digest；
5. 正常记录 proposal、Gate allow 和 execution start；
6. backend 保存 protected claim；
7. 只投影 Evidence boundary 及之前、绑定当前 run 的成功 review-read 执行和修改性审计事实；
8. 运行全部 checkpoint；
9. fail：append `checkpoint.evaluated`，保持 active；
10. pass：append `run.completed`，进入 done；
11. 返回结构化结果；pass 时允许 runtime 机器渲染最终报告。

operation/action digest 至少绑定：

```text
runId
expectedRunRevision
practiceId/version
completionSchemaId/version
checkpointSetId/version
claimDigest
evidenceTerminalHash
profileDigest
```

模型不提交 toolCallId、event hash 或 Evidence refs。

### 9.7 `abandon_work`

参数：

```json
{
  "reasonCode": "superseded_by_new_request | unsupported_scope | cannot_complete | user_cancelled | other",
  "summary": "..."
}
```

要求：

- 仅 active run，且当前 authenticated actor 与 origin actor 匹配；
- summary 有大小上限；
- append terminal `run.abandoned`；
- 不删除 Evidence、request 或已有 claim；
- 不把 abandoned 显示为 completed；
- replay 不重复归档或推进 revision。

---

## 10. Evidence projection

### 10.1 Event binding

wrapper 在 active run 下写入工具 Evidence 时，公共上下文增加：

```text
practiceRunId
roleId
profileDigest
practiceId
practiceVersion
```

`start_work` 创建 run 前的 proposal/Gate 事件没有 runId；创建成功后单独记录 state event ref。完成 start 后，同一 turn 的后续工具必须看到更新后的 active run context。

### 10.2 EventRef

```json
{
  "sessionId": "...",
  "turnId": "...",
  "toolCallId": "...",
  "sequence": 42,
  "eventHash": "..."
}
```

必要时 checkpoint result 可同时保存 `operationDigest`，但它不能替代以上字段。

### 10.3 Projection 算法

`evidence/projection.mjs` 应：

1. 验证全部 segment/active chain，并确认调用方提供的 terminal sequence/hash 确实位于该链；
2. 只读取该 terminal boundary 及之前的事件；当前 `check_completion` 自身随后产生的事件不属于检查输入；
3. 只选择 `practiceRunId` 等于当前 run、且 actor binding 与 origin 一致的事件；
4. 对 practice-required `read` 和修改性审计事件，按稳定 invocation/operation identity 关联 proposal、Gate、started、completed；
5. 验证相关事件顺序和字段一致；
6. review-read 只接受 Gate allow + backend success；
7. 对相关 read/mutation group 的重复、缺失、矛盾或 ambiguous identity fail closed；state-transition 工具不作为 review-read completion Evidence；
8. 从 `gate.decided.operation` 取得 normalized request；
9. 从 `tool.execution.completed` 取得 backend result metadata；
10. 返回内部 `CapturedExecution` 投影，不复制 raw tool output；
11. 返回本次选择的 exact EventRefs 和调用方固化的 chain terminal sequence/hash。

建议内部类型：

```text
CapturedExecution
  practiceRunId
  toolName
  invocationIdentity
  operationDigest
  operation
  resultMetadata
  startedRef
  completedRef
```

### 10.4 Read coverage

对最终 scope 中每个文件：

- 至少一个成功 read；
- 所有用于该文件的片段必须具有相同 `fileDigest/fullFileLines`；
- 读取区间并集必须无缺口覆盖 `1..fullFileLines`；
- 超范围、空范围、错误结果不计；
- 只读取文件头部不算完整；
- 若文件 digest 混杂，要求重新完整读取当前版本。

---

## 11. Completion claim 与 checkpoint

### 11.1 Claim schema

```json
{
  "criteriaResults": [
    {
      "criterionId": "criterion-1",
      "status": "addressed",
      "explanation": "..."
    }
  ],
  "scope": {
    "files": ["worker/agent/runtime.mjs"]
  },
  "report": {
    "outcome": "accept",
    "synopsis": "...",
    "observations": [
      {
        "level": "minor",
        "target": {
          "path": "worker/agent/runtime.mjs",
          "lineStart": 35,
          "lineEnd": 35
        },
        "statement": "...",
        "rationale": "...",
        "suggestedAction": "...",
        "confidence": "high"
      }
    ],
    "limitations": [
      {
        "code": "STATIC_REVIEW_ONLY",
        "detail": "No tests or runtime commands were executed."
      }
    ],
    "nextActions": []
  }
}
```

Schema 要求：

- exact keys；
- 所有字符串/数组有上限；
- `criteriaResults[].status` 只允许 `addressed | not_addressed`；
- 两种 status 都要求非空有界 explanation；`not_addressed` 应说明当前静态能力为何无法处理，但机器只验证结构，不认证理由语义；
- `criteriaResults`、`scope.files`、`observations`、`limitations`、`nextActions` 必须存在；
- enum 使用严格固定值；
- 不允许 model-provided Evidence ref、toolCallId 或 digest；
- `report.synopsis` 必须为非空有界字符串；
- observation 使用 exact keys：`level/target/statement/rationale/suggestedAction/confidence`；
- target 使用 exact keys：`path`，以及同时出现或同时省略的 `lineStart/lineEnd`；
- limitations 在 v1 必须恰好为一个 `{code:"STATIC_REVIEW_ONLY", detail}`；
- `nextActions` 数组可为空；每个元素必须是有界非空字符串；
- claim 中名为 rationale/detail 的文本仍是模型 claim，不是机器 Evidence。

### 11.2 Checkpoint set

#### `claim-schema-valid`

严格验证 schema、大小、枚举、exact keys 和 UTF-8 字符串。

#### `criteria-covered`

- 每个 run criterion 恰好出现一次，不允许未知 ID；
- status 必须为 `addressed` 或 `not_addressed`；
- 两者都必须有非空有界 explanation；后者应说明所需的额外能力或对象；
- 不要求全部 criterion 为 `addressed`。

这里只证明模型逐项作出结构化声明，不证明处理结果或无法处理的理由语义正确。

#### `scope-matches-final`

- claim scope 与 materialized final scope 完全一致；
- 顺序、normalized path、数量均一致；
- 不允许遗漏、额外文件或别名路径。

#### `scope-fully-read`

按 §10.4 验证最终 scope 每个文件的完整、同版本 read Evidence。

#### `observation-targets-valid`

- target 必须是 exact-key object，不使用 `path:line` 字符串解析；
- `target.path` 必须与最终 scope 中的 normalized path 精确匹配；
- 可选 `lineStart/lineEnd` 必须同时出现、为正整数、顺序合法且不超过该版本文件总行数；
- 不接受任意 URL、绝对路径或额外 location 字段。

#### `outcome-consistent`

初始规则：

- 有 `critical` observation 或任一 `not_addressed` criterion → outcome 必须为 `blocked`；
- 无上述 blocker 且有 `major` → outcome 必须为 `changes_requested`；
- 全部 criterion 为 `addressed` 且无 critical/major → outcome 必须为 `accept`；
- `blocked` 至少有一个 critical 或一个 `not_addressed`；
- `changes_requested` 至少有一个 major，且不能有 blocker；
- 存在 `not_addressed` 时 `nextActions` 至少一项，用于声明所需额外验证或输入。

因此全部 criterion 为 `not_addressed` 仍可在完整 read Evidence 等其它 checkpoint 通过后完成，但结果只能是 `done + blocked`，不能伪装为 accept。

#### `static-review-limitation-recorded`

limitations 必须恰好包含一个 `STATIC_REVIEW_ONLY` item，不允许其它 limitation code；该事实也由 profile 工具集机器确定，不以模型文字作为权限证明。

#### `no-mutation-observed`

检查绑定当前 run 的投影中不存在修改性执行。Reviewer Gate 本应事前阻止写；该 checkpoint 是结果审计，不替代 Gate。

### 11.3 Checkpoint result

```text
CheckpointResult
  schemaVersion
  runId
  runRevision
  claimDigest
  evidenceTerminalHash
  allSatisfied
  results[]
    checkpointId
    satisfied
    reasonCode?
    selectedEventRefs[]?
  evaluatedAt
```

失败反馈只返回稳定 reason code 和可执行恢复提示，不泄露 protected payload 或要求模型读取 runtime state 文件。

---

## 12. Context assembly

### 12.1 基础 prompt

session 创建时由可信 profile、role Skill、Practice methodology 和 active tool metadata 构建基础 system prompt，替代当前硬编码 `SYSTEM_PROMPT`。

继续设置：

```text
noContextFiles=true
noExtensions=true
noPromptTemplates=true
noSkills=true
noThemes=true
```

Tiangong 自己显式注册的 inline extension factory 不属于自动 discovery。

### 12.2 Per-turn ContextPack

使用 Tiangong-owned `before_agent_start` inline extension，在每个普通模型 turn 前先校验 requester binding，再读取权威 state 并追加本 turn system prompt：

```text
ContextPack
  schemaVersion
  roleId/profileDigest
  assuranceLevel
  activeRun?
    runId/revision/status
    objective + source
    acceptanceCriteria[] + source
    final scope revision/files/digest
    last checkpoint reason codes
```

约束：

- 有大小上限；超限在 start/extend 阶段提前拒绝；
- 仅当当前 authenticated actor 与 run origin actor 匹配时包含 active run；
- actor mismatch 时不进入模型循环，并返回不含 run 细节的稳定 control error；
- 不包含完整 Evidence、raw request、claim payload、session transcript 或其它 Worker 状态；
- 不持久化为重复 custom messages；
- `start_work` 后同一 agent loop 通过 tool result 得知新状态；
- 下一 Matrix turn/restart/reset 重新组装；
- ContextPack 只帮助模型认知，不授予权限。

### 12.3 不提供 `work_status`

Reviewer v1 不注册 `work_status` 工具。模型通过：

- start/extend/check/abandon tool result；
- 下个 turn 的可信 ContextPack；
- 最终机器 status block

获知 Work 状态。

---

## 13. TurnResult 和用户可见状态

### 13.1 结构化 workStatus

普通模型 turn 的 TurnResult 增加：

```json
{
  "workStatus": {
    "assurance": "direct-unverified | worker-local",
    "runId": "run-... | null",
    "practiceId": "review | null",
    "state": "none | active | done | abandoned",
    "checkpoint": "not-run | failed | passed | not-applicable",
    "scopeRevision": 2,
    "scopeFileCount": 2
  }
}
```

所有字段由 runtime 从 machine state 生成并严格规范化。actor mismatch control result 不得携带 runId、practiceId、scope 或 checkpoint 细节。

### 13.2 Matrix 状态块

OpenClaw adapter 在普通模型输出末尾追加：

```text
---
Tiangong machine status
assurance: worker-local
work: run-...
practice: review
state: done
checkpoint: passed
scope: revision 2, files 2
verification: static-review-only
```

规则：

- 最后一个状态块是权威机器投影；
- 模型输出中的保留 marker 必须转义；
- 无 Work 时显示 `assurance: direct-unverified`；
- active checkpoint fail 必须显示 active/failed；
- pass 只称 worker-local，不称 team-verified；
- peer transport 等依赖精确 marker 的 deterministic control turn 不追加状态块；
- adapter 不自行计算 Work 状态，只渲染已验证 TurnResult。

### 13.3 机器渲染完成报告

`check_completion` pass 后，runtime 可从已验证 claim 机器渲染最终报告，避免模型在 done 后重新改写结论。渲染必须明确区分：

- `Review claim`：模型专业判断；
- `Machine completion facts`：scope、file digests/refs、checkpoint/status；
- `Verification limitation`：static-review-only。

若最终 assistant prose 为空，但存在有效 `run.completed`，runtime 应使用该机器渲染结果，而不是报“无 assistant text”。

---

## 14. Reset、restart 和 crash 语义

### 14.1 Transcript reset

`PersistentSessionStore.reset()` 仍按最小权限只删除：

```text
sessions/<session-hash>/pi/
```

业务状态已物理迁出 `sessions/`；这不是扩大 reset 删除范围的理由。测试既要证明 reset 前后五类业务状态的 identity/digest 不变，也要直接删除整个 `sessions/<session-hash>/` 后证明它们仍完整可恢复。

### 14.2 Worker restart

重启后：

1. 加载并验证 fixed profile；
2. 用 state-path resolver 派生该 session 的各独立顶层路径；
3. 验证 PracticeRun journal并重建/验证 snapshot 与 invocation index；
4. 验证 Evidence chain 和 idempotency journal；
5. 打开 pending-operation/rollback recovery state，不自动重跑外部 side effect；
6. 打开 pi transcript（存在则恢复，不存在则新建）；
7. 新 turn 组装 ContextPack。

### 14.3 State-transition crash points

必须确定性测试：

| Crash point | 恢复语义 |
|---|---|
| protected payload 写入前 | 无 state event，安全重试 |
| protected payload durable、journal 前 | orphan 不构成 Work；安全忽略/后续维护清理 |
| Evidence started 前 | 无 backend 执行事实 |
| Evidence started 后、journal 前 | state 未推进；同 invocation 可安全重试 state transition |
| journal commit 后、wrapper completion 前 | journal 是权威；恢复/replay 返回已保存结果并记录新的 replay/recovery 事实 |
| run.completed 后、Matrix delivery 前 | 不重复 completion；下个 turn 从 done + claim 渲染结果 |
| scope.revised 后、read 前 | 新 scope 保留；下个 turn 继续读取新增文件 |

不得把后到的模型 prose用作 crash reconciliation 依据。

---

## 15. Observability

OTel phase 只允许 `practice.run.start`、`practice.scope.extend`、`practice.checkpoint.pass|fail`、`practice.run.abandon`；属性限 practice ID、status、scope count/revision、outcome 和 digest correlation。禁止 path/payload/模型文本/raw error；OTel 缺失不得影响权威结果。

---

## 16. 模块边界

| 职责 | 建议位置 |
|---|---|
| Fixed profile/methodology | `worker/role-profiles/`、`worker/roles/reviewer/`、`worker/practices/review/` |
| Profile/role registry | `worker/agent/config/`、`worker/agent/roles/` |
| Practice state/checkpoint | `worker/agent/practices/` |
| Work tools/status | `worker/agent/work/` |
| Per-turn context | `worker/agent/context/` |
| Evidence projection | `worker/agent/evidence/projection.mjs` |
| 独立 state roots | `worker/agent/persistence/` 中代码拥有的统一 path resolver |

集成涉及 runtime/session、maintenance CLI、pending remote、tool/Evidence/Gate、adapter、image 和 smoke。路径拼接不得分散，业务判断不得进入 adapter/prompt；新增依赖须审查公开来源、pin、许可证和供应链。

---

## 17. 五个 PR 的实施顺序

| PR | 唯一交付边界 | 必需验证与禁止声明 |
|---|---|---|
| PR1 Reset safety | clean-cut 独立 state roots；reset 只删 `pi/`；同步 runtime、write rollback、retention/reconciliation、pending remote path | reset/整棵 session 删除隔离测试及现有 Evidence/approval/idempotency/recovery 回归；无 shim，不加入 Reviewer |
| PR2 Trusted profile | fixed profile、strict loader、closed registries、静态 methodology context | profile/path/digest/spoof、role×tool、container image/profile；不宣称闭环完成 |
| PR3 PracticeRun kernel | journal/snapshot/protected payload、CAS/lock、state-transition replay、start/extend/abandon | one-active、scope append、limits、duplicate/stale/corruption；只声明状态内核 |
| PR4 Reviewer slice | scoped text read、file digest/range、Evidence projection、claim/checkpoint、check tool、ContextPack、status、Reviewer image | 全部 deterministic/container truth tables；不得省略 fail-closed 邻接路径 |
| PR5 Real integration | official OpenClaw + Matrix/Gateway 的 Basic/Recovery Full、Journey canary 与公开文档 | hard machine oracle、canary 分类、run-owned cleanup、现有 Gate/approval/recovery 回归；硬 Gate 通过后才更新 README |

每个 PR 必须保持系统可运行，不能用 TODO、mock success 或 prompt-only enforcement 代替当前边界。

---

## 18. 确定性测试矩阵

### 18.1 Profile

- valid profile pass；missing/unknown/extra field fail；
- duplicate/unknown registry ID 或 write/bash capability fail；
- ENV、Worker name、prompt、tool args 均不能提升 role；
- image/profile digest mismatch，以及 methodology 缺失、symlink、超限或 digest mismatch 均 fail。

### 18.2 PracticeRun

- authenticated actor/message 缺失时 start fail；none → start → active；active → start 返回 `ACTIVE_RUN_EXISTS`；
- actor mismatch 在模型前 fail 且无 run detail；
- same invocation/same digest replay；different digest conflict；
- extend append pass；删除/替换/重复/超限或 stale revision fail；
- active → abandon，terminal replay stable；terminal old run 拒绝 mutation；
- journal partial/hash/revision/sequence corruption fail；
- two-process lock serialization；snapshot 可重建且 mismatch 不受信任。

### 18.3 Read/Gate

- no active run、actor mismatch、out-of-scope 均 deny；in-scope text pass；
- workspace escape、symlink、sensitive path、非普通文件均 deny；
- binary、invalid UTF-8、image、oversized file/scope 均 deny；
- valid offset/limit metadata pass；invalid range fail；
- full coverage pass；partial coverage 或 mixed chunk digest fail。

### 18.4 Evidence projection

- current-run完整 lifecycle pass；pre-start/unbound/wrong-run ignored；
- Gate deny/error 不计；missing started/completed fail；
- duplicate/ambiguous identity 或 operation/result join mismatch fail；
- event/segment tamper fail；EventRefs 精确指向 sequence/hash；
- operation digest 不能替代 file/event digest。

### 18.5 Checkpoint

- invalid/oversized/extra-key claim，以及 missing/duplicate/unknown criterion fail；
- `not_addressed` + explanation + blocked + next action pass；explanation 缺失/空 fail；
- 任一 `not_addressed` + accept 或空 nextActions fail；全部 `not_addressed` 可在其它检查通过时 `done + blocked`；
- claim scope missing/extra/reordered、partial read 或 mixed file digest fail；
- observation outside scope 或 line invalid/out-of-range fail；
- outcome/severity mismatch 或 static limitation 缺失 fail；
- all facts pass；pass → done，fail → active；completion replay 不重复 `run.completed`。

### 18.6 Context/status/reset/recovery

- active ContextPack 正确有界且无 raw request/claim/Evidence；requester mismatch 不注入、不运行模型、不泄露；
- transcript reset 后恢复 active run；各业务 root identity/digest 不变；
- 删除 `sessions/<hash>/` 后 PracticeRun/Evidence/idempotency/pending/rollback 仍可恢复；
- retention/reconciliation/AgentTeams remote pending path 使用新布局；
- direct-unverified 与 active/fail/done/abandoned 状态正确；模型 marker 被转义；peer marker 不受影响；
- journal commit crash 可恢复；delivery crash 不重复 completion。

---

## 19. Smoke 合同

### 19.1 Basic smoke

目的：证明最小真实集成路径。

```text
real Matrix request
  → official OpenClaw
  → Reviewer image/profile
  → start_work
  → one scoped read
  → check_completion pass
  → machine-rendered report/status
  → persistent run/Evidence verification
```

Required machine facts：

- 实际容器 image/profile digest 是 Reviewer；
- active tool surface 精确匹配 profile；
- `run.started` 和 `run.completed` 存在且 hash/revision 有效；
- read Evidence 绑定同一 runId；
- file digest 与 disposable fixture 独立计算值一致；
- status 是 `worker-local / done / checkpoint passed / static-review-only`；
- 没有 write/bash execution；
- Matrix delivery 成功；
- fixture、Worker、storage prefix 等 run-owned 资源精确清理并验证不存在。

不能把模型说“读过/完成”当 oracle。

### 19.2 Recovery Full smoke

目的：硬证明跨 turn append-only scope 与 restart 恢复；post-restart 模型活性不充当状态 oracle。

```text
start/read A → later extend_scope(B) → journal remote durable
→ delete derived snapshot → restart → rebuild same active A+B run
```

Required machine facts：同一 runId/actor/profile；objective/criteria digest 不变；唯一 scope event 只追加 B；A read digest 独立匹配；journal/Evidence boundary 跨重启不变；snapshot 从 journal 重建；恢复后 active/not-run；无 mutation 工具；official delivery、Harness、cleanup 通过。

### 19.3 Journey canary

独立 fresh run 在 Recovery Full 后观察 `read B → check_completion → done`。PASS 要求完整 B Evidence、唯一 final-scope completion 和 terminal status。每个 image/provider/model artifact 只运行预定次数，不抽样求绿；记录 PASS、NO_VALID_READ_EVIDENCE、NO_VALID_COMPLETION 或 INCONCLUSIVE。它只衡量长链活性，不阻断发布；cleanup 仍硬阻断，no-progress 不得生成虚假 Evidence 或 done。

### 19.4 Block rules

profile/image、A read、journal/Evidence、same-run recovery、official Channel Plane 或 cleanup 任一不可证明，Recovery Full 保持红色。不得用私有依赖、prose 或放宽断言判绿。Journey 仅满足 terminal oracle 才记录 PASS，失败必须分类。

---

## 20. Reviewer v1 发布 Gate

发布必须同时满足：

1. 五个 PR、deterministic tests/truth tables、profile 与容器合同通过；
2. spoof、wrong scope/run、Evidence tamper 均 fail closed，read oracle 一致；
3. state-root isolation/reset/restart/replay 与现有 approval/rollback/recovery/idempotency/maintenance 未削弱；
4. Basic、Recovery Full、kernel regression 和各自 exact cleanup 通过；
5. OTel 仅含 sanitized allowlist metadata，repository 无私有依赖或运行材料；
6. Journey canary 按预定 artifact 运行并诚实记录，但不替代任何硬 Gate。

发布口径：

> Reviewer statically reviews explicit bounded workspace text files. Run-bound Evidence checks complete versioned reads. State recovers after restart; later progress is model-dependent, and no-progress cannot create Evidence or completion. This does not claim tests, git/PR freshness, or Team verification.

---

## 21. 给实现 AI 的执行清单

每次只实现当前 PR：

1. 写明 observable contract、owning module、调用方和状态变更；
2. 搜索已有 helper/store，定义 exact schema、limits、error codes 和 fail-closed 行为；
3. 对授权/持久化变更列出 crash points；
4. 先写 positive/negative/adjacent/replay deterministic tests；
5. 保持 active tools sequential，不用 prompt/Skill 修补代码缺口；
6. 不把 raw prompt、claim、文件正文或凭据写入 Evidence/OTel；
7. 不把 Practice/Gate 业务判断放进 OpenClaw adapter；
8. 不启用 v1 scope 外工具；
9. 按 cheapest-first 运行验证，最后 re-read diff；
10. 只更新已验证行为，并报告未运行或 blocked 的验证。

实现者不得自行增加目录/git/bash/search，删除或替换 scope，修改 objective/criteria，转移跨 run Evidence，将 static review 标成 team-verified，以 transcript/prose 恢复 state，或保留旧稿 shim。改变冻结决策必须先修订本文并单独 review。

---

## 22. Reader test

把本文交给没有讨论上下文的 AI，要求它回答：

1. v1 支持和明确不支持什么？
2. Role Profile 的权威来源及 role×tool 边界是什么？
3. 五个工具的前置条件、actor binding 和状态转换是什么？
4. objective/criteria/scope 哪些可变，`not_addressed` 如何影响 outcome？
5. read 如何证明完整读取特定文件版本？
6. 哪个 event 推进 done，reset/restart/crash 后如何恢复？
7. claim、state、Evidence、OTel 有何区别？
8. 五个 PR、Basic/Recovery Full oracle、Journey canary 和禁止放宽的 block rules 是什么？

合格：fresh AI 仅依据本文一致作答，不依赖仓库外背景，不混淆现状或 prompt、claim、state、Evidence、OTel。

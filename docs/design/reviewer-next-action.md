# Reviewer nextAction 历史扩展合同

> **状态：** ContextPack v2实现记录；已由Reviewer v2/ContextPack v3 target语义clean-cut取代。
> **基础：** [`agent-plane-foundation.md`](./agent-plane-foundation.md) 的历史Reviewer v1。
> **历史范围：** 为Reviewer v1 per-turn ContextPack增加由Machine Evidence确定性派生的advisory `nextAction`。
> **保证不变：** `worker-local / static-review-only`；`nextAction` 不授予权限、不修改状态、不推进完成。
> **不是：** 通用 Concern runner、模型活性保证、任务调度器、新工具、typed target、目录/git/search/vision/bash 能力。

## 0. 如何使用本文

本文是 Reviewer v1 的窄增量合同。实现前后都必须继续遵守根目录 `AGENTS.md` 及 `docs/rules/` 下的 implementation、verification、security-and-evidence 和 worker-runtime 规则。

本合同曾实现以下增量边界；current runtime不兼容读取本文schema：

- Reviewer v1 ContextPack 使用本文定义的 schema version 2；
- `nextAction` 由代码和验证过的 Machine Evidence 投影生成，不由 prompt、Skill 或 smoke 文本模拟；
- typed target、Captured Artifact、目录/git 或其它后续能力仍不在本切片内。

本文仅对 `agent-plane-foundation.md` 的以下 v1 设计点形成增量覆盖：

- §6.1 “v1 不实现 Concern runner”：仍不实现通用 runner，但增加 review practice-owned 的纯函数式 `nextAction`；
- §12.2 ContextPack：从 schema version 1 clean-cut 更新为本文定义的 version 2；
- §19.3 Journey canary：继续是非发布 Gate 的模型活性观察，不因本扩展升级为硬 Gate。

其余角色权威、actor binding、scope、Gate、Evidence、checkpoint、state、reset/restart 和 assurance 不变量保持不变。

---

## 1. 问题与目标

Reviewer v1 已能在 restart 后恢复同一 active PracticeRun、最终 append-only file scope 和 Evidence。已观察到的 Journey no-progress 是：scope 为 A+B、A 已完整读取、B 未读时，恢复后的模型可能重读 A，未继续读取 B。

当前 ContextPack 已提供：

- active run ID/revision/status；
- objective、criteria 和 final scope；
- 最后一次 checkpoint reason codes。

但它没有把当前 Evidence coverage 投影为一个明确、机器生成的首要下一步。

本扩展的唯一产品目标是：

> 每个普通 Reviewer turn 开始前，runtime 基于当前 run、固定 Evidence boundary 和 review coverage 生成一个结构化、可验证、advisory 的 `nextAction`。

它只证明 guidance 正确，不证明模型一定执行 guidance。

---

## 2. 冻结不变量

### 2.1 Advisory，不是 authority

`nextAction`：

- 只进入 per-turn system ContextPack；
- 不写 PracticeRun journal；
- 不改变 run/scope revision；
- 不创建 Claim 或 Evidence；
- 不改变 Gate allow/deny/pending；
- 不调用工具；
- 不决定 checkpoint pass；
- 不推进 `done`；
- 不作为后续完成认证的 Evidence。

模型可以遵循或不遵循；无论模型如何回复，Machine State、Gate、backend 和 checkpoint 仍是权威。

### 2.2 基于固定机器边界

active run 下的 `nextAction` 必须来自：

1. 当前 authenticated actor 拥有的 active PracticeRun；
2. 本 turn 模型循环前固化的 Evidence terminal sequence/hash；
3. 该 boundary 及之前、通过链验证、绑定当前 run/actor/profile/practice 的成功 read lifecycle；
4. 与 completion checkpoint 相同的文件版本与行覆盖语义；
5. journal 中最后一次失败 checkpoint 的稳定 reason codes。

不得从 transcript、模型 prose、上一次 assistant 回复、工具展示文本或未经验证的日志推断。

### 2.3 失败时不猜测

以下情况必须在进入模型循环前 fail closed，不得降级为 `NONE`、`CHECK_COMPLETION` 或自由文本提示：

- Evidence chain/segment/boundary 无效；
- read lifecycle duplicate、缺失、矛盾或 join ambiguous；
- operation/result metadata 不一致；
- run/actor/profile/practice binding 冲突；
- active Reviewer run 投影出成功 mutation execution；
- active run 出现 `lastCheckpoint.allSatisfied=true` 等状态不变量冲突；
- ContextPack 超过固定大小上限。

失败可以通过现有 adapter 返回有界错误，但不得调用模型或泄露 run、Evidence、request、claim 内容。

### 2.4 不改变 Reviewer 能力面

Reviewer profile 继续精确 materialize：

```text
start_work
extend_scope
read
check_completion
abandon_work
```

本扩展不新增 tool ID，不改变 Gate policy，不开放 mutation，不改变 profile digest 或 assurance wording。

---

## 3. ContextPack version 2

### 3.1 Exact shape

ContextPack clean-cut 更新为：

```text
ContextPack
  schemaVersion: 2
  roleId
  profileDigest
  assuranceLevel
  activeRun: object | null
  nextAction
    code
    targetRefs[]
    reasonCodes[]
```

`activeRun` 保持现有字段：

```text
activeRun
  runId
  revision
  status
  objective
  acceptanceCriteria[]
  scope
  lastCheckpointReasonCodes[]
```

示例：A 是 final scope 第一个文件并已完整读取，B 是第二个文件且未读：

```json
{
  "schemaVersion": 2,
  "roleId": "reviewer",
  "profileDigest": "<fixed-profile-digest>",
  "assuranceLevel": "worker-local / static-review-only",
  "activeRun": {
    "runId": "run-...",
    "revision": 2,
    "status": "active",
    "objective": {
      "text": "Review selected files",
      "source": "model_normalized"
    },
    "acceptanceCriteria": [
      {
        "id": "criterion-1",
        "description": "Identify correctness risks",
        "source": "model_normalized"
      }
    ],
    "scope": {
      "revision": 2,
      "files": ["A.txt", "B.txt"],
      "digest": "<scope-digest>",
      "source": "model_normalized"
    },
    "lastCheckpointReasonCodes": []
  },
  "nextAction": {
    "code": "READ_REMAINING_SCOPE",
    "targetRefs": ["scope-file-2"],
    "reasonCodes": ["SCOPE_READ_INCOMPLETE"]
  }
}
```

### 3.2 `code`

只允许：

```text
READ_REMAINING_SCOPE
ADDRESS_CHECKPOINT_FAILURE
CHECK_COMPLETION
NONE
```

语义：

| code | 语义 |
|---|---|
| `READ_REMAINING_SCOPE` | final scope 至少一个文件未满足当前完整读取合同；先完成这些读取 |
| `ADDRESS_CHECKPOINT_FAILURE` | 当前 scope 已完整读取，但上一次 completion checkpoint 失败；按机器 reason codes 修正或重新提交 |
| `CHECK_COMPLETION` | 当前 scope 已完整读取，且没有待处理的失败 checkpoint；可以提交 completion claim |
| `NONE` | 当前 actor 没有 active run；没有 run-bound guidance |

`NONE` 不表示工作成功、失败或无需创建新 Work，只表示没有 active PracticeRun 可派生下一步。

### 3.3 `targetRefs`

Reviewer file-scope 首版不重复复制 path，而使用 scope 顺序派生的稳定引用：

```text
scope-file-1
scope-file-2
...
scope-file-N
```

其中 `scope-file-N` 精确指向 `activeRun.scope.files[N-1]`。

选择该形式是为了：

- 避免在 ContextPack 中重复最多 32 KiB 的 scope paths；
- 保持现有 `MAX_CONTEXT_PACK_BYTES=64KiB` 和 admission reserve 可证明；
- scope append-only 时已有 ref 保持稳定；
- 让 target 列表保持有界、结构化并避免路径拼接式提示。

约束：

- 只允许 `^scope-file-[1-9][0-9]*$`；
- N 不得大于 final scope 文件数；
- 按 final scope 顺序排列；
- 不重复；
- 数量不超过现有 `MAX_SCOPE_FILES`；
- 只有 `READ_REMAINING_SCOPE` 可以非空，且此时必须至少一个；
- 其它 code 必须为空数组。

后续 typed-target 合同可以 clean-cut 修改 ref 语义；本合同不提前定义 typed target ID。

### 3.4 `reasonCodes`

只包含代码产生的稳定 reason code，不包含自由文本。

约束：

- 按权威来源顺序排列并去重，保留第一次出现；
- 数量不得超过 checkpoint 数量与 read coverage reason 种类的固定上限；
- `READ_REMAINING_SCOPE`：来自当前 coverage 的 `SCOPE_READ_INCOMPLETE` / `FILE_VERSION_MIXED`；
- `ADDRESS_CHECKPOINT_FAILURE`：来自 `run.lastCheckpoint.results` 中全部 `satisfied=false` 项；
- `CHECK_COMPLETION` / `NONE`：必须为空数组。

`activeRun.lastCheckpointReasonCodes` 保持现有机器投影；`nextAction.reasonCodes` 是本次首要动作的有界依据，不替换 journal checkpoint facts。

### 3.5 固定解释文本

ContextPack 的代码拥有前缀应增加固定说明：

```text
nextAction is advisory machine guidance. It does not grant authority or complete work.
scope-file-N refers to activeRun.scope.files[N-1].
```

不得根据 path、claim 或模型内容动态生成自然语言指令。所有动态值只出现在 canonical JSON 中。

---

## 4. 权威 read coverage

### 4.1 单一实现

completion checkpoint 与 `nextAction` 必须消费同一个 review practice-owned coverage projector。不得在 Context 层重新实现一套“是否读完”逻辑。

建议模块职责：

```text
worker/agent/practices/review-read-coverage.mjs
  projectReviewReadCoverage(run, evidenceProjection)

worker/agent/practices/review-next-action.mjs
  deriveReviewNextAction({ run, coverage, evidenceProjection })
```

模块名可以在实现评审中调整，但 ownership 和单一语义不能改变：

- `evidence/projection.mjs` 负责验证 Evidence chain/lifecycle 并产出 CapturedExecution；
- review coverage 负责文件版本与行区间；
- review checkpoint 和 nextAction 共同消费 coverage；
- context assembler 只组装并做大小检查。

### 4.2 每文件 coverage 状态

内部 coverage 至少区分：

```text
complete
unread
partial
mixed_version
```

规则保持 Reviewer v1 当前 checkpoint 语义：

1. 只接受当前 run/actor、Gate allow、backend success 的 `read`；
2. 以 `fileDigest + fullFileLines` 分组；
3. 选择 completion sequence 最新的版本组；
4. 该版本区间并集无缺口覆盖 `1..fullFileLines` 时为 `complete`；
5. 没有成功 read 时为 `unread`；
6. 只有一个版本且覆盖不完整时为 `partial`；
7. 多个版本且最新版本覆盖不完整时为 `mixed_version`；
8. 最新版本已完整覆盖时为 `complete`，更老版本不使其失败；
9. read error、Gate deny、只读文件头、错误 run、pre-start 和 boundary 后事件不计入；
10. scope extension 不使已有文件的有效完整 Evidence 失效，但 final scope 新增文件必须单独覆盖。

映射：

| coverage | nextAction coverage reason |
|---|---|
| `unread` | `SCOPE_READ_INCOMPLETE` |
| `partial` | `SCOPE_READ_INCOMPLETE` |
| `mixed_version` | `FILE_VERSION_MIXED` |
| `complete` | 无 |

checkpoint 对 pass/fail 的现有 observable semantics 必须保持不变。提取共享 coverage 不能改变已发布 checkpoint reason、selected EventRefs、file facts 或 done 条件。

### 4.3 Evidence boundary

active run 的每次普通 turn 在 `before_agent_start` 中：

1. 先通过 authenticated actor 取得 active run；
2. 固化当前 Evidence terminal sequence/hash；
3. 验证整条 chain 及该 boundary；
4. 只投影 boundary 及之前事件；
5. 计算 coverage；
6. 派生 `nextAction`；
7. 组装 ContextPack v2；
8. 之后才允许进入模型循环。

若步骤 2–7 失败，不得调用模型。

没有 active run 时直接生成 `NONE`，不需要为了 direct chat 扫描 run-bound Evidence。

---

## 5. 确定性派生算法

### 5.1 优先级

按以下顺序，首个命中项决定唯一 code：

```text
1. no active run
   → NONE

2. active run + any final-scope file not complete
   → READ_REMAINING_SCOPE

3. active run + all final-scope files complete + last checkpoint failed
   → ADDRESS_CHECKPOINT_FAILURE

4. active run + all final-scope files complete + no failed checkpoint
   → CHECK_COMPLETION
```

读取缺口优先于旧 checkpoint failure。旧 failure facts 仍保留在 `activeRun.lastCheckpointReasonCodes`；模型完成读取后，下一 turn 会得到 `ADDRESS_CHECKPOINT_FAILURE`。

即使上次 checkpoint 只因读取缺口失败，而当前 coverage 后来已经补齐，第 3 条仍保守返回 `ADDRESS_CHECKPOINT_FAILURE`，要求模型重新检查并提交。`nextAction` 不尝试在 Context 层重新执行 claim/checkpoint 语义。

### 5.2 Truth table

| Active run | Current coverage | Last checkpoint | code | targetRefs | reasonCodes |
|---:|---|---|---|---|---|
| 否 | n/a | n/a | `NONE` | `[]` | `[]` |
| 是 | A complete，B unread | 无 | `READ_REMAINING_SCOPE` | `[scope-file-2]` | `[SCOPE_READ_INCOMPLETE]` |
| 是 | A partial | 无 | `READ_REMAINING_SCOPE` | `[scope-file-1]` | `[SCOPE_READ_INCOMPLETE]` |
| 是 | A old complete，new partial | 无 | `READ_REMAINING_SCOPE` | `[scope-file-1]` | `[FILE_VERSION_MIXED]` |
| 是 | A/B 都 complete，C partial | 失败 | `READ_REMAINING_SCOPE` | `[scope-file-3]` | `[SCOPE_READ_INCOMPLETE]` |
| 是 | 全部 complete | 失败 | `ADDRESS_CHECKPOINT_FAILURE` | `[]` | 上次失败 reason codes |
| 是 | 全部 complete | 从未 check | `CHECK_COMPLETION` | `[]` | `[]` |
| 是 | 最新版本 complete，旧版本不完整 | 无 | `CHECK_COMPLETION` | `[]` | `[]` |

以下不是 truth-table fallback，而是 hard failure：Evidence tamper/ambiguity、成功 mutation、active+passed checkpoint、ContextPack overflow。

### 5.3 Pseudocode

```text
if activeRun is null:
  return { code: NONE, targetRefs: [], reasonCodes: [] }

assert activeRun.status == active
assert activeRun.lastCheckpoint?.allSatisfied != true
assert evidenceProjection has no successful mutation

remaining = coverage.files in final scope order where status != complete
if remaining is not empty:
  return {
    code: READ_REMAINING_SCOPE,
    targetRefs: remaining mapped to scope-file-N,
    reasonCodes: remaining coverage reasons, stable unique
  }

failedReasons = last checkpoint unsatisfied reasons, stable unique
if failedReasons is not empty:
  return {
    code: ADDRESS_CHECKPOINT_FAILURE,
    targetRefs: [],
    reasonCodes: failedReasons
  }

return { code: CHECK_COMPLETION, targetRefs: [], reasonCodes: [] }
```

---

## 6. Runtime 与模块边界

### 6.1 Context extension

`createReviewerContextExtension` 需要受信任的 Evidence dependency，以便在每 turn 组装前固化和投影 boundary。它仍通过 Tiangong-owned inline `before_agent_start` extension 工作，不启用自动 extension discovery。

建议调用流：

```text
runtime
  → activeForActor
  → evidenceBoundary
  → projectReviewEvidence
  → projectReviewReadCoverage
  → deriveReviewNextAction({ run, coverage, evidenceProjection })
  → buildReviewerContextPack
  → pi model loop
```

### 6.2 Turn consistency

- `nextAction` 是 turn-start snapshot；同一 agent loop 内执行 read 后不重写已注入 ContextPack；
- 工具结果继续向模型返回最新 read/run facts；
- 下一 Matrix turn/restart/reset 重新投影；
- tools 保持 sequential；
- 本扩展不引入并发 Context/Gate/Evidence 语义。

### 6.3 Persistence

不新增 state root、journal event、protected payload 或 retention 类型。restart 后的 guidance 只从现有 PracticeRun 与 Evidence 重建，不持久化 `nextAction` 缓存。

### 6.4 Observability

`nextAction` 不需要新的 OTel span 或 attribute 才能成为正确行为。若实现增加诊断，只允许 code、target count 和 reason count；禁止 path、objective、criteria、request、claim、Evidence 内容。OTel 失败不得影响 authoritative result。

---

## 7. Fail-closed 与用户可见行为

### 7.1 Actor mismatch

沿用现有 runtime 前置控制：

- wrong actor 在模型循环前拒绝；
- 不注入 active ContextPack；
- 不泄露 runId、scope、nextAction 或 reason codes；
- `workStatus` 保持 `direct-unverified` 控制结果。

### 7.2 Evidence/state failure

active run 下 guidance projection 失败时：

- 不调用模型；
- 不伪造 `nextAction`；
- 不推进 PracticeRun；
- 不追加“成功 guidance” Machine Evidence；
- adapter 只返回现有有界 attempt failure；
- diagnostics 只记录稳定 error code 和 digest/count-safe metadata。

实现可以复用现有 `EVIDENCE_*` / `STATE_CORRUPTED` 错误，也可以增加一个有界 guidance invariant code；不得吞掉原始 fail-closed 原因并继续模型 turn。

### 7.3 Model output

用户可见 machine status block 保持现有字段和语义。本切片不把 `nextAction` 追加到最终 machine status，也不声称模型已执行建议。

---

## 8. 确定性测试合同

### 8.1 Coverage projector

必须覆盖：

- no read → unread；
- 单段完整 → complete；
- 多段无缺口 → complete；
- 头部/尾部/中间缺口 → partial；
- duplicated/overlapping ranges 的并集语义；
- old complete + new partial → mixed_version；
- old partial + new complete → complete；
- mixed digest/fullFileLines；
- read error/Gate deny/wrong run/pre-start/boundary 后 ignored；
- scope append后旧文件 coverage 保留、新文件 unread；
- mutation success 触发 guidance invariant failure；
- Evidence tamper/ambiguous lifecycle fail closed。

### 8.2 Derivation

逐项覆盖 §5.2 truth table，并断言：

- targetRefs exact、稳定、按 scope 顺序、无重复；
- reasonCodes exact、稳定、去重；
- READ 优先于旧 checkpoint failure；
- all complete + failed checkpoint → ADDRESS；
- all complete + no failed checkpoint → CHECK；
- no active → NONE；
- active + passed checkpoint/state conflict fail closed。

### 8.3 ContextPack

- schemaVersion 精确为 2；
- exact keys；
- ContextPack 包含 nextAction 但不包含 raw request/claim/Evidence/transcript；
- `scope-file-N` 映射正确；
- 最大 64 refs 仍满足 64 KiB ContextPack 上限；
- overflow fail closed；
- canonical JSON 转义 path 内容，不产生动态 prompt 拼接；
- ContextPack 每 turn 重建，不持久化 custom message；
- no-active `NONE` 不扫描或暴露其它 actor/run Evidence。

### 8.4 Runtime/restart

- A complete、append B、restart 后同一 run 得到 `READ_REMAINING_SCOPE + scope-file-2`；
- transcript reset 后 guidance 相同；
- 读取 B 后下一 turn 得到 `CHECK_COMPLETION`，或存在 failed checkpoint 时得到 `ADDRESS_CHECKPOINT_FAILURE`；
- wrong actor 不进入 model loop；
- Evidence corruption/guidance invariant failure 不进入 model loop；
- start/extend/read/check/abandon、status、report rendering 和 checkpoint observable behavior 回归不变。

---

## 9. 真实集成验证

实现 PR 的 hard gate 先是全部 deterministic tests。真实集成按相关边界执行：

1. Reviewer Basic：确认新增 ContextPack 不破坏官方 Matrix → OpenClaw → Reviewer completion；
2. focused Journey canary：使用 fresh Worker 重现 A complete、append B、restart，再观察下一 turn；
3. canary 只按现有机器 oracle 记录 PASS / `NO_VALID_READ_EVIDENCE` / `NO_VALID_COMPLETION` / `INCONCLUSIVE`；
4. 不通过重复采样寻绿；
5. no-progress 不阻断本扩展，只要 deterministic guidance 正确且没有虚假 Evidence/done；
6. cleanup 继续是硬 Gate；
7. 只有共享 wrapper/Gate/Evidence/idempotency/recovery 安全边界被实现改动时，才追加相关 Kernel Full，而不是机械运行无关昂贵 smoke。

smoke report 可以记录 `nextAction.code` 和 target count 的有界机器诊断，但不得记录 ContextPack 全文、paths、objective、criteria 或模型私有内容。

---

## 10. 实现完成条件

只有同时满足以下条件，才可把本合同状态更新为已实现：

1. ContextPack v2 exact schema 已落地；
2. coverage 与 checkpoint 使用同一 practice-owned 语义；
3. §5 truth table 全部通过；
4. Evidence/state/mutation 异常在模型前 fail closed；
5. restart/reset 后 guidance 从 durable state + Evidence 重建；
6. Reviewer 工具面、Gate、checkpoint、assurance 和 machine status 未扩大；
7. deterministic tests 和 Reviewer Basic 通过；
8. focused canary 按预声明次数诚实分类且 exact cleanup 通过；
9. README/release wording 只在上述证据存在后更新。

允许的公开口径：

> Reviewer derives an advisory next action from the active PracticeRun and validated read Evidence at the start of each turn. This guidance does not grant authority, execute tools, complete work, or guarantee that the configured model will make progress.

禁止口径：

- “Reviewer restart 后一定继续”；
- “Concern 保证长链稳定”；
- “模型已按 nextAction 执行”；
- “nextAction 是 completion Evidence”；
- “Reviewer 获得目录/git/bash 等新能力”。

---

## 11. Reader test

把本文单独交给无讨论上下文的读者，要求回答：

1. `nextAction` 能做什么、不能做什么？
2. 四个 code 的精确优先级是什么？
3. 为什么使用 `scope-file-N` 而不是重复 path？
4. read coverage 如何处理 partial、mixed version 和最新完整版本？
5. Evidence 在何时固化，损坏时是否进入模型循环？
6. 上次 checkpoint 失败且当前仍有未读文件时返回什么？
7. 为什么 canary no-progress 不自动阻断本扩展？
8. 哪些现有 Reviewer 权限、状态和 assurance 保持不变？

合格标准：读者只依据本文即可一致回答，不把 advisory guidance 当成授权、状态、Evidence、完成或模型活性保证。

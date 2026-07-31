# Reviewer typed target 与 immutable snapshot 设计合同

> **状态：** 公开设计合同，尚未实现；本文不描述当前已发布行为。
> **基础：** [`agent-plane-foundation.md`](./agent-plane-foundation.md) 与已验证的 [`reviewer-next-action.md`](./reviewer-next-action.md)。
> **范围：** 将 Reviewer 的显式文件 scope clean-cut 演进为 append-only typed targets，并在 target admission 时固化不可变 snapshot identity。
> **保证不变：** `worker-local / static-review-only`；target、snapshot、Captured Artifact 和 `nextAction` 都不授予权限、不认证模型判断、不执行测试或修改 workspace。
> **不是：** CapturedArtifactStore 实现、目录浏览工具、git executor、working-tree/index diff、远程 PR、search/fetch、vision、bash、Team Work 或兼容迁移。

## 0. 如何使用本文

本文是 Reviewer 当前显式文件合同的下一项窄设计增量。实现者仍须遵守根目录 `AGENTS.md` 及 `docs/rules/` 下的 implementation、verification、security-and-evidence 和 worker-runtime 规则。

在本合同实现并通过验证前：

- 当前公开事实仍是 `scope.files[]`、ContextPack v2、review claim v1 和显式 workspace UTF-8 文件评审；
- README、release notes、profile、tool schema 和 UI 不得宣称支持 typed target、目录、commit 或 git diff；
- 不得用 prompt、Skill、workspace manifest 或模型自报 digest 模拟 immutable snapshot；
- 不得在实现中保留旧 `scope.files[]` shim、双读 journal 或自动迁移。

本合同被接受后，后续实现仍必须按依赖边界拆分：

1. 单独评审 [`CapturedArtifactStore`](./captured-artifact-store.md) 的持久化、配额、Evidence、restart、tamper 和 retention 合同；
2. 只有目标种类的 admission、consume backend 和固定 profile policy 全部存在时，才 materialize 该 target kind；
3. directory inspection 和 local git inspection 各自保留独立工具、executor 与 smoke 合同。

本文定义稳定的 target/state seam，不提前实现这些后续能力。

---

## 1. 问题、目标与非目标

### 1.1 当前问题

Reviewer 目前把模型归纳的 workspace 路径写入 `scope.files[]`，读取时重新打开该路径，并由 completion checkpoint 选择某个完整文件版本。该合同适合显式文件 v1，但不能表达：

- 同一路径在 admission 时的固定版本；
- 一个目录的确定成员集合；
- ref 移动后仍固定的 commit/tree；
- 固定 base/head 的 commit-to-commit diff；
- 不依赖数组位置的稳定 target reference；
- manifest、diff 等较大 canonical bytes 与 journal/Evidence 的安全分离。

### 1.2 唯一目标

> PracticeRun 在 `start_work` 或 `extend_scope` 成功提交时，持有一个有序、append-only 的 `scope.targets[]`；每个 target 都有 runtime-generated ID、代码规范化 descriptor 和 runtime-captured immutable snapshot identity。后续消费和 completion 只认该 identity，不重新解释原始路径或 ref。

“immutable”只表示已提交 target 的 identity、descriptor、snapshot facts 和 artifact bindings 不会被静默刷新。它不声称普通 filesystem capture 是存储系统级原子快照，也不保证外部 source 永远仍可读取。

### 1.3 非目标

本合同不提供：

- 任意目录、glob、git argv 或 shell 字符串；
- working tree、index、stash、branch range 或 remote PR snapshot；
- `git fetch`、网络、hook、external diff、textconv、pager 或用户 git config；
- binary/image/PDF/Office consumption；
- target refresh、replace、remove、reorder 或 supersede；
- 选择性抽样后仍称“完整目录评审”；
- 模型在 admission 时 mint target ID，或在后续 selector 中使用不属于当前 actor/run/final scope 的 target ID；
- model-provided snapshot digest、artifact ref 或 Evidence ref；
- 对 workspace、commit message、diff、manifest 或模型结论真实性的认证。

---

## 2. 事实模型与术语

以下事实不可互相替代：

| 事实 | 含义 | 权威载体 |
|---|---|---|
| Target request | 模型根据当前 ingress 归纳的 target selector | wrapped tool input + protected request digest |
| Normalized descriptor | 代码校验、规范化后的 target selector | PracticeRun journal Machine State |
| Target snapshot | admission 时捕获的版本、成员或 OID/artifact binding | PracticeRun journal Machine State |
| Snapshot identity | 对 target kind、descriptor、capture version、facts 和 artifact content metadata 的 canonical SHA-256 | PracticeRun journal Machine State |
| Captured Artifact | backend 规范化并实际可交给模型的确定 bytes | 独立 CapturedArtifactStore |
| Machine Evidence | Gate、capture/consume lifecycle 和 backend 结果事实 | hash-chained Evidence |
| Claim | 模型对 target 的专业判断 | protected claim payload + digest |
| Diagnostic telemetry | 有界、脱敏的阶段与计数 | OTel；不参与 checkpoint |

额外约束：

- target snapshot 不是 Captured Artifact；前者描述 Machine State，后者保存 bytes；
- Captured Artifact 不是第二条 Evidence chain；Evidence 证明 capture lifecycle 与 digest/ref binding；
- artifact 被捕获不证明其内容真实、安全或无 prompt injection；
- `practice-runs/.../snapshot.json` 是 journal-derived materialization cache，不是本文的 target snapshot；两者在代码、错误和文档中不得简称为同一事实。

---

## 3. Clean-cut schema 决策

本合同实现时进行一次 clean-cut：

| 合同 | 当前 | typed-target 目标 |
|---|---:|---:|
| fixed Reviewer profile schema | 1 | 2 |
| review PracticeDefinition version | 1 | 2 |
| PracticeRun / journal schema | 1 | 2 |
| scope | `files[]` | `targets[]` |
| protected review claim | 1 | 2 |
| checkpoint set/result | `review-v1` / 1 | `review-v2` / 2 |
| Reviewer ContextPack | 2 | 3 |
| nextAction target refs | `scope-file-N` | stable `targetId` |
| machine status count | files | targets |

要求：

- v2 loader 遇到 v1 PracticeRun journal 必须返回稳定 `UNSUPPORTED_STATE_SCHEMA` 并停止，不得猜测、双读、自动删除或迁移；
- 部署者必须先完成/放弃旧 active run，或为新 schema 使用 fresh owned Worker/state；
- implementation PR 不加入旧 tool input、旧 claim、旧 ContextPack 或旧 status compatibility path；
- Reviewer profile v2 增加 exact、非空、有界、唯一的 `targetKindIds[]`，只能引用 closed target-kind registry；tool schema、admission backend、consume backend 和 profile policy 必须对每个 materialized kind 完整一致；
- run 的 `practiceVersion=2`，v1 practice 不得读取或推进 v2 target state；
- GitHub/public文档只有在实现和 hard gates 通过后才更新为当前行为。

目标 Reviewer profile exact shape：

```json
{
  "schemaVersion": 2,
  "roleId": "reviewer",
  "title": "Reviewer",
  "practiceIds": ["review"],
  "targetKindIds": ["file"],
  "toolIds": [
    "start_work",
    "extend_scope",
    "read",
    "check_completion",
    "abandon_work"
  ],
  "gatePolicyId": "reviewer-v2",
  "roleSkillId": "reviewer-v2"
}
```

`targetKindIds` 示例只表示最小 file activation，不预先启用 directory/git。closed role、gate policy、practice v2、target-kind registry、tool materialization、role methodology 和 profile digest 必须对该 ordered list 精确一致；ENV、Worker name、prompt 或 tool params 不能增加 kind。新增 kind 是 fixed profile/registry 变更并需自己的 capability verification，不是运行时动态插件。

---

## 4. Target request DTO

`start_work` clean-cut 将 `files` 替换为 `targets`：

```json
{
  "practiceId": "review",
  "objective": "...",
  "acceptanceCriteria": ["..."],
  "targets": []
}
```

`extend_scope` 变为：

```json
{
  "targets": []
}
```

两个数组都必须非空、有界、整体原子 admission。下文四种 request 组成 closed target-kind registry 的完整设计集合；实际 ToolDefinition 只暴露 fixed profile `targetKindIds[]` 已 materialize 的 union。绕过 schema 调用 closed registry 中存在但当前 profile 未启用的 kind，backend 仍返回 `TARGET_KIND_NOT_MATERIALIZED`。不得向模型展示不可达 kind 再依赖自然语言解释拒绝。

### 4.1 `file`

```json
{
  "kind": "file",
  "path": "worker/agent/runtime.mjs"
}
```

### 4.2 `directory_snapshot`

```json
{
  "kind": "directory_snapshot",
  "path": "worker/agent",
  "selection": {
    "includePrefixes": ["."],
    "excludePrefixes": ["generated", "fixtures/generated"]
  }
}
```

`includePrefixes` / `excludePrefixes` 是相对 target root 的 literal path prefixes，不是 glob、regex 或 gitignore pattern。匹配必须按完整 path component 边界；`.` 表示 root。数组在规范化后按 UTF-8 byte order 排序，并拒绝：

- 绝对路径、空字符串、NUL、`.` 之外的 dot segment、`..` 或 workspace escape；
- duplicate prefix；
- 同一数组中 ancestor/descendant 的冗余重叠；
- 不位于任一 include prefix 下的 exclude prefix；
- selector 数量或总 bytes 超限。

只有显式 selection 内、且不在 exclusion 内的成员属于 target。代码拥有的 workspace/sensitive/runtime-state deny 仍优先，不能由 selection 解除。

### 4.3 `commit`

```json
{
  "kind": "commit",
  "repositoryPath": ".",
  "ref": "refs/heads/develop",
  "pathPrefixes": ["."]
}
```

`commit` 表示固定 commit tree 中、由 literal `pathPrefixes` 选择的 UTF-8 regular-file snapshot；它不是“该 commit 相对父提交的 patch”。若需要 changeset，使用 `git_diff`。

### 4.4 `git_diff`

```json
{
  "kind": "git_diff",
  "repositoryPath": ".",
  "baseRef": "refs/heads/main",
  "headRef": "refs/heads/develop",
  "pathPrefixes": ["."]
}
```

`git_diff` 首版只表示两个 commit OID 之间的 direct commit-to-commit diff。它不使用 merge-base 语义，不读取 working tree/index，也不接受 `A..B`、`A...B` 或任意 revision expression。

### 4.5 Ref 与 path selector grammar

Git ref input 只允许：

- `HEAD`；
- 当前 repository object format 对应长度的完整 lowercase hex object ID；
- 通过严格 ref-name 校验的完整 `refs/heads/...` 或 `refs/tags/...`。

拒绝 abbreviated OID、leading dash、reflog selector、`^`、`~`、`:`, `..`、`@{}`, wildcard、control character 和任意 option-shaped value。annotated tag 必须由 backend 安全 peel 到 commit，并只将最终 commit/tree OID 作为 snapshot authority。

Git `pathPrefixes` 与 directory prefix 使用相同 literal component-boundary 语义；不允许 pathspec magic、glob、attribute selector 或 leading dash。`.` 是 workspace/directory/repository root 和“选择全部”的唯一 canonical root spelling，normalizer 必须保留它；其它 path 中的 `.` segments 被移除。`file.path` 不能是 `.`。

---

## 5. Materialized target 与 scope

### 5.1 Target schema

journal 折叠后的 target 使用 exact schema：

```json
{
  "targetId": "target-550e8400-e29b-41d4-a716-446655440000",
  "kind": "file",
  "descriptor": {
    "schemaVersion": 1,
    "source": "model_normalized",
    "value": {
      "path": "worker/agent/runtime.mjs"
    }
  },
  "snapshot": {
    "schemaVersion": 1,
    "source": "runtime_captured",
    "captureVersion": "review-file-snapshot-v1",
    "identity": "<lowercase sha256>",
    "capturedAt": "<ISO-8601>",
    "facts": {},
    "artifacts": []
  }
}
```

要求：

- `targetId` 由 runtime 在 admission 生成，必须匹配 lowercase canonical `^target-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`；与当前 run candidate/committed IDs 冲突时最多重新生成 8 次，仍冲突返回 `TARGET_ID_GENERATION_FAILED`；模型、用户和 provider 不能 mint；后续 consume/claim 可以回显 ContextPack 中属于当前 run 的 ID，但 ID 本身不授予权限；
- `kind` 必须来自 closed target-kind registry，并由 fixed profile/deployment policy materialize；
- `descriptor` exact keys 为 `schemaVersion/source/value`；`source` 必须是 `model_normalized`，`value` 是规范化 target request 去掉 `kind` 后的 kind-owned exact DTO；
- `snapshot.source` 必须是 `runtime_captured`；`facts` 和 `artifacts` 使用 kind-owned exact schema；
- captureVersion exact enum 为：file=`review-file-snapshot-v1`、directory=`review-directory-snapshot-v1`、commit=`review-commit-snapshot-v1`、git_diff=`review-git-diff-snapshot-v1`；每个 ID 冻结对应 path/workspace/text/producer contract，任一语义变化必须 bump ID，不能拼接版本字符串；
- `capturedAt` 必须是 injected clock 产生的 UTC millisecond RFC 3339 `YYYY-MM-DDTHH:mm:ss.sssZ`；每个 target 在其 capture 完成时取一次，replay 使用 journal 原值；它不参与 content identity；
- admission artifact content identity 使用 exact keys：

```json
{
  "purpose": "directory_manifest",
  "contentDigest": "<sha256>",
  "contentBytes": 1234,
  "contentLines": 1,
  "mediaType": "application/vnd.tiangong.directory-manifest+json;version=1",
  "truncated": false,
  "producerId": "review-directory-capture",
  "producerVersion": 1,
  "transformVersion": 1
}
```

`purpose` 是 kind-owned fixed enum；artifact identities 按 `purpose`、再按 `contentDigest` 排序且不得重复。当前 file admission 使用空 array，directory/commit/git_diff 各要求一个合同指定 purpose。
- `snapshot.identity` exact formula：

```text
sha256(canonicalJson({
  schemaId: "tiangong.target-snapshot.v1",
  snapshotSchemaVersion: 1,
  kind,
  descriptor,
  captureVersion,
  facts,
  artifacts: artifactContentIdentities
}))
```

storage path、opaque/random ref、`capturedAt` 和最终 `identity` 自身不参与该 projection。

### 5.2 Scope schema

```json
{
  "scope": {
    "revision": 2,
    "targets": ["<materialized target objects>"],
    "digest": "<lowercase sha256>"
  }
}
```

`scope.digest` exact formula：

```text
sha256(canonicalJson({
  schemaId: "tiangong.review-scope.v2",
  targets: scope.targets.map(target => ({
    targetId: target.targetId,
    kind: target.kind,
    descriptor: target.descriptor,
    snapshotIdentity: target.snapshot.identity
  }))
}))
```

所有 D2 identity/digest 都使用代码现有的 canonical JSON 语义：object keys 递归按 ECMAScript default UTF-16 code-unit order 排序、array 保序、只允许 JSON null/boolean/string/finite number、`-0` 规范为 `0`、忽略 object 中的 `undefined`、不做 Unicode normalization，并对 `JSON.stringify` 产出的 UTF-8 bytes 计算 lowercase SHA-256。

其它 exact domain：

- normalized target request digest：`sha256(canonicalJson({schemaId:"tiangong.target-requests.v1", targets:[...normalized request DTOs]}))`；
- directory selection digest：`sha256(canonicalJson({schemaId:"tiangong.directory-selection.v1", rootPath, includePrefixes, excludePrefixes}))`；
- git selection digest：`sha256(canonicalJson({schemaId:"tiangong.git-selection.v1", repositoryPath, pathPrefixes}))`；
- canonical JSON manifest bytes：`Buffer.from(canonicalJson(manifest), "utf8")`，无 BOM、无 trailing LF；`manifestContentDigest` 对这些 raw bytes 计算；
- operation digest：对 §8.2 exact operation object 直接 `sha256(canonicalJson(operation))`。

禁止字符串拼接、locale sort 或 filesystem/map traversal order 影响 digest。实现测试必须为以上 projection 提供固定 golden vectors。raw非 JSON artifact `contentDigest` 只对实际 canonical bytes 计算。

scope 规则：

- `start_work` 创建 initial `scope.revision=1`；每次成功 `extend_scope` 严格 +1；checkpoint/abandon 只增加 run revision，不改变 scope revision；replay 保持原 revision；
- `start_work` 创建初始 target array；`extend_scope` 只能在尾部追加；
- 已有 target object 的任何字段都不可更新；
- 删除、替换、刷新、重排和 supersede 均没有 API；
- 同一 `kind + descriptor + snapshot.identity` 不能重复加入；
- 同一 descriptor 的新 snapshot identity 可以作为新 target 追加，旧 target 仍在 final scope；
- completion 必须覆盖 final ordered target ID array；
- target ID 只在所属 run 内有意义，不能跨 run 转移 Evidence 或 artifact authority。

如果未完成的旧 snapshot 已不可消费，追加新 snapshot 不会让旧 target 自动完成；必须恢复原 bytes，或 abandon 并开始新 run。若旧 target 已经以匹配 snapshot identity 的 Evidence 完整消费，后续 source 变化不会撤销该历史 Machine Evidence。

---

## 6. Kind-owned snapshot facts

### 6.1 `file`

```json
{
  "facts": {
    "contentDigest": "<sha256>",
    "contentBytes": 1234,
    "contentLines": 42,
    "encoding": "utf-8"
  },
  "artifacts": []
}
```

admission 必须：

1. 通过 workspace/sensitive/runtime-state/symlink/hardlink 检查；
2. 以 no-follow/beneath 语义打开普通文件并固定同一 handle；
3. 记录 `fstat` A；若不是 regular、`nlink!=1` 使用 `TARGET_TYPE_UNSUPPORTED`，若初始 size 超过 `MAX_MEMBER_BYTES` 立即 `TARGET_LIMIT_EXCEEDED`，不分配/读取完整 source；
4. 使用总 allocation/read 上限 `MAX_MEMBER_BYTES+1` 从 position 0 捕获 Buffer A，记录 `fstat` B；再以同一上限从 position 0 捕获 Buffer B，记录 `fstat` C，并重新解析 descriptor path；任何 observed size/buffer 超限优先返回 `TARGET_LIMIT_EXCEEDED`；
5. 要求三次 `dev/ino/type/nlink/size/mtimeNs/ctimeNs` 相同、两份 Buffer byte-for-byte 相同、两次 length 等于 size、descriptor 仍解析到同一 opened inode；
6. 对 Buffer A 计算 raw digest/bytes，并用固定 fatal UTF-8 decoder生成 line facts；
7. 任一稳定性检查不满足返回 `TARGET_CHANGED_DURING_CAPTURE`；binary、invalid UTF-8、unsupported type 或 limit 使用各自更具体 code。

该算法证明两次受约束 capture 得到相同 bytes 并且 descriptor 在验证点仍绑定同一 inode；它不声称观察到发生后又恢复为相同 bytes 的所有 filesystem write。initial physical resolution 使用 §14 path errors；一旦 handle 已成功打开，最终 descriptor re-resolution 的 ENOENT/EACCES/symlink/different inode/type 都统一视为 observed race，返回 `TARGET_CHANGED_DURING_CAPTURE`，不重新映射为 initial path error。

后续 consume 必须重新计算并匹配 admission `contentDigest/contentBytes/contentLines`。不匹配返回 `TARGET_CHANGED`，不得把新版本当作原 target。

### 6.2 `directory_snapshot`

snapshot facts：

```json
{
  "facts": {
    "memberCount": 12,
    "totalContentBytes": 45678,
    "selectionDigest": "<sha256>",
    "manifestContentDigest": "<sha256>"
  },
  "artifacts": ["<directory-manifest binding>"]
}
```

canonical manifest 是 Captured Artifact，使用 media type `application/vnd.tiangong.directory-manifest+json;version=1`、producer `review-directory-capture/1`、transformVersion `1`，并使用稳定排序和 exact schema：

```json
{
  "schemaVersion": 1,
  "kind": "directory-manifest",
  "rootPath": "worker/agent",
  "selectionDigest": "<sha256>",
  "members": [
    {
      "path": "context/reviewer-context.mjs",
      "contentDigest": "<sha256>",
      "contentBytes": 1234,
      "contentLines": 42,
      "encoding": "utf-8"
    }
  ]
}
```

目录 capture 不是 filesystem 级原子快照。backend 必须以以下有限合同形成稳定 capture：

1. 第一次稳定排序枚举 selected path set；
2. 对每个 selected regular file 执行与 `file` 相同的 stable Buffer capture；
3. 第二次稳定排序枚举，要求 selected path set 完全一致，并再次打开/捕获每个成员，要求 digest/bytes/lines 与第一次完全一致；
4. 任何成员 digest/identity 在两次 capture 间变化、成员增删、selected symlink/special/binary/invalid UTF-8 或 limit violation 均返回 `TARGET_CHANGED_DURING_CAPTURE` 或更具体稳定 code；
5. 不在同一次 backend execution 内无限重试；调用方可发起新的 invocation。

selected unsupported member 不得静默忽略。明确 excluded 的 subtree 不属于 target；mandatory sensitive/runtime-state deny 不能被 include 恢复。空 manifest 返回 `TARGET_EMPTY`。

后续 member consume 使用 manifest 中的 normalized relative path 和 expected digest；manifest 外路径 deny。source 中新增文件不会改变 snapshot；manifest 内未完成成员发生变化时返回 `TARGET_CHANGED`。

### 6.3 `commit`

snapshot facts：

```json
{
  "facts": {
    "objectFormat": "sha1",
    "commitOid": "<full oid>",
    "treeOid": "<full oid>",
    "memberCount": 12,
    "totalContentBytes": 45678,
    "selectionDigest": "<sha256>",
    "manifestContentDigest": "<sha256>"
  },
  "artifacts": ["<git-tree-manifest binding>"]
}
```

admission 固化 full commit OID 和 tree OID。ref 后续移动不改变 target。canonical tree manifest 至少包含 selected path、blob OID、canonical content digest/bytes/lines，并按 path bytes 排序。

首版只允许 repository root 与 git directory 都位于授权 workspace 内的普通非 bare repository。linked worktree、外部 git dir、外部 submodule、replace object、promisor/network object retrieval 或不支持的 layout fail closed。selected binary/symlink/submodule/special entry 不得静默当作已评审文本。

后续 consume 只使用 pinned tree/blob identity，不重新解析原 ref。pinned commit/tree/blob object 缺失统一返回 `GIT_OBJECT_UNAVAILABLE`；object bytes 可读取但与 pinned OID、manifest content digest 或 metadata 冲突时返回 `TARGET_ARTIFACT_INVALID`。

### 6.4 `git_diff`

snapshot facts：

```json
{
  "facts": {
    "objectFormat": "sha1",
    "baseCommitOid": "<full oid>",
    "headCommitOid": "<full oid>",
    "changedFileCount": 3,
    "diffContentDigest": "<sha256>",
    "diffContentBytes": 9876,
    "diffContentLines": 220
  },
  "artifacts": ["<canonical git-diff binding>"]
}
```

base/head ref 在一次 admission 中各解析一次并固化 full commit OID。后续 ref movement 不改变 target。canonical diff 的 argv、environment、rename/context policy、binary handling、ordering、producer 和 transform version 必须由单独 local-git 合同固定。

只有 `truncated=false`、完全可规范化为 UTF-8 text patch 的 canonical diff 才可成为 target snapshot。selected binary、submodule 或 unsupported object change 返回 `TARGET_TYPE_UNSUPPORTED`，不得只凭 “binary files differ” marker 宣称完整消费。空 diff 返回 `TARGET_EMPTY`；截断输出只允许成为后续探查结果，不能满足 target admission 或 completion。

---

## 7. CapturedArtifactStore seam

任何 kind 在 journal 中引用 artifact 前，[`CapturedArtifactStore`](./captured-artifact-store.md) 必须已经通过独立公开合同和 deterministic tests。D2a 只冻结以下接口不变量：

- artifact bytes 与 metadata 在 journal commit 前 durable；
- journal 只保存 store-validated opaque ref 和有界 metadata，不保存 manifest/diff/raw content；
- Evidence 只保存 artifact-ref digest、content digest、bytes、media type、truncated、producer/transform version，不保存 raw ref 或 bytes；
- store 必须维护由 `sessionId + actorId + runId + targetId + invocation identity + artifactRefDigest` 精确查找 opaque ref 的受保护 index；coverage/restart 只能用这些 machine fields join，不能枚举 store 或从模型/transcript取得 ref；
- ContextPack、OTel、tool errors 和 machine status 不暴露 artifact ref、manifest、diff 或 source content；
- store read 必须重新验证 actor/run/target binding、ordinary file/no symlink、permissions、length 和 content digest；
- missing、partial、tampered、cross-run 或 cross-target artifact 在模型循环前 fail closed；
- transcript reset 不删除 artifact；artifact retention 不能让 active/recoverable target伪装为仍可消费；
- admission array 中任一 target 失败时不写 PracticeRun event；此前产生但未被 journal 引用的 artifact 是 orphan，不构成 scope 或 completion Evidence。

ArtifactStore 的目录布局、exact envelope、serialization、quota、purge/tombstone 和 remote storage behavior 由其独立合同拥有，本文不预先实现。

---

## 8. Admission、Gate、effects 与幂等

### 8.1 Operation effects

所有 typed-target admission/consume operation 的 `effects` 由代码生成 exact keys：

```json
{
  "localRead": true,
  "workspaceMutation": false,
  "networkEgress": false,
  "modelInference": false,
  "costBearing": false
}
```

`effects` 是事实描述，不授予权限。mode 来自 fixed profile/deployment policy；模型不能提供或覆盖。local git operation 仍为 localRead，不因使用 subprocess 变成任意代码执行。

`start_work` / `extend_scope` admission operation exact outer keys：

```json
{
  "policyVersion": "practice-run-v2",
  "category": "state-transition",
  "toolName": "start_work",
  "effects": {
    "localRead": true,
    "workspaceMutation": false,
    "networkEgress": false,
    "modelInference": false,
    "costBearing": false
  },
  "workspaceScope": "<workspace-root sha256>",
  "roleId": "reviewer",
  "profileDigest": "<sha256>",
  "practiceId": "review",
  "practiceVersion": 2,
  "origin": {
    "actorId": "<authenticated actor>",
    "sourceMessageId": "<stable message id>",
    "requestDigest": "<protected request digest>"
  },
  "state": null,
  "input": {}
}
```

`workspaceScope = sha256(canonicalJson({schemaId:"tiangong.workspace-scope.v1",workspaceRealpath}))`，其中 workspaceRealpath 是 runtime 初始化时固定的 trusted absolute realpath，不来自 model。`start_work.input` exact keys 为 `objectiveDigest/objectiveBytes/criteria/targetRequests/targetRequestsDigest/capturePolicyVersion/workspacePolicyVersion/textPolicyVersion`；`state=null`。`extend_scope.input` exact keys 为 `targetRequests/targetRequestsDigest/capturePolicyVersion/workspacePolicyVersion/textPolicyVersion/previousScopeDigest`；`state` exact 为 `{runId,expectedRunRevision}`。`targetRequests` 是 §4 DTO 的 normalized ordered array；digest 使用 §5.2 formula；版本 exact 为 `capturePolicyVersion="review-target-capture-v1"`、`workspacePolicyVersion="workspace-target-policy-v1"`、`textPolicyVersion="review-text-lines-v1"`。operation digest 对完整 object 计算，因此 actor/profile/workspace/state/requests/effects/policies 全部绑定；candidate IDs 和 backend snapshot facts是结果，不进入 proposal operation。

### 8.2 Admission transaction

`start_work` / `extend_scope` 的 wrapped backend 按顺序：

1. 在 proposal 前按 §14 precedence 完成 actor/profile/active-state、DTO/kind、pure lexical descriptor/policy 和同 batch exact descriptor duplicate validation；只做 Context 固定 upper-bound 预检；
2. 构建 §8.1 exact operation，operation digest 绑定 normalized target requests、policy versions、actor/profile/workspace 和 expected state；
3. Gate allow 后生成 candidate run ID（start 适用）、candidate target IDs 和本 invocation staging identity；这些 ID 在 journal commit 前不构成 Machine State；
4. 按 request order 执行 physical target capture，并将所需 Captured Artifacts 以 candidate actor/run/target binding durable；
5. 构建 snapshot identities 与 new scope digest；
6. 对 existing-scope snapshot duplicate、aggregate quota、artifact bindings 和 final-scope schema 做 validation；
7. 构建 final materialized ContextPack v3 并执行 exact rendered-byte capacity check；
8. 在 journal lock 内执行 commit-time CAS，一次 append `run.started` 或 `scope.revised`；journal reference 使对应 store objects authoritative，未被引用者仍是 orphan；
9. wrapper 记录完成或 replay Evidence。

不得在 Gate allow 前读取 target filesystem metadata、持久化 artifact、执行 git subprocess 或提交 journal。preflight allowlist 仅包括纯 lexical DTO/ref/path normalization、trusted workspace-root identity、fixed profile/registry lookup、actor/active-run/revision lookup、objective/criteria validation 和 Context upper-bound calculation。对每个 target 的 existence、`lstat/realpath`、type、symlink/hardlink、directory membership、repository layout、ref existence、`.git` config 和 source bytes 的检查全部在 Gate allow 后。多 target 不扩大该 preflight allowlist。

snapshot facts 是 backend result，不由模型提供。operation 在 journal 前 crash 时尚无 authoritative target；durable artifact 只是 orphan。journal commit 后，即使 wrapper completion Evidence 写入失败，PracticeRun state 仍权威，same invocation replay 返回已保存 target IDs/snapshot identities，不能 recapture。

### 8.3 Atomicity 与 CAS

- target array 全部成功或全部不进入 scope；
- `start_work` journal commit 在同一 file lock reload 后要求 `activeRunId=null`；两个并发 start 只能一个提交。loser 若是已提交 original invocation则 replay；否则同 actor 返回 `ACTIVE_RUN_EXISTS`，不同 actor 返回不泄露 run detail 的 `RUN_REQUESTER_MISMATCH`；其 candidate artifacts 均为 orphan；
- `extend_scope` 绑定 `runId + expectedRunRevision + previousScopeDigest`；
- 并发 extension 只有一个 CAS 成功，另一个返回 `STALE_RUN_REVISION`；
- original invocation replay 返回原结果；相同 invocation identity 的不同 target request/input digest 返回 `INVOCATION_CONFLICT`；
- source 在 preflight 与 backend capture 之间变化时，以成功提交的 backend capture 为唯一 snapshot；如果无法形成内部稳定 capture则失败；
- source 在 journal commit 后变化不修改 journal。

---

## 9. Target-bound consume contract

本合同不新增实际工具，但冻结后续 consume operation 的 authority boundary。旧 `read({path,...})` 在 schema activation 时 clean-cut 变为 target-bound union：

```json
{
  "targetId": "target-...",
  "offset": 1,
  "limit": 2000
}
```

或对于有成员的 target：

```json
{
  "targetId": "target-...",
  "memberPath": "context/reviewer-context.mjs",
  "offset": 1,
  "limit": 2000
}
```

规则：

- `file` 和 `git_diff` 不接受 `memberPath`；
- `directory_snapshot` 和 `commit` 必须提供 manifest 中的 normalized `memberPath`；
- model 不能提交 path 代替 target ID，也不能提交 snapshot/artifact/content digest；
- backend 从 current actor-owned active run 解析 target ID，再映射 descriptor/manifest/artifact；
- file/directory source bytes 必须匹配 admission snapshot；commit 只按 pinned OID/blob；git_diff 只读 bound artifact；
- 每次 consume 只把本次实际返回给模型的 canonical chunk bytes 保存为一个 Captured Artifact，不保存整份 resource 的副本；full bytes/lines 来自 target snapshot/resource metadata，chunk artifact digest 只覆盖 returned bytes；
- chunk artifact 在返回模型前 durable，并在 Evidence 中记录安全 digest/ref binding；
- raw returned bytes 不进入 hash-chain Evidence、journal、OTel 或错误；
- operation metadata 绑定 run/revision、targetId、snapshot identity、resource selector、offset/limit、policy/effects/profile；
- result metadata 绑定 content/artifact digest、full bytes/lines、returned range、truncated 和 target snapshot identity；
- failed、denied、digest-mismatch 或 truncated-admission lifecycle 不计入 complete consumption。

文本范围语义 clean-cut 沿用 Reviewer 的 LF-based contract：固定 `TextDecoder("utf-8", {fatal:true, ignoreBOM:false})`，因此可选 UTF-8 BOM 计入 raw `contentDigest/contentBytes` 但不出现在 decoded text/model chunk；decode 后以 U+000A (`\n`) 分割，bare `\r` 不分行，CRLF 中的 `\r` 保留在该逻辑行；空文本有 1 个空行，末尾 `\n` 产生最后一个空行。

consume tool 的 `offset/limit` 必须是 positive safe integer；`limit` 最大 2000；offset 超过 `contentLines`、`limit=0`、fraction 或 unsafe integer 返回 `TARGET_RANGE_INVALID`。backend 在 requested `[offset, min(contentLines, offset+limit-1)]` 内返回从 offset 开始、加入 `\n` separator 后仍不超过 50KiB 的最大完整行前缀；若第一行即超过 byte limit，返回 `TARGET_LIMIT_EXCEEDED`，否则成功返回该前缀，`returnedLineEnd` 为最后一行，`truncated = returnedLineEnd < contentLines`。因此两行各 30KiB 时 `offset=1,limit=2` 只成功返回第一行并覆盖 `[1,1]`。空 file resource 的 observation `[1,1]` 合法，但仍要求一次成功的 `[1,1]` zero-byte consume Evidence，不能零次自动 complete。coverage 按 inclusive line ranges 合并，并同时校验 returned bytes digest/range metadata。

`review-text-lines-v1` 的 binary predicate 对 stable raw Buffer 逐 byte 执行：任何 byte `<0x20` 且不属于 TAB `0x09`、LF `0x0a`、CR `0x0d`，或 byte 等于 DEL `0x7f`，均返回 `TARGET_TYPE_UNSUPPORTED`；因此 NUL 即使属于合法 UTF-8 也被拒绝。只有 predicate 通过后才执行 fatal UTF-8 decode。

`MAX_CONSUME_SEGMENTS_PER_RESOURCE=128` 统计 fixed Evidence boundary 内绑定该 resource/snapshot 的全部成功 consume executions，不是合并后的区间数；第 129 个使 resource/target `blocked`，reason=`TARGET_EVIDENCE_LIMIT_EXCEEDED`，不能通过忽略旧 Evidence 恢复。

目录 list/search 或 git show/log/status/blame 是后续结构化探查 operation。它们可以产生 Captured Artifact，但除非 kind-owned coverage projector 明确选择，不得替代 full target consumption。

---

## 10. Coverage 与 `nextAction`

### 10.1 Target coverage projection

review practice 继续拥有单一 deterministic coverage projector，checkpoint 和 `nextAction` 不得复制算法。目标投影：

```text
TargetCoverage
  targetId
  kind
  snapshotIdentity
  status: complete | unread | partial | blocked
  reasonCode?
  selectedEventRefs[]
  resourceFacts?        # internal only; not copied into ContextPack
```

kind-owned complete semantics：

| kind | complete condition |
|---|---|
| `file` | matching admission content identity 的区间并集完整覆盖 `1..contentLines` |
| `directory_snapshot` | exact manifest 已验证，且每个 manifest member 都按其 admission digest 完整覆盖 |
| `commit` | pinned tree manifest 已验证，且每个 selected blob resource 都完整覆盖 |
| `git_diff` | bound non-truncated canonical diff artifact 完整覆盖 |

共同规则：

- coverage 只使用 fixed Evidence boundary 及之前、actor/run/target/snapshot/artifact binding 完整的成功 lifecycle；
- 同一 target 的 Evidence 不能转给同 descriptor 的另一个 target；target source 新版本、其它 commit OID 或其它 artifact digest 不计；
- resource 顺序固定为 final target order；file/git_diff 各一个 resource，directory/commit 按 canonical manifest member order；
- 每 resource 先按 completed Evidence sequence 升序收集 matching success；超过 128 立即 `blocked/TARGET_EVIDENCE_LIMIT_EXCEEDED`；
- deterministic interval selection 从 `covered=0` 开始：在 `start <= covered+1` 且 `end > covered` 的候选中选择 `end` 最大者；tie 选择 completed sequence 最小者；按选择顺序追加该 execution 的 startedRef、completedRef，更新 covered；无候选且未到 full lines 则 partial；
- target selected refs 按 resource order 拼接；全部 target refs 再按 final target order 拼接；若总数超过 2048，coverage projector 以 `EVIDENCE_LIMIT_EXCEEDED` 全局 fail closed，不生成部分 TargetCoverage、ContextPack、nextAction 或 checkpoint，不得换一套非合同算法规避上限；
- 若 resource 已按上述算法 complete，后到的 source-change consume failure不撤销完成；若仍不完整，最新 target-bound terminal failure code 属于 `TARGET_CHANGED/TARGET_UNAVAILABLE/GIT_OBJECT_UNAVAILABLE` 时投影为 blocked；
- manifest/diff artifact tamper、missing store object、ambiguous lifecycle、成功 mutation 或 binding conflict 在 Context/checkpoint 前 fail closed，不降级为 blocked guidance；
- `blocked` reason 只允许 `TARGET_CHANGED/TARGET_UNAVAILABLE/GIT_OBJECT_UNAVAILABLE/TARGET_EVIDENCE_LIMIT_EXCEEDED`，不包含 raw path/content/error。

### 10.2 ContextPack v3 `nextAction`

ContextPack v3 clean-cut 使用：

```text
nextAction.code
  RESOLVE_TARGET_BLOCKER
  CONSUME_REMAINING_TARGETS
  ADDRESS_CHECKPOINT_FAILURE
  CHECK_COMPLETION
  NONE
nextAction.targetRefs[]   # exact target IDs, final scope order
nextAction.reasonCodes[]
```

优先级：

| Active run | Coverage | Last checkpoint | code |
|---|---|---|---|
| 否 | 不扫描 run-bound Evidence | 任意 | `NONE` |
| 是 | 至少一个 `blocked` | 任意 | `RESOLVE_TARGET_BLOCKER` |
| 是 | 无 blocker，至少一个 unread/partial | 任意 | `CONSUME_REMAINING_TARGETS` |
| 是 | 全部 complete | failed | `ADDRESS_CHECKPOINT_FAILURE` |
| 是 | 全部 complete | none | `CHECK_COMPLETION` |

`targetRefs` 只列对应 blocker 或 incomplete targets，按 final scope 顺序，无重复。`nextAction` 仍是 advisory：不自动调用 consume、refresh target、abandon run 或推进 completion。

---

## 11. ContextPack v3

固定 preamble exact 为三行：

```text
Tiangong authoritative per-turn ContextPack (machine state; model prose cannot modify it):
nextAction is advisory machine guidance. It does not grant authority or complete work.
targetRefs are runtime-generated IDs in activeRun.scope.targets; each consume still requires actor/run/snapshot authorization.
```

active run 的有界 machine projection：

```json
{
  "schemaVersion": 3,
  "roleId": "reviewer",
  "profileDigest": "...",
  "assuranceLevel": "worker-local / static-review-only",
  "activeRun": {
    "runId": "run-...",
    "revision": 2,
    "status": "active",
    "objective": {
      "text": "...",
      "source": "model_normalized"
    },
    "acceptanceCriteria": [
      {
        "id": "criterion-1",
        "description": "...",
        "source": "model_normalized"
      }
    ],
    "scope": {
      "revision": 2,
      "digest": "...",
      "targets": [
        {
          "targetId": "target-...",
          "kind": "directory_snapshot",
          "descriptor": {},
          "snapshotSummary": {
            "identity": "...",
            "memberCount": 12,
            "totalContentBytes": 45678
          }
        }
      ]
    },
    "lastCheckpointReasonCodes": []
  },
  "nextAction": {
    "code": "CONSUME_REMAINING_TARGETS",
    "targetRefs": ["target-..."],
    "reasonCodes": ["TARGET_CONSUMPTION_INCOMPLETE"]
  }
}
```

约束：

- `descriptor` 精确复制 bounded `target.descriptor.value`；它可以包含 normalized path、selection、requested ref 和 path prefixes，但不包含 raw request 或 model prose；
- `snapshotSummary` 使用以下 exact allowlist，所有未列字段都禁止：

| kind | snapshotSummary exact keys |
|---|---|
| `file` | `identity, contentBytes, contentLines` |
| `directory_snapshot` | `identity, memberCount, totalContentBytes` |
| `commit` | `identity, objectFormat, commitOid, treeOid, memberCount, totalContentBytes` |
| `git_diff` | `identity, objectFormat, baseCommitOid, headCommitOid, changedFileCount, diffContentBytes, diffContentLines` |

- ContextPack 不显示 source content digest、selection/manifest digest、artifact ref/ref digest、capturedAt、manifest members、diff/commit message、raw content、Evidence 或 source request；不得让模型 prose 混入 Machine State；
- descriptor 每字段、每 selector array 和总 bytes 受 §14 limits；kind summary 只含固定整数/enum/digest/OID；
- top-level exact keys 为 `activeRun/assuranceLevel/nextAction/profileDigest/roleId/schemaVersion`；activeRun exact keys 与上例一致；scope exact keys 为 `digest/revision/targets`；target summary exact keys 为 `descriptor/kind/snapshotSummary/targetId`；
- `nextAction` 始终 exact keys `code/reasonCodes/targetRefs`；targetRefs/reasonCodes 有序、唯一、各最多 64/16；无 active run 时 `activeRun=null` 且 nextAction exact 为 `{code:"NONE",targetRefs:[],reasonCodes:[]}`，不扫描 artifact store 或旧 run Evidence；
- guidance reason code closed set 为 `TARGET_CONSUMPTION_INCOMPLETE/TARGET_CHANGED/TARGET_UNAVAILABLE/GIT_OBJECT_UNAVAILABLE/TARGET_EVIDENCE_LIMIT_EXCEEDED/CRITERIA_COVERAGE_INVALID/CLAIM_SCOPE_MISMATCH/OBSERVATION_TARGET_INVALID/REPORT_OUTCOME_INCONSISTENT/STATIC_LIMITATION_REQUIRED/MUTATION_OBSERVED`；每个 action 只使用 §10.2 对应来源；`EVIDENCE_LIMIT_EXCEEDED` 是 model-loop 前全局错误，不进入 guidance；
- `lastCheckpointReasonCodes` 从 lastCheckpoint.results 的固定 checkpoint order 过滤 `satisfied=false` 后取 reasonCode，并按首次出现 stable-unique，最多 8；任何不在上述 checkpoint subset（从 `CRITERIA_COVERAGE_INVALID` 到 `MUTATION_OBSERVED`，含 target consumption/blocker codes）的值使 state/context fail closed，不排序、不复制重复；
- ContextPack bytes 精确等于固定 code-owned preamble、一个 LF 和 `canonicalJson(pack)` 的 UTF-8 bytes；admission capacity 在 `start_work` / `extend_scope` commit 前用 final materialized pack 计算，overflow 整体失败；
- `MAX_TARGET_DESCRIPTOR_BYTES` 对完整 `descriptor` wrapper 的 canonical UTF-8 bytes 计算；`MAX_SCOPE_DESCRIPTOR_BYTES` 对 ordered descriptor wrapper array 的 canonical UTF-8 bytes 计算；
- `targetRefs` 直接使用 target ID，不再支持 `scope-file-N`；
- actor mismatch、journal/artifact tamper、ambiguous Evidence 或 context overflow 时不进入模型循环。

---

## 12. Claim v2 与 checkpoint v2

`review-claim-v2` 的完整 top-level exact shape：

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
    "targetIds": ["target-..."]
  },
  "report": {
    "outcome": "accept",
    "synopsis": "...",
    "observations": [
      {
        "level": "minor",
        "target": { "targetId": "target-..." },
        "statement": "...",
        "rationale": "...",
        "suggestedAction": "...",
        "confidence": "high"
      }
    ],
    "limitations": [
      {
        "code": "STATIC_REVIEW_ONLY",
        "detail": "..."
      }
    ],
    "nextActions": []
  }
}
```

schema 规则保持显式：

- top-level、criterion、scope、report、observation、limitation 和 observation-target 全部 exact keys；`canonicalJson(claim)` UTF-8 最大 256KiB；
- `criteriaResults` 非空、最多 32；criterionId 必须匹配 `^criterion-[1-9][0-9]*$`、最大 64 bytes，并对 final run criteria 一一覆盖且无重复；status exact enum 为 `addressed/not_addressed`；
- observations 可空、最多 256；level exact enum 为 `critical/major/minor/note`；confidence exact enum 为 `low/medium/high`；
- outcome exact enum 为 `accept/changes_requested/blocked`；
- `report.nextActions` 是 string array，可空、最多 256；每个 item trim 后非空、无 NUL、最大 16KiB；
- explanation/synopsis/statement/rationale/suggestedAction/limitation detail 都必须是非空 string、无 NUL、各最大 16KiB；
- limitations 必须恰好一个 exact `{code:"STATIC_REVIEW_ONLY",detail}`；
- targetId 使用 §5.1 pattern；claim line fields 必须 positive safe integer 且 `lineEnd>=lineStart`，否则 `CLAIM_SCHEMA_INVALID`；通过 schema 后的 target kind/member membership/full-line bounds 在 checkpoint 中验证，失败 reason=`OBSERVATION_TARGET_INVALID`，不返回 consume-tool 的 `TARGET_RANGE_INVALID`；memberPath 使用 §15.1 normalized relative path语义；
- 任何 model-provided digest、artifact/Evidence ref、toolCallId、revision 或额外 location field 都是 `CLAIM_SCHEMA_INVALID`。

outcome consistency 继续精确定义为：任一 `critical` 或 `not_addressed` → `blocked`；否则任一 `major` → `changes_requested`；否则 → `accept`。存在 `not_addressed` 时 `nextActions` 非空。解释和结论仍是模型 claim，机器只验证结构与一致性。

### 12.1 Claim scope

claim v2 clean-cut 使用 ordered target IDs：

```json
{
  "scope": {
    "targetIds": ["target-..."]
  }
}
```

模型不重复 descriptor、snapshot identity、artifact ref 或 digest。`scope-matches-final` 对 final ordered target ID array exact compare。

### 12.2 Observation target

observation target 只允许以下 exact-key union：

```json
{ "targetId": "target-..." }
```

```json
{ "targetId": "target-...", "lineStart": 10, "lineEnd": 20 }
```

```json
{ "targetId": "target-...", "memberPath": "context/reviewer-context.mjs" }
```

```json
{
  "targetId": "target-...",
  "memberPath": "context/reviewer-context.mjs",
  "lineStart": 10,
  "lineEnd": 20
}
```

validation：

- `file`：不允许 memberPath；可选 line range 必须在 admission text resource 内；
- `directory_snapshot` / `commit`：memberPath 必须在 exact manifest；可选 lines 必须不超过该 snapshot member；
- `git_diff`：首版只允许 target-level observation，不允许 memberPath/line range；local-git 合同若需要精确 diff location，必须另行版本化 claim schema；
- target 必须属于 final scope 且 coverage complete；
- observation location 是模型 claim，不是 Machine Evidence。

### 12.3 Checkpoint set

claim schema validation 在 wrapper proposal/Evidence/journal 前完成；`CLAIM_SCHEMA_INVALID/CLAIM_LIMIT_EXCEEDED` 直接拒绝 invocation，不持久化 claim 或 `checkpoint.evaluated`，因此不会进入 `lastCheckpointReasonCodes`。进入 checkpoint 的 `claim-schema-valid` 按构造恒为 true，保留该 item 只用于固定 checkpoint set/audit，不能记录 false。

`review-v2` 保持八个职责，但 clean-cut 修改 scope/coverage identity：

```text
claim-schema-valid
criteria-covered
scope-matches-final
targets-fully-consumed
observation-targets-valid
outcome-consistent
static-review-limitation-recorded
no-mutation-observed
```

`targets-fully-consumed` 选择 kind-owned coverage 的 exact Evidence refs，并绑定 target ID、snapshot identity 和 artifact/content digest。任何 blocked、partial、unread、truncated、tampered、missing artifact 或 unsupported target 均失败。

其它 outcome、criteria 和 `STATIC_REVIEW_ONLY` 语义保持不变。checkpoint result schemaVersion=2，operation 绑定 `review-claim-v2`、`review-v2`、final scope digest、claim digest 和 fixed Evidence boundary。

---

## 13. Journal 与 recovery

### 13.1 `run.started`

payload v2 保存：

- role/practice/profile/origin/spec refs；
- initial ordered materialized targets；
- scope digest；
- target capture policy/registry versions；
- artifact safe refs/metadata，不保存 bytes。

### 13.2 `scope.revised`

payload v2 将 `addedFiles` 替换为 `addedTargets`，并绑定：

```text
previousScopeDigest
newScopeDigest
sourceRequestDigest/ref
expectedRunRevision
```

全部 target 已 capture/durable 后才一次 append。

### 13.3 Restart order

模型循环前：

1. 验证 fixed profile 与 target-kind registry；
2. 完整验证 PracticeRun v2 journal chain/revision/scope digest；
3. 重建 derived `snapshot.json` cache；
4. 对 active run 的 artifact bindings 做 store envelope、digest、actor/run/target availability validation；
5. 验证 Evidence chain；
6. 生成 coverage、nextAction 和 ContextPack v3。

artifact 缺失或损坏不得降级为 live path/ref recapture，也不得自动刷新 snapshot。

### 13.4 Crash truth table

| Crash point | Authoritative result |
|---|---|
| Gate 前 | 无 capture、artifact 或 state |
| capture 中、artifact durable 前 | 无 state；partial temp 不可读 |
| artifact durable、journal 前 | orphan artifact；不属于 scope，可安全忽略/显式维护清理 |
| 部分 targets captured、final journal 前 | 整个 target array 未提交；不得部分加入 scope |
| journal commit、wrapper completion Evidence 前 | journal targets 权威；replay 返回原 IDs/identities，不 recapture |
| scope commit、source change 后 | journal snapshot 不变；后续 mismatched live consume 返回 `TARGET_CHANGED` |
| journal valid、artifact missing/tampered | 模型前 fail closed；不从 source 重建 |
| derived PracticeRun cache missing/mismatch | 验证 journal 后重建 cache；不改变 target snapshot |
| completion commit、delivery 前 | done 权威；不重复 checkpoint 或 target capture |

---

## 14. Limits 与 fail-closed errors

首版至少固定并集中测试：

```text
MAX_SCOPE_TARGETS=64
MAX_TARGET_DESCRIPTOR_BYTES=4KiB
MAX_SCOPE_DESCRIPTOR_BYTES=32KiB
MAX_PATH_BYTES=1KiB
MAX_SELECTOR_PREFIXES_PER_TARGET=128
MAX_DIRECTORY_MEMBERS=2048
MAX_MEMBER_BYTES=2MiB
MAX_TARGET_CONTENT_BYTES=16MiB
MAX_RUN_TARGET_CONTENT_BYTES=16MiB
MAX_CONTEXT_PACK_BYTES=64KiB
MAX_CONSUME_SEGMENTS_PER_RESOURCE=128
MAX_SELECTED_EVENT_REFS=2048
```

CapturedArtifactStore 或 Channel Plane 有更低 limit 时取更低值并同步公开合同。任何 aggregate limit 必须在 journal append 前验证；不允许截断后标记 complete。

稳定错误至少包括：

```text
INVALID_TARGET
TARGET_KIND_NOT_MATERIALIZED
TARGET_SELECTOR_INVALID
TARGET_LIMIT_EXCEEDED
TARGET_OUTSIDE_WORKSPACE
TARGET_NOT_FOUND
TARGET_TYPE_UNSUPPORTED
TARGET_SYMLINK_DENIED
TARGET_SENSITIVE_PATH_DENIED
TARGET_EMPTY
TARGET_CHANGED_DURING_CAPTURE
TARGET_CHANGED
TARGET_UNAVAILABLE
TARGET_ARTIFACT_INVALID
TARGET_RANGE_INVALID
TARGET_EVIDENCE_LIMIT_EXCEEDED
TARGET_ID_GENERATION_FAILED
EVIDENCE_LIMIT_EXCEEDED
SCOPE_TARGET_ALREADY_PRESENT
GIT_REF_INVALID
GIT_REPOSITORY_UNSUPPORTED
GIT_OBJECT_UNAVAILABLE
CAPTURE_LIMIT_EXCEEDED
UNSUPPORTED_STATE_SCHEMA
CONTEXT_PACK_LIMIT_EXCEEDED
```

相邻错误不得重叠：

- malformed exact DTO、wrong JSON type、unknown key/kind 使用 `INVALID_TARGET`；未 materialize closed kind 使用 `TARGET_KIND_NOT_MATERIALIZED`；
- malformed include/exclude/path-prefix shape、overlap 或 duplicate 使用 `TARGET_SELECTOR_INVALID`，git ref grammar 使用 `GIT_REF_INVALID`；absolute path、`..` 或任何 lexical/physical workspace escape 使用 `TARGET_OUTSIDE_WORKSPACE`；
- admission source 不存在使用 `TARGET_NOT_FOUND`；permission/unreadable 使用 `TARGET_UNAVAILABLE`；wrong special type、hardlink、binary 或 invalid UTF-8 使用 `TARGET_TYPE_UNSUPPORTED`；symlink/sensitive 使用各自 code；
- per descriptor/member/target size/count limit 使用 `TARGET_LIMIT_EXCEEDED`；final run aggregate/store quota使用 `CAPTURE_LIMIT_EXCEEDED`；Context rendered bytes 单独使用 `CONTEXT_PACK_LIMIT_EXCEEDED`；
- 同 batch exact `kind+normalized descriptor` duplicate 在 capture 前使用 `SCOPE_TARGET_ALREADY_PRESENT`；与已有 scope 的 duplicate 只有在 capture 后 snapshot identity 也相同才使用该 code；
- 已提交 file/directory source/member 后续缺失使用 `TARGET_UNAVAILABLE`；bytes 存在但不匹配 snapshot 使用 `TARGET_CHANGED`；pinned git object 缺失使用 `GIT_OBJECT_UNAVAILABLE`；CapturedArtifactStore object 缺失、tampered、partial 或 metadata/digest conflict 使用 `TARGET_ARTIFACT_INVALID`；
- invalid consume offset/limit 使用 `TARGET_RANGE_INVALID`；claim line type/order使用 `CLAIM_SCHEMA_INVALID`，合法整数但 target/member/full-line bounds 不匹配使用 checkpoint reason `OBSERVATION_TARGET_INVALID`；per-resource/global selected-ref Evidence limit 分别使用 `TARGET_EVIDENCE_LIMIT_EXCEEDED/EVIDENCE_LIMIT_EXCEEDED`。

确定性 precedence：

1. actor/profile/active-state；
2. exact DTO 与 materialized kind；
3. lexical path/ref/prefix grammar与 workspace escape；
4. lexical sensitive-name policy；
5. 同 batch exact normalized descriptor duplicate；
6. Gate；
7. 对每个 request、directory member按声明/canonical order执行 initial physical traversal：每个 component 依次处理 OS error（ENOENT→`TARGET_NOT_FOUND`，EACCES/其它不可读→`TARGET_UNAVAILABLE`），再检查 symlink，最终检查 ordinary type/hardlink；handle 成功打开后的 final re-resolution race统一按 §6.1 `TARGET_CHANGED_DURING_CAPTURE`；
8. initial/per-object size/count limit与 bounded-read cap；
9. double-capture stability；
10. binary/UTF-8/text-line validation；
11. capture 后与 existing scope 的 exact snapshot duplicate；
12. final aggregate quota → artifact validation → final Context capacity → run CAS/journal。

因此不存在的 `.env` 和名为 `.env` 的 symlink 都在 Gate 前稳定返回 `TARGET_SENSITIVE_PATH_DENIED`；非敏感 symlink 返回 `TARGET_SYMLINK_DENIED`。更早阶段失败时不继续寻找后续错误；已 durable 的先前 artifact 仍只是 orphan。

错误结果只返回 stable code 和有界安全说明；不得包含 manifest、diff、commit message、raw stderr、artifact path、protected request 或 unrestricted source path。

---

## 15. Security boundaries

### 15.1 Filesystem

- 所有 workspace path 走同一代码拥有 resolver；descriptor 使用 `/` 分隔的 workspace-relative UTF-8 path，移除普通 `.` segment，拒绝 absolute、empty（canonical root `.` 除外）、NUL、`..`、trailing separator 和 escape；
- Linux Worker 以 case-sensitive bytes 识别 path，不做 Unicode/case normalization；同一路径的 `a` 与 `./a` 规范为同一 descriptor；
- trusted workspace root 在 runtime 初始化时解析为非 symlink directory；从该 root 到 target 的每个现存 component（包括最终项）有 symlink 即 `TARGET_SYMLINK_DENIED`，即使 symlink 最终仍指向 workspace 内；actual open 必须使用可证明 `beneath + no symlink` 的 OS/public primitive，并在 open 后再次验证 workspace containment 与 descriptor inode；若平台 primitive 不能证明该合同，typed target 不得 materialize；
- workspace regular-file target 与 selected regular-file member 要求 `nlink=1`；任何 file hardlink 返回 `TARGET_TYPE_UNSUPPORTED`，避免 path-based sensitive deny 被 inode alias 绕过；directory component 使用 no-symlink/beneath traversal，不对正常 directory link count 使用该限制；
- mandatory deny 由 code-owned `workspace-target-policy-v1` 提供：任一 segment case-insensitive 等于 `.tiangong/.env/auth.json/credentials/credentials.json/id_ed25519/id_rsa/openclaw.json`，以 `.env.` 开头，或以 `.pem/.key/.p12` 结尾均拒绝；§5.1 fixed captureVersion IDs 规范性冻结该 policy，§8.1 operation.input 另以 exact `workspacePolicyVersion` 绑定；
- pre-Gate lexical descriptor normalization 只执行 §8.2/§14 的 string grammar、escape 和 sensitive-name policy；post-Gate physical resolution/actual open 才执行 component `lstat`、beneath containment、symlink、hardlink、type 和 source checks；两阶段不得都简称为 descriptor normalization；
- stable file capture 使用 §6.1 两次 full-buffer 算法；directory 两遍 capture 对每个成员各执行该算法，跨遍还要求 selected path set、每成员 `dev + ino` 和 digest/bytes/lines 相同；
- directory recursion 不跟随 symlink；selection 不能解除 mandatory deny；
- manifest/member path 是不可信数据，展示给模型时不能成为 tool authority。

### 15.2 Git

- 只能使用结构化 action 与代码生成的 fixed `execFile` argv；不经 shell；
- 固定 cwd、最小 environment、禁 pager、禁 network、禁 hooks、禁 external diff/textconv/config injection；
- `GIT_CONFIG_NOSYSTEM=1`、空 global config、`GIT_OPTIONAL_LOCKS=0`；
- timeout、stdout/stderr、process group 和 artifact quota 必须由 local-git 合同确定；
- raw stderr、commit message 和 patch 只是不可信 content，不能进入 authorization、Evidence reason 或 Machine State prose；
- D2a 不使任何 git executor 可达。

### 15.3 Prompt injection 与事实边界

workspace、manifest、commit、diff 和 artifact 内容都可能包含 prompt injection。它们只能作为 review data；不能：

- 修改 role/profile/Gate/policy；
-选择 target/artifact/Evidence ref；
- 调用隐藏工具；
- 推进 run 或 checkpoint；
- 改写 machine status；
- 提升 assurance。

---

## 16. Status、report 与 observability

machine `workStatus` clean-cut 使用 exact keys：

```json
{
  "assurance": "worker-local",
  "runId": "run-...",
  "practiceId": "review",
  "state": "active",
  "checkpoint": "not-run",
  "scopeRevision": 2,
  "scopeTargetCount": 3
}
```

assurance enum 为 `direct-unverified/worker-local`；state 为 `none/active/done/abandoned`；checkpoint 为 `not-run/failed/passed/not-applicable`；runId/practiceId 在 no-run 时为 null，target count/revision 为 0。Matrix block 使用 `scope: revision N, targets M`。不再输出 `scopeFileCount` 或 `files M`；status 不列 path、OID、manifest 或 artifact ref。

机器渲染 completed report 对每个 target 只显示 allowlisted facts：target ID、kind、snapshot identity、safe descriptor summary、selected Evidence refs 和 checkpoint result。模型 claim 与 Machine completion facts 继续分区。

OTel clean-cut 使用 `tiangong.practice.target_count`，移除 Reviewer 的 `tiangong.practice.scope_count`。allowlist 允许 materialized kind counts、target count、status/revision 和稳定 outcome；禁止 descriptor path/ref、OID、content/artifact digest、manifest、diff、claim 和 raw error。

---

## 17. Deterministic truth tables

### 17.1 Generic target/state

| Case | Result |
|---|---|
| runtime-generated unique ID + valid snapshot | target admitted |
| model submits an admission targetId/digest/artifact ref/extra key | `INVALID_TARGET` |
| kind not in fixed materialized registry | `TARGET_KIND_NOT_MATERIALIZED` |
| one item in array fails | no target from array committed |
| same descriptor + same snapshot already in scope | `SCOPE_TARGET_ALREADY_PRESENT` |
| same descriptor + new snapshot | append distinct target; old target unchanged |
| concurrent starts from no-active observation | one journal CAS pass; loser replay/`ACTIVE_RUN_EXISTS`/`RUN_REQUESTER_MISMATCH` |
| concurrent extensions from same revision | one pass; one `STALE_RUN_REVISION` |
| journal v1 opened by v2 runtime | `UNSUPPORTED_STATE_SCHEMA` |
| artifact tamper/missing/cross-run | fail before model; no recapture |
| transcript reset/restart | same target IDs, identities, artifacts and scope digest |

### 17.2 File

| Case | Result |
|---|---|
| bounded regular UTF-8 stable file | admit exact digest/bytes/lines |
| alias paths normalize to duplicate | reject duplicate |
| two full captures or required identity fields differ | `TARGET_CHANGED_DURING_CAPTURE` |
| source changes before incomplete later consume | `TARGET_CHANGED`; no completion credit |
| source changes after exact complete Evidence | historical target remains complete |
| symlink/hardlink/binary/invalid UTF-8/sensitive/escape | stable specific deny code |
| initial/observed file bytes exceed 2MiB | bounded read; `TARGET_LIMIT_EXCEEDED` |
| requested lines exceed 50KiB after at least one line fits | maximal fitting prefix succeeds; remainder stays incomplete |

### 17.3 Directory

| Case | Result |
|---|---|
| stable selected tree | canonical sorted manifest admitted |
| explicitly excluded subtree | absent by declared selector; not silently counted |
| selected symlink/special/binary/sensitive member | entire target denied |
| member set differs between enumerations | `TARGET_CHANGED_DURING_CAPTURE` |
| empty selection | `TARGET_EMPTY` |
| list/search result truncated | exploration only; cannot satisfy manifest/coverage |
| one manifest member unread/partial/changed | target incomplete/blocked |

### 17.4 Commit/git diff

| Case | Result |
|---|---|
| safe ref resolves to commit | full commit/tree OID frozen |
| ref moves after admission | target OIDs unchanged |
| abbreviated/revision expression/option-shaped ref | `GIT_REF_INVALID` |
| linked worktree/external git dir/submodule layout | `GIT_REPOSITORY_UNSUPPORTED` |
| pinned object unavailable later | `GIT_OBJECT_UNAVAILABLE` / target blocked |
| base/head direct diff complete and nonempty | immutable diff artifact admitted |
| diff truncated or artifact digest mismatch | cannot admit/complete |
| working tree/index/remote fetch requested | not materialized / deny |

### 17.5 Claim/nextAction

| Case | Result |
|---|---|
| blocked target exists | `RESOLVE_TARGET_BLOCKER` before all other actions |
| no blocker, incomplete targets | `CONSUME_REMAINING_TARGETS` in final scope order |
| all complete + failed checkpoint | `ADDRESS_CHECKPOINT_FAILURE` |
| all complete + no failed checkpoint | `CHECK_COMPLETION` |
| claim missing/extra/reordered target IDs | `CLAIM_SCOPE_MISMATCH` |
| observation target/member/range invalid | `OBSERVATION_TARGET_INVALID` |
| successful mutation bound to run | fail closed / `MUTATION_OBSERVED` |

---

## 18. Verification 与 smoke 合同

### 18.1 Cheapest-first

1. exact schemas、normalizers、digest projections、limits 和 error codes；
2. per-kind admission positive/negative/adjacent tests；
3. journal v2 CAS/replay/corruption/crash/restart/reset tests；
4. CapturedArtifactStore join/tamper/quota tests；
5. target-bound consume、coverage、nextAction、claim/checkpoint deterministic tests；
6. image/profile/tool schema checks；
7. capability-owning Basic/Recovery smoke；
8. only when relevant，focused Journey observation。

不得用真实 model/Matrix 证明 target identity、manifest ordering、OID pinning、coverage 或 crash state。

### 18.2 Baseline file Basic

schema activation 的最小 hard gate：

```text
explicit file target request
→ runtime targetId + file snapshot identity
→ target-bound complete consume
→ claim v2 exact targetIds
→ review-v2 pass
→ done/static-review-only
```

Machine facts 必须证明 snapshot digest 与独立 fixture digest 一致、Evidence 绑定同 target ID/identity、无旧 path-authority read、无 mutation、official delivery/Harness/cleanup 通过。

### 18.3 Recovery

```text
start target A → consume A → append target B
→ persist journal/artifacts → delete derived PracticeRun cache
→ restart → same ordered IDs/identities/scope digest
```

artifact store 与 journal 必须分别验证；不能从 transcript/source recapture。模型活性不是恢复 oracle。

### 18.4 Directory 和 git smoke ownership

- directory capability 自己证明 stable manifest、member completeness、official delivery 和 cleanup；
- local git capability 自己证明 repo identity、ref→OID pinning、canonical artifact digest、no-network/no-mutation 和 cleanup；
- D2a 设计 PR 不运行或宣称这些 capability smoke；
- raw ContextPack、manifest、diff、transcript、assistant prose 和 unrestricted logs 不是 smoke oracle。

---

## 19. 实现模块职责

建议按现有 concrete Reviewer modules 演进，不建设通用角色/plugin framework：

| 职责 | Owner |
|---|---|
| target request normalization / admission | review practice-owned target registry |
| journal target schema / CAS / replay | PracticeRun service/store |
| artifact bytes / refs / retention | separately reviewed CapturedArtifactStore |
| filesystem target capture | constrained workspace backend |
| git target capture | separately reviewed structured local-git backend |
| target-bound consume | Reviewer work operations |
| target coverage / nextAction | review practice projector |
| claim/checkpoint | review practice checkpoint |
| ContextPack/status/report | Reviewer context/work renderer |
| Matrix delivery | unchanged thin OpenClaw adapter |

第二个真实角色出现前，不抽象 generic target plugin loader、dynamic policy DSL、通用 Concern runner 或 arbitrary executor。

---

## 20. 设计接受 Gate

进入实现前，评审必须能仅凭本文回答：

1. target request、descriptor、snapshot、artifact、Evidence 和 claim 分别是什么事实？
2. 为什么 ref/path 后续变化不能静默改变 target？
3. target ID、snapshot identity 和 scope digest 各绑定什么？
4. admission 在哪个 Gate 阶段读取/持久化，并如何处理部分失败和 crash orphan？
5. directory snapshot 的“完整”与 filesystem atomic snapshot 有何区别？
6. 每种 kind 的 complete consumption 如何由机器证明？
7. source changed、artifact missing、ref moved 和 truncated diff 分别如何处理？
8. ContextPack、claim、checkpoint、status 和 nextAction 如何 clean-cut 演进？
9. 为什么 CapturedArtifactStore 必须独立评审且先于依赖它的 capability？
10. 哪些行为仍明确不支持？

任何答案仍依赖 prompt、模型自报 digest、raw transcript、任意 git argv、未定义 store ref 或兼容猜测时，本合同不得进入实现。

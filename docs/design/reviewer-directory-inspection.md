# Reviewer directory snapshot 与 workspace inspection 合同

> **状态：** 已随Reviewer v2 clean-cut实现，并通过deterministic、image/profile、official Matrix Basic与journal-derived Recovery Full；本合同描述current `directory_snapshot`与structured inspection行为。
> **基础：** [`reviewer-typed-targets.md`](./reviewer-typed-targets.md)、[`captured-artifact-store.md`](./captured-artifact-store.md) 与 [`agent-plane-foundation.md`](./agent-plane-foundation.md)。
> **范围：** 冻结 Reviewer 第一个 `directory_snapshot` target、directory manifest、target-bound member read、结构化 list/search、coverage 与 clean-cut activation。
> **保证不变：** `worker-local / static-review-only`；目录、manifest、search hit、Captured Artifact 和模型 prose 都不认证内容真实性，也不授予权限。
> **不是：** 任意 glob/regex/shell、通用 grep、git、远程 PR、测试执行、workspace mutation、采样式“完整目录评审”、动态 producer 或 artifact browser。

## 0. 当前事实与 activation Gate

Reviewer v2已一次性clean-cut激活以下集合；它们共同构成current runtime，不能只更新prompt或单个DTO：

- Reviewer profile/role skill/Gate=`reviewer-v2`；
- `targetKindIds=["file","directory_snapshot","commit","git_diff"]`，本文只拥有directory kind；
- PracticeDefinition/PracticeRun/journal/claim=`v2`；
- ContextPack=`v3`，checkpoint=`review-v2`；
- tools ordered exact 为 `start_work,extend_scope,read,inspect_directory,inspect_repository,check_completion,abandon_work`；
- `start_work.targets[]` / `extend_scope.targets[]` 与 `scope.targets[]`；
- status 使用 `scopeTargetCount`，OTel 使用 `tiangong.practice.target_count`；
- CapturedArtifactStore closed registry新增本文两个 producer。

不保留 `files[]`、path-based旧 `read`、ContextPack v2、claim v1、journal v1的双读、迁移或 compatibility shim。v2 runtime 遇到旧 durable PracticeRun 返回 `UNSUPPORTED_STATE_SCHEMA`，不猜测转换；pi transcript不参与转换。activation已同时更新当前行为文档与smoke oracle，避免profile声称v2而runtime仍部分使用v1。

---

## 1. 事实与 authority

| 事实 | 含义 | 权威载体 |
|---|---|---|
| Directory request | 模型提交的 root 与 literal selection | tool DTO；不是成员事实 |
| Normalized descriptor | runtime规范化后的 root/include/exclude | PracticeRun descriptor |
| Enumeration observation | 某一 capture pass 观察到的 directory/member identity | operation-local memory |
| Canonical manifest | stable double capture后得到的 ordered member facts | CapturedArtifactStore bytes |
| Directory snapshot | descriptor、selection/manifest identity与artifact binding | PracticeRun journal |
| List/search result | 对validated manifest或其live matching member bytes的一次有界探查 | Captured Artifact + successful Evidence |
| Member consumption | 实际交给模型的一个manifest member chunk | Captured Artifact + successful Evidence |
| Coverage | 对每个manifest member的validated consume interval投影 | review-owned deterministic projector |
| Claim | 模型对target/member的评审判断 | protected claim；不是Machine Evidence |

关键规则：

- request不能自证成员；manifest只来自Gate allow后的runtime capture；
- manifest artifact durable但journal未引用时只是orphan；
- list/search成功不表示模型完整读过任何member；
- search hit只证明固定算法在验证过的snapshot bytes中观察到匹配，不证明语义正确、完整或安全；
- raw artifactRef、artifact/content digest、manifest bytes不进入ContextPack、claim、status或model tool参数；
- targetId只能回显当前actor-owned active run中的target，不能单独授予authority。

---

## 2. Fixed profile、kind 与 tools

profile exact目标：

```json
{
  "schemaVersion": 2,
  "roleId": "reviewer",
  "title": "Reviewer",
  "practiceIds": ["review"],
  "targetKindIds": ["file", "directory_snapshot", "commit", "git_diff"],
  "toolIds": [
    "start_work",
    "extend_scope",
    "read",
    "inspect_directory",
    "check_completion",
    "abandon_work"
  ],
  "gatePolicyId": "reviewer-v2",
  "roleSkillId": "reviewer-v2"
}
```

closed target-kind registry current materialize `file`、`directory_snapshot`、`commit` 与 `git_diff`；本合同只定义前两者中的directory行为，local-git dispatch由独立合同拥有。ENV、Worker name、workspace文件、prompt和tool参数不能增加kind/producer/action。

`read` 是target-bound consume，不接受自由workspace path：

```json
{
  "targetId": "target-...",
  "memberPath": "context/reviewer-context.mjs",
  "offset": 1,
  "limit": 2000
}
```

- directory target必须有`memberPath`；file target禁止`memberPath`；DTO missing/extra key、malformed targetId或offset/limit type使用`INVALID_TARGET`，well-formed shape在target resolve后与kind不匹配使用`TARGET_KIND_MISMATCH`；
- raw memberPath使用与manifest相同的relative path normalizer：移除普通`.` segments，拒绝canonical `.`（不是file）、absolute/`..`（`TARGET_OUTSIDE_WORKSPACE`）以及NUL/trailing/oversize（`TARGET_SELECTOR_INVALID`）；`context/./a.mjs`规范为`context/a.mjs`；
- resource selector hash、manifest exact lookup、operation-local binding、model-visible details与coverage都只使用normalized memberPath；raw spelling只留在tool call/transcript，不进入operation/Evidence；normalized memberPath不在manifest时`TARGET_MEMBER_NOT_FOUND`，不能只做prefix、basename或digest lookup；
- range、50KiB chunk、LF/CR/BOM、segment和Evidence语义完全使用typed-target合同§9；
- backend必须重新捕获member并匹配manifest digest/bytes/lines后才可交付chunk；post-admission缺失/permission/unreadable使用`TARGET_UNAVAILABLE`；symlink/type/hardlink、当前operation内部identity变化或A/B不稳定、final re-resolution race以及bytes facts mismatch统一`TARGET_CHANGED`，不向coverage透传`TARGET_CHANGED_DURING_CAPTURE`；
- successful consume artifact使用现有 `review-target-consume/1`、purpose=`review_target_chunk`。

`inspect_directory`仅对directory target可达，定义见§7。file target调用它返回`TARGET_KIND_MISMATCH`。

### 2.1 Read operation、result 与 Evidence

pre-Gate validator保留raw `memberPath`于bounded operation-local memory，但wrapped operation只保存selector digest。operation exact为：

```json
{
  "policyVersion": "review-target-consume-v2",
  "category": "read-only",
  "toolName": "read",
  "effects": {
    "localRead": true,
    "workspaceMutation": false,
    "networkEgress": false,
    "modelInference": false,
    "costBearing": false
  },
  "workspaceScope": "<sha256>",
  "roleId": "reviewer",
  "profileDigest": "<sha256>",
  "practiceId": "review",
  "practiceVersion": 2,
  "state": {
    "runId": "run-...",
    "expectedRunRevision": 3,
    "targetId": "target-..."
  },
  "input": {
    "resourceSelectorDigest": "<sha256>",
    "offset": 1,
    "limit": 2000,
    "consumePolicyVersion": "review-target-consume-v1"
  }
}
```

resource selector exact：

```text
sha256(canonicalJson({
  schemaId: "tiangong.review-resource-selector.v1",
  targetId,
  memberPath       // normalized directory string; file null
}))
```

pre-Gate只从actor-owned active-run Machine State读取`runId/revision`并回显caller targetId；不解析target kind/snapshot/artifact，也不访问Store/source。run revision + immutable targetId足以绑定proposal，snapshot identity只在Gate后validated result/Evidence中出现。wrapper先解析exact same invocation的durable successful replay；已成功的原invocation即使run后来extend也返回原Evidence+Store result。非replay execution在Gate allow后reload run并解析target kind/snapshot，要求revision/target exact；revision变化即`STALE_RUN_REVISION`，即使target仍存在也不继续，caller必须以current revision发起new invocation。backend随后用journal/manifest将selector digest重新绑定raw memberPath并按resolved kind验证null/string shape，执行stable capture/range/chunk，写一个Store artifact（purpose=`review_target_chunk`, ordinal=0），并把以下exact completion metadata交给wrapper：

```json
{
  "targetId": "target-...",
  "snapshotIdentity": "<sha256>",
  "resourceSelectorDigest": "<sha256>",
  "fullContentDigest": "<sha256>",
  "fullContentBytes": 1234,
  "fullContentLines": 42,
  "encoding": "utf-8",
  "requestedOffset": 1,
  "requestedLimit": 20,
  "returnedLineStart": 1,
  "returnedLineEnd": 20,
  "truncated": true,
  "artifact": {
    "artifactKey": "<sha256>",
    "artifactRefDigest": "<sha256>",
    "ordinal": 0,
    "contentDigest": "<sha256>",
    "contentBytes": 456,
    "contentLines": 20,
    "mediaType": "text/plain;charset=utf-8",
    "encoding": "utf-8",
    "truncated": true,
    "purpose": "review_target_chunk",
    "producerId": "review-target-consume",
    "producerVersion": 1,
    "transformVersion": 1
  }
}
```

outer completion lifecycle仍由existing wrapper拥有；上述object是其`metadata.reviewTargetConsume` exact value。artifact `truncated`必须等于top-level truncated，即returnedLineEnd是否小于fullContentLines。full digest是manifest member digest，chunk digest是actual model-visible canonical bytes digest；二者不能互换。Evidence不保存memberPath/raw bytes/artifactRef。

model-visible tool result exact为一个text content item和safe details：

```json
{
  "content": [{"type": "text", "text": "<exact decoded chunk>"}],
  "details": {
    "targetId": "target-...",
    "memberPath": "context/a.mjs",
    "returnedLineStart": 1,
    "returnedLineEnd": 20,
    "fullContentBytes": 1234,
    "fullContentLines": 42,
    "truncated": true
  }
}
```

file target details使用`memberPath=null`。model result不含snapshot/artifact/content digest或ref。wrapper必须先append successful completion Evidence，再交付同一chunk；append失败则artifact orphan且无successful result。same invocation已有successful completion时从Evidence+Store exact replay原chunk，不重新读取live source；Store成功但Evidence失败后的retry只有在live source仍匹配snapshot时才能same-key replay并重新append，source已变则fail closed。

---

## 3. Directory request 与 normalization

request exact沿用typed-target合同：

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

### 3.1 Path

- `path`是workspace-relative UTF-8 directory path；canonical workspace root为`.`；
- 使用`/`分隔，普通`.` segment被移除；拒绝absolute、empty、NUL、`..`、trailing separator和lexical/physical escape；
- `MAX_PATH_BYTES=1024`按normalized UTF-8 bytes计算；
- mandatory sensitive/runtime-state policy在Gate前对normalized segments执行；root自身命中即`TARGET_SENSITIVE_PATH_DENIED`；
- Gate allow后才做existence、component traversal、lstat/open、symlink/type/permission和source capture。

### 3.2 Literal prefixes

prefix相对directory root，不是glob、regex、pathspec或gitignore：

- `.`是root/选择全部的唯一canonical spelling；其它prefix移除普通`.` segments；
- component-boundary match：`src`匹配`src/a.js`与`src`，不匹配`src-old/a.js`；
- arrays先normalize，再按`Buffer.compare(Buffer.from(value,"utf8"))`排序；
- 每array拒绝duplicate及ancestor/descendant冗余重叠；
- 每个exclude必须位于至少一个include之下；include与exclude exact相同时selection无效；
- 每array最多128项；selector bytes exact为`Buffer.byteLength(canonicalJson({includePrefixes,excludePrefixes}),"utf8")`，最多16KiB；反斜杠/control的JSON escaping计入；完整descriptor仍另受4KiB `MAX_TARGET_DESCRIPTOR_BYTES`，取更低effective limit；
- includePrefixes非空；excludePrefixes可空；
- non-root include prefix在initial traversal中不存在或不可达分别返回`TARGET_NOT_FOUND` / `TARGET_UNAVAILABLE`；不存在的exclude prefix合法，因为它不声明成员存在；
- 明确excluded subtree不属于target，enumerator不得进入或检查其内容；mandatory deny不能被include恢复，但位于明确excluded subtree内的entry不是selected member；
- include外的sibling不属于target，也不通过后续list/search变成成员。

`selectionDigest` exact沿用：

```text
sha256(canonicalJson({
  schemaId: "tiangong.directory-selection.v1",
  rootPath,
  includePrefixes,
  excludePrefixes
}))
```

同batch duplicate使用normalized full descriptor；与existing scope只有在capture后snapshot identity也相同才是`SCOPE_TARGET_ALREADY_PRESENT`。

---

## 4. Traversal 与 selected member policy

### 4.1 OS boundary

实现必须使用Linux上可证明`beneath + no symlink`的reviewed public primitive，或等价的directory-handle/openat traversal；若实现只能依赖`realpath`后普通path reopen，kind不得materialize。

每次enumeration使用raw directory-entry bytes：

1. 从trusted、startup-fixed workspace root directory identity开始；
2. 逐component no-follow打开target root；
3. `readdir`取得raw name bytes，fatal UTF-8 decode并要求round-trip bytes相同；
4. traversal exact为pre-order DFS：每个directory内先按raw UTF-8 bytes排序，遇到selected directory立即递归完成后再处理下一个sibling；该顺序只拥有enumeration/traversal error precedence；
5. 只进入selection需要且未excluded的directory；
6. path normalization与component-boundary selection只使用validated decoded name；
7. 对selected entry执行no-follow open/fstat，并复核descriptor仍指向同一inode且位于workspace beneath。

任一traversed directory直接枚举到的invalid-UTF-8 raw name都以`TARGET_TYPE_UNSUPPORTED`使target fail closed，即使该name最终无法与某个narrow include比较；不得replacement-decode后跳过。selected symlink使用`TARGET_SYMLINK_DENIED`；socket/device/FIFO、非普通file/directory或无法安全遍历的mount/layout使用`TARGET_TYPE_UNSUPPORTED`。directory本身不应用file `nlink=1`；selected regular file必须`nlink=1`。

### 4.2 Selected text member

每个selected regular file执行typed-target§6.1 exact stable capture：same handle上的`fstat A → bounded Buffer A → fstat B → bounded Buffer B → fstat C → descriptor re-resolution`，要求identity/size/time facts稳定、A/B byte equal，再执行binary predicate、fatal UTF-8 decode与line facts。dev/ino/time只用于一次capture及A/B pass稳定性，不写manifest/journal/snapshot identity；post-admission source若被原子替换为不同inode但重新stable capture得到完全相同digest/bytes/lines且仍为安全`nlink=1` ordinary file，则合法匹配原snapshot。实现不得依赖未持久化inode cache，使restart前后结论不同。

固定limits：

```text
MAX_DIRECTORY_MEMBERS=960
MAX_REQUIRED_CONSUME_SEGMENTS_PER_DIRECTORY=960
MAX_MEMBER_BYTES=2MiB
MAX_TARGET_CONTENT_BYTES=16MiB
MAX_DIRECTORY_MANIFEST_BYTES=4MiB
MAX_PATH_BYTES=1KiB
```

- 在读取完整member前先检查initial size；bounded allocation/read最多`MAX_MEMBER_BYTES+1`；
- 每个traversed directory/selected member同时要求target-relative normalized path UTF-8 bytes≤1KiB，且与root拼接后的完整workspace-relative normalized path UTF-8 bytes≤1KiB（root `.`不增加`./`）；任一越界即`TARGET_LIMIT_EXCEEDED`；manifest保存前者；
- member count、每member、累计content和manifest candidate任一越界即`TARGET_LIMIT_EXCEEDED`；
- total bytes按actual stable member Buffer计；不按stat声明或decoded chars计；
- hidden file没有通用ignore；只要selected且未命中mandatory deny，就与其它member相同处理；
- selected binary、invalid UTF-8、hardlink、sensitive或unsupported entry使整个target失败；
- 不允许“已捕获其余成员所以部分提交”。

admission必须对每个decoded member模拟唯一canonical completion plan：从offset=1开始，每次`limit=min(2000,remaining lines)`，应用typed-target§9 exact 50KiB maximal-complete-line-prefix算法，下一offset=`returnedLineEnd+1`，直至覆盖全部lines；empty member计划exact为一次zero-byte `[1,1]` consume。若任一当前位置第一逻辑行无法在50KiB内返回、单member计划超过128 segments，或全directory计划之和超过960，admission在写manifest前返回`TARGET_LIMIT_EXCEEDED`。每member count写入`requiredConsumeSegments`，facts保存sum。

因此单个admitted directory target存在一条bounded non-overlap完整路径。start/extend在所有candidate capture后、任何journal append前，还必须对`existing final scope + candidates`执行global feasibility：所有materialized file/directory/commit/git_diff resources的`requiredConsumeSegments`之和≤960，全部directory manifest actual bytes之和≤8MiB，并满足local-git合同的run aggregate；违反任一返回final aggregate `CAPTURE_LIMIT_EXCEEDED`，整个array不commit。file target使用同一canonical plan，首行不可消费或单resource>128时在其capture阶段`TARGET_LIMIT_EXCEEDED`。

final scope canonical plan因此最多960 successful consume artifacts/1920 selected Evidence refs。每directory最多64、每run最多128个inspection；run最多64个manifest、960 consume与128 inspection artifacts，共≤1152，低于Store run count4096。optimal consume bytes≤16MiB、all manifest≤8MiB、all inspection≤8MiB，合计≤32MiB，低于Store run content128MiB；单target的manifest+consume+64 inspection也低于Store target count/content quota。模型选择冗余/重叠小range或后续orphan仍可能消耗额外quota并触发既有hard limit，但这不使新commit的final scope在canonical plan和reserved inspection budget下先天不可完成。

### 4.3 Error specificity

Pass A initial traversal按typed-target§14 precedence：OS missing/unreadable → symlink → type/hardlink → initial limit → stable capture → binary/UTF-8。Pass A handle成功打开后的descriptor re-resolution race使用`TARGET_CHANGED_DURING_CAPTURE`。selected mandatory-sensitive entry使用`TARGET_SENSITIVE_PATH_DENIED`；不得因它同时是binary或oversize改变优先级。Pass A完整结束后，Pass B中此前traversed/selected path的missing、unreadable、symlink、filesystem type/identity变化或内部A/B不稳定统一`TARGET_CHANGED_DURING_CAPTURE`；但该path若stable captured size越界使用`TARGET_LIMIT_EXCEEDED`，stable bytes变为binary/invalid UTF-8使用`TARGET_TYPE_UNSUPPORTED`，其余stable UTF-8 content facts与A不同才使用`TARGET_CHANGED_DURING_CAPTURE`。Pass B首次出现的raw invalid-UTF-8 name使用`TARGET_TYPE_UNSUPPORTED`；新出现selected member依次应用sensitive → symlink → type/hardlink → limit/binary/text specific code；若new member本身valid则member-set mismatch使用`TARGET_CHANGED_DURING_CAPTURE`。所有情况都不提交。

错误只返回stable code和bounded说明，不返回unrestricted path、entry name、content、query、manifest、digest或raw OS error。

---

## 5. Stable directory capture

一次admission不重试，按以下exact two-pass算法：

### 5.1 Pass A

1. 先按§4.1 pre-order raw-byte DFS完整执行discovery，不读member content；operation-local记录traversed directory identity和selected ordinary member path/inode metadata。invalid name、unreadable directory、symlink/type/hardlink等discovery error按该DFS首次出现返回；
2. discovery成功后，把全部selected member按完整target-relative path的UTF-8 bytes全局排序；该array是manifest order；
3. 严格按全局member order执行§4.2 stable content capture，记录`dev/ino`与content facts；因此content/size/binary错误按global manifest order选择，不按DFS leaf order；
4. 达到任何limit立即失败，不继续寻找更晚错误。

例如同时存在`a/z`与`a.txt`时，DFS可先discover `a/z`，但content capture比较完整path bytes并先处理`a.txt`；两个member各自binary/oversize时由`a.txt`决定首个content error。

### 5.2 Pass B

- 从同一workspace root identity重新打开descriptor，按同一pre-order DFS完成discovery，再按同一全局member order capture；root/include或Pass A已观察path在B中missing/unreadable不重新映射initial `TARGET_NOT_FOUND/TARGET_UNAVAILABLE`，统一`TARGET_CHANGED_DURING_CAPTURE`；B中新raw invalid name或new selected sensitive/symlink/type/limit使用§4.3 specific precedence；
- 要求traversed directory path set、selected member path set及global byte order与A exact相同；
- 要求每个traversed directory的`dev/ino/type/mtimeNs/ctimeNs`与A相同；
- 严格按global member order再次执行§4.2 capture并应用§4.3 Pass B specific precedence；若无specific failure，要求每个member在A/B pass的`dev/ino`和digest/bytes/lines/encoding相同，否则`TARGET_CHANGED_DURING_CAPTURE`。

任何member增删、rename、directory replacement、identity/time变化或content变化统一`TARGET_CHANGED_DURING_CAPTURE`，除非更早的specific sensitive/type/limit错误已触发。空selected set返回`TARGET_EMPTY`。不无限重试；新invocation重新开始全流程。

该算法只证明两个完整pass和每member内部double read一致；不声称filesystem transaction/atomic snapshot，也不声称检测到两次观察之间发生后完全恢复的所有写入。

---

## 6. Canonical manifest 与 Store binding

### 6.1 Exact schema

manifest bytes exact为`Buffer.from(canonicalJson(manifest),"utf8")`，无BOM/trailing LF/whitespace：

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
      "encoding": "utf-8",
      "requiredConsumeSegments": 1
    }
  ]
}
```

- top-level/member exact keys；members非空，按member relative path UTF-8 bytes严格升序、唯一；
- member path相对target root，不以`./`开头；root下file示例为`README.md`；
- manifest不包含inode/time/absolute workspace path/source prose；
- manifest Store content identity的`contentLines=1`，即使JSON string内转义了文件名控制字符；
- `manifestContentDigest`对exact bytes计算；
- facts exact为`memberCount/totalContentBytes/requiredConsumeSegments/selectionDigest/manifestContentDigest`；aggregate required count等于members字段之和；
- snapshot identity、scope digest和artifact content identity使用typed-target§5公式，不另创projection。

### 6.2 Admission producer

CapturedArtifactStore新增closed definition：

```json
{
  "producerId": "review-directory-capture",
  "producerVersion": 1,
  "allowedPurposes": ["directory_manifest"],
  "allowedMediaTypes": ["application/vnd.tiangong.directory-manifest+json;version=1"],
  "allowedEncodings": ["utf-8"],
  "maxContentBytes": 4194304,
  "textPolicyId": "canonical-json-v1",
  "transformVersions": [1]
}
```

`canonical-json-v1`要求fatal UTF-8/JSON parse、exact schema由producer validator提供、actual wire逐byte等于项目`canonicalJson(parsed)`；因此duplicate key、alternate whitespace、BOM、trailing LF/data和noncanonical number拒绝。Store仍独立复核bytes/encoding/size，directory producer validator复核manifest语义。

artifact：purpose=`directory_manifest`、ordinal=0、encoding=`utf-8`、`truncated=false`，binding使用candidate actor/run/target/invocation/operation identity。Store receipt成功且read-back后才能构建snapshot。journal `snapshot.artifacts[0]` exact使用typed-target§5.1 binding：`artifactRef/artifactRefDigest/artifactKey/storeBinding/ordinal/encoding/contentIdentity`；storeBinding持久化原invocationIdentity/sourceOperationDigest并与journal session/actor/run/target exact交叉验证，restart不从Evidence或Store envelope猜测。snapshot identity只投影`contentIdentity`。Store read时exact构造`expectedContentIdentity={...contentIdentity,ordinal,encoding}`并传journal-validated storeBinding；不能把snapshot窄identity直接传给Store。Context/model不接收raw manifest artifact ref。

如果Store成功而后续target/array/Context/CAS/journal失败，对象是计quota的orphan，不是scope authority。same invocation在journal已提交后replay原target/receipt，不recapture source。

---

## 7. `inspect_directory` exact contract

### 7.1 Tool DTO

list：

```json
{
  "targetId": "target-...",
  "action": "list",
  "prefix": ".",
  "offset": 0,
  "limit": 200
}
```

search：

```json
{
  "targetId": "target-...",
  "action": "search",
  "prefix": ".",
  "query": "sourceOperationDigest",
  "maxResults": 100
}
```

exact rules：

- union按`action`关闭，unknown/missing/extra key使用`DIRECTORY_INSPECTION_INVALID`；
- prefix使用member-relative literal path grammar，`.`为all members；不能是glob/regex/absolute/`..`；最多1KiB；
- prefix按component boundary过滤manifest member；无matching member返回`DIRECTORY_PREFIX_EMPTY`，不回退到workspace traversal；
- list offset是zero-based safe integer，limit为`1..200`；offset大于或等于matching member count返回`TARGET_RANGE_INVALID`；
- search query是nonempty UTF-8 string，最多256 bytes；拒绝NUL、LF、CR、C0 control和DEL；
- search exact使用decoded JavaScript string上的ECMAScript `String.prototype.includes`（UTF-16 code-unit sequence）、case-sensitive且不做Unicode normalization；不是regex；
- maxResults为`1..200`；one result per matching logical line，即同一行多次出现仍只产生一个result。

DTO error mapping exact：missing/extra key、unknown action、wrong JSON type、malformed targetId或wrong nullable branch → `DIRECTORY_INSPECTION_INVALID`；prefix absolute或含`..` → `TARGET_OUTSIDE_WORKSPACE`；其它prefix grammar/NUL/trailing separator/oversize → `TARGET_SELECTOR_INVALID`；list offset/limit或search maxResults的zero/fraction/unsafe/out-of-range → `TARGET_RANGE_INVALID`；query empty/control/invalid/oversize → `DIRECTORY_QUERY_INVALID`。well-formed targetId不属于current actor-owned active run → `TARGET_NOT_FOUND`；属于run但kind不是directory → `TARGET_KIND_MISMATCH`。

### 7.2 Gate operation

pre-Gate只做actor/profile/active-state、exact DTO、query/prefix lexical validation、query digest和fixed upper bound；不读manifest/artifact/source。

operation exact：

```json
{
  "policyVersion": "review-directory-inspect-v1",
  "category": "read-only",
  "toolName": "inspect_directory",
  "effects": {
    "localRead": true,
    "workspaceMutation": false,
    "networkEgress": false,
    "modelInference": false,
    "costBearing": false
  },
  "workspaceScope": "<sha256>",
  "roleId": "reviewer",
  "profileDigest": "<sha256>",
  "practiceId": "review",
  "practiceVersion": 2,
  "state": {
    "runId": "run-...",
    "expectedRunRevision": 3,
    "targetId": "target-..."
  },
  "input": {
    "action": "search",
    "selectorDigest": "<sha256>",
    "prefixDigest": "<sha256>",
    "prefixBytes": 1,
    "offset": null,
    "limit": null,
    "queryDigest": "<sha256>",
    "queryBytes": 21,
    "maxResults": 100,
    "inspectionPolicyVersion": "review-directory-inspection-v1"
  }
}
```

list使用`queryDigest/queryBytes/maxResults=null`；search使用`offset/limit=null`。prefix先按§7.1 grammar得到`normalizedPrefix`；prefixDigest exact为`sha256(canonicalJson({schemaId:"tiangong.directory-prefix.v1",prefix:normalizedPrefix}))`；queryDigest exact为`sha256(canonicalJson({schemaId:"tiangong.directory-query.v1",query}))`；selectorDigest使用§7.5 formula并使用normalizedPrefix。原始未规范化prefix和raw query只存在model tool call/transcript与operation-local bounded memory；normalizedPrefix会作为canonical list/search artifact中的`prefix`交给model并由storage administrator可见，但不进入operation、proposal/completion Evidence、Store envelope、OTel、error或machine status。wrapper proposal Evidence可保存上述完整safe operation，因为其中只有digest/bytes/range/effects，不含prefix/query。Gate只见这些safe fields。

Gate allow后backend必须：

1. 在wrapper durable successful replay未命中后，取得§7.5 session inspection lifecycle lock；
2. reload current actor-owned active run，exact匹配run revision/targetId；revision变化返回`STALE_RUN_REVISION`且不读取manifest/Store/source，append-only extension不让stale prepared operation继续；
3. 确认target kind=`directory_snapshot`并在同一lock内复核successful inspection count；
4. 从journal binding读取并验证manifest Store object、snapshot identity和facts；
5. 执行§7.3 list或§7.4 search；
6. 把exact model-visible JSON Buffer写入Store；
7. wrapper在lock内append successful completion Evidence；
8. Evidence成功后释放lock，才把同一Buffer交给model。

completion Evidence失败时不得返回successful tool result；artifact为orphan。inspect不写PracticeRun、不改变revision/checkpoint/coverage。

### 7.3 List

list只查询validated immutable manifest，不读取live workspace。matching members保持manifest order，先应用prefix，再应用offset/limit。

model-visible canonical JSON exact：

```json
{
  "schemaVersion": 1,
  "kind": "directory-list",
  "targetId": "target-...",
  "prefix": ".",
  "offset": 0,
  "returnedCount": 1,
  "totalMatchingMembers": 12,
  "truncated": true,
  "members": [
    {"path": "context/a.mjs", "contentBytes": 120, "contentLines": 5}
  ]
}
```

members不含content/artifact digest。`returnedCount === members.length`且`returnedCount <= limit`；`truncated = offset+returnedCount < totalMatchingMembers`。先按requested limit构建完整candidate；若canonical bytes超过64KiB，整体`TARGET_LIMIT_EXCEEDED`且不自动减少members、不写Store。targetId/path可见但不构成额外authority；后续read仍从current run exact resolve。

### 7.4 Search

search按manifest member order重新捕获prefix下每个member，使用相同底层stable member算法并exact匹配manifest digest/bytes/lines，但应用post-admission错误映射：missing/permission/unreadable=`TARGET_UNAVAILABLE`；symlink/type/hardlink、当前capture内部identity变化/A-B不稳定/final re-resolution race或content facts mismatch=`TARGET_CHANGED`。admission inode不参与比较；safe replacement产生完全相同content facts时允许。任一失败使整个operation无partial hits/artifact；不得在旧manifest bytes之外搜索新文件。

对每个validated decoded member按LF规则逐逻辑行执行literal match。收集全部match count，最多返回前`maxResults`个canonical results；因此`truncated`准确，不因达到limit而停止验证后续member。

model-visible canonical JSON exact：

```json
{
  "schemaVersion": 1,
  "kind": "directory-search",
  "targetId": "target-...",
  "prefix": ".",
  "matchMode": "literal-case-sensitive-v1",
  "returnedCount": 1,
  "totalMatchCount": 5,
  "truncated": true,
  "matches": [
    {"memberPath": "context/a.mjs", "line": 18}
  ]
}
```

`returnedCount === matches.length`且`returnedCount === min(totalMatchCount,maxResults)`；`truncated = totalMatchCount > returnedCount`。先按maxResults构建完整candidate；若canonical bytes超过64KiB，整体`TARGET_LIMIT_EXCEEDED`且不自动减少matches、不写Store。不回显query、line content、preview或digest。用户/模型可用target-bound `read`读取对应line；search result本身不产生该line的coverage。

### 7.5 Inspection producer

```json
{
  "producerId": "review-directory-inspect",
  "producerVersion": 1,
  "allowedPurposes": ["directory_list", "directory_search"],
  "allowedMediaTypes": [
    "application/vnd.tiangong.directory-list+json;version=1",
    "application/vnd.tiangong.directory-search+json;version=1"
  ],
  "allowedEncodings": ["utf-8"],
  "maxContentBytes": 65536,
  "textPolicyId": "canonical-json-v1",
  "transformVersions": [1]
}
```

每次inspection产生ordinal=0的一个artifact，binding使用current actor/run/target/invocation/operation。purpose/media exact按action配对：list=`directory_list`/`application/vnd.tiangong.directory-list+json;version=1`，search=`directory_search`/`application/vnd.tiangong.directory-search+json;version=1`。Store put的`truncated`必须exact等于canonical list/search result中的`truncated`（表示相对全部matching members/results仍有省略），并等于completion Evidence safe artifact metadata和top-level inspection metadata的同名字段；不能以“JSON document自身完整”为由写false。该boolean参与Store content identity/replay。

`selectorDigest` exact为：

```text
sha256(canonicalJson({
  schemaId: "tiangong.directory-inspection-selector.v1",
  action,
  prefix,          // normalizedPrefix
  offset,          // list integer; search null
  limit,           // list integer; search null
  queryDigest,     // list null; search §7.2 digest
  maxResults       // list null; search integer
}))
```

completion lifecycle的`metadata.reviewDirectoryInspection` exact为：

```json
{
  "targetId": "target-...",
  "snapshotIdentity": "<sha256>",
  "action": "list",
  "selectorDigest": "<sha256>",
  "resultCount": 1,
  "truncated": true,
  "artifact": {
    "artifactKey": "<sha256>",
    "artifactRefDigest": "<sha256>",
    "ordinal": 0,
    "contentDigest": "<sha256>",
    "contentBytes": 456,
    "contentLines": 1,
    "mediaType": "application/vnd.tiangong.directory-list+json;version=1",
    "encoding": "utf-8",
    "truncated": true,
    "purpose": "directory_list",
    "producerId": "review-directory-inspect",
    "producerVersion": 1,
    "transformVersion": 1
  }
}
```

search替换对应purpose/media；其余keys相同。`resultCount`始终等于model-visible `returnedCount`，不是total count；top-level/artifact truncated exact相等。禁止raw ref、query、prefix、path array、matches、manifest、total count或content进入Evidence/OTel。

model tool result exact为`{content:[{type:"text",text:<same canonical JSON UTF-8 decoded string>}],details:{targetId,action,resultCount,truncated}}`；details不含prefix/query/digest/ref。

V1固定`MAX_DIRECTORY_INSPECTIONS_PER_TARGET=64`和combined `MAX_SUCCESSFUL_INSPECTIONS_PER_RUN=128`。v2 state resolver在`practice-runs/<sessionHash>/review-inspection-lock-target`提供mode0600、empty、no-symlink kernel `flock` target；它不是business state，并与`inspect_repository`共享。successful replay在加锁前返回。new execution在Gate allow后取得该session-wide exclusive lock，持锁执行：reload run/revision/target → 在validated Evidence boundary同时计数该target与run的successful directory/repository inspection completions → target已64或combined run已128时，directory返回`DIRECTORY_INSPECTION_LIMIT_EXCEEDED`且不调用Store → backend/Store put → wrapper successful completion Evidence append；append完成或任一failure后才释放。crash/descriptor close由kernel释放；Store已成功而Evidence失败时artifact为orphan且不计64。

所有实现使用lock order `review-inspection lock → CapturedArtifactStore session lock → Evidence append lock`；其它路径不得持Store/Evidence lock后再请求inspection lock。lock wait固定35秒，directory失败映射`DIRECTORY_INSPECTION_LOCK_FAILED`。这样target 63或run 127边界的并发inspection只能一个占用最后相应slot，另一个在reload/recount后稳定失败；不能只依赖普通Evidence append serialization做check-then-append。

---

## 8. Coverage、Context、claim 与 checkpoint

### 8.1 Coverage

review practice单一coverage projector：

- 先通过journal binding验证manifest Store bytes/facts/snapshot identity；
- 每个manifest member是独立resource，顺序为manifest order；
- 只选择successful target-bound `read` lifecycle，要求actor/run/target/snapshot/member digest/range/chunk artifact exact；
- list/search的successful或failed Evidence都不进入coverage、member terminal-failure selection或selected completion refs；inspection source failure只使该tool call失败，不把target投影为blocked；
- 每member全部`1..contentLines`被覆盖才complete；empty member仍要求一次zero-byte `[1,1]` consume；
- 任一member unread/partial使target unread/partial；只有绑定该exact member selector的target-bound `read` terminal failure可使未完成member因changed/unavailable而blocked；已完成member后续read failure不撤销历史complete；
- artifact tamper/missing/ambiguous lifecycle在Context/checkpoint前fail closed，不降级为“未读”；
- segment/evidence limits、deterministic interval selection和global 2048 refs沿用typed-target§10。

### 8.2 ContextPack v3

ContextPack严格复用typed-target§11 exact target summary keys `targetId/kind/descriptor/snapshotSummary`，不新增`progress` sibling。directory summary exact为：

```json
{
  "targetId": "target-...",
  "kind": "directory_snapshot",
  "descriptor": {
    "path": "worker/agent",
    "selection": {
      "includePrefixes": ["."],
      "excludePrefixes": ["generated"]
    }
  },
  "snapshotSummary": {
    "identity": "<sha256>",
    "memberCount": 12,
    "totalContentBytes": 45678
  }
}
```

`descriptor` exact复制bounded `target.descriptor.value`；不以counts-only变体替代selection。snapshot summary不含progress/member names/manifest digest/artifact ref。nextAction使用target IDs和stable reason codes表达target级incomplete/blocked；member discovery通过explicit `inspect_directory`，不是把manifest塞进system prompt。final materialized Context超过64KiB时admission整体`CONTEXT_PACK_LIMIT_EXCEEDED`。

### 8.3 Claim v2

claim scope为final ordered target IDs。directory observation location exact：

```json
{
  "targetId": "target-...",
  "memberPath": "context/a.mjs",
  "lineStart": 18,
  "lineEnd": 22
}
```

- memberPath必须exact在manifest；line bounds必须在member facts内；
- model不能提交snapshot/artifact/content digest、search ref或额外path；
- list/search中的match不能让未consume range成为合法observation；checkpoint仍要求target fully consumed后才可done；
- `STATIC_REVIEW_ONLY` limitation与no-mutation规则不变。

### 8.4 Checkpoint

`targets-fully-consumed`对directory要求validated manifest的每个member完整覆盖。不存在“浏览过列表”“搜索无命中”“模型称已抽样”或“manifest很大所以跳过”替代条件。若产品未来需要sampling target，必须新增不同kind和checkpoint名称。

---

## 9. Replay、restart、source change 与 crash

| Boundary | Result |
|---|---|
| Gate前validation失败 | 无filesystem read、artifact、state |
| capture中失败 | 无target state；Store可能仅有可清理tmp |
| manifest artifact durable、journal前失败 | orphan；计Store quota，不属于scope |
| multi-target中later target失败 | 整个array不commit；此前artifact均orphan |
| journal commit、wrapper Evidence失败 | target state authoritative；same invocation replay原target，不recapture |
| restart/reset | 从journal raw ref/key/refDigest + expected binding读取同manifest；transcript/session删除不影响 |
| manifest Store missing/tampered | model前`TARGET_ARTIFACT_INVALID`；不从live directory重建 |
| source新增manifest外file | existing snapshot不变；read/search不把它加入target |
| incomplete member changed/missing + target-bound read | read失败；该member/target coverage blocked |
| member changed/missing + search | search整体失败、无partial artifact；coverage不变且无需在Evidence暴露失败member |
| member已完整consume后source变化 | historical matching Evidence仍complete；后续failure不撤销 |
| list/search Store return、completion Evidence前crash | inspection artifact orphan；无inspection success |
| successful inspection replay | wrapper idempotency返回原result，不重复search或Store put |

inspection是read-only operation，不要求跨turn pending approval；process crash前没有successful completion Evidence时，caller可新invocation重新执行。same invocation已有successful Evidence/Store binding时必须exact replay，不产生第二个artifact。

---

## 10. Limits 与 stable errors

除typed-target§14 limits外固定：

```text
MAX_DIRECTORY_MANIFEST_BYTES=4MiB
MAX_DIRECTORY_INSPECTION_BYTES=64KiB
MAX_RUN_DIRECTORY_MANIFEST_BYTES=8MiB
MAX_DIRECTORY_LIST_LIMIT=200
MAX_DIRECTORY_SEARCH_RESULTS=200
MAX_DIRECTORY_QUERY_BYTES=256
MAX_DIRECTORY_INSPECTIONS_PER_TARGET=64
MAX_DIRECTORY_INSPECTIONS_PER_RUN=128
MAX_REQUIRED_CONSUME_SEGMENTS_PER_DIRECTORY=960
MAX_REQUIRED_CONSUME_SEGMENTS_PER_RUN=960
MAX_SELECTOR_BYTES_PER_TARGET=16KiB
```

stable additions：

```text
DIRECTORY_INSPECTION_INVALID
DIRECTORY_PREFIX_EMPTY
DIRECTORY_QUERY_INVALID
DIRECTORY_INSPECTION_LIMIT_EXCEEDED
DIRECTORY_INSPECTION_LOCK_FAILED
TARGET_KIND_MISMATCH
TARGET_MEMBER_NOT_FOUND
```

precedence：

### Admission

使用typed-target§14：actor/profile/state → exact DTO/materialized kind → lexical path/selector/sensitive → same-batch duplicate → Gate → initial traversal per canonical path → type/hardlink → size/count → stable two-pass → binary/UTF-8 → existing snapshot duplicate → aggregate/Store/Context → CAS journal。

### Read

actor/profile/active run → exact successful invocation replay → exact read DTO/range grammar → Gate → post-Gate run revision reload（stale=`STALE_RUN_REVISION`）→ targetId current-run authority/kind → manifest Store validation → exact member existence → live stable capture/digest → range/chunk limit → Store put → completion Evidence。manifest外member使用`TARGET_MEMBER_NOT_FOUND`且不打开workspace path。

### Inspect

actor/profile/active run → exact successful invocation replay → exact action DTO/query/prefix/range grammar → Gate → inspection lifecycle lock → post-Gate run revision reload（stale=`STALE_RUN_REVISION`）→ targetId current-run authority/kind → successful-inspection recount/cap → manifest Store/snapshot validation → prefix match/range → search live member validation → canonical output/limit → Store put → completion Evidence → unlock。

更早失败不继续。Store error在practice boundary映射：binding/ref/key/content identity mismatch或missing/tamper → `TARGET_ARTIFACT_INVALID`；producer/global single-artifact limit → `TARGET_LIMIT_EXCEEDED`；target/run/session aggregate quota → `CAPTURE_LIMIT_EXCEEDED`；其它write/read/lock错误 → bounded `TARGET_UNAVAILABLE`，但原stable Store code可存在于非model diagnostic outcome且不带content/path。

---

## 11. Security 与 privacy

- path/selection/query/manifest/member bytes都视为不可信data，不能修改profile/Gate/tool registry/role methodology；
- search不是shell、regex或dynamic module；query不进入argv或subprocess；实现不需要spawn grep/find；
- list从validated artifact读取；search/read只从manifest授权member通过beneath/no-follow resolver读取；
- runtime state、sensitive path、symlink、hardlink与workspace escape由代码拒绝，不能靠prompt；
- Captured Artifact可能含workspace names和inspection results，storage administrator可读；无end-to-end encryption或v1 purge claim；
- raw query不进入Evidence/OTel/errors；OTel只允许action、outcome、result-count bucket、truncated和stable error；
- logs/Matrix status不输出query、member path、manifest、digest/ref或raw OS error；
- artifact/list/search存在不证明model读到、理解或正确使用；successful Evidence也只证明operation lifecycle和exact bytes。

---

## 12. Deterministic verification

### 12.1 Schemas/golden vectors

- profile/kind/tool/request/descriptor/target/snapshot/scope/Context/claim exact keys；
- prefix normalization/component-boundary/UTF-8 byte ordering与selectionDigest golden；
- manifest canonical bytes、manifest digest、artifact key/ref/envelope与snapshot/scope identity golden；
- list/search operation/query/selector digest和canonical result golden；
- unknown key/kind/action/version fail closed。

### 12.2 Filesystem/capture

- root `.`, nested roots, includes/excludes, non-existing include/exclude；
- hidden、sensitive、runtime-state、invalid UTF-8 name、symlink、hardlink、binary、special、permission；
- raw byte ordering independent oflocale/readdir order；
- member add/delete/rename/change、directory replacement、same-size/time-adjacent mutation；
- per member/member count/total bytes/path/selector/manifest bounds与adjacent；
- empty selection；no partial target commit；no unbounded retries。

### 12.3 Store/transaction/recovery

- admission/inspection/consume exact producer definitions；
- manifest durable before journal；orphan boundaries；same invocation replay；
- artifact/ref/binding/content tamper and cross-run/target fail；
- multi-target atomicity、start/extend CAS、journal/snapshot corruption；
- restart/transcript reset/session-root deletion preservemanifest；retention CLI不删除Store；
- completion Evidence append failure不把inspection/consume result交给model。

### 12.4 Inspection/coverage/privacy

- list prefix/offset/limit/truncated；search literal/case/Unicode/line/total/truncated；
- query never appears in Evidence/OTel/error/status/Store envelope；
- search changed member returns no partial hits；manifest外file/member不可达；
- list/search Evidence不计coverage；每memberread coverage与zero-byte member；
- 63/64/65 concurrent inspection lifecycle、inspection output/Store quota、canonical required-segment plan、128/129 per-resource consume segments与global refs；
- no model-visible Store/list/findByDigest surface；tool surface exact六项；
- current Reviewer v1 tests replaced by v2 assertions，不保留双schema。

---

## 13. Integration 与 smoke

设计PR只运行文档、repository和existing regression checks，不运行capability smoke。

实现PR先通过deterministic filesystem/store/journal/Evidence tests，再验证image/profile exact六工具且`commit/git_diff`仍不materialize。Basic/Recovery scenario必须使用run-owned小型fixture（至少两个text members和一个明确excluded subtree），机器oracle证明：

1. directory request形成唯一manifest-bound target；
2. list/search output有bounded successful Evidence但不增加member coverage；
3. 每个manifest member通过target-bound read完整消费；
4. checkpoint只在全部member覆盖后pass；
5. restart/reset后target ID/snapshot/manifest identity不变；
6. source-change、artifact-tamper与manifest外read fail closed；
7. raw artifact ref/query/content不出现在Evidence、OTel、Matrix machine status或diagnostics；
8. 无workspace mutation、无git/network/subprocess、official delivery与exact cleanup通过。

模型是否选择最佳search/read顺序是liveness观察，不替代Machine Evidence oracle。no-progress不得生成虚假member Evidence或done。filesystem/digest/quota/coverage正确性不使用模型smoke证明。

---

## 14. 实现职责

| 职责 | Owner |
|---|---|
| profile/kind/tool materialization | fixed role/profile registry |
| path/prefix/beneath resolver | code-owned workspace target policy |
| stable enumeration/member capture | review directory target backend |
| manifest/list/search canonicalization | closed review producer modules |
| artifact persistence | CapturedArtifactStore |
| run/target append/CAS/replay | PracticeRun v2 service/store |
| consume/inspection Gate lifecycle | existing wrapper + Reviewer v2 Gate |
| coverage/nextAction/checkpoint | review practice projector |
| claim/protected prose | protected claim store |
| status/OTel/Matrix delivery | existing bounded renderers/boundaries |

不创建generic filesystem browser、dynamic selector engine、generic concern runner、arbitrary command executor或跨角色runtime factory。

---

## 15. 设计接受 Gate

fresh reader必须仅凭公开合同唯一回答：

1. request、descriptor、enumeration、manifest、artifact、Evidence和claim分别是什么事实？
2. include/exclude如何normalize、排序、匹配；哪些entry被明确排除，哪些会使target失败？
3. two-pass capture证明什么、不证明什么，任何变化如何fail？
4. manifest exact bytes、producer、Store/journal binding和snapshot identity如何形成？
5. list与search分别读取什么，query去哪，为什么都不算member consumption？
6. target-bound read如何限制到manifest member并验证source未变？
7. crash、orphan、CAS、restart、reset、source change和artifact tamper各产生什么权威结果？
8. full directory completion为何必须覆盖每个manifest member？
9. profile/tool/schema如何clean-cut，为什么没有旧`files[]`兼容路径？
10. 哪些事实可进入Context/Evidence/OTel/status，哪些必须保持受保护？

任一问题仍有两个合理答案，或需要依赖本文未链接的非公开信息，合同均未达到实现Gate。

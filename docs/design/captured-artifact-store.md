# CapturedArtifactStore 持久化与 Evidence 合同

> **状态：** v1持久化基础设施及Reviewer v2 directory capture/inspection consumers已实现；Store仍不是model-visible artifact tool。
> **基础：** 历史 [`agent-plane-foundation.md`](./agent-plane-foundation.md) 与已实现部分的 [`reviewer-typed-targets.md`](./reviewer-typed-targets.md)。
> **范围：** 定义第一个 target-bound CapturedArtifactStore：保存 backend 规范化并实际可交给模型的有界 bytes，同时保持与 PracticeRun Machine State、Machine Evidence、claim 和 transcript 分离。
> **保证不变：** artifact 不授予权限、不认证内容真实性、不推进 checkpoint；`worker-local / static-review-only` 不因持久化 bytes 提升。
> **不是：** 第二条 Evidence chain、通用 blob service、模型可枚举文件库、目录/git/search/vision 能力实现、远程 PR、workspace mutation、自动 retention、通用 bash 或兼容迁移。

## 0. 如何使用本文

本文是 CapturedArtifactStore v1 的窄公开合同。实现者仍须遵守根目录 `AGENTS.md` 以及 implementation、verification、security-and-evidence 和 worker-runtime rules。

当前实现边界：

- Worker image已有concrete CapturedArtifactStore模块和独立state root；Reviewer v2 runtime由代码调用它保存directory manifest、member consume及bounded list/search output，Store本身不在model tool registry；
- typed `file`/`directory_snapshot`与directory manifest已实现；canonical git diff、network search/fetch或vision仍未实现，不得把Store基础设施描述为这些capability已可用；
- 不得把 artifact bytes 塞入 Evidence、PracticeRun journal、OTel、transcript、自定义 prompt message、错误或 filename 来绕过 Store；
- 不得以 protected payload store、pending write payload 或 workspace 临时文件冒充 artifact store；
- 不加入旧路径扫描、迁移、双写或 compatibility shim。

v1 只 materialize `practice_target` binding。未来 search/fetch、native image ingress 或 run-level inference 若需要不同 owner，必须版本化 binding union；不得预先用 nullable actor/run/target 字段猜测其授权语义。

---

## 1. 问题、目标与非目标

### 1.1 问题

PracticeRun journal 和 hash-chained Evidence 应保持有界、可审计且不承载潜在敏感大内容。但后续 target admission/consume 需要在 restart 后验证：

- backend 实际捕获了哪些 exact bytes；
- model-visible chunk、manifest 或 diff 的 content digest 是否仍对应磁盘对象；
- artifact 是否绑定当前 session、actor、run、target 和 invocation；
- missing、partial、tampered 或 cross-target object 是否会 fail closed；
- crash 后 durable object 是 authoritative reference 还是 orphan。

仅记录 digest 不能在 source 变化或消失后重新验证 bytes；把 raw bytes 写入 Evidence 又会破坏敏感内容和大小边界。

### 1.2 唯一目标

> 在独立 per-session state root 中，以 code-generated opaque identity 保存 exact bounded bytes 和 exact metadata；只有 committed PracticeRun journal 或 successful Machine Evidence lifecycle 能使 durable object成为被引用 artifact。Store 自身只证明 byte integrity 与 binding，不证明内容真实或专业结论正确。

### 1.3 非目标

v1 不提供：

- model/tool parameter 中的 artifact ID/ref/digest；
- list、search、glob、prefix scan、latest artifact 或按 content digest lookup；
- cross-session、cross-actor、cross-run 或 cross-target sharing/dedup；
- content-addressed public URL、HTTP server 或 external object-store API；
- 自动 recapture、repair、eviction、expiry、purge 或 tombstone；
- artifact semantic sanitization、malware guarantee 或 prompt-injection removal；
- 任意 media producer、transform module path 或 dynamic plugin；
- source query、URL、path、prompt、commit message 或 model prose metadata。

---

## 2. 事实模型

| 事实 | 含义 | 权威载体 |
|---|---|---|
| Producer input | backend 在内存中持有的 source/raw bytes | operation-local memory；默认不持久化 |
| Canonical bytes | producer 按固定 transform 生成、准备交给模型的 exact bytes | CapturedArtifactStore content file |
| Artifact envelope | canonical bytes 的 identity、binding、producer 与大小事实 | CapturedArtifactStore envelope |
| Artifact receipt | Store 返回给可信 runtime 的 frozen metadata/ref | in-memory runtime value；本身不授予 authority |
| Target snapshot | target admission 的 immutable state与 artifact binding | PracticeRun journal |
| Machine Evidence | wrapped operation proposal/Gate/start/completion 与 artifact metadata | hash-chained Evidence |
| Claim/model prose | 模型对 artifact/target 的判断 | protected claim/transcript；不是 artifact fact |
| Diagnostic telemetry | 有界阶段、计数和稳定错误 | sanitized OTel；不参与授权/checkpoint |

CapturedArtifactStore 不是 Evidence chain：

- Store 不决定 Gate、run state、checkpoint 或 done；
- envelope digest 只做 object integrity，不证明事件顺序；
- artifact 存在不证明 model 看到它；只有 successful wrapped completion Evidence 能证明某次 consume lifecycle 完成；
- artifact 内容可能错误、恶意、过时或包含 prompt injection。

---

## 3. V1 authority 与 binding

### 3.1 Exact binding

v1 envelope 只接受：

```json
{
  "kind": "practice_target",
  "sessionHash": "<lowercase sha256>",
  "actorId": "@user:example.test",
  "practiceRunId": "run-...",
  "targetId": "target-...",
  "invocationIdentity": "<lowercase sha256>",
  "sourceOperationDigest": "<lowercase sha256>"
}
```

规则：

- binding exact keys，不允许 null、unknown field 或 empty value；sessionHash/invocationIdentity/sourceOperationDigest匹配lowercase SHA-256；practiceRunId匹配`^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`；targetId匹配`^target-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`；actorId非空、无NUL、最大512 bytes；
- `sessionHash` 必须等于 state-path resolver 为当前 trusted session 派生的值；caller 不能选择其它 session root；
- actor/run/target 必须来自 current trusted invocation 与 PracticeRun Machine State；
- candidate run/target IDs 可在 Gate allow 后用于 staging，但 journal commit 前不构成 Machine State；
- `invocationIdentity` 与 `sourceOperationDigest` 由 wrapper/runtime 计算；模型不能提供；
- Store API 永远重新接收 expected binding并 exact compare；artifact ref/digest 本身不授予读取权限。

### 3.2 Binding kinds 不泛化

v1 不接受 `practiceRunId=null`、`targetId=null`、generic owner string 或 arbitrary metadata map。未来 capability 必须新增 schema version和 exact union，并证明 actor/approval/run/ingress authority后才可 materialize。

---

## 4. Artifact identity、key、ref 与 envelope

### 4.1 Canonical hashing

所有 metadata digest 使用项目 `canonicalJson`：recursive object-key sort（ECMAScript UTF-16 code-unit order）、array保序、finite JSON values、UTF-8 bytes、lowercase SHA-256。每种 projection 含固定 `schemaId` domain separation。raw `contentDigest` 只对 exact canonical content bytes 计算。

### 4.2 Artifact key

每个 logical producer output 使用：

```text
artifactKey = sha256(canonicalJson({
  schemaId: "tiangong.captured-artifact-key.v1",
  binding,
  purpose,
  ordinal
}))
```

- `purpose` 匹配 `^[a-z][a-z0-9_-]{0,63}$` 并来自 closed producer registry；
- `ordinal` 是 `0..63` safe integer，由 code-owned producer按 operation内稳定顺序分配；模型不能提供；
- 同 key/same metadata/same bytes replay 返回原 receipt；同 key 不同 bytes/metadata 返回 `ARTIFACT_KEY_CONFLICT`；
- 不按 content digest deduplicate，避免跨 binding 内容关联和 authority 转移。

### 4.3 Artifact ID/ref

- `artifactId` 由 Store 生成，必须匹配 lowercase canonical `^artifact-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`；
- artifactId在同一session root内必须唯一；Store在kernel lock下扫描validated final envelopes建立used-ID set；quota通过后最多生成/检查8个candidate，仍collision返回 `ARTIFACT_ID_GENERATION_FAILED`；
- opaque `artifactRef` exact 为 `artifact-v1/<artifactId>`；只允许存在于Store envelope、可信 runtime和需要持久绑定的 PracticeRun journal，不进入模型、Evidence、OTel、错误或公开输出；
- ref digest：

```text
artifactRefDigest = sha256(canonicalJson({
  schemaId: "tiangong.captured-artifact-ref.v1",
  sessionHash,
  artifactRef
}))
```

- object path 只使用 `artifactKey`，不使用 artifactId、artifactRef/refDigest、content digest、purpose、path、query 或模型内容。

### 4.4 Exact envelope

```json
{
  "schemaVersion": 1,
  "artifactId": "artifact-...",
  "artifactRef": "artifact-v1/artifact-...",
  "artifactRefDigest": "<sha256>",
  "artifactKey": "<sha256>",
  "binding": {
    "kind": "practice_target",
    "sessionHash": "<sha256>",
    "actorId": "@user:example.test",
    "practiceRunId": "run-...",
    "targetId": "target-...",
    "invocationIdentity": "<sha256>",
    "sourceOperationDigest": "<sha256>"
  },
  "purpose": "review_target_chunk",
  "ordinal": 0,
  "contentDigest": "<sha256>",
  "contentBytes": 1234,
  "contentLines": 20,
  "mediaType": "text/plain;charset=utf-8",
  "encoding": "utf-8",
  "truncated": false,
  "producerId": "review-target-consume",
  "producerVersion": 1,
  "transformVersion": 1,
  "createdAt": "2026-07-31T00:00:00.000Z",
  "envelopeDigest": "<sha256>"
}
```

Exact constraints：

- top-level 与 binding 都 exact keys；
- digest fields 是 lowercase SHA-256；IDs 使用各自 pattern；
- actor ID 非空、最大 512 bytes；mediaType/encoding/producer/purpose 各自有 fixed registry与大小上限；
- contentBytes 是 `0..MAX_ARTIFACT_BYTES` safe integer；zero-byte artifact 合法；
- UTF-8 text artifact：`encoding="utf-8"`、contentLines positive safe integer，Store 以 fatal decode和 producer指定 text policy复核；
- non-text artifact：`encoding=null`、`contentLines=null`；
- `truncated` 是 boolean；是否可成为 target authority由 capability合同决定，Store不把 false/true解释为 complete；
- `createdAt` 是 injected clock 的 UTC millisecond RFC 3339；replay使用原值；
- envelopeDigest exact：

```text
sha256(canonicalJson({
  schemaId: "tiangong.captured-artifact-envelope.v1",
  envelope: <all envelope fields except envelopeDigest>
}))
```

Envelope wire bytes exact为 `Buffer.from(canonicalJson(envelope),"utf8")`：无BOM、无trailing LF/whitespace。read先做size bound与fatal UTF-8/JSON parse，再要求actual bytes逐byte等于重新canonicalize后的bytes；duplicate key、alternate whitespace、trailing data或noncanonical number因此fail closed。`MAX_ENVELOPE_BYTES`按actual wire bytes计算。

### 4.5 Artifact key 是唯一 lookup index

V1 不维护另一个可丢失或与object冲突的key index。`artifactKey` 本身是 binding/purpose/ordinal 的受保护确定性lookup key，final object directory exact 为 `objects/<artifactKey>`。read/replay还必须用 expected `artifactRefDigest` 验证envelope中的随机ref identity；知道artifactKey或refDigest任一项都不授予authority。

---

## 5. Fixed state layout

state-path resolver clean-cut 增加：

```text
<worker-state-root>/
  captured-artifacts/
    <session-hash>/
      objects/
        <artifact-key>/
          content
          envelope.json
      tmp/
        <runtime-generated-temp-id>/
      store-lock-target
```

要求：

- `capturedArtifactsRoot` 与 `sessions/`、`practice-runs/`、`evidence/` 平级；
- session path 只使用 resolver 派生的 lowercase session hash；
- root/session/objects/tmp/object directories mode `0700`；content/envelope files mode `0600`；
- 对expected ordinary node发现group/other permission bits时，Store在持有session exclusive lock后只允许执行 `chmod 0700/0600` 修复并立即 `lstat/fstat` 复核；修复成功继续，无法修复才 `ARTIFACT_STORE_CORRUPTED`；symlink/wrong type/content mismatch永不repair；
- root到leaf每个component必须是expected ordinary directory/file且非symlink；每个final `objects/<artifactKey>/` directory的entry set必须exact为`content,envelope.json`，任何额外regular/symlink/directory entry都使whole Store `ARTIFACT_STORE_CORRUPTED`且不能作为quota workaround；
- content filename固定为 `content`，原始source name/path/media不进入filename；
- Store不得接受caller-provided filesystem path；
- transcript reset和删除整个 `sessions/<hash>/` 不触及 captured-artifacts；
- runtime、tests、maintenance全部使用统一 state-path resolver，不各自拼路径。

首次bootstrap是§11.1 lock规则的唯一例外，只能幂等创建 `captured-artifacts/`、`<session-hash>/` 与 empty `store-lock-target`，不能创建object/tmp content：使用no-symlink逐层`mkdir(mode=0700)`和`open(O_CREAT,0600)`；每个creator验证expected type/no-symlink，fsync新/已开node并fsync parent。新node按exact mode创建；existing broader mode只记录，取得session lock后按下段repair。并发bootstrap只会得到相同fixed nodes。随后先取得kernel lock，再在lock内repair/创建/验证objects/tmp并逐级fsync。lock timeout时bootstrap nodes可保留，但不存在业务object/tmp mutation。

对permission repair执行chmod后必须fsync被修复file/directory并fsync parent，再lstat/fstat复核；无法durable flush或复核失败为 `ARTIFACT_STORE_CORRUPTED`。这样Store成功return前各级directory entry和mode都跨crash durable。

`store-lock-target` 是mode `0600` ordinary lock file，不保存业务内容。V1必须通过reviewed public dependency/non-shell binding持有Linux kernel advisory exclusive lock（`flock(2)`等价语义）：file descriptor/process退出自动释放；不得使用mtime lease、PID猜测、stale directory reclaim或fencing近似。lock wait固定35秒，超时为 `ARTIFACT_LOCK_FAILED`。若build/runtime无法提供该kernel primitive，Store不得materialize。

---

## 6. Closed producer registry

Store 只接受 code-owned producer definition：

```text
producerId
producerVersion
allowedPurposes[]
allowedMediaTypes[]
allowedEncodings[]
maxContentBytes
textPolicyId?
transformVersions[]
```

首个 typed-target producer exact definition：

```json
{
  "producerId": "review-target-consume",
  "producerVersion": 1,
  "allowedPurposes": ["review_target_chunk"],
  "allowedMediaTypes": ["text/plain;charset=utf-8"],
  "allowedEncodings": ["utf-8"],
  "maxContentBytes": 51200,
  "textPolicyId": "review-text-lines-v1",
  "transformVersions": [1]
}
```

`review-text-lines-v1` exact：先执行 byte predicate（byte `<0x20` 仅允许 TAB/LF/CR，拒绝 `0x7f`），再使用 `TextDecoder("utf-8",{fatal:true,ignoreBOM:false})`；以LF分割，bare CR保留，empty bytes=1 line，trailing LF增加最后一个empty line。producer交给Store的chunk已是model-visible canonical bytes且最大50KiB；Store按同一policy独立重算contentLines。`truncated`允许true/false但由target coverage解释。

directory/git producer只有其独立 capability合同、canonical transform和profile materialize后才加入registry。

规则：

- model、profile workspace文件、ENV或tool parameter不能注册producer、media type或transform；
- producer在调用Store前完成canonical transform；Store不加载动态module，不执行source content；
- Store复核registry、metadata、bytes、encoding、line count与limit；
- producer semantic变化必须bump producer/transform version；
- artifact metadata不得含 arbitrary headers、URL、query、source path、commit message、prompt、claim或model output summary。

---

## 7. Put transaction

### 7.1 Trusted input

概念API：

```text
put({
  binding,
  purpose,
  ordinal,
  mediaType,
  encoding,
  truncated,
  producerId,
  producerVersion,
  transformVersion,
  canonicalBytes
}) -> ArtifactReceipt
```

Store自己计算 contentDigest/contentBytes/contentLines、artifactKey、artifactId/ref/refDigest、createdAt与envelopeDigest。caller不能提供/override这些字段。

### 7.2 Validation precedence

1. current session root与§3 binding exact schema/pattern validation；invalid long ID在任何envelope/limit计算前稳定返回`ARTIFACT_BINDING_INVALID`；
2. producer/purpose/media/encoding/transform registry；
3. ordinal与metadata schema；
4. bytes type和per-artifact producer/global limit；
5. fatal text decode、line count与media consistency；
6. artifactKey calculation；
7. per-session kernel lock acquire validation；
8. mandatory tmp cleanup与full-store structure/used-ID/integrity scan，并计算quota；
9. direct object replay/conflict validation；
10. 对new key执行aggregate quota；
11. artifactId/ref/refDigest generation与最多8次per-session collision check；
12. durable object-directory write；
13. read-after-write verification。

较早失败不继续后续步骤；错误不含raw content或source metadata。

### 7.3 Durable write order

producer在调用Store前可于内存生成bounded canonical bytes；Store filesystem temp write、quota check与final commit全部在per-session kernel exclusive lock内：

1. 强制执行§11.2 owned-temp cleanup并fsync tmp；
2. 扫描全部final objects的structure/envelope：验证directory/content/envelope expected types、mode repair、exact entry set、envelope canonical/digest、artifactKey path binding、actual content stat size与per-session artifactId uniqueness并计算quota；不读取unrelated content bytes，任何unrelated structural/envelope/size corruption仍fail closed；
3. 若 `objects/<artifactKey>` 已存在，按§7.4 full content replay validation后返回；
4. quota通过后生成per-session unique artifactId/ref；
5. 写入temp object directory：content → fsync content；envelope → fsync envelope；fsync temp directory；
6. atomic rename到 `objects/<artifactKey>`；依次fsync `tmp/` 与 `objects/` 两个parent directory；
7. 重新以 no-follow open读取envelope/content并验证exact bytes/digests/binding；
8. 返回 frozen receipt。

Store只在step 7成功后返回。object destination collision必须读取并exact compare；不能覆盖。atomic directory rename保证final object不是“只有content/envelope的一半”；rename后必须同时fsync source/target parents才宣称final durable。失败时只可能留下owned temp，或一个完整但尚无journal/Evidence authority的orphan object。不得回滚/删除可能已被并发或journal引用的final object。

### 7.4 Replay

全store structural/used-ID/quota scan已通过且 `objects/<artifactKey>` 存在时：

- no-follow读取object envelope→content；
- exact验证 artifactKey、expected binding、purpose/ordinal/producer/metadata和canonical bytes；
- 全部相同返回原 receipt，`replayed=true`；
- key相同但任何metadata/content不同返回 `ARTIFACT_KEY_CONFLICT`；
- missing/partial/tampered/symlink/type mismatch，或permission按§5无法修复，返回 `ARTIFACT_STORE_CORRUPTED`，不创建替代object。

---

## 8. Read/resolve contract

`expectedContentIdentity` exact keys，与PracticeRun journal/Evidence保存的safe projection一致：

```json
{
  "purpose": "review_target_chunk",
  "ordinal": 0,
  "contentDigest": "<sha256>",
  "contentBytes": 1234,
  "contentLines": 20,
  "mediaType": "text/plain;charset=utf-8",
  "encoding": "utf-8",
  "truncated": false,
  "producerId": "review-target-consume",
  "producerVersion": 1,
  "transformVersion": 1
}
```

任何字段缺失/额外/不匹配都不能只按contentDigest通过。admission journal和consume completion Evidence都使用该exact projection；raw artifactRef只额外存在于admission journal。

概念API分成两个authority入口：

```text
readFromJournal({
  artifactRef,
  artifactRefDigest,
  artifactKey,
  expectedBinding,
  expectedContentIdentity
}) -> { envelope, bytes }

readFromEvidence({
  artifactRefDigest,
  artifactKey,
  expectedBinding,
  expectedContentIdentity
}) -> { envelope, bytes }
```

PracticeRun journal validator拥有raw-ref检查：先验证`artifact-v1/<artifactId>` pattern，按journal sessionHash重算refDigest，再与journal字段比较；Store随后要求raw ref（journal入口）、refDigest和envelope三者exact一致。Evidence入口没有raw ref，只使用chain-validated refDigest/key/binding/content identity。caller必须从validated PracticeRun Machine State或validated Evidence projection取得expected fields；不能从model/transcript取得。

read顺序（全程持session kernel lock）：

1. validate current session root、ref/key digest和expected binding；
2. 强制cleanup owned temp并执行与§7.3 step 2相同的full-store structure/mode/envelope/content-stat/artifactId scan；任一unrelated structural/envelope/size corruption也阻断read，但unrelated raw content digest按需lazy验证；
3. no-follow读取 `objects/<artifactKey>` directory/envelope/content；
4. validate exact schema、envelopeDigest、refDigest formula与artifactKey formula；
5. validate requested refDigest、expected binding、purpose/ordinal/producer/content identity；journal入口另exact compare requested raw ref；
6. validate actual file size、raw content digest、UTF-8/line metadata与permissions；
7. 返回新Buffer/frozen envelope clone。

任何missing、partial、tampered、cross-session/actor/run/target/invocation、unexpected type、digest mismatch或ref/key ambiguity都fail closed；不得：

- 扫描objects寻找“相同digest”；
- 从live workspace/ref/provider recapture；
- 创建替代artifact；
- 返回部分bytes；
- 降级为unverified model content。

Store API不提供 enumerate/list/latest/findByDigest，tool registry也不暴露Store本身。

---

## 9. Receipt、Machine State 与 Evidence join

### 9.1 Receipt

frozen receipt exact keys：

```text
artifactRef               # trusted runtime/journal only
artifactRefDigest
artifactKey
ordinal
contentDigest
contentBytes
contentLines
mediaType
encoding
truncated
purpose
producerId
producerVersion
transformVersion
binding
replayed
```

receipt本身不表示 model已看到bytes，也不推进run。

### 9.2 Authority rules

| Durable object状态 | Authority |
|---|---|
| temp only | none；不是artifact |
| complete final object durable、无journal/Evidence ref | orphan；none |
| committed PracticeRun journal引用receipt | target snapshot Machine State authority |
| successful wrapped consume completion Evidence引用receipt metadata | completed consume Machine Evidence |
| tool started/failed，或completion Evidence append失败 | no successful consume authority；object仍orphan |

state-transition journal commit后、wrapper completion Evidence失败时，journal仍可使admission artifact authoritative；same invocation replay不得recapture。read-only consume只有successful completion Evidence才能用于coverage。

### 9.3 Evidence metadata

wrapped completion只记录：

```json
{
  "artifactKey": "<sha256>",
  "artifactRefDigest": "<sha256>",
  "ordinal": 0,
  "contentDigest": "<sha256>",
  "contentBytes": 1234,
  "contentLines": 20,
  "mediaType": "text/plain;charset=utf-8",
  "encoding": "utf-8",
  "truncated": false,
  "purpose": "review_target_chunk",
  "producerId": "review-target-consume",
  "producerVersion": 1,
  "transformVersion": 1
}
```

- 不记录artifactRef、bytes、source path/query/URL、manifest/diff、prompt或prose；
- artifact array的ordinal必须从0连续递增、按ordinal排序、最多64；projection用event binding + purpose + ordinal重算artifactKey；
- Evidence projection先验证chain/lifecycle，再用refDigest+key+expected binding读取Store；
- Store failure使projection/checkpoint/Context fail closed，不能只忽略该execution；
- Store不自行append Evidence；caller必须是已经通过Tiangong wrapper/Gate的backend。

---

## 10. Quotas

V1固定：

```text
MAX_ARTIFACT_BYTES=16MiB
MAX_ENVELOPE_BYTES=32KiB
MAX_ARTIFACTS_PER_TARGET=2048
MAX_CONTENT_BYTES_PER_TARGET=64MiB
MAX_ARTIFACTS_PER_RUN=4096
MAX_CONTENT_BYTES_PER_RUN=128MiB
MAX_ARTIFACTS_PER_SESSION=8192
MAX_CONTENT_BYTES_PER_SESSION=256MiB
MAX_ARTIFACTS_PER_OPERATION=64
MAX_TEMP_BYTES_PER_SESSION=16MiB+32KiB+2bytes
```

规则：

- session group=`sessionHash`；run group=`sessionHash+actorId+practiceRunId`；target group=`sessionHash+actorId+practiceRunId+targetId`；operation group=完整binding中的`sessionHash+actorId+practiceRunId+targetId+invocationIdentity+sourceOperationDigest`；裸runId/targetId永不跨actor合并；
- producer limit与global limit取更低值；
- content quota按actual content file bytes计，不按declared metadata；当前kernel lock内Store temp bytes同时计入session content quota和`MAX_TEMP_BYTES_PER_SESSION`，final rename后不重复计；
- 每个complete final object（包括无journal/Evidence authority的orphan）都计入session/run/target quota；tmp bytes计入session临时budget，单个put不得超过artifact limit；
- key/envelope/tmp overhead另受entry count与fixed envelope limit控制；
- quota在final rename前、per-session lock内重新计算；
- same-key replay不重复计数；
- quota不足返回 `ARTIFACT_QUOTA_EXCEEDED`，不自动evict terminal、orphan或old artifact；
- quota达到后允许read、verification和operator diagnostics，不允许新put；
- malformed/unreadable object不能被当作0 bytes绕过quota；Store返回corrupted并停止put。

V1无purge，因此部署者必须诚实监控配额；容量不足不能通过删除Evidence、修改envelope或新建兼容root规避。

---

## 11. Concurrency、temporary objects 与 crash

### 11.1 Lock

- §5 fixed bootstrap完成后，initialization、put、read、permission repair、tmp cleanup和quota scan都持per-session kernel exclusive lock；bootstrap仅创建lock所需fixed empty nodes；
- producer canonical transform在Store调用前完成；Store从quota reload、tmp write到atomic object rename/read-back始终持lock；
- process crash/descriptor close由kernel释放lock，不存在stale reclaim、lease expiry、old writer恢复或fencing generation；
-同一进程另有Promise queue，但不能替代kernel lock；
-不同session不共享lock；35秒内不能取得lock则不做filesystem mutation并返回 `ARTIFACT_LOCK_FAILED`。

### 11.2 Temporary cleanup

`tmp/` 只接受Store生成的lowercase `^tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` directory。每次initialization/put/read在任何scan或新tmp创建前，必须在kernel lock内删除并fsync `tmp/`：

- `tmp/` 中匹配pattern的directory总数必须为0或1；多于1个即 `ARTIFACT_STORE_CORRUPTED`，不逐个删除来规避session temp aggregate；若存在一个，其type为ordinary directory且name匹配exact pattern；
- crash stage允许entry set exact为 `{}`、`{content}` 或 `{content,envelope.json}`；存在的entry必须ordinary non-symlink file；content最多`MAX_ARTIFACT_BYTES+1`，envelope最多`MAX_ENVELOPE_BYTES+1`，且两者actual-size sum不得超过`MAX_TEMP_BYTES_PER_SESSION`；允许partial/invalid bytes因为它们从未final；
- 任何其它entry name/type、oversize temp或nested directory均为 `ARTIFACT_STORE_CORRUPTED`，不递归跟随/删除未知内容。

Store不扫描PracticeRun journal来判断temp：API只在两个parent fsync和final read-back后返回receipt，因此journal/Evidence不可能合法引用tmp namespace。kernel lock保证每session同时至多一个Store temp，disk temp总量不超过`MAX_TEMP_BYTES_PER_SESSION`。删除temp是未提交写入清理，不是artifact retention。

### 11.3 Crash table

| Crash point | Result |
|---|---|
| temp content前/中 | no artifact；owned temp可清理 |
| temp object durable、final rename前 | no artifact；owned temp可清理 |
| atomic rename后、`fsync(tmp)`与`fsync(objects)`都完成前 | no authority；restart允许complete final、owned temp或object不存在，same-key retry/cleanup按实际状态继续 |
| 两个parent fsync后、Store return前 | durable complete final orphan；same-key replay验证并返回原receipt |
| Store return后、PracticeRun journal前 | orphan，除非后续same invocation commits同receipt |
| journal commit后、wrapper Evidence前 | journal artifact authoritative；replay不recapture |
| consume Store return后、completion Evidence前 | no consume authority；artifact orphan |
| completion Evidence后、model delivery前 | consume Evidence authoritative；delivery/liveness另行判断 |
| content/envelope/key后续missing/tampered | read/projection fail closed；不repair |

---

## 12. Restart、reset 与 initialization

Store使用lazy initialization：只有put/read或trusted active-run artifact reference需要Store时才bootstrap/lock；no active run的普通Context guidance不因此扫描artifact root。V1 Store initialization：

1. derive/bootstrap fixed session root并取得kernel lock；
2. validate root/objects/tmp expected types、permissions和no symlink；
3. mandatory cleanup §11.2 owned temps并fsync tmp；
4. 执行与§7.3 step 2相同的full-store structure/mode/envelope/content-stat/artifactId/quota scan；raw content digest只在对应artifact direct read/replay时验证；
5. active PracticeRun存在时，resolve其journal-bound admission artifacts；
6. Context/coverage需要consume Evidence时，再按selected ref/key exact读取（read仍先执行full scan）；
7. no active run不扫描旧run artifacts或Evidence来生成guidance。

要求：

- transcript reset、pi session删除和整个 `sessions/<hash>/` 删除不改变artifact root identity/bytes；
- restart从journal/Evidence expected metadata连接Store，不从transcript重建ref；
- session/object root missing时可创建fresh empty layout；随后任何trusted journal/Evidence read若要求不存在的artifactKey即 `ARTIFACT_STORE_CORRUPTED`；
- unexpected final object或orphan可以保留并计quota，但不能成为authority；
- Store不通过content digest、refDigest或mtime猜测object；只按expected artifactKey direct lookup；
- 只有orphan、没有任何trusted journal/Evidence ref时，外部管理员删除整个artifact root与真正fresh session在机器事实中不可区分；V1不声称检测该外部tamper，orphan quota只对仍存在的physical objects保守计数。runtime自身仍无purge/delete API；
- journal/Evidence tamper优先由各自chain验证失败；Store不能“证明”损坏state为真。

---

## 13. Retention、可见性与 AgentTeams storage

### 13.1 V1 retention

V1没有artifact delete/purge API：

- active、done、abandoned和orphan artifact都不自动删除；
- existing `tiangong-retain compact` 必须忽略 captured-artifacts root；
- Evidence永不因artifact容量或terminal run删除；
- quota exhaustion是hard failure，不触发LRU、TTL、terminal cleanup或source recapture；
- object missing没有tombstone语义，统一视为corruption。

未来operator purge必须单独设计/评审，至少要求terminal/no-recovery dependency、显式actor/reason/confirmation、pre/post Evidence、crash reconciliation、durable tombstone、remote erasure和“purged后不可重放/验证”的用户可见状态；不得在V1实现PR顺手加入。

### 13.2 Storage-administrator visibility

artifact可能包含workspace source、manifest、diff、external content、image或inference prose。文件mode 600只限制容器内普通principal；拥有Worker/container/host/AgentTeams storage administration权限的principal仍可读取。公开安全文档必须诚实说明，不能称end-to-end encryption或model-only visibility。

### 13.3 AgentTeams boundary

- artifact root位于官方synchronized Worker state directory；AgentTeams继续拥有storage sync/restore；
- Tiangong不向model暴露storage credential、`mc`、remote object path或sync command；
- local fsync只证明local durable boundary；跨Worker restart smoke必须等待official storage durability/readiness并独立验证digest；
- V1无remote purge/erasure claim；不得仅删除local file就宣称远端已擦除；
- public project不得依赖private storage service/API/image/fixture。

---

## 14. Stable errors 与 precedence

V1 stable codes：

```text
ARTIFACT_BINDING_INVALID
ARTIFACT_PRODUCER_NOT_ALLOWED
ARTIFACT_METADATA_INVALID
ARTIFACT_LIMIT_EXCEEDED
ARTIFACT_QUOTA_EXCEEDED
ARTIFACT_ID_GENERATION_FAILED
ARTIFACT_KEY_CONFLICT
ARTIFACT_STORE_CORRUPTED
ARTIFACT_LOCK_FAILED
ARTIFACT_WRITE_FAILED
ARTIFACT_READ_FAILED
```

映射：

- caller binding/session/actor/run/target/invocation mismatch → `ARTIFACT_BINDING_INVALID`；
- producer/purpose/media/encoding/transform不在closed registry → `ARTIFACT_PRODUCER_NOT_ALLOWED`；
- malformed ordinal/metadata/UTF-8 line facts → `ARTIFACT_METADATA_INVALID`；
- single artifact bytes/envelope/operation count超限 → `ARTIFACT_LIMIT_EXCEEDED`；aggregate target/run/session → `ARTIFACT_QUOTA_EXCEEDED`；
- same artifactKey different bytes/metadata/binding → `ARTIFACT_KEY_CONFLICT`；
- expected artifactKey object missing、partial、tampered、symlink、wrong type、permission无法按§5修复、digest或ambiguous collision → `ARTIFACT_STORE_CORRUPTED`；
- pre-lock bootstrap `lstat/fstat` 等inspection非integrity I/O failure → `ARTIFACT_READ_FAILED`；fixed node create/open-for-create/fsync mutation failure → `ARTIFACT_WRITE_FAILED`；unexpected existing type/symlink或post-lock permission无法repair → `ARTIFACT_STORE_CORRUPTED`；
- kernel lock acquire/timeout失败 → `ARTIFACT_LOCK_FAILED`；
- validated put中I/O failure → `ARTIFACT_WRITE_FAILED`；post-lock initialization/read scan的非integrity I/O failure → `ARTIFACT_READ_FAILED`。

precedence：binding → producer → metadata → per-artifact limit/decode → artifactKey calculation → fixed bootstrap → kernel lock → mandatory tmp cleanup → full-store structure/used-ID/integrity/quota scan → direct replay/conflict → new-key quota enforcement → artifactId collision generation → write/read I/O → read-after-write integrity。session quota已满且RNG也collision时稳定返回`ARTIFACT_QUOTA_EXCEEDED`。integrity mismatch始终是corrupted，不因同时存在I/O或quota问题降级。错误只输出stable code和bounded safe说明，不含path/ref/content/digest、actor、run/target ID、query/URL或raw OS error。

---

## 15. Security invariants

- Store只由wrapped backend在Gate allow后调用；Store存在不绕过tool registry/Gate；
- bytes永不作为代码执行，content file不可执行；
- artifact content不进入system prompt；只有capability renderer显式读取后作为不可信data交给model；
- actor/run/target binding在put/read/join每层复核；
- raw artifactRef仅可存在于protected runtime state；refDigest/contentDigest都不授予authority；
- no symlink、no caller path、exact filenames、atomic write、fsync、cross-process lock和read-after-write全部由代码执行；
- Store不接收credential/header/cookie/proxy environment；未来network producer自己拥有egress/secret合同；
- OTel只允许producer ID/version、media family、bytes bucket、outcome和stable error code；禁止artifact/ref/content digest、actor、run/target、raw error或content；
- logs/CLI/report只输出aggregate count/bytes和stable code，不输出object names或bindings；
- claims、prose、artifact、Machine State、Evidence和telemetry保持分离。

---

## 16. 与 typed target 的 exact seam

### 16.1 Admission artifact

- Gate allow后生成candidate run/target IDs；
- directory/commit/git_diff producer写artifact，receipt binding使用candidate IDs；
- target snapshot identity只使用receipt的content identity，不使用random ref；
- PracticeRun journal保存raw artifactRef + refDigest + key + content identity；journal validator按§8拥有raw-ref pattern/refDigest formula验证，Store `readFromJournal`再与envelope exact compare；
- journal前crash/object是orphan；journal后Store read必须exact join；
- `truncated=true` 是否允许由target kind合同决定，Store不冒充complete。

### 16.2 Consume chunk

- target-bound backend从validated target/resource生成actual returned chunk；
- `review-target-consume` put完成后，tool backend返回同一Buffer给wrapper；
- wrapper先append successful completion Evidence（只含safe artifact metadata），再把content交给model；
- completion Evidence失败时不得把chunk作为successful tool result交给model；artifact是orphan；
- coverage按Evidence ref/key/refDigest读取Store并复核bytes，然后使用target snapshot identity/range metadata；
- Store tamper/missing使Context/checkpoint fail closed。

### 16.3 No circular authority

- Store验证binding，但不查询model claim；
- PracticeRun journal引用Store，但Store object不能创建/修改journal；
- Evidence引用refDigest，但Store envelope不能伪造Evidence lifecycle；
- checkpoint消费validated journal + Evidence + Store，不信任任何单一载体自证。

---

## 17. Deterministic verification

### 17.1 Schema/identity

- envelope/binding/key/receipt exact keys；unknown/missing/wrong version fail；
- fixed golden vectors for artifactKey/refDigest/envelopeDigest/contentDigest；
- UUID/ref pattern与8次collision limit；
- same content different binding不dedupe；same key replay exact；same key conflict fail；
- zero-byte UTF-8与non-text metadata positive/negative cases。

### 17.2 Filesystem/integrity

- mode 700/600 create与repair；无法repair fail；
- root/object/content/envelope/key/temp symlink和wrong type fail；
- partial content/envelope、length/digest/line/envelope mismatch fail；
- atomic rename/fsync order fault injection；
- read-after-write与restart digest round trip；
- caller path/ref/ID injection不能改变filesystem path。

### 17.3 Concurrency/crash

- same-process queue与two-process same/different key serialization；
- same key same bytes one object/replay；different bytes conflict；
- kernel lock跨进程互斥、35秒timeout与process-crash自动释放；证明不存在mtime stale reclaim/live-writer takeover；
- crash at every §11.3 point；temp cleanup只删owned temp；
- complete object without journal/Evidence authority remains orphan and counts quota；
- journal commit后wrapper Evidence failure仍可按journal恢复admission artifact；consume failure不生成coverage。

### 17.4 Binding/quota/reset

- session/actor/run/target/invocation/operation mismatch fail；
- no model-supplied ref/list/enumeration surface；
- per artifact/target/run/session/operation boundary、adjacent和actual-size quota tests；
- replay不重复quota；orphan计quota；quota满仍可read；
- transcript reset与删除sessions tree后artifact identity/bytes不变；
- state resolver exact root；legacy path不扫描；
- existing retention CLI不触及artifact root。

### 17.5 Evidence/privacy

- successful Evidence metadata exact且无raw ref/content/path/query/URL；
- started/failed/completion-append failure不算successfulconsume；
- Store bytes、ref、actor/run/target不进入OTel/error/CLI output；
- storage-administrator visibility documentation；
- repository/fixture/log scan无artifact raw test secrets或private dependency。

---

## 18. Integration 与 smoke

Store correctness先由deterministic filesystem tests证明，不用model/Matrix证明digest、binding、quota或crash。

首个真实consumer的Basic/Recovery smoke必须证明：

- actual image含Store实现但Store不是model tool；
- target-bound operation产生一个expected artifact receipt与successful Evidence join；
- independent fixture bytes/digest匹配Store metadata；
- restart/reset后同refDigest/key/binding读取相同bytes；
- raw artifactRef/content不出现在Evidence、OTel、Matrix machine status或bounded diagnostics；
- no mutation/new authority；official delivery/Harness和exact cleanup通过。

Store设计/基础设施PR不运行或宣称directory/git/search/vision capability smoke。真实storage smoke只证明official sync、digest恢复与cleanup，不证明artifact内容真实。

---

## 19. 模块职责

| 职责 | Owner |
|---|---|
| state root/path derivation | existing centralized state-path resolver |
| envelope/key/object persistence | `worker/agent/artifacts/` concrete Store |
| producer definitions | closed code-owned artifact producer registry |
| actor/run/target expected binding | PracticeRun/runtime caller |
| Gate/idempotency/tool lifecycle | existing wrapper/Gate |
| successful artifact metadata | wrapper Evidence completion metadata |
| target snapshot refs | PracticeRun journal |
| coverage/checkpoint joins | review practice projector |
| Channel/storage sync | AgentTeams/OpenClaw boundary |
| future purge | separately reviewed operator maintenance contract |

不创建dynamic store plugin、generic role factory、arbitrary serializer、content transformer loader或model-accessible artifact manager。

---

## 20. 设计接受 Gate

进入实现前，fresh reader必须能仅凭本文回答：

1. artifact bytes、envelope、receipt、target snapshot、Evidence和claim各是什么事实？
2. artifactKey、artifactRef、refDigest、contentDigest、envelopeDigest分别绑定什么？
3. model为什么不能mint/枚举/read artifact？
4. put何时产生orphan，何时journal/Evidence使其authoritative？
5. same-key replay、conflict和two-process race如何处理？
6. filesystem layout、permissions、no-symlink、atomic write/fsync和lock合同是什么？
7. quota如何计算，为什么不能自动evict？
8. missing/tampered/key conflict/restart/reset分别如何fail closed？
9. V1 retention和storage-administrator visibility是什么？
10. CapturedArtifactStore为何不是Evidence chain或内容真实性证明？

若任一答案仍依赖model prose、raw transcript、source recapture、caller path、private storage、未定义nullable binding或“best effort”repair，本合同不得进入实现。

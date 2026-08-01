# Reviewer local-git target contract

> **状态：** 设计冻结；runtime尚未materialize `commit` / `git_diff`，实现与真实smoke必须走独立PR。
>
> **范围：** Worker-local、non-mutating、本地普通repository中的immutable commit snapshot与direct commit-to-commit diff；不包含working tree/index diff、remote fetch/PR、任意git argv、shell或项目执行。

## 0. Current boundary and activation Gate

当前Reviewer profile schema v2只materialize：

- target kinds：`file`、`directory_snapshot`；
- tools：`start_work`、`extend_scope`、`read`、`inspect_directory`、`check_completion`、`abandon_work`。

[`reviewer-typed-targets.md`](./reviewer-typed-targets.md) 已为`commit`和`git_diff`保留kind-owned snapshot/coverage位置，但明确禁止在local-git合同落地前使executor可达。本文冻结该独立合同；设计PR本身不得修改profile、tool registry、producer registry或runtime dispatch。

实现activation必须一次性满足：

- profile schema仍为v2，profile `targetKindIds` exact为`file,directory_snapshot,commit,git_diff`；`materializedTargetKindIds`是image/profile checker从closed runtime registry派生的assertion output，不是profile JSON字段，且必须exact同序；
- tool顺序exact为`start_work,extend_scope,read,inspect_directory,inspect_repository,check_completion,abandon_work`；
- PracticeRun/journal/claim继续使用v2，ContextPack继续使用v3，checkpoint继续使用`review-v2`；
- `commit`/`git_diff` target、artifact producer、read/coverage/checkpoint/context/status/OTel和smoke oracle同时激活；
- 不保留只接受两种kind的双dispatch、旧profile digest shim、journal自动迁移或模型侧fallback；
- 旧active run若绑定不同fixed profile digest，按既有profile binding规则fail closed，不重写其target或Evidence。

本文不会把尚未实现的能力写成current product behavior。实现与hard gates通过后，才更新README、CHANGELOG和current-behavior文档。

---

## 1. Goal, non-goals, and facts

### 1.1 Goal

让Reviewer能够把本地Git数据表达为两种immutable typed target：

1. **`commit`**：某个已pin full commit/tree OID下、由literal path prefixes选择的完整UTF-8 regular-file set；
2. **`git_diff`**：两个已pin full commit OID之间、同一repository内、由literal path prefixes选择的direct textual patch。

机器保证只包括：受约束backend在Gate后从一个支持的本地repository捕获了确定对象/字节，target与artifact被journal/Evidence/Store精确绑定，且checkpoint选择的read Evidence完整覆盖这些snapshot resources。机器不保证commit/diff内容正确、可信、安全、可构建或可运行。

### 1.2 Non-goals

首版明确不提供：

- working-tree、index、stash、merge-base或three-dot diff；
- remote URL、fetch/pull/clone/ls-remote、GitHub/GitLab PR解析或新鲜度声明；
- arbitrary git command、argv、revision expression、pathspec magic或shell；
- `status`、`log`、`blame`、free-form `show`、commit graph exploration或submodule traversal；
- test/build/lint/package-manager/project code执行；
- workspace、index、refs、objects、config或hooks写入；
- commit signature、author identity、message truth、patch semantics或review correctness认证；
- generic repository browser、generic subprocess framework或第二角色runtime abstraction。

### 1.3 Fact separation

| Fact | Authority | Not authority |
|---|---|---|
| requested repository/ref/prefix | protected tool input + operation digest | model prose |
| normalized descriptor | PracticeRun journal target | raw request text |
| resolved commit/tree/blob OID | runtime-captured target snapshot | requested ref after admission |
| canonical manifest/diff bytes | CapturedArtifactStore + exact journal/Evidence join | artifact existence/ref alone |
| consume coverage | validated journal + Evidence lifecycle + Store bytes | list output or model statement |
| review conclusion | protected claim | Git metadata/patch |
| completion | `review-v2` checkpoint | successful Git subprocess alone |

`targetId`、OID、snapshot identity、artifact key/ref/digest和model-visible content都不单独授予authority。

---

## 2. Target request and descriptor schemas

### 2.1 `commit`

Model-visible admission DTO exact为：

```json
{
  "kind": "commit",
  "repositoryPath": ".",
  "ref": "refs/heads/develop",
  "pathPrefixes": ["worker"]
}
```

normalized descriptor value exact keys/order-independent schema为：

```json
{
  "repositoryPath": ".",
  "ref": "refs/heads/develop",
  "pathPrefixes": ["worker"]
}
```

`ref`保留normalized request spelling，供ContextPack解释用户要求；它不是post-admission authority。

### 2.2 `git_diff`

Model-visible admission DTO exact为：

```json
{
  "kind": "git_diff",
  "repositoryPath": ".",
  "baseRef": "refs/heads/main",
  "headRef": "refs/heads/develop",
  "pathPrefixes": ["worker"]
}
```

normalized descriptor value exact keys为`repositoryPath/baseRef/headRef/pathPrefixes`。base/head按该顺序解析；语义是`baseCommitOid`到`headCommitOid`的direct two-tree diff，不计算merge base。

### 2.3 Repository path

`repositoryPath`复用typed-target workspace-relative path grammar并允许canonical root `.`：

- UTF-8 bytes最大1KiB；
- `/`为唯一separator；移除普通`.` segment；
- 拒绝absolute、empty component、trailing `/`、NUL、`..`和workspace escape；
- 任一code-owned sensitive segment按`workspace-target-policy-v1`拒绝；
- descriptor只表示repository root，不能指向repository内任意subdirectory后向上discover；
- Gate后physical root必须exact等于Git top level，且`.git`必须是其direct child ordinary directory。

### 2.4 Ref grammar

pre-Gate pure normalizer只接受：

- exact `HEAD`；
- 40或64位lowercase hex full OID candidate；
- `refs/heads/...`或`refs/tags/...` full ref name。

full ref bytes最大1KiB，且必须满足Git check-ref-format等价closed grammar：

- 不含C0/DEL、space、`~ ^ : ? * [ \\`；
- 不含`..`、`@{`、`//`；
- 不以`.`、`/`开始或结束；
- 任一component非空、不以`.`开始、不以`.lock`结束；
- ref整体不以`.`结束；
- 不接受abbreviated OID、`@`、reflog selector、`^`/`~` suffix、`A..B`、`A...B`、`:<path>`、wildcard或option-shaped值。

object format只有在Gate后检查repository时可知；因此40/64位candidate可通过preflight，但长度与repository object format不匹配时稳定返回`GIT_REF_INVALID`。normalizer不做Unicode normalization或case folding。

### 2.5 Literal path prefixes

`pathPrefixes`为non-empty array，最多128项、canonical JSON总bytes最多16KiB。normalizer先执行每项/array grammar与16KiB cap，再构造descriptor并应用typed-target 4KiB per-descriptor与32KiB scope cap；因此current effective single-target selector通常受4KiB descriptor先挡住，统一返回`TARGET_LIMIT_EXCEEDED`且仍发生在Gate前。每项：

- 使用repository-root-relative `/` path，`.`是唯一“全部”spelling；
- 复用component-boundary ancestor语义，不是glob/pathspec expression；
- 拒绝absolute、NUL、C0/DEL、backslash、`..`、empty component、trailing separator，以及leading dash或leading colon（pathspec-magic shape）；
- UTF-8 bytes最多1KiB；
- stable UTF-8 byte sort后不得duplicate或ancestor/descendant overlap；
- 任一sensitive segment在Gate前返回`TARGET_SENSITIVE_PATH_DENIED`。

Git subprocess即使接收prefix，也始终使用`--literal-pathspecs`和`--`。backend仍独立按component boundary过滤parsed paths，不能把Git pathspec parser当作唯一authorization check。

### 2.6 Descriptor and request digests

`descriptor` wrapper、target request digest和scope digest沿用typed-target合同。Git selection digest exact为：

```text
sha256(canonicalJson({
  schemaId: "tiangong.git-selection.v1",
  repositoryPath,
  pathPrefixes
}))
```

同batch exact normalized descriptor duplicate在Gate前返回`SCOPE_TARGET_ALREADY_PRESENT`。同descriptor只有在capture后snapshot identity也与existing target相同才算existing-scope duplicate。

---

## 3. Supported repository layout

### 3.1 Accepted layout

首版只接受Linux Worker workspace内的ordinary non-bare main worktree：

```text
<workspace>/<repositoryPath>/
  .git/                 # direct ordinary directory, not gitfile/symlink
    HEAD
    config
    refs/                # mandatory ordinary directory; may be empty
    packed-refs?         # optional ordinary file
    objects/
      pack/              # mandatory ordinary directory; may contain zero pairs
```

physical validation必须证明：

- trusted workspace root与repository path的每个component均ordinary directory、no symlink、beneath workspace；
- repository root realpath与normalized descriptor一致；
- `.git`是root direct child ordinary directory，realpath仍在workspace；operation持有workspace root/repository/`.git`/objects/refs/pack directory handles并记录`dev/ino/type`，全部source open相对这些pinned handles执行；capture结束final re-resolution必须仍指向same handles；
- `.git/commondir`与`.git/config.worktree`必须不存在，因此`git common dir == git dir == <root>/.git`由布局构造保证，不通过repository discovery猜测；
- config声明non-bare，未设置external `core.worktree`，repository format/object format受支持；
- ref storage是files/packed-refs；`.git/HEAD`无论request使用full OID、HEAD或其它ref都必须stable capture并通过§5.1 grammar，作为ordinary main-worktree layout proof；
- object storage是local `.git/objects`，没有alternate/promisor/lazy-fetch依赖；
- `.git/objects/info/alternates`与`http-alternates`必须不存在，`objects/pack` entry count有界；source `.pack/.idx` pair和按OID读取的loose-object parent/leaf必须ordinary、no symlink，任何`.promisor` marker拒绝；
- 所有实际读取的ref/object/pack/index/config node均no symlink并有界；config/HEAD/loose-ref/packed-refs要求`nlink=1`，hard-linked content-addressed object/pack file可读；source object storage只被stable-copy到ephemeral mirror，Git child不直接打开source object path，actual decompressed object bytes仍必须重算OID。

repository path中嵌套普通repository允许，但必须显式指向该nested root；不向父级或子级自动discover。一次operation的config、ref、pack和loose-object reads都必须来自同一组pinned directory handles；mandatory `refs`/`objects/pack` directories全程持handle。optional `packed-refs`在operation start记录stable present+identity或absent，并在final re-resolution要求same state；新建/删除/替换都视为observed change。final descriptor re-resolution若missing/symlink/different inode/type返回`TARGET_CHANGED_DURING_CAPTURE`。该算法证明各验证点与double reads观察到的稳定性，不宣称检测发生后又恢复为相同identity/bytes的所有ABA变化。

### 3.2 Rejected layout/features

以下任一项返回`GIT_REPOSITORY_UNSUPPORTED`，且不执行target object capture：

- bare repository；
- `.git` file、linked worktree、separate/external git dir或external common dir；
- `core.worktree`、`extensions.worktreeConfig`、reftable或未知required repository extension；
- `.git/objects/info/alternates`、`GIT_ALTERNATE_OBJECT_DIRECTORIES`语义或任何external object directory；
- partial clone/promisor marker/config、missing-object lazy retrieval；
- loose或packed `refs/replace/*` namespace（executor仍额外设置no-replace）；
- object format不是exact `sha1`或`sha256`；
- internal config/ref/object node symlink或unsupported ref/object storage。

以上layout/features使用`GIT_REPOSITORY_UNSUPPORTED`。selected gitlink/submodule、symlink tree entry、special/unknown mode，或selected path不能按fatal UTF-8与§2.5 canonical grammar表示，则使用`TARGET_TYPE_UNSUPPORTED`而不是repository code。`.gitmodules`本身可作为普通selected UTF-8 file评审；mode `160000` gitlink始终拒绝，不打开或递归submodule。shallow repository只要pinned commits及其selected objects完整可用即可用于target capture；本文不提供history/log语义。任何缺失pinned object仍失败，不能fetch补齐。

### 3.3 Original repository config is not execution config

backend只以bounded fixed probes读取原`.git/config`中的repository-format facts；它不得把该config作为Git subprocess config。probe：

- backend先用no-follow handle stable capture original config bytes，node必须ordinary/no-symlink、最大64KiB；capture前后identity/size/mtime/ctime或double-buffer不一致返回`TARGET_CHANGED_DURING_CAPTURE`；
- 使用absolute prlimit-wrapped `/usr/bin/git config --file - --no-includes ...`，并只把已捕获bytes写入child stdin后立即close；不得把original path放入argv，也不得把raw config写入temp/Store/Evidence；
- 每个probe固定加`--null`；multi-value检查使用`--get-all`，name scan使用`--name-only --get-regexp`，parser只接受NUL-terminated UTF-8 fields、无trailing/duplicate/extra bytes；exit 1只在合同指定的“absent”case接受；
- exact probes为：`core.repositoryformatversion`使用`--type=int --get-all`（absent→0，否则exact one canonical `0|1`）、`core.bare`使用`--type=bool --get-all`（absent或exact one canonical `false` only）、`core.worktree`（must be absent）、all `extensions.*` names（only one optional `extensions.objectformat`）、`extensions.objectformat`（format0 must absent；format1 exact one `sha256`），以及name-only scans `^include\.` / `^includeif\.` / `^remote\..*\.promisor$` / `^remote\..*\.partialclonefilter$`（must be absent）；
- `/usr/bin/git`之后的probe argv exact templates为：

```text
config --file - --no-includes --null --type=int --get-all core.repositoryformatversion
config --file - --no-includes --null --type=bool --get-all core.bare
config --file - --no-includes --null --get-all core.worktree
config --file - --no-includes --null --name-only --get-regexp ^extensions\.
config --file - --no-includes --null --get-all extensions.objectformat
config --file - --no-includes --null --name-only --get-regexp ^include\.
config --file - --no-includes --null --name-only --get-regexp ^includeif\.
config --file - --no-includes --null --name-only --get-regexp ^remote\..*\.promisor$
config --file - --no-includes --null --name-only --get-regexp ^remote\..*\.partialclonefilter$
```

- these tokens/order、accepted exit/status framing与per-field 4KiB/total16KiB stdout caps属于`review-local-git-config-probe-v1` golden contract；malformed config、duplicate required key、unknown extension或promisor key返回`GIT_REPOSITORY_UNSUPPORTED`；
- `--no-includes`禁止追随`include`/`includeIf`，synthetic object commands也从不加载original config；raw config、remote URL、credential、include path和unknown values不进入Evidence、artifact、error或model。

后续object commands使用runtime生成的synthetic bare Git directory，因此repository-local alias、pager、hook、credential helper、diff driver、textconv、fsmonitor、remote和include不会进入execution config。

---

## 4. Local Git execution boundary

### 4.1 Closed executable and version

local-git subprocess executable allowlist exact为：

- `/usr/bin/git`：首版`--version` stdout bytes exact为ASCII `git version 2.43.0\n`（含single final LF、无其它bytes）；
- `/usr/bin/prlimit`：fixed resource-limit launcher，version family exact `prlimit from util-linux 2.39.3`；
- `/usr/bin/flock`：version family exact `flock from util-linux 2.39.3`，只由既有kernel-file-lock primitive用于acquire/unlock，不承载Git argv。

Reviewer image build必须验证三个path均root-owned ordinary executable、非symlink，`/usr/lib/git-core`是root-owned ordinary directory、非symlink，fixed versions/commands可用。runtime startup只做no-exec `lstat/fstat` trusted-image checks；不会在无Gate时运行Git/prlimit。每个Gate-allowed backend在source inspection前通过fixed prlimit-wrapped `git --version`核对actual version，missing、wrong type/version/ownership返回`GIT_RUNTIME_UNAVAILABLE`。不得通过`PATH`选择workspace executable，也不得调用`sh -c`、`bash`、command string或user-provided argv。

Every Git launch uses exact prlimit prefix:

```text
/usr/bin/prlimit
  --as=268435456
  --core=0
  --cpu=65
  --fsize=0
  --nofile=64
  --
  /usr/bin/git
```

Node wall-clock/output limits remain authoritative in addition toRLIMIT_AS/CPU/FSIZE/NOFILE。pre-spawn executable/stat或version-action spawn/exit failure返回`GIT_RUNTIME_UNAVAILABLE`；version action通过后，其它child outcome只按§14.2 action table分类，绝不从stderr区分prlimit/Git，也绝不fallback到unlimited Git。

### 4.2 Synthetic bare Git directory

每个new Git execution lifecycle在session-wide local-git kernel lock下创建一个owned ephemeral sandbox；state root只保存lock target，raw Git object mirror不进入AgentTeams-synchronized state：

```text
<state-root>/local-git/<session-hash>/
  lock-target

/tmp/tiangong-local-git/<session-hash>/
  git-op-<invocation-hash>-<nonce>/
    HEAD
    config
    objects/
      pack/              # stable-copied source pack/index pairs only
      <hex>/<rest>       # stable-copied loose object on demand
    refs/
```

- `/tmp/tiangong-local-git`及session/sandbox parent缺失时用exclusive mkdir mode`0700`创建；pre-existing node必须ordinary directory、root-owned、exact mode0700、no symlink，否则fail而非repair/chown；`objects`/`pack`/`refs` mode `0700`，HEAD/config/copied object files mode `0600`；
- HEAD bytes exact为`ref: refs/heads/__tiangong__\n`且该ref永不创建，refs保持empty，仅用于Git repository setup validation；
- no symlink、ordinary fixed nodes、atomic config write、directory fsync；
- name只由validated invocation hash与runtime nonce生成；caller不能提交path；
- SHA-1 config bytes exact为`[core]\n\trepositoryformatversion = 0\n\tbare = true\n`；SHA-256 exact为`[core]\n\trepositoryformatversion = 1\n\tbare = true\n[extensions]\n\tobjectformat = sha256\n`；synthetic HEAD/ref不参与任何target resolution，所有object command只接受runtime-validated full OID；
- backend在启动object command前，通过与workspace target相同的beneath/no-symlink directory handles两次stable enumerate source `objects/pack`；required pair basename exact为`pack-<object-format-width lowercase hex>`且每个basename恰好一个`.pack`与`.idx` ordinary file，0..16 pairs；用fixed-size streaming buffers从no-follow handles两遍读取并比较size/content digest/fstat，再把exact first-pass bytes复制到sandbox，不把整pack载入parent memory；optional same-basename `.rev/.bitmap/.mtimes`与`multi-pack-index`只有ordinary/no-symlink、each<=16MiB且combined<=64MiB时可忽略、不复制；`.keep` each<=4KiB并计入same combined cap；unknown entry、missing pair、duplicate或任何`.promisor`拒绝；
- loose object只按runtime-known full OID定位，用no-follow handle执行same-file double read/fstat与compressed-byte digest compare后复制；Git发现的next tree/blob OID必须先完成该copy或已存在于mirrored pack；
- child `GIT_OBJECT_DIRECTORY`只指向sandbox `objects`；不设置alternate，也不把original object/config/ref path交给object child；Git因此不能跟随source race/symlink或读取mirror外对象；
- 不复制ref、original config、hook、credential、working-tree file或unselected loose blob；pack是bounded opaque object transport，实际selected object仍逐个解压并OID验证；
- operation finally在锁内递归删除exact owned sandbox并fsync tmp parent；不得跟随symlink或删除unknown entry；
- process crash只留下bounded owned temp；runtime startup只做no-exec bounded lstat并标记residue，不调用flock/Git；下一次Gate-allowed local-git operation先取得同一kernel lock，再校验name/type后删除；若无后续Git operation则等待container cleanup或显式operator maintenance；
- temp存在、mirrored pack/object、config path或sandbox ID不授予target/artifact authority；container/host administrator在operation期间可见这些transient bytes，合同不宣称加密；该root不保存recovery facts、不远端同步，transcript reset不扫描它，explicit maintenance只可在无held lock时删除validated residue，不能触及PracticeRun/Evidence/Store。

local-git lock复用 [`captured-artifact-store.md`](./captured-artifact-store.md) 已冻结的kernel-file-lock primitive：parent持ordinary mode0600 lock-target FileHandle；`/usr/bin/flock`以empty env和inherited FD 3完成acquire/unlock后立即退出，lock附着于parent open file description；35秒acquire timeout，不使用mtime stale reclaim，也不存在长期lock-helper。保证覆盖cooperating runtime setup/copy/cleanup；Git child不持有business authority，parent crash后失去stdin/stdout consumer，即使短暂存活也只能读取ephemeral mirror，不能获得source path、Store、journal或Evidence authority。新runtime取得lock后可unlink residue使其失败；container restart是最终process cleanup boundary。lock timeout保持fail closed。lock order固定为：

```text
local-git session lock
→ CapturedArtifactStore session lock
→ PracticeRun journal lock（仅在Git lock释放后）
→ Evidence append lock（仅在tool backend返回后）
```

禁止在Store/journal/Evidence lock已持有时反向获取local-git lock。lock失败返回`GIT_EXECUTION_LOCK_FAILED`。

### 4.3 Exact child environment

child `env`从空object构造，exact allowlist为：

```text
PATH=/usr/bin:/bin
HOME=/nonexistent
XDG_CONFIG_HOME=/nonexistent
LC_ALL=C
LANG=C
TZ=UTC
GIT_CONFIG_NOSYSTEM=1
GIT_CONFIG_SYSTEM=/dev/null
GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_COUNT=0
GIT_OPTIONAL_LOCKS=0
GIT_NO_REPLACE_OBJECTS=1
GIT_LITERAL_PATHSPECS=1
GIT_TERMINAL_PROMPT=0
GIT_PAGER=cat
PAGER=cat
GIT_EDITOR=/bin/false
GIT_SEQUENCE_EDITOR=/bin/false
GIT_ASKPASS=/bin/false
SSH_ASKPASS=/bin/false
GIT_EXEC_PATH=/usr/lib/git-core
GIT_ATTR_NOSYSTEM=1
```

所有child另加`GIT_CEILING_DIRECTORIES=<owned-sandbox>`。version/config-probe action设置`GIT_DIR=<owned-sandbox>/no-repository`，且该path必须不存在；explicit GIT_DIR禁止从sandbox cwd向`/tmp` ancestors做repository discovery。object/diff actions改为exact `GIT_DIR=<owned-sandbox>`和`GIT_OBJECT_DIRECTORY=<owned-sandbox>/objects`。不传入original repository path、provider/storage credential、proxy、cookie、SSH agent、ambient Git config、`GIT_WORK_TREE`、namespace、index或alternate variables。deterministic test在`/tmp/.git`放置sentinel config/alias并证明所有actions仍只使用explicit sandbox/nonexistent GIT_DIR。

### 4.4 Fixed global argv prefix

除只读config probe外，所有object command argv以前缀开始：

```text
/usr/bin/git
  --no-pager
  --no-replace-objects
  --no-optional-locks
  --literal-pathspecs
  -c color.ui=false
  -c core.attributesFile=/dev/null
  -c core.commitGraph=false
  -c core.fsmonitor=false
  -c core.multiPackIndex=false
  -c credential.helper=
  -c diff.external=
  -c diff.renames=false
  -c pager.diff=false
  -c protocol.allow=never
  -c submodule.recurse=false
```

只允许code registry中的`config_probe/object_batch/diff_raw/diff_patch` actions映射到fixed argv template。`object_batch` argv exact为`cat-file --batch-command --buffer`；backend只向stdin写code-generated `contents <full-oid>\n`与`flush\n` commands，不发`info`或其它batch command。Git 2.43 response framing exact为：

```text
success: <same-full-oid> SP <tag|commit|tree|blob> SP <canonical-decimal-size> LF
         <exactly size raw bytes> LF
missing: <same-full-oid> SP missing LF
flush:   no response bytes
```

size为`0`或无leading-zero positive decimal safe integer；每个success raw bytes后的single protocol LF独立于content自身是否以LF结束。parser按request order消费header→declared bytes→protocol LF；missing映射`GIT_OBJECT_UNAVAILABLE`；wrong OID/type token/size、short/extra frame、missing protocol LF、unexpected EOF、stdin close后trailing bytes或nonzero exit按§14.2映射`TARGET_ARTIFACT_INVALID`（timeout/output cap除外）。commit tree由backend解析并OID验证raw tree objects，不依赖porcelain listing。模型输入只能进入已验证的full OID或literal prefix slots；action/flag/order/cwd/env由代码拥有。raw argv、stdin command、absolute repo/object/config/sandbox path不进入Evidence、OTel、status或model result；Evidence只记录`argvSchemaVersion="review-local-git-argv-v1"`及其digest。

### 4.5 Process and output lifecycle

- 使用`execFile("/usr/bin/prlimit", fixedLimits ++ ["--", "/usr/bin/git"] ++ generatedGitArgv)`，`shell=false`、`windowsHide=true`、binary streams；prlimit execs Git in the same child PID，不解析shell；`config_probe` stdin只接收bounded captured config bytes，`object_batch` stdin只接收code-generated full-OID commands，diff actions stdin立即关闭；不得把model prose或source content bytes写入command stdin；
- fixed cwd为owned sandbox root，不是workspace/repository；synthetic bare config与mirrored object database使object commands不读取working tree/index/source `.git`；
- config/raw-diff/patch child hard timeout 5秒；single streaming object-batch child最多60秒，且whole target capture/read deadline始终60秒；
- timeout/abort使用`SIGKILL`；accepted command set不调用pager、hook、credential、remote、external diff/textconv或其它helper，因此被杀Git process就是完整process boundary；
- config/diff stdout由`execFile` buffer cap约束；object-batch stdout按header-declared size流式读取并同时执行per-object/aggregate hard cap，任何short/extra/ambiguous frame立即kill；stderr独立<=16KiB；overflow discard全部partial bytes；
- stderr永不作为artifact/model text，也不进入Evidence/log/status；只映射stable code；
- nonzero exit、signal、timeout和maxBuffer严格按§14.2 phase/cause table归类，不从stderr文字猜测，不把raw OS/Git error透传；
- single operation最多16个Git child processes与8192个object-batch requests；max diff path exact budget为1 version + 9 config probes + 2 object batches + 2 raw diffs + 2 patches；不得通过额外diagnostic child越界。达到任一上限前若canonical completion算法尚未完成，返回`TARGET_LIMIT_EXCEEDED`。

只读plumbing command与`protocol.allow=never`、synthetic config、no promisor/alternate、no replace共同证明该boundary不发起network、不运行hooks/helper、不写workspace。若未来需要会spawn helper的action，必须新合同与process-group sandbox，不能扩展本registry暗中启用。

---

## 5. Ref and object authority

### 5.1 Ref storage grammar and resolution

mandatory original `.git/HEAD` bytes无BOM且exact为以下二选一，single final LF后无trailing bytes：`ref: refs/heads/<valid-full-ref-suffix>\n`或`<object-format-width lowercase full OID>\n`。该grammar无论requested ref为何都验证。requested loose head/tag ref file exact为`<full OID>\n`，不接受symbolic ref、CRLF、comment、space或extra line。

optional `packed-refs`为0 bytes或LF-terminated UTF-8 text。非空时只允许：

- optional first line `# pack-refs with: <tokens> \n`；tokens是canonical order `peeled fully-peeled sorted`的non-duplicate subsequence；无其它comment/blank line；
- entry line `<full OID> SP <valid refs/... full name>\n`；full name使用§2.4 component grammar但scan阶段允许任意`refs/` namespace，随后`refs/replace/*`单独触发layout deny；ref names按raw UTF-8 bytes严格递增且无duplicate；OID width匹配object format；
- optional peeled line `^<full OID>\n`只可紧随一个`refs/tags/...` entry且最多一个；它只做format validation，runtime仍从actual tag object peel；
- malformed ordering、duplicate、unknown header token、invalid full ref、bare CR或trailing partial line返回`GIT_REPOSITORY_UNSUPPORTED`。

Gate后backend以受约束filesystem reader解析exact input ref：

- full OID：不读取ref files；长度必须匹配object format；
- `HEAD`：读取ordinary/no-symlink bounded`.git/HEAD`，只接受detached full OID或指向`refs/heads/...`的single symbolic ref；
- heads/tags：loose ref ordinary file优先，否则读取bounded stable`packed-refs` exact entry；
- non-HEAD symbolic loose ref、ambiguous duplicate、malformed HEAD/loose/packed-ref bytes或unexpected trailing content返回`GIT_REPOSITORY_UNSUPPORTED`；stable double-read/fstat或final ref-storage identity mismatch返回`TARGET_CHANGED_DURING_CAPTURE`；valid requested ref absent返回`GIT_OBJECT_UNAVAILABLE`；
- each ref source使用bounded stable capture；不会调用`rev-parse`解释model string。

layout validation总是以pinned refs handles证明`refs/replace`不存在，并扫描bounded stable packed-refs确认没有`refs/replace/` entry；这与`--no-replace-objects`形成defense in depth，full-OID request也不跳过。resolved object随后在synthetic object boundary中按最多8层annotated tag chain peel；每层读取actual tag bytes、验证object type和computed OID，最终必须是commit。cycle、wrong type、depth overflow或missing object返回`GIT_OBJECT_UNAVAILABLE`。snapshot只保存最终commit OID，不把tag object或requested ref当authority。

同一admission内每个request ref只解析一次；`git_diff`严格base后head。ref在成功capture/journal后移动不改变target。若ref在failed invocation的后续explicit retry前移动，且尚无journal authority/Store conflict，则该retry的成功capture是唯一snapshot；已durable same-key orphan发生bytes conflict时仍fail closed。

### 5.2 Object verification

每个实际读取的commit/tag/tree/blob object都必须：

1. 在Git request前按OID尝试stable-copyexact loose-object path；若source loose object不存在，则允许sandbox Git在已完整mirror的pack/index set中查找，不要求backend另写pack-index parser；source lookup/copy不把path或compressed bytes交给model/Evidence；
2. 由full OID与fixed object command从sandbox mirror读取；
3. stdout在per-type cap内完整返回；
4. backend根据object format重算`hash(concat(Buffer("<type> <decimal-byte-length>\\0", "ascii"), rawBytes))`并exact匹配requested OID；
5. object type、tree entry mode和parsed byte lengths与command metadata一致；
6. missing/truncated/nonzero output不作为partial success。

pinned object在complete mirror中由exact `missing` frame证明不存在时返回`GIT_OBJECT_UNAVAILABLE`；malformed pack/index、object-batch nonzero/frame failure或bytes可读但OID/type/metadata冲突统一返回`TARGET_ARTIFACT_INVALID`；不得从stderr猜测“missing”。禁止replace refs、abbreviation、object name discovery和network retrieval。

commit/tag parser只解释first blank LF之前的header block，不把message decode/return：commit要求exact one `tree <full-oid>`且其OID长度匹配object format；tag要求exact one `object <full-oid>`与`type <type>`，下一object actual type必须一致。header NUL、CRLF、duplicate required field、invalid OID/type或size cap均`TARGET_ARTIFACT_INVALID`。tree parser按Git raw tree grammar逐byte处理：canonical mode ASCII、single SP、non-empty name、NUL、object-format-width raw OID；entry order/duplicate/name containing`/`或NUL不合法。只有validated tree/blob/tag/commit type可继续。

### 5.3 Repository identity

snapshot facts保存：

```text
repositoryIdentity = sha256(canonicalJson({
  schemaId: "tiangong.git-repository.v1",
  repositoryPath,
  gitDirectoryPath,
  objectFormat,
  repositoryFormat,
  refStorage: "files-v1",
  objectStorage: "local-only-v1"
}))
```

`gitDirectoryPath`是workspace-relative direct `.git` path；`.` repository对应`.git`。canonical JSON中的`repositoryFormat`是number（不是string），由supported pair exact派生：SHA-1=`0`，SHA-256=`1`。该digest绑定supported layout contract，不是物理inode capability，也不单独授予read authority。operation中的workspaceScope、target descriptor、journal actor/run/target binding仍必须同时成立。

### 5.4 Canonical completion-plan algorithm

commit member与git_diff `requiredConsumeSegments`使用同一exact pure algorithm：

```text
lines = decodedText.split("\n")              # N >= 1, existing review-text-lines-v1
next = 1
segments = 0
while next <= N:
  requestedEnd = min(N, next + 2000 - 1)
  returnedEnd = largest e in [next, requestedEnd] where
    utf8ByteLength(lines[next-1 .. e-1].join("\n")) <= 50 * 1024
  if no such e: TARGET_LIMIT_EXCEEDED          # applies at every next, not only line 1
  segments += 1
  if segments > 128: TARGET_LIMIT_EXCEEDED
  next = returnedEnd + 1
return segments
```

range indices为inclusive 1-based。empty resource得到`lines=[""]`并产生一个zero-byte segment `[1,1]`。末尾LF产生final empty logical line并参与最后segment；CRLF中的CR属于line bytes。算法固定使用`limit=2000`与maximal complete-line prefix，不计chunk Artifact envelope/JSON bytes。只有循环到`next=N+1`才可admit；因此任何later oversized line同样拒绝。final run required segment sum另受960限制。

---

## 6. `commit` snapshot

### 6.1 Exact facts

```json
{
  "objectFormat": "sha1",
  "repositoryIdentity": "<sha256>",
  "gitPolicyVersion": "review-local-git-v1",
  "gitVersion": "2.43.0",
  "commitOid": "<full oid>",
  "treeOid": "<full oid>",
  "memberCount": 2,
  "totalContentBytes": 1234,
  "requiredConsumeSegments": 2,
  "selectionDigest": "<sha256>",
  "manifestContentDigest": "<sha256>"
}
```

captureVersion保持typed-target已冻结的`review-commit-snapshot-v1`。facts exact-key validation必须独立复算OID长度、selection/repository/artifact digest和counts。

### 6.2 Canonical tree manifest

admission artifact exact schema：

```json
{
  "schemaVersion": 1,
  "kind": "git-tree-manifest",
  "repositoryPath": ".",
  "objectFormat": "sha1",
  "commitOid": "<full oid>",
  "treeOid": "<full oid>",
  "selectionDigest": "<sha256>",
  "members": [
    {
      "path": "worker/agent/runtime.mjs",
      "mode": "100644",
      "blobOid": "<full oid>",
      "contentDigest": "<sha256>",
      "contentBytes": 1234,
      "contentLines": 42,
      "encoding": "utf-8",
      "requiredConsumeSegments": 1
    }
  ]
}
```

manifest使用canonical JSON、无BOM/无trailing LF，members按raw UTF-8 path bytes严格递增。producer contract：

```text
producerId: review-git-commit-capture
producerVersion: 1
purpose: git_tree_manifest
mediaType: application/vnd.tiangong.git-tree-manifest+json;version=1
encoding: utf-8
textPolicyId: canonical-json-v1
transformVersion: 1
truncated: false
maxContentBytes: 4MiB
```

### 6.3 Capture algorithm

在一次Gate-allowed backend execution内：

1. Gate后取得local-git lock，创建尚未包含config的empty owned sandbox，以该sandbox为cwd执行version check；
2. 从pinned workspace/repository directory handles验证layout，stable-capture original config并以stdin probe得到object format；随后写入exact synthetic HEAD/config/objects/refs并stable-copy bounded source pack/index pairs；
3. resolve requested ref得到first full object OID；按OID stable-copy loose object（若存在），再从sandbox peel annotated tags得到full commit OID；
4. 读取并OID验证commit object，解析exact root tree OID；
5. 从root tree开始按prefix intersection递归读取raw tree objects；每个tree都重算OID，并解析`mode SP name NUL raw-oid` binary entries；不进入与selection无ancestor/descendant交集的subtree；
6. backend按component boundary过滤selected paths并按UTF-8 bytes排序；遍历的tree count/raw metadata bytes和selected entry count都受§13限制；
7. 对每个selected entry按canonical order验证path grammar/sensitive policy/mode；只允许`100644`/`100755` blob；
8. 每个blob执行bounded object read、OID验证、binary predicate、fatal UTF-8 decode和typed-target line facts；
9. 对每member模拟canonical maximal-complete-line chunk plan，单resource必须`requiredConsumeSegments<=128`；
10. 形成manifest bytes并复核members/count/bytes/segments/digest，final re-resolve repository/`.git`/objects handles；
11. 将manifest写入Store；receipt content identity进入target snapshot；
12. release Git sandbox/lock；后续service执行final aggregate/context/CAS/journal。

Git tree content-addressed identity与每个object OID recomputation取代filesystem两遍capture；ref只解析一次并立即转为full OID。physical pack/loose storage可在capture中重排，只要fixed object bytes完整可读且OID匹配；missing/partial/corrupt则失败，不无限retry。

空selection返回`TARGET_EMPTY`。selected member任一unsupported/sensitive/binary/invalid UTF-8/oversize使整个target失败，不静默忽略。executable bit只以mode事实呈现，不执行文件。

### 6.4 Post-admission consume

`read({targetId,memberPath,offset,limit})`：

- `memberPath`必须exact存在于validated manifest；path本身不授予authority；
- backend只使用manifest中的pinned blob OID，不重新解析ref/tree；
- source repository仍必须重复admission的exact safe-source checks：pinned workspace containment、direct `.git`、mandatory HEAD/refs/objects/pack、commondir/config.worktree absence、stable config format/probes、replace/promisor/alternate deny、pack pair/ignored-metadata limits与final handle re-resolution；只跳过requested ref resolution和unrelated target enumeration；
- post-admission phase使用不同于admission的source mapping：repository/mandatory node missing、unsafe/malformed layout/config/HEAD/pack/replace/promisor/alternate state或blob exact missing frame统一`GIT_OBJECT_UNAVAILABLE`；current consume内source double-read/fstat/final-handle mismatch返回`TARGET_CHANGED`；stable object bytes/OID/content facts冲突返回`TARGET_ARTIFACT_INVALID`；
- blob bytes必须重算OID并exact匹配manifest content digest/bytes/lines；冲突返回`TARGET_ARTIFACT_INVALID`；
- chunk、Store producer、range/maximal-prefix和Evidence语义复用`review-target-consume/1`；
- durable replay只有在validated successful completion Evidence exact匹配invocation/selector/artifact时才从Store返回原chunk，不访问repository或Git subprocess；Store object单独存在或put receipt replay不等于successful tool replay；
- ref/branch movement、working tree/index变化不参与consume。

---

## 7. `git_diff` snapshot

### 7.1 Exact facts

```json
{
  "objectFormat": "sha1",
  "repositoryIdentity": "<sha256>",
  "gitPolicyVersion": "review-local-git-v1",
  "gitVersion": "2.43.0",
  "baseCommitOid": "<full oid>",
  "headCommitOid": "<full oid>",
  "changedFileCount": 3,
  "diffContentDigest": "<sha256>",
  "diffContentBytes": 9876,
  "diffContentLines": 220,
  "requiredConsumeSegments": 2
}
```

captureVersion保持`review-git-diff-snapshot-v1`。base/head同OID或selected direct diff为空返回`TARGET_EMPTY`。

### 7.2 Raw change preflight

在任何`diff-tree` child前，backend先从mirrored base/head root trees按literal prefix intersection执行OID-verified parallel tree walk，copy所需loose tree objects，推导candidate changed paths/modes/OIDs，并mirror candidate old/new blobs与pinned-head ancestor attribute blobs。只有该closed object set完整且在logical source/tree/attribute limits内，才以fixed command获取NUL-delimited raw changes作为独立Git confirmation：

```text
git <fixed-global-prefix>
  --attr-source=<headCommitOid>
  diff-tree
  --raw -r -z --no-commit-id --no-renames
  --abbrev=<40-for-sha1-or-64-for-sha256>
  <baseCommitOid> <headCommitOid>
  -- <literal pathPrefixes...>
```

parser只接受direct A/D/M/T records，禁止rename/copy/combined/unknown status。old/new mode只能是absent `000000`或regular `100644/100755`；任何`120000` symlink、`160000` gitlink或other type返回`TARGET_TYPE_UNSUPPORTED`。rename在`--no-renames`下按delete+add paths计数，`changedFileCount`是canonical unique changed paths数量。

raw records必须与backend tree-walk candidate set按path/mode/OID exact一致。所有changed paths必须fatal UTF-8、selected、non-sensitive并按UTF-8 bytes可排序；为使patch framing无quoting ambiguity，git_diff changed path另须匹配ASCII-safe grammar：每个component非空且只含`[A-Za-z0-9._@+-]`、不以`-`开头、不等于`.`/`..`，完整path仍以`/`分隔并<=1KiB；不满足返回`TARGET_TYPE_UNSUPPORTED`。每个unique old/new blob执行§5.2 OID验证与text policy。对每个可能作用于changed path的pinned-head root/ancestor `.gitattributes`位置，tree entry必须absent或exact regular mode `100644|100755`；`120000`/`160000`/tree/other mode在启动diff child前返回`TARGET_TYPE_UNSUPPORTED`。present attribute blob必须OID验证、unique合计<=1MiB、通过binary predicate/fatal UTF-8，并计入32MiB logical source limit，第二pass重新验证。任何working-tree/global/info attributes不可达。因此binary/invalid UTF-8不能降级为“Binary files differ”marker。

### 7.3 Canonical patch command

preflight通过后exact patch argv为：

```text
git <fixed-global-prefix>
  --attr-source=<headCommitOid>
  diff-tree
  --no-commit-id
  -r
  -p
  --no-renames
  --no-ext-diff
  --no-textconv
  --no-color
  --full-index
  --unified=3
  --diff-algorithm=myers
  --no-indent-heuristic
  --src-prefix=a/
  --dst-prefix=b/
  <baseCommitOid> <headCommitOid>
  -- <literal pathPrefixes...>
```

`--attr-source`只读取pinned head tree attributes；synthetic config没有repository diff driver/external command。attribute若把selected textual change标为binary，最终patch出现binary marker并返回`TARGET_TYPE_UNSUPPORTED`。patch不得包含Git binary patch、submodule marker、combined diff或truncation marker。

`review-git-patch-framing-v1`利用§7.2 ASCII-safe paths只验证安全correlation，不重实现Git diff算法：每个raw changed path必须按same order对应exact one unquoted column-0 line `diff --git a/<path> b/<path>\n`；下一block以该marker或EOF界定。source content line即使含`diff --git`也带context/add/delete prefix，不能成为block marker。quoted path、path reorder、missing/extra block或forbidden binary/submodule/combined marker返回`TARGET_ARTIFACT_INVALID`/`TARGET_TYPE_UNSUPPORTED`。其它mode/index/hunk bytes由pinned Git 2.43 exact argv产生并作为canonical artifact保存；deterministic golden corpus覆盖add/delete/modify/mode-only/empty/no-final-LF cases。

backend在first tree walk/mirror完成后运行两轮`raw confirmation → object/attribute validation → patch`；第二轮必须得到相同raw change facts、每个blob/attribute OID/content facts和byte-for-byte identical patch。所有Git child只读同一sandbox mirror；source pack/ref/object后续变化不改变该attempt。source mirror double-read/fstat/set mismatch返回`TARGET_CHANGED_DURING_CAPTURE`；同一immutable mirror上的two-pass raw/object/attribute/patch mismatch返回`TARGET_ARTIFACT_INVALID`；command timeout/output/nonzero分别严格按§14.2返回`GIT_EXECUTION_TIMEOUT/TARGET_LIMIT_EXCEEDED/GIT_EXECUTION_FAILED`；不在同一次execution无限retry。

### 7.4 Canonical diff artifact

actual patch stdout就是canonical bytes：

```text
producerId: review-git-diff-capture
producerVersion: 1
purpose: git_diff
mediaType: text/x-diff;charset=utf-8
encoding: utf-8
textPolicyId: review-text-lines-v1
transformVersion: 1
truncated: false
maxContentBytes: 4MiB
```

Store前必须：

- non-empty、<=4MiB；
- binary predicate与fatal UTF-8通过；
- exact `diffContentDigest/Bytes/Lines`计算；
- §5.4 canonical maximal chunk plan覆盖全部logical lines且`requiredConsumeSegments<=128`；
- raw changed paths/count与patch file headers一致；
- second patch bytes exact相同；
- repository/`.git`/objects descriptor final re-resolution仍绑定operation-pinned handles。

Store不接受`truncated=true`作为target admission。stdout overflow、partial patch或Node maxBuffer kill返回`TARGET_LIMIT_EXCEEDED`，不会保存“可探查但不完整”的target artifact。

### 7.5 Consume

`read({targetId,offset,limit})`对`git_diff`禁止`memberPath`。backend从journal-authorized admission artifact读取完整patch，再按existing line/maximal-prefix算法产生chunk artifact与Evidence：

- 不访问source repository、ref或Git subprocess；
- admission diff artifact missing/tampered/cross-target使model loop/checkpoint fail closed，映射`TARGET_ARTIFACT_INVALID`；
- successful chunk replay必须先join matching completed Evidence，再从Store exact返回；Store orphan不能自行升级为coverage/replay authority；
- full coverage只按bound patch content identity与line ranges计算。

---

## 8. Bounded repository inspection

### 8.1 Tool surface

activation新增一个coarse tool，而不是每个Git action一个tool：

```text
inspect_repository
```

首版只materializecommit manifest pagination；不会暴露live Git：

```json
{
  "targetId": "target-...",
  "action": "list_commit",
  "prefix": ".",
  "offset": 0,
  "limit": 200
}
```

exact schema：targetId pattern；action exact；prefix使用§2.5 canonical root/path grammar但只在bound manifest内匹配；offset non-negative safe integer；limit 1..200，表示maximum requested members而非保证count。unknown/extra fields返回`GIT_INSPECTION_INVALID`。

`targetId`必须属于current actor-owned active run且kind=`commit`；其它kind返回`GIT_INSPECTION_UNSUPPORTED`。tool只读journal-authorized manifest Artifact，不解析ref、不启动Git、不读取workspace/object store。

### 8.2 Canonical result artifact

```json
{
  "schemaVersion": 1,
  "kind": "git-commit-list",
  "targetId": "target-...",
  "prefix": ".",
  "offset": 0,
  "returnedCount": 2,
  "totalMatchingMembers": 2,
  "truncated": false,
  "members": [
    {
      "path": "worker/agent/runtime.mjs",
      "mode": "100644",
      "contentBytes": 1234,
      "contentLines": 42
    }
  ]
}
```

producer：`review-git-inspect/1`，purpose=`git_commit_list`，media type=`application/vnd.tiangong.git-commit-list+json;version=1`，canonical JSON，max64KiB，transformVersion1，truncated field只表示pagination尚有成员，Artifact envelope自身`truncated=false`（bytes完整）。backend从offset起按manifest order选择不超过`limit`且使final canonical JSON<=64KiB的最大non-empty member prefix；因此long valid paths只减少returnedCount，不造成producer overflow。单个合法member在schema上保证可装入64KiB。zero matches/offset out of bounds返回`GIT_PREFIX_EMPTY`/`TARGET_RANGE_INVALID`，不产生empty success artifact。

### 8.3 Authority and caps

- list output只帮助model发现manifest memberPath，不产生resource/member/line coverage；
- raw prefix/member list不进入Evidence、OTel、status或journal；Evidence只保存prefix/selector digest、bytes/count/truncated与safe artifact metadata；
- existing directory与new repository inspections共享session-wide review-inspection lifecycle lock；activation clean-cut把state path/module命名从directory-only扩为review inspection；旧lock target不是business state且不迁移，deployment必须先停止旧runtime，禁止old/new processes并行使用不同lock paths；
- successful inspections每target最多64、每run最多128，directory+repository合计；Evidence是durable count authority；new repository inspection在recount时已达target64或run128，返回`GIT_INSPECTION_LIMIT_EXCEEDED`且不读manifest/put Store；directory tool在同一combined boundary继续返回其owned `DIRECTORY_INSPECTION_LIMIT_EXCEEDED`；
- lock order仍为review-inspection lock → Store lock → Evidence append lock，并持有到successful completion Evidence append；
- exact successful invocation replay只有在matching completed Evidence + Store join通过时才可在加锁前返回且不增加count；failed/interrupted invocation不计count，existing same-key Store object仍是orphan，retry必须重新经过Gate/lock/revision/backend validation并append新的successful completion后才获得authority；
- source manifest Artifact tamper在result生成前fail closed。

inspection precedence独立为：actor/profile/active run → matching completed-Evidence replay → exact DTO/prefix/range → Gate → review-inspection lock → revision reload/target authority/kind → combined cap recount → manifest Store join → prefix/offset → byte-fit canonical output → Store put → completion Evidence → unlock。

---

## 9. Gate, operation, atomicity, and replay

### 9.1 Gate ordering

Git target使用typed-target既有code-owned effects：

```json
{
  "localRead": true,
  "workspaceMutation": false,
  "networkEgress": false,
  "modelInference": false,
  "costBearing": false
}
```

pre-Gate只允许actor/profile/active state、exact DTO、pure lexical path/ref/prefix/sensitive/duplicate validation、trusted workspaceScope和Context upper-bound。以下全部在Gate allow后：

- repository existence/layout/config/ref/object inspection；
- local-git lock/sandbox；
-任何Git subprocess；
- manifest/diff/chunk/list Artifact put；
- PracticeRun journal commit。

Gate deny时这些side effects必须为零。`effects`是code-owned facts，不授予权限。

### 9.2 Admission operation binding

`start_work`/`extend_scope` outer operation与policy versions继续使用typed-target v2 exact schema。normalized targetRequests包含完整Git descriptor；operation digest因此绑定actor/profile/workspace/run revision/requested refs/path prefixes。candidate run/target IDs、resolved OIDs、repo facts和artifact bytes是Gate后的result，不进入proposal。

每个Git target snapshot通过`gitPolicyVersion/gitVersion/repositoryIdentity/captureVersion/facts/artifact content identity`绑定实际capture semantics。内部argv schema digest可作为successful completion safe metadata，但不能替代target facts或Store join。

### 9.3 Atomic array and orphan behavior

- request array按声明顺序capture；任一失败时不append `run.started`/`scope.revised`；
- 已put的manifest/diff是Store orphan，计quota但不属于scope/Evidence coverage；
- journal commit前ref movement只影响尚未成功capture的attempt；已materialized candidate snapshot不被刷新；
- final existing-scope duplicate、aggregate quota、Context capacity或CAS失败时candidate artifacts仍是orphans；
- journal commit后state权威；wrapper completion Evidence失败时same invocation从journal replay，不重新解析ref/执行Git；
- successful read/list replay先验证matching completed lifecycle Evidence，再从Artifact bytes返回，不执行Git或重新读source；
- Store put成功但completion Evidence失败/崩溃时object保持orphan。exact retry不得走successful-replay shortcut：它重新Gate并执行backend；commit read必须重新验证pinned source并重构expected chunk，diff read/list可从journal-authorized admission artifact确定性重构；随后Store same-key exact replay receipt可复用bytes，但只有new completion Evidence成功后才返回model/计coverage；
- same artifact key different bytes/metadata保持Store conflict，不能用retry覆盖。

### 9.4 Inspection operation

`inspect_repository` operation exact包含：

```text
policyVersion: review-git-inspect-v1
category: read-only
toolName: inspect_repository
effects: fixed local-read effects
workspaceScope / roleId / profileDigest / practiceId / practiceVersion
state: {runId, expectedRunRevision, targetId}
input: {
  action,
  selectorDigest,
  prefixDigest,
  prefixBytes,
  offset,
  limit,
  inspectionPolicyVersion: "review-git-inspection-v1"
}
```

raw prefix不进入operation/Evidence。digest exact为：

```text
prefixDigest = sha256(canonicalJson({
  schemaId: "tiangong.git-inspection-prefix.v1",
  prefix
}))
selectorDigest = sha256(canonicalJson({
  schemaId: "tiangong.git-inspection-selector.v1",
  targetId,
  action: "list_commit",
  prefix,
  offset,
  limit
}))
```

new execution在review-inspection lock内reload run revision、recountdurable successes、read manifest、byte-fit result、Store put、append completion Evidence；stale revision返回`STALE_RUN_REVISION`且无success artifact authority。

---

## 10. Journal, Store, Evidence, and privacy

### 10.1 Journal

PracticeRun v2 target artifacts使用typed-target exact binding。kind-specific rules：

- `commit`恰好一个`git_tree_manifest` admission binding；
- `git_diff`恰好一个`git_diff` admission binding；
- producer/purpose/media/encoding/ordinal/transform/truncated全部exact；
- store binding session/actor/run/target/invocation/source operation与journal envelope exact join；
- target facts、artifact content identity、snapshot identity、scope digest独立复算；
- journal保存raw opaque artifactRef是protected runtime state；Context/status/report/OTel不得复制。

### 10.2 Evidence

successful lifecycle按现有wrapper记录proposal/Gate/start/completion/replay/failure。Git相关safe fields最多包括：

- tool/category/policy/profile/practice/run revision；
- targetId、target kind、snapshot identity；
- object format enum；
- requested ref/path-prefix digest与bytes/count，不含raw值；
- resolved OID digest，不含raw OID；
- repository identity digest、argv schema version/digest；
- artifact key/ref digest、content digest/bytes/lines/media/producer/transform/truncated；
- returned range、member selector digest、count与stable error code。

Evidence禁止：

- raw repository path/ref/OID/member path/path prefix；
- original config/remote URL/credential/include path；
- argv、cwd、env、sandbox/object/config path；
- commit/tag message、author/email、manifest、patch、chunk/list bytes；
- raw stdout/stderr/OS error、artifactRef或Store object path。

Git subprocess success只证明backend capture的一部分；只有wrapper successful completion与exact journal/Store join构成可选择Machine Evidence。

### 10.3 Store producers

closed producer registry新增exact三项：

| producer | purpose | media | max bytes |
|---|---|---|---:|
| `review-git-commit-capture/1` | `git_tree_manifest` | `application/vnd.tiangong.git-tree-manifest+json;version=1` | 4MiB |
| `review-git-diff-capture/1` | `git_diff` | `text/x-diff;charset=utf-8` | 4MiB |
| `review-git-inspect/1` | `git_commit_list` | `application/vnd.tiangong.git-commit-list+json;version=1` | 64KiB |

producer byte validators解析exact schema、canonical JSON/path/OID order/count/line facts或patch text policy。unknown producer/purpose/media/version、malformed canonical bytes或metadata mismatch在Store层拒绝；practice层按合同映射stable target error。

### 10.4 OTel, status, and report

- OTel继续只输出target count/kind count、tool name、producer/version、media family、bytes bucket、stable outcome/error；不输出path/ref/OID/digest/config/argv/content；
- `workStatus` schema不变，只显示scope revision/target count；
- ContextPack descriptor可以显示normalized requested ref/path prefixes，因为它是actor-bound model context；不得显示artifact ref/content digest/manifest/patch；
- completed machine report使用typed-target allowlisted descriptor、snapshot summary、selected Evidence refs；commit summary可显示full pinned commit/tree OID，git_diff summary可显示full pinned base/head OID，这是Machine State，不进入OTel/Evidence；
- model claim与Machine facts继续分区。

---

## 11. Coverage, nextAction, claim, and checkpoint

### 11.1 Resource order and completeness

coverage projector仍是single practice-owned implementation：

- `commit` resource order：target final scope order，再按manifest UTF-8 byte order的每个member；每member必须由matching target/snapshot/blob/content identity read Evidence完整覆盖`1..contentLines`；
- `git_diff`：target-level single patch resource，必须完整覆盖bound non-truncated artifact的`1..diffContentLines`；
- empty text仍需一次successful zero-byte `[1,1]` read；
- inspection list、Git capture completion、model prose、raw OID或artifact存在都不产生consume coverage；
- per resource最多128 successful consume executions，global selected Evidence refs最多2048；
- target required segments参与final scope `<=960`可完成性检查。

### 11.2 Blockers

incomplete commit target的latest matching terminal consume failure：

- `GIT_OBJECT_UNAVAILABLE` → blocked；
- `TARGET_ARTIFACT_INVALID`（source object bytes/OID conflict）→ blocked；
- timeout/transient `GIT_EXECUTION_FAILED`不伪装为complete，保持unread/partial供explicit retry；
- admission/manifest Store tamper在Context/checkpoint前global fail closed，不降级为blocker guidance。

ContextPack guidance closed set新增`TARGET_ARTIFACT_INVALID`作为`RESOLVE_TARGET_BLOCKER` reason。已完整覆盖的historical target不会因后续repo/ref/object变化撤销；其selected successful Evidence仍需Store chunk join有效。

### 11.3 ContextPack v3

schema version不变。snapshotSummary exact allowlist为：

- commit：`identity,objectFormat,commitOid,treeOid,memberCount,totalContentBytes`；
- git_diff：`identity,objectFormat,baseCommitOid,headCommitOid,changedFileCount,diffContentBytes,diffContentLines`。

不显示repository identity、git version/policy、selection/manifest/diff digest、blob OID、members、artifact metadata或capturedAt。Context capacity在journal commit前按final materialized pack exact检查。

### 11.4 Claim/checkpoint

claim v2与`review-v2`不升schema：

- scope仍是final ordered target IDs；
- commit observation允许manifest memberPath与可选line range；
- git_diff首版只允许target-level observation，不允许memberPath/line range；
- observation位置仍是model claim，不是Machine Evidence；
- `targets-fully-consumed`必须选择上述exact coverage；
- `no-mutation-observed`拒绝任何绑定run的successful workspace mutation；local Git temp/Store/journal state不是workspace mutation；
- limitation仍恰好`STATIC_REVIEW_ONLY`，不得声称测试、执行、remote freshness或Team verification。

---

## 12. Restart, crash, and source changes

### 12.1 Restart order

模型循环前：

1. 验证fixed profile、four-kind registry与seven-tool surface；
2. 验证PracticeRun v2 chain、Git target exact schema/snapshot/scope digest；
3. 重建derived snapshot cache；
4. 对commit manifest/git diff admission artifacts执行Store journal join；
5. 验证Evidence chain与selected consume/inspection artifacts；
6. 生成coverage/nextAction/ContextPack。

restart不得重新解析ref、重新生成manifest/diff或要求source repository仍存在。只有后续incomplete commit member read才需要pinned object source；git_diff consume完全来自Store。

### 12.2 Crash truth table

| Crash point | Authoritative outcome |
|---|---|
| Gate前 | no repo read/subprocess/artifact/state |
| sandbox/config创建中 | no target；owned temp under lock cleanup |
| Git capture中 | no target；parent timeout/abort kills child；parent crash leaves no receiver/authority and next locked cleanup unlinks residue；container restart最终清理process |
| artifact durable、journal前 | orphan counts quota；not scope/coverage |
| multi-target中部分artifact durable | entire array not committed |
| journal commit、wrapper completion前 | journal target authoritative；replay no Git |
| commit target complete后repo/ref/object变化 | historical completion remains；no recapture |
| incomplete commit source missing | read fails `GIT_OBJECT_UNAVAILABLE`；target blocked |
| diff source repo deleted after admission | bound diff remains consumable fromStore |
| Store admission artifact tampered/missing | fail before model；no Git/source rebuild |
| derived cache missing | rebuild from journal/Store；identities unchanged |
| completion commit、delivery前 | done authoritative；no repeated Git/checkpoint |

### 12.3 Retry

- denied/failed execution不产生successful coverage；
- exact failed invocation可按wrapper contractexplicit retry；它重新通过Gate/state/source checks；
- successful invocation replay必须返回journal/Store bytes，不访问Git；
- timeout不自动后台retry；
- interrupted child不会被视为outcome-uncertain workspace mutation，因为accepted action没有workspace side effect；若未来command可写，必须使用独立reconciliation合同。

---

## 13. Limits

实现必须集中export并做adjacent tests：

```text
MAX_GIT_REPOSITORIES_PER_TARGET=1
MAX_GIT_TARGETS_PER_ADMISSION=4
MAX_GIT_TARGETS_PER_RUN=16
MAX_GIT_CONFIG_BYTES=64KiB
MAX_GIT_PACKED_REFS_BYTES=4MiB
MAX_GIT_PACK_PAIRS=16
MAX_GIT_PACK_DIRECTORY_ENTRIES=96
MAX_GIT_PACK_MIRROR_BYTES=64MiB
MAX_GIT_IGNORED_PACK_METADATA_BYTES=64MiB
MAX_GIT_SINGLE_IGNORED_PACK_METADATA_BYTES=16MiB
MAX_GIT_KEEP_BYTES=4KiB
MAX_GIT_LOOSE_MIRROR_BYTES=40MiB
MAX_GIT_SANDBOX_BYTES=128MiB
MAX_GIT_REF_BYTES=1KiB
MAX_GIT_TAG_PEEL_DEPTH=8
MAX_GIT_COMMIT_OBJECT_BYTES=1MiB
MAX_GIT_TAG_OBJECT_BYTES=1MiB
MAX_GIT_SINGLE_TREE_OBJECT_BYTES=2MiB
MAX_GIT_PATH_PREFIXES=128
MAX_GIT_SELECTOR_BYTES=16KiB
MAX_GIT_COMMIT_MEMBERS=256
MAX_GIT_CHANGED_PATHS=256
MAX_GIT_SINGLE_BLOB_BYTES=2MiB
MAX_GIT_COMMIT_CONTENT_BYTES=16MiB
MAX_GIT_DIFF_SOURCE_BYTES=32MiB
MAX_GIT_ATTRIBUTE_BYTES=1MiB
MAX_GIT_TREE_METADATA_BYTES=2MiB
MAX_GIT_TREE_OBJECTS_PER_OPERATION=1024
MAX_GIT_RAW_DIFF_BYTES=2MiB
MAX_GIT_DIFF_BYTES=4MiB
MAX_GIT_MANIFEST_BYTES=4MiB
MAX_GIT_INSPECTION_BYTES=64KiB
MAX_GIT_INSPECTION_RESULTS=200
MAX_GIT_CHILD_STDERR_BYTES=16KiB
MAX_GIT_SHORT_CHILD_SECONDS=5
MAX_GIT_OBJECT_BATCH_SECONDS=60
MAX_GIT_OPERATION_SECONDS=60
MAX_GIT_CHILDREN_PER_OPERATION=16
MAX_GIT_OBJECT_REQUESTS_PER_OPERATION=8192
MAX_GIT_OBJECT_BATCH_RESPONSE_BYTES_PER_PASS=64MiB
MAX_GIT_CHILD_ADDRESS_SPACE_BYTES=256MiB
MAX_GIT_TEMP_RESIDUE=8
MAX_COMMIT_MEMBERS_PER_RUN=960
MAX_REQUIRED_CONSUME_SEGMENTS_PER_RESOURCE=128
MAX_REQUIRED_CONSUME_SEGMENTS_PER_RUN=960
MAX_SUCCESSFUL_INSPECTIONS_PER_TARGET=64
MAX_SUCCESSFUL_INSPECTIONS_PER_RUN=128
```

这里的“operation”在process limits中exact指一个Git target execution lifecycle：一次`commit` capture、一次`git_diff` capture，或一次non-replayed commit-member `read`。outer `start_work/extend_scope`最多含4个Git targets，按request order串行执行；每个target单独取得lock并拥有16-child/8192-request/60s budget，outer tool不共享或并行这些budgets。`inspect_repository`不启动Git，不属于该budget。

同时受generic target、Context、Evidence和CapturedArtifactStore更低quota约束。`MAX_GIT_DIFF_SOURCE_BYTES`按`objectFormat + type + full OID`作为dedupe key，对unique old/new/attribute blob raw bytes求和；同一blob承担多个role只计一次，required second-pass reread不再计。`MAX_GIT_ATTRIBUTE_BYTES`只对其中attribute-role unique subset求和。tree metadata同样按tree OID unique求和。64MiB object response cap分别应用于每个pass并包含frame/tree/commit/tag overhead。

sandbox bytes按sandbox内所有ordinary file `stat.size`实际求和（HEAD/config、copied pack+idx、每个unique loose compressed object各一次）；directory不计bytes，source second read不计sandbox，达到128MiB前必须预检next write。`MAX_GIT_PACK_MIRROR_BYTES`只计copied pack+idx actual bytes；ignored metadata不进入sandbox但受独立64MiB source cap。

final `MAX_RUN_TARGET_CONTENT_BYTES=16MiB` projection exact为：每个file `contentBytes` + 每个directory `totalContentBytes` + 每个commit `totalContentBytes` + 每个git_diff `diffContentBytes`，对final ordered targets求和；32MiB diff source、manifest/diff JSON framing、sandbox mirror和consume/inspection artifacts不进入该projection，它们分别受local process/Store quotas。single/member/mirror/sandbox/child-memory/output超限用`TARGET_LIMIT_EXCEEDED`（non-timeout RLIMIT signal按§14.2为`GIT_EXECUTION_FAILED`）；final scope/Store aggregate超限用`CAPTURE_LIMIT_EXCEEDED`。不得以truncation后标complete规避。

`MAX_COMMIT_MEMBERS_PER_RUN`对final scope所有commit manifests求和；`MAX_REQUIRED...RUN`对file/directory/commit/git_diff全部resources求和。Git diff changed path count不是commit member count，但仍受单target 256限制。

---

## 14. Stable errors and precedence

### 14.1 Errors

除既有typed-target/Store codes，local-git stable codes为：

```text
GIT_REF_INVALID
GIT_RUNTIME_UNAVAILABLE
GIT_REPOSITORY_UNSUPPORTED
GIT_OBJECT_UNAVAILABLE
GIT_EXECUTION_LOCK_FAILED
GIT_EXECUTION_TIMEOUT
GIT_EXECUTION_FAILED
GIT_INSPECTION_INVALID
GIT_INSPECTION_UNSUPPORTED
GIT_INSPECTION_LIMIT_EXCEEDED
GIT_PREFIX_EMPTY
```

既有相关codes：

```text
INVALID_TARGET
TARGET_KIND_NOT_MATERIALIZED
TARGET_SELECTOR_INVALID
TARGET_SENSITIVE_PATH_DENIED
TARGET_OUTSIDE_WORKSPACE
TARGET_SYMLINK_DENIED
TARGET_NOT_FOUND
TARGET_TYPE_UNSUPPORTED
TARGET_EMPTY
TARGET_CHANGED_DURING_CAPTURE
TARGET_ARTIFACT_INVALID
TARGET_RANGE_INVALID
TARGET_EVIDENCE_LIMIT_EXCEEDED
CAPTURE_LIMIT_EXCEEDED
STALE_RUN_REVISION
```

错误只返回stable code与bounded code-owned message；不得包含path/ref/OID/config/argv/stderr/content/digest或raw OS error。

### 14.2 Mapping

- malformed DTO/extra key/unknown kind → `INVALID_TARGET`；closed但未materialize kind → `TARGET_KIND_NOT_MATERIALIZED`；
- malformed ref grammar/object-format length mismatch → `GIT_REF_INVALID`；valid grammar但ref/object absent/not commit → `GIT_OBJECT_UNAVAILABLE`；
- lexical repo/prefix escape → `TARGET_OUTSIDE_WORKSPACE`；selector overlap/control/leading dash/leading colon → `TARGET_SELECTOR_INVALID`；sensitive → `TARGET_SENSITIVE_PATH_DENIED`；
- initial repository path missing → `TARGET_NOT_FOUND`；workspace/repository root或direct `.git` traversal遇到symlink → `TARGET_SYMLINK_DENIED`；exists但internal ref/object node symlink或layout/config/object storage unsupported → `GIT_REPOSITORY_UNSUPPORTED`；
- selected symlink/gitlink/special/binary/invalid UTF-8/path bytes → `TARGET_TYPE_UNSUPPORTED`；
- pinned object later missing/layout no longer safely usable → `GIT_OBJECT_UNAVAILABLE`；object bytes/OID/manifest facts conflict → `TARGET_ARTIFACT_INVALID`；
- child wall timeout → `GIT_EXECUTION_TIMEOUT`；stdout/target/mirror/sandbox/object-request bytes/count overflow → `TARGET_LIMIT_EXCEEDED`；RLIMIT/other sanitized child failure → `GIT_EXECUTION_FAILED`；
- no selected commit members or no selected direct diff → `TARGET_EMPTY`；
- list input schema/kind/prefix empty/range分别→`GIT_INSPECTION_INVALID/GIT_INSPECTION_UNSUPPORTED/GIT_PREFIX_EMPTY/TARGET_RANGE_INVALID`；successful recount已达per-target/run cap→`GIT_INSPECTION_LIMIT_EXCEEDED`；result使用byte-fitting，不把valid requested count造成的64KiB boundary映射为error；
- >8 owned temp residue、tmp/bootstrap unknown entry/symlink/wrong owner/mode无法repair、Git/prlimit/flock executable mismatch → `GIT_RUNTIME_UNAVAILABLE`（lock acquisition本身仍`GIT_EXECUTION_LOCK_FAILED`）；
- Store producer/single bytes failure → `TARGET_LIMIT_EXCEEDED`；Store aggregate quota → `CAPTURE_LIMIT_EXCEEDED`；Store integrity/binding failure → `TARGET_ARTIFACT_INVALID`。

Child/parent execution cause table是normative，优先于generic bullets：

| Phase/action | Exact cause | Code |
|---|---|---|
| any parent phase | whole target lifecycle 60s deadline expires | `GIT_EXECUTION_TIMEOUT` |
| lock | 35s acquire/nonzero/lock helper error | `GIT_EXECUTION_LOCK_FAILED` |
| version | spawn error、signal、nonzero、stdout cap或wrong exact stdout | `GIT_RUNTIME_UNAVAILABLE` |
| config probe (any phase) | expected-absent query exit 1 + empty stdout | accepted absence |
| config probe (admission) | other nonzero/signal/malformed or duplicate frame | `GIT_REPOSITORY_UNSUPPORTED` |
| config probe (post-admission commit read) | other nonzero/signal/malformed or duplicate frame | `GIT_OBJECT_UNAVAILABLE` |
| config probe (any phase) | wall timeout | `GIT_EXECUTION_TIMEOUT` |
| admission config probe | stdin/stdout/stderr cap | `TARGET_LIMIT_EXCEEDED` |
| post-admission config probe | stdin/stdout/stderr cap | `GIT_OBJECT_UNAVAILABLE` |
| object/raw/patch child | stdout/stderr/frame/request cap before timeout/nonzero classification | `TARGET_LIMIT_EXCEEDED` |
| object batch | exact `<oid> missing\n` | `GIT_OBJECT_UNAVAILABLE` |
| object batch | nonzero、wrong/short/extra frame、OID/type/size/protocol mismatch | `TARGET_ARTIFACT_INVALID` |
| object batch | signal not caused by parent timeout | `GIT_EXECUTION_FAILED` |
| raw diff / patch | nonzero or non-timeout signal | `GIT_EXECUTION_FAILED` |
| raw/object/attribute/patch pass | two successful outputs differ on same mirror | `TARGET_ARTIFACT_INVALID` |
| admission source config/ref/pack/loose copy | per-source/mirror size or count cap | `TARGET_LIMIT_EXCEEDED` |
| post-admission commit read source | per-source/mirror size or count cap | `GIT_OBJECT_UNAVAILABLE` |
| admission source config/ref/pack/loose copy | stable double-read/set/fstat/final-handle mismatch | `TARGET_CHANGED_DURING_CAPTURE` |
| admission source HEAD/loose-ref/packed-refs/config or pack filename/pair set | stable but grammar/layout unsupported | `GIT_REPOSITORY_UNSUPPORTED` |
| post-admission commit read source | mandatory repo/node missing or layout/config/HEAD/replace/promisor/alternate/pack state unsafe/malformed | `GIT_OBJECT_UNAVAILABLE` |
| post-admission commit read source | double-read/fstat/final-handle mismatch in current read | `TARGET_CHANGED` |
| post-admission commit read object | stable OID/content facts conflict | `TARGET_ARTIFACT_INVALID` |

Parent checks deadline before/after every filesystem loop、child launch/exit和Store handoff；deadline expiry不继续下一phase。不得根据raw stderr把同一cell改成其它code。

### 14.3 Deterministic precedence

1. actor/profile/active-run binding；
2. exact tool/target DTO与materialized kind；
3. lexical repository/ref/prefix grammar与workspace escape；
4. lexical sensitive policy；
5. same-batch normalized descriptor duplicate；
6. Git target count cap（single admission >4或final run >16 → `TARGET_LIMIT_EXCEEDED`）；
7. Gate；
8. Git/prlimit/flock trusted-image facts、local-git lock、owned residue cleanup、empty sandbox与post-Gate Git version check；
9. repository path existence、pinned directory handles、physical containment、`.git` direct layout；
10. stable config probe与format/ref/object-storage support；
11. finalize synthetic config并stable-copy pack mirror；
12. refs按request/base-head顺序resolve，on-demand loose copy后从mirror peel；
13. commit/tree/change metadata parse与per-target count；
14. selected paths/modes/sensitive/type；
15. blob/attribute bytes/OID/size；
16. binary/UTF-8/line/feasibility；
17. second-pass stability、final source-handle re-resolution与canonical manifest/diff limit；
18. Store producer/binding/put；
19. existing-scope snapshot duplicate；
20. final scope aggregate/Context capacity；
21. run CAS/journal；
22. wrapper completion Evidence。

更早失败不继续寻找后续错误。base在head前；manifest members和changed paths按canonical UTF-8 bytes顺序。specific object/type/limit error优先于generic second-pass change；Store integrity永不降级为source retry。

---

## 15. Security invariants

- no shell、no arbitrary argv、no repository discovery、no ambient PATH/config/env；
- Git subprocess只在Gate allow后，且original repository config永不成为execution config；
- synthetic bare Git不读取working tree/index，不运行hooks/pager/editor/credential/external diff/textconv；
- no alternate/promisor/replace/submodule traversal，`protocol.allow=never`，无proxy/credential env；
- local Git command不会fetch，full OID/ref pin不声明remote freshness；
- repository、ref、tree和blob path均由code-owned resolver与OID verification约束；
- patch/manifest/commit content是不可信review data，不能修改profile/Gate/policy/tool authority或Machine State；
- temp/Store/journal写入runtime state不等于workspace mutation；workspace/.git bytes、refs、index/config/object/hook不得被backend修改；
- raw source/config/stderr不进入Evidence/OTel/status；storage administrator可见Store artifact bytes，合同不声明端到端加密；
- Artifact、OID、digest、target ID和model prose都不能自证scope或completion；
- no successful lifecycle Evidence means no consume/inspection credit；
- any futurelive status/log/blame/remote/working-tree feature需要独立schema/effects/security/smoke review。

---

## 16. Deterministic truth tables

### 16.1 Admission and refs

| Case | Result |
|---|---|
| ordinary local repo + full branch ref → commit | pin full commit/tree OID |
| annotated tag → commit | bounded peel; store final commit only |
| ref moves after journal commit | target OIDs/snapshot unchanged |
| abbreviated OID/revision expression/remote shorthand | `GIT_REF_INVALID` pre-Gate |
| valid full ref absent/non-commit | `GIT_OBJECT_UNAVAILABLE`; no target |
| 40-byte OID in SHA-256 repo | `GIT_REF_INVALID` |
| one Git target fails in target array | no array journal commit; prior artifacts orphan |

### 16.2 Layout/execution

| Case | Result |
|---|---|
| direct `.git` main worktree/local objects | supported |
| linked worktree/gitfile/bare/external git dir | `GIT_REPOSITORY_UNSUPPORTED` |
| alternates/promisor/unknown extension | `GIT_REPOSITORY_UNSUPPORTED`; no network |
| malicious local alias/pager/hook/diff/textconv/credential config | ignored by synthetic config; sentinel not executed |
| workspace `git` executable earlier in PATH | ignored; absolute `/usr/bin/git` only |
| child timeout | killed, no partial artifact, `GIT_EXECUTION_TIMEOUT` |
| stdout overflow | killed/discarded, `TARGET_LIMIT_EXCEEDED` |
| raw stderr contains secret fixture | stable code only; no Evidence/OTel/status leak |

### 16.3 Commit

| Case | Result |
|---|---|
| selected regular UTF-8 blobs | sorted manifest + exact content facts |
| executable regular blob | mode recorded, bytes reviewable, never executed |
| selected symlink/gitlink/binary/invalid path UTF-8 | entire target `TARGET_TYPE_UNSUPPORTED` |
| selected sensitive path through `.` prefix | entire target denied; not silently omitted |
| selected set empty | `TARGET_EMPTY` |
| 256/257 members | adjacent pass / `TARGET_LIMIT_EXCEEDED` |
| ref moves before later member read | pinned blob still used |
| pinned blob disappears | `GIT_OBJECT_UNAVAILABLE`; incomplete target blocked |
| blob bytes no longer hash to OID | `TARGET_ARTIFACT_INVALID`; fail closed |
| list manifest success | exploration only; no member coverage |

### 16.4 Git diff

| Case | Result |
|---|---|
| nonempty direct textual base→head diff | exact non-truncated patch artifact admitted |
| base=head or selected paths unchanged | `TARGET_EMPTY` |
| rename | deterministic delete+add; no rename detection |
| binary/symlink/submodule change | `TARGET_TYPE_UNSUPPORTED` |
| patch >4MiB or any logical line cannot fit the 50KiB single-chunk bound | canonical plan fails with `TARGET_LIMIT_EXCEEDED`; no target |
| attributes force binary marker | `TARGET_TYPE_UNSUPPORTED` |
| base/head refs move after admission | pinned patch unchanged |
| source repository deleted after admission | diff read/replay still succeeds fromStore |
| diff artifact tampered/missing | fail before model/checkpoint; no recapture |
| partial/truncated command output | never admitted/complete |

### 16.5 Coverage/recovery/privacy

| Case | Result |
|---|---|
| all commit members + full diff read | both targets complete |
| manifest list only | commit unread |
| patch partially read | git_diff partial |
| target IDs/OIDs echoed in model prose | no coverage |
| restart with valid journal/Store, no derived cache | same target IDs/OIDs/artifacts/scope |
| journal commit but completion Evidence absent | state replay; no recapture |
| successful read Artifact replay | same bytes; no Git child |
| raw ref/path/patch/stderr scan of Evidence/OTel/status | absent |
| successful mutation Evidence bound run | checkpoint `MUTATION_OBSERVED` |

---

## 17. Verification and smoke contract

### 17.1 Cheapest-first deterministic verification

1. exact target/tool/manifest/list schemas、normalizers、digest golden vectors；
2. ref parser/packed-refs/tag peel/SHA-1/SHA-256 positive-negative-adjacent cases；
3. repository layout, config probe, symlink/alternate/promisor/linked-worktree/submodule denies；
4. fake `execFile` registry证明absolute executable、exact argv/env/cwd、no shell、timeouts/maxBuffer/error sanitization；
5. real disposable repositories证明OID recomputation、tree ordering、text/mode/path rules、canonical patch golden bytes；
6. malicious config/hook/pager/external diff/textconv/credential/remote helper sentinels保持未执行；
7. Store producer schema/binding/quota/tamper/orphan/replay；
8. commit/diff read、inspection no-coverage、coverage/nextAction/claim/checkpoint；
9. journal CAS/crash/restart/ref movement/object removal/derived cache rebuild；
10. profile/image exact four kinds/seven tools/Git version；
11. repository-review Basic，再运行Recovery Full；
12. shared wrapper/Gate/Evidence/Store/idempotency regression。

不得用真实模型证明OID、patch digest、no mutation、coverage或recovery。model no-progress只属于独立Journey observation，不是安全oracle。

### 17.2 Repository-review Basic

run-owned fixture必须是public-test-created local repository，使用fixed author/time/config生成至少两个commits：

- pinned commit target选择两个small UTF-8 files；
- diff target覆盖base→head的modify/add textual patch；
- original repo config包含不会被执行的sentinel hook/pager/external diff/textconv/credential/remote settings；
- independent harness计算commit/tree/blob OID、manifest member digests、canonical patch digest/bytes/lines和pre-run repository byte-state digest。byte-state projection exact为canonical JSON array：按UTF-8 relative path排序递归列出fixture repository内每个directory/ordinary file/symlink的`{path,type,mode}`，ordinary file另含raw byte SHA-256/bytes，symlink另含literal link-target；不含atime/mtime/ctime/inode，fixture不允许其它node；对canonical bytes取SHA-256，post-run按同公式exact compare。

Official Matrix path要求：

```text
start commit + git_diff targets
→ inspect_repository list_commit
→ complete target-bound reads for every commit member
→ complete git_diff read
→ claim exact ordered target IDs
→ review-v2 done/passed/static-only
→ official delivery + Harness
```

Machine oracle必须join journal/Evidence/Store并证明：four-kind/seven-tool profile、two target snapshots、manifest/diff producer bytes、full coverage、no list credit、no mutation/sentinel helper execution、no raw Artifact ref leakage、pre/post repository byte-state digest identical、cleanup passed。zero-network是closed action/argv/env/synthetic-config/mirror contract及deterministic fake-executor tests的结构性结论；smoke sentinel只证明fixture配置的helper未执行，不把“未观察到sentinel”夸大成packet-level network monitor。模型措辞不是oracle。

### 17.3 Recovery Full

```text
commit target A admitted/read
→ append git_diff target B
→ wait exact remote journal + Evidence durability
→ capture pre-restart Harness and Store facts
→ delete only derived PracticeRun cache
→ restart
→ reconstruct same ordered IDs/OIDs/scope/artifacts
```

Recovery oracle使用journal/Store/Evidence与independent fixture facts，不重新解析refs作为expected source。restart后不要求第二个model turn；post-restart model liveness只能是非gating canary。删除或移动source ref后，snapshot仍不变；diff Artifact仍可读。cleanup failure始终red。

### 17.4 Ownership and cleanup

- scenario只创建unique run-owned workspace repository、Matrix request IDs和runtime state；
- 不覆盖existing repo/room/state；
- fixture mutation只由harness setup/explicit ref-movement cell拥有，runtime mutation为失败；
- diagnostics有界脱敏，只保存stable IDs/digests/counts/codes；
- cleanup exact删除run-owned fixture/container/state并证明无sentinel/process/temp残留；
- provider/model override必须预声明，不能为追绿静默切换。

---

## 18. Implementation ownership

| Responsibility | Owner |
|---|---|
| Git DTO/ref/prefix normalizer | review practice target registry |
| workspace/repository physical policy | constrained local-git backend |
| sandbox/argv/env/process runner | review-owned local-git executor |
| commit/diff capture | review target capture backend |
| manifest/diff/list bytes | CapturedArtifactStore closed producers |
| commit/diff target validation | PracticeRun service/store |
| target-bound read | Reviewer read operation |
| repository list inspection/cap | Reviewer inspection operation + shared review-inspection lock |
| coverage/nextAction | review practice projector |
| claim/checkpoint | review practice checkpoint |
| Context/status/report/OTel | existing Reviewer renderers |
| official delivery | unchanged OpenClaw adapter |
| Basic/Recovery oracle | smoke-testing Reviewer scenario owners |

不新增dynamic target plugin、generic command runner、policy DSL或general Git service。第二个真实consumer出现后才能按实际差异提取公共层。

---

## 19. Activation and reader acceptance Gate

实现PR前fresh reader必须能只凭本文回答：

1. requested ref、pinned OID、manifest/diff Artifact、consume Evidence和claim分别是什么事实？
2. 为什么ref movement、working tree/index变化不能改变已提交target？
3. 为什么original `.git/config`不能运行alias/hook/pager/external diff/textconv或触发network？
4. full OID/tag peel、SHA-1/SHA-256与object byte verification如何工作？
5. linked worktree、alternate、partial clone、submodule和unsupported tree mode如何fail closed？
6. commit与git_diff分别如何形成canonical complete Artifact，并怎样拒绝truncation/binary？
7. model如何发现commit members，为什么list不产生coverage？
8. Gate、local-git lock、Store、journal、Evidence的顺序是什么？
9. crash、retry、successful replay、restart与source deletion分别怎样处理？
10. 哪些path/ref/OID/content/config/argv facts可进入Context、Evidence、OTel和status？
11. Basic/Recovery怎样用machine oracle证明no mutation、artifact join和complete consumption？
12. 哪些Git/remote/execution能力仍明确不可达？

任一问题需要依赖prompt、仓库外context、实现猜测或raw logs才能回答，合同不得进入implementation。

---

## 20. Public references

- Git 2.43 command/global options：<https://git-scm.com/docs/git/2.43.0>
- Git 2.43 config scopes and environment：<https://git-scm.com/docs/git-config/2.43.0>
- Git 2.43 tree comparison：<https://git-scm.com/docs/git-diff-tree/2.43.0>
- Git 2.43 object access：<https://git-scm.com/docs/git-cat-file/2.43.0>
- Git 2.43 revision verification caveats：<https://git-scm.com/docs/git-rev-parse/2.43.0>
- Node.js `child_process.execFile`：<https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback>

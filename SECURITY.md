# 安全策略

## 报告漏洞

如果你发现安全漏洞，**请不要在公开 Issue 中报告**。请通过仓库的 [Private vulnerability reporting](https://github.com/cynos-ai/Tiangong/security/advisories/new) 提交；如果该入口尚未启用，请联系：`shenjiecode@gmail.com`。

请尽量包含：问题描述、复现步骤、影响范围和建议修复。

## 支持的版本

Tiangong 尚无发布版本，因此当前没有受支持的稳定版本。我们仍接受针对当前公开开发状态的安全报告；首个版本发布后将在此列出明确的支持范围。

## 本地部署安全默认值

本地 AgentTeams 栈强制仅绑定 `127.0.0.1`，密钥文件权限为 `600`。但嵌入式 Controller 挂载容器运行时 Socket，因此该栈不是主机安全边界，不应在敏感工作站或共享生产主机上运行不可信任务。详见 [`README.md`](./README.md) 的“Local security model”。

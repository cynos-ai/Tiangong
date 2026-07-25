# Developer Certificate of Origin（DCO）

Tiangong 要求每个提交包含 DCO 签名，确认贡献者有权以本项目许可证（Apache-2.0）提交该代码。

## 如何签名

提交时加 `-s`：

```bash
git commit -s
```

效果是在提交信息末尾追加：

```
Signed-off-by: 你的名字 <你的邮箱>
```

开发者需确保 `user.name` 与 `user.email` 已正确配置（`git config --global user.name / user.email`）。Pull Request CI 会要求每个新增 commit 的 `Signed-off-by` 与该 commit 的作者姓名和邮箱一致。

## DCO 全文

见 <https://developercertificate.org/>。签名即表示你同意该证书的条款。

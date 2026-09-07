# 自动部署（GitHub 连接后）

本服务已连接 GitHub 仓库 `yu3461018595/mes-light`，并启用 **Auto Deploy**：

- 每次 `git push` 到 `main` 分支 → Railway 自动拉取最新提交并**重新构建部署**。
- 也支持通过 GitHub Contents API 提交（本机到 github.com 的 git 协议不稳时可用 API 替代）。

## 重要：Redeploy ≠ 重新构建

Railway 控制台里：

- **Redeploy**（某个已有部署右侧的按钮）：只是**用旧的构建产物重启一次**，不会重新拉代码。
  如果代码已更新但线上还是旧行为，点 Redeploy 无效。
- **Deploy latest commit / New Deployment**：从 `main` 最新提交拉取并**全新构建**，
  这才是让新代码上线的正确方式。Auto Deploy 开启后，push 新 commit 等价于触发此动作。

## 如何触发一次全新构建

- 方式一（推荐，已启用）：push 任意新 commit 到 main，Auto Deploy 自动构建。
- 方式二：控制台 → Deployments → 点 "Deploy latest commit"。

## 部署后验证（报工页已完工口径）

修复「报工页/员工在制页 已完工数量误用 SUM」后，口径应为 MIN（瓶颈工序）：

- 多工序、进度不均的工单（如某工序合格数仍为 0），报工页「已完工」应显示 0，
  而非各工序合格数之和（SUM）。
- 可用管理员账号登录后生成工单二维码，打开报工页核对 `qty_done`。

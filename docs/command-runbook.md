# 命令执行位置说明（本机 / GitHub / 服务器）

## 1) 在你当前电脑执行（本机）
用于查看分支和推送到 GitHub。

> Windows 请使用真实磁盘路径（例如 `C:\othello\marketing`），不要使用 Linux 容器路径 `/workspace/marketing`。

```bash
# 进入本机项目目录（示例）
cd C:\othello\marketing

git remote -v
git branch --show-current
git fetch origin --prune
git branch -r
```

## 2) GitHub 是代码仓库
`git push` 的目标是 GitHub，不是业务服务器。

## 3) 在业务服务器执行
服务器要更新代码，需要登录服务器后在项目目录执行：

```bash
git pull origin main
npm install
npm run dev
```

## 4) 常见问题：`fatal: couldn't find remote ref work`
如果执行 `git pull origin work` 报错，通常说明远端没有 `work` 分支。

先检查远端分支：

```bash
git fetch origin --prune
git branch -r
```

若只看到 `origin/main`，请使用：

```bash
git pull origin main
```

如果你确实要使用 `work` 分支，需要先在本地创建并推送：

```bash
git checkout -b work
git push -u origin work
```

## 5) 常见问题：`git pull origin main` 显示 `Already up to date`
这表示**GitHub 的 `main` 分支没有新的提交**，不是服务器故障。

你需要先确认“新代码是否已经推到 GitHub 的 `main`”：

```bash
git fetch origin --prune
git log --oneline --decorate --graph -n 8
git log --oneline origin/main -n 8
```

### 场景 A：你的新提交在本地，但不在 `origin/main`
先把提交推上去：

```bash
git push origin main
```

推送成功后，再到服务器执行：

```bash
git pull origin main
```

### 场景 B：你的新提交在本地 `work` 分支
如果远端没有 `work`，先创建并推送：

```bash
git checkout work
git push -u origin work
```

然后通过 PR 合并 `work -> main`（推荐），或者明确需要时直接：

```bash
git checkout main
git merge work
git push origin main
```

最后服务器再拉取：

```bash
git pull origin main
```

## 6) 常见问题：GitHub 页面看起来“没有更新”
按下面顺序检查，避免只看错分支或看错提交：

```bash
# 1) 本地最新提交
git log --oneline -n 3

# 2) 远端 main 的最新提交
git fetch origin --prune
git log --oneline origin/main -n 3

# 3) 对比本地分支与远端 main 是否一致
git rev-parse --short HEAD
git rev-parse --short origin/main
```

如果两个 commit id 不同，说明你的最新提交还没到 GitHub main：

```bash
# 当前就在 main 分支时
git push origin main
```

如果你在 `work` 分支开发：

```bash
git push -u origin work
# 然后在 GitHub 发起 PR: work -> main
```

> GitHub 网页默认常停留在 `main`。如果你刚推的是 `work`，页面切换到 `work` 才能看到更新。

## 7) 你现在这条日志的结论（`Everything up-to-date`）
当你看到：

```bash
git branch --show-current
# main

git log --oneline -n 3
# f45f885 (HEAD -> main, origin/main, origin/HEAD) update project

git push origin main
# Everything up-to-date
```

含义是：你的本机 `main` 和 GitHub `main` 完全一致，当前**没有可推送的新提交**。

### 下一步应该在哪输入命令
就在你现在这个 PowerShell 路径输入：

```bash
PS C:\othello\marketing>
```

不是在 Codex 网页的“连接器”页面输入。

### 一键检查是否真的有新提交（可直接复制）
```bash
git fetch origin --prune
git status
git branch --show-current
git log --oneline -n 5
git log --oneline origin/main -n 5
git rev-parse --short HEAD
git rev-parse --short origin/main
```

如果最后两个 commit id 一样，就说明 GitHub 没有新版本可拉。

## 8) 常见报错：`pathspec 'work' did not match` / `src refspec work does not match any`
你这两个报错通常同时出现，原因是：本地根本没有 `work` 分支（也没有任何提交指向它）。

### 处理方式（两选一）

#### 方案 A：只用 `main`（最简单）
如果你不打算用 `work`，就一直在 `main` 开发并推送：

```bash
git checkout main
git add .
git commit -m "your change"
git push origin main
```

#### 方案 B：要使用 `work`
先从 `main` 创建 `work`，再提交并推送：

```bash
git checkout main
git checkout -b work
git add .
git commit -m "your change"
git push -u origin work
```

> 注意：如果没有新提交，`git push -u origin work` 也可能提示没有可推送内容。

## 9) 常见报错：`M package-lock.json`
`npm install` 后出现 `M package-lock.json`，表示锁文件被修改但还未提交。

如果你不想带上这次修改：

```bash
git restore package-lock.json
```

如果你确认需要保留依赖变更：

```bash
git add package-lock.json
git commit -m "chore: update lockfile"
git push origin <current-branch>
```

## 10) 一键推送到 GitHub（Windows PowerShell）
如果你只想执行“更新到 GitHub”并减少手动排错，可在项目目录运行：

```powershell
cd C:\othello\marketing
powershell -ExecutionPolicy Bypass -File .\scripts\update-github.ps1 -Branch main
```

脚本会自动检查：
- 当前目录是否是 Git 仓库
- 工作区是否有未提交改动
- 本地分支是否存在
- 然后执行 `git push -u origin <branch>`

如果你使用 `work` 分支：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\update-github.ps1 -Branch work
```

## 11) 数据库一键初始化（方便测试）
如果你只想尽快把数据库准备好并开始测试：

```powershell
cd C:\othello\marketing
copy .env.example .env
npm run db:init
npm run dev
```

说明：
- `npm run db:init` 会自动：
  - 连接 MySQL
  - 创建 `DB_NAME` 对应数据库（不存在则创建）
  - 执行 `db/schema.sql` 建表与初始数据
- 默认读取 `.env`，未配置时使用默认值（`127.0.0.1:3306`, `root`, `marketing`）。
- 若报连接失败，请先确认 MySQL 服务已启动并且账号密码正确。

## 12) 圆通 API 配置与退单重试
### 配置入口
- 页面：`/portal/settings/yuantong`
- 权限：Admin / Supervisor 可访问与修改

### 配置步骤
1. 填写 `base_url`、`app_key`、`app_secret`、`customer_code`
2. 勾选“启用圆通推送”并保存
3. 点击“测试连通性”验证可用性

### 退单推送与重试
- 在订单详情页点击“标记退件并推圆通”会：
  - 将订单状态设为 `Returned`
  - 调用圆通推送接口
  - 在 `courier_api_logs` 写请求/响应日志
  - 在 `shipment_events` 写成功/失败事件
- 若失败，可点击“重试退单推送”触发 `/portal/returns/:id/retry-yto`。

### 排查命令
```sql
SELECT id, courier_code, biz_type, biz_id, success, http_status, error_message, created_at
FROM courier_api_logs
ORDER BY id DESC
LIMIT 50;
```

## 13) 新版功能清单（角色/线索/批次/圆通）
- 用户：`/portal/users`、`/portal/users/new`、`/portal/users/:id/edit`
- 线索：`/portal/leads`、`/portal/leads/new`、`/portal/leads/:id/edit`、`/portal/leads/:id`、`/portal/leads/recommendations`、`/portal/leads/import`
- 模板下载：`/portal/leads/template`
- 批次：`/portal/campaigns`、`/portal/campaigns/new`、`/portal/campaigns/:batchId`
- 圆通：`/portal/settings/yuantong`（supervisor 只读，admin 可编辑）
- 提醒：`/portal/reminders`
- 日志：`/portal/logs`

## 14) 角色与权限
- `admin`：全权限（系统设置/员工/导入导出/密钥编辑）
- `supervisor`：管理权限（可看团队与统计；圆通设置只读）
- `employee`：仅本人线索执行权限（线索操作/创建批次）

调试角色方式：
- `?as=admin`
- `?as=supervisor`
- `?as=employee`

## 15) 启动报错 `does not provide an export named 'portalRoutes'` 排查
如果出现该报错，先检查是否有旧产物/错误文件被命中：

```bash
npm run diag:routes
```

然后清理构建产物并按统一方式启动：

```bash
npm run clean
npm run dev
```

生产打包方式：

```bash
npm run build
npm run start:dist
```

说明：
- 默认启动统一使用 `node server.js`（`npm run dev` / `npm run start`），避免 `dist` 与源码不一致引发导入冲突。
- 路由导入已固定为 `.ts` 路径，降低误命中旧 `.js` 文件的概率。

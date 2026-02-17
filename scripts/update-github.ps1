param(
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

Write-Host "[1/6] 检查 Git 可用性..."
git --version | Out-Null

Write-Host "[2/6] 检查当前目录是否为 Git 仓库..."
$insideRepo = git rev-parse --is-inside-work-tree 2>$null
if ($insideRepo -ne "true") {
  throw "当前目录不是 Git 仓库。请先 cd 到项目目录（例如 C:\othello\marketing）。"
}

Write-Host "[3/6] 更新远端引用..."
git fetch origin --prune

Write-Host "[4/6] 检查工作区状态..."
$dirty = git status --porcelain
if ($dirty) {
  Write-Warning "检测到未提交改动。请先 git add / git commit 后再推送。"
  git status -sb
  exit 1
}

Write-Host "[5/6] 检查本地分支是否存在：$Branch"
$localBranch = git show-ref --verify --quiet "refs/heads/$Branch"; $exists = $LASTEXITCODE -eq 0
if (-not $exists) {
  throw "本地分支 '$Branch' 不存在。请先创建分支或改用 -Branch main。"
}

Write-Host "[6/6] 推送到 GitHub..."
git push -u origin $Branch

Write-Host "完成：已执行 git push -u origin $Branch"

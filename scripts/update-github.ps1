param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("main","work")]
    [string]$Branch
)

Write-Host "=== One-Click GitHub Push Helper ===" -ForegroundColor Cyan

# 1. Check Git installed
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "Git is not installed."
    exit 1
}

# 2. Ensure inside Git repo
if (-not (Test-Path ".git")) {
    Write-Error "Current directory is not a Git repository."
    exit 1
}

# 3. Fetch latest from origin
git fetch origin --prune

# 4. Ensure working tree is clean
$dirty = git status --porcelain
if ($dirty) {
    Write-Error "Working tree is not clean. Please commit or stash changes first."
    git status
    exit 1
}

# 5. Check branch exists locally
$exists = git branch --list $Branch
if (-not $exists) {
    Write-Error "Local branch '$Branch' does not exist."
    exit 1
}

# 6. Checkout branch
git checkout $Branch

# 7. Push
git push -u origin $Branch

Write-Host "Push completed successfully." -ForegroundColor Green

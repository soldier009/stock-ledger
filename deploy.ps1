# Stock Ledger - one-click deploy to GitHub Pages
# Usage: .\deploy.ps1
# Optional: set $env:GITHUB_TOKEN to a PAT (repo scope) to avoid interactive auth.
#   PowerShell:  $env:GITHUB_TOKEN = "ghp_xxx"; .\deploy.ps1

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

$OWNER   = "soldier009"
$REPO    = "stock-ledger"
$REMOTE  = "https://github.com/$OWNER/$REPO.git"

# 1. Build
Write-Host "==> Building production bundle..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { Write-Error "Build failed"; exit 1 }

# 2. Push dist to gh-pages branch
$pushUrl = $REMOTE
if ($env:GITHUB_TOKEN) {
    $pushUrl = "https://$OWNER`:$($env:GITHUB_TOKEN)@github.com/$OWNER/$REPO.git"
}

$distDir = Join-Path $PWD "dist"
Push-Location $distDir
try {
    git init -b gh-pages 2>&1 | Out-Null
    git add -A
    git -c user.name="$OWNER" -c user.email="$OWNER@users.noreply.github.com" commit -m "deploy: $(Get-Date -Format 'yyyy-MM-dd HH:mm')" 2>&1 | Out-Null
    Write-Host "==> Pushing to gh-pages..." -ForegroundColor Cyan
    git push -f $pushUrl HEAD:gh-pages
    if ($LASTEXITCODE -ne 0) { Write-Error "Push failed"; exit 1 }
} finally {
    Pop-Location
    Remove-Item -Recurse -Force (Join-Path $distDir ".git") -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "==> Deployed: https://$OWNER.github.io/$REPO/" -ForegroundColor Green
Write-Host "    (GitHub Pages takes ~1 min to refresh)"

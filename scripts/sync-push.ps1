[CmdletBinding()]
param(
    [string]$CommitMessage = ""
)

$ErrorActionPreference = "Stop"

# Ensure we are in the repo root
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "PlanktonOTC Multi-Repo Dual-Identity Sync" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 1. Identity definitions
$NAD7_NAME  = "NAD7"
$NAD7_EMAIL = "notadeveloper7@outlook.com"
$NAD7_REMOTE = "nad7"
$NAD7_URL   = "https://github.com/NotADeveloper7/PlanktonOTC.git"

$PLANKTON_NAME  = "PlanktonOTC"
$PLANKTON_EMAIL = "subpenny@atomicmail.io"
$PLANKTON_REMOTE = "planktonotc"
$PLANKTON_URL   = "https://github.com/PlanktonOTC/plankton.git"

# Ensure repo-local config is set
git config --local user.name $NAD7_NAME
git config --local user.email $NAD7_EMAIL
git config --local credential.useHttpPath true

# Ensure remotes exist
$remotes = git remote
if ($remotes -notcontains $NAD7_REMOTE) {
    git remote add $NAD7_REMOTE $NAD7_URL
}
if ($remotes -notcontains $PLANKTON_REMOTE) {
    git remote add $PLANKTON_REMOTE $PLANKTON_URL
}

# 2. Check current branch
$currentBranch = (git branch --show-current).Trim()
if ($currentBranch -ne "main") {
    Write-Warning "Current branch is '$currentBranch', expected 'main'."
    if (-not $currentBranch) {
        git checkout -B main
        $currentBranch = "main"
    }
}

# 3. Commit uncommitted changes if any
$status = git status --porcelain
if ($status) {
    if (-not $CommitMessage) {
        $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
        $CommitMessage = "Update plankton project: $timestamp"
    }
    Write-Host "Staging and committing changes with NAD7 identity..." -ForegroundColor Yellow
    git add -A
    $env:GIT_AUTHOR_NAME = $NAD7_NAME
    $env:GIT_AUTHOR_EMAIL = $NAD7_EMAIL
    $env:GIT_COMMITTER_NAME = $NAD7_NAME
    $env:GIT_COMMITTER_EMAIL = $NAD7_EMAIL
    git commit -m $CommitMessage
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to commit changes."
    }
} else {
    Write-Host "Working tree clean, no new uncommitted changes." -ForegroundColor Green
}

# 4. Get commits on main
$mainCommits = @(git rev-list --reverse main)
if (-not $mainCommits -or $mainCommits.Count -eq 0) {
    throw "No commits found on branch 'main' to push."
}
Write-Host "Total commits on 'main': $($mainCommits.Count)" -ForegroundColor Cyan

# 5. Mirror/Replicate to planktonotc-main with PlanktonOTC identity
Write-Host "Syncing branch 'planktonotc-main' with PlanktonOTC identity..." -ForegroundColor Yellow

$planktonCommits = @()
$planktonHead = git rev-parse --verify --quiet refs/heads/planktonotc-main
if ($planktonHead) {
    $planktonCommits = @(git rev-list --reverse refs/heads/planktonotc-main)
}

# Check matching prefix
$matchCount = 0
$minCount = [Math]::Min($mainCommits.Count, $planktonCommits.Count)
for ($i = 0; $i -lt $minCount; $i++) {
    $mainTree = (git rev-parse "$($mainCommits[$i])^{tree}").Trim()
    $planktonTree = (git rev-parse "$($planktonCommits[$i])^{tree}").Trim()
    if ($mainTree -eq $planktonTree) {
        $matchCount++
    } else {
        break
    }
}

$forcePlanktonPush = $false
if ($matchCount -lt $planktonCommits.Count) {
    Write-Host "Detected history divergence between main and planktonotc-main. Rebuilding mirror branch..." -ForegroundColor Magenta
    $matchCount = 0
    $parent = $null
    $forcePlanktonPush = $true
} else {
    $parent = if ($matchCount -gt 0) { $planktonCommits[$matchCount - 1] } else { $null }
}

for ($i = $matchCount; $i -lt $mainCommits.Count; $i++) {
    $c = $mainCommits[$i]
    $tree = (git rev-parse "$c^{tree}").Trim()
    $rawMsg = git log -1 --format=%B $c
    
    # Strip any extraneous co-author tags to guarantee strictly PlanktonOTC identity
    $cleanLines = @()
    foreach ($line in ($rawMsg -split "`r?`n")) {
        if ($line -notmatch '^\s*co-authored-by:\s*' -and $line -notmatch '^\s*signed-off-by:\s*') {
            $cleanLines += $line
        }
    }
    $cleanMsg = ($cleanLines -join "`n").Trim()
    if (-not $cleanMsg) { $cleanMsg = "Commit $c" }

    $authorDate = (git log -1 --format=%aI $c).Trim()
    $committerDate = (git log -1 --format=%cI $c).Trim()

    $env:GIT_AUTHOR_NAME = $PLANKTON_NAME
    $env:GIT_AUTHOR_EMAIL = $PLANKTON_EMAIL
    $env:GIT_AUTHOR_DATE = $authorDate
    $env:GIT_COMMITTER_NAME = $PLANKTON_NAME
    $env:GIT_COMMITTER_EMAIL = $PLANKTON_EMAIL
    $env:GIT_COMMITTER_DATE = $committerDate

    if ($parent) {
        $newP = ($cleanMsg | git commit-tree $tree -p $parent).Trim()
    } else {
        $newP = ($cleanMsg | git commit-tree $tree).Trim()
    }
    $parent = $newP
}

# Reset environment variables
Remove-Item env:GIT_AUTHOR_NAME -ErrorAction SilentlyContinue
Remove-Item env:GIT_AUTHOR_EMAIL -ErrorAction SilentlyContinue
Remove-Item env:GIT_AUTHOR_DATE -ErrorAction SilentlyContinue
Remove-Item env:GIT_COMMITTER_NAME -ErrorAction SilentlyContinue
Remove-Item env:GIT_COMMITTER_EMAIL -ErrorAction SilentlyContinue
Remove-Item env:GIT_COMMITTER_DATE -ErrorAction SilentlyContinue

if ($parent) {
    git update-ref refs/heads/planktonotc-main $parent
}

# 6. Push to both remotes
Write-Host "Pushing main to $NAD7_REMOTE ($NAD7_URL)..." -ForegroundColor Cyan
git push $NAD7_REMOTE main:main
if ($LASTEXITCODE -ne 0) {
    throw "Failed to push to $NAD7_REMOTE."
}

Write-Host "Pushing planktonotc-main to $PLANKTON_REMOTE ($PLANKTON_URL)..." -ForegroundColor Cyan
if ($forcePlanktonPush) {
    git push --force $PLANKTON_REMOTE planktonotc-main:main
} else {
    git push $PLANKTON_REMOTE planktonotc-main:main
}
if ($LASTEXITCODE -ne 0) {
    throw "Failed to push to $PLANKTON_REMOTE."
}

# 7. Fetch and verify
Write-Host "Fetching remotes for verification..." -ForegroundColor Gray
git fetch $NAD7_REMOTE main --quiet
git fetch $PLANKTON_REMOTE main --quiet

$nad7LatestAuthor = (git log -1 --format='%an <%ae> | %cn <%ce>' "$NAD7_REMOTE/main").Trim()
$planktonLatestAuthor = (git log -1 --format='%an <%ae> | %cn <%ce>' "$PLANKTON_REMOTE/main").Trim()
$nad7RemoteUrl = (git remote get-url $NAD7_REMOTE).Trim()
$planktonRemoteUrl = (git remote get-url $PLANKTON_REMOTE).Trim()

Write-Host "`n================ PUSH VERIFICATION ================" -ForegroundColor Green
Write-Host "Remote 1: $NAD7_REMOTE" -ForegroundColor White
Write-Host "  URL: $nad7RemoteUrl" -ForegroundColor Gray
Write-Host "  Latest Commit Author: $nad7LatestAuthor" -ForegroundColor Green

Write-Host "Remote 2: $PLANKTON_REMOTE" -ForegroundColor White
Write-Host "  URL: $planktonRemoteUrl" -ForegroundColor Gray
Write-Host "  Latest Commit Author: $planktonLatestAuthor" -ForegroundColor Green
Write-Host "====================================================`n" -ForegroundColor Green

# 8. Full history identity audit
$nad7Audit = @(git log --format='%an <%ae> | %cn <%ce>' "$NAD7_REMOTE/main" | Select-Object -Unique)
$planktonAudit = @(git log --format='%an <%ae> | %cn <%ce>' "$PLANKTON_REMOTE/main" | Select-Object -Unique)

$nad7Expected = "$NAD7_NAME <$NAD7_EMAIL> | $NAD7_NAME <$NAD7_EMAIL>"
$planktonExpected = "$PLANKTON_NAME <$PLANKTON_EMAIL> | $PLANKTON_NAME <$PLANKTON_EMAIL>"

$nad7Bad = $nad7Audit | Where-Object { $_ -ne $nad7Expected }
$planktonBad = $planktonAudit | Where-Object { $_ -ne $planktonExpected }

if ($nad7Bad) {
    Write-Error "Identity audit failed on $NAD7_REMOTE/main! Unexpected identities: $($nad7Bad -join ', ')"
}
if ($planktonBad) {
    Write-Error "Identity audit failed on $PLANKTON_REMOTE/main! Unexpected identities: $($planktonBad -join ', ')"
}
if (-not $nad7Bad -and -not $planktonBad) {
    Write-Host "History audit passed: 100% strictly isolated identities across all commits." -ForegroundColor Green
}

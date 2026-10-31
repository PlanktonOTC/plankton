#!/usr/bin/env bash
set -e

# Repository Root
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "=========================================="
echo "PlanktonOTC Multi-Repo Dual-Identity Sync"
echo "=========================================="

NAD7_NAME="NAD7"
NAD7_EMAIL="notadeveloper7@outlook.com"
NAD7_REMOTE="nad7"
NAD7_URL="https://github.com/NotADeveloper7/PlanktonOTC.git"

PLANKTON_NAME="PlanktonOTC"
PLANKTON_EMAIL="subpenny@atomicmail.io"
PLANKTON_REMOTE="planktonotc"
PLANKTON_URL="https://github.com/PlanktonOTC/plankton.git"

# Ensure repo-local config is set
git config --local user.name "$NAD7_NAME"
git config --local user.email "$NAD7_EMAIL"
git config --local credential.useHttpPath true

# Ensure remotes exist
if ! git remote | grep -q "^${NAD7_REMOTE}$"; then
    git remote add "$NAD7_REMOTE" "$NAD7_URL"
fi
if ! git remote | grep -q "^${PLANKTON_REMOTE}$"; then
    git remote add "$PLANKTON_REMOTE" "$PLANKTON_URL"
fi

# Check current branch
CURRENT_BRANCH="$(git branch --show-current || true)"
if [ "$CURRENT_BRANCH" != "main" ]; then
    echo "Current branch is '$CURRENT_BRANCH', switching to main..."
    git checkout -B main
fi

# Commit uncommitted changes if any
if [ -n "$(git status --porcelain)" ]; then
    COMMIT_MSG="$1"
    if [ -z "$COMMIT_MSG" ]; then
        COMMIT_MSG="Update plankton project: $(date '+%Y-%m-%d %H:%M:%S')"
    fi
    echo "Staging and committing changes with NAD7 identity..."
    git add -A
    GIT_AUTHOR_NAME="$NAD7_NAME" \
    GIT_AUTHOR_EMAIL="$NAD7_EMAIL" \
    GIT_COMMITTER_NAME="$NAD7_NAME" \
    GIT_COMMITTER_EMAIL="$NAD7_EMAIL" \
    git commit -m "$COMMIT_MSG"
else
    echo "Working tree clean, no uncommitted changes."
fi

# Get commits on main
MAIN_COMMITS=($(git rev-list --reverse main))
if [ ${#MAIN_COMMITS[@]} -eq 0 ]; then
    echo "Error: No commits found on branch 'main' to push."
    exit 1
fi
echo "Total commits on 'main': ${#MAIN_COMMITS[@]}"

# Replicate to planktonotc-main with PlanktonOTC identity
echo "Syncing branch 'planktonotc-main' with PlanktonOTC identity..."
PLANKTON_COMMITS=()
if git rev-parse --verify --quiet refs/heads/planktonotc-main >/dev/null; then
    PLANKTON_COMMITS=($(git rev-list --reverse refs/heads/planktonotc-main))
fi

MATCH_COUNT=0
MIN_COUNT=${#MAIN_COMMITS[@]}
if [ ${#PLANKTON_COMMITS[@]} -lt $MIN_COUNT ]; then
    MIN_COUNT=${#PLANKTON_COMMITS[@]}
fi

for ((i=0; i<$MIN_COUNT; i++)); do
    MAIN_TREE="$(git rev-parse "${MAIN_COMMITS[$i]}^{tree}")"
    PLANKTON_TREE="$(git rev-parse "${PLANKTON_COMMITS[$i]}^{tree}")"
    if [ "$MAIN_TREE" = "$PLANKTON_TREE" ]; then
        MATCH_COUNT=$((MATCH_COUNT + 1))
    else
        break
    fi
done

FORCE_PUSH=false
PARENT=""
if [ $MATCH_COUNT -lt ${#PLANKTON_COMMITS[@]} ]; then
    echo "Detected divergence between main and planktonotc-main. Rebuilding mirror branch..."
    MATCH_COUNT=0
    FORCE_PUSH=true
else
    if [ $MATCH_COUNT -gt 0 ]; then
        PARENT="${PLANKTON_COMMITS[$((MATCH_COUNT - 1))]}"
    fi
fi

for ((i=$MATCH_COUNT; i<${#MAIN_COMMITS[@]}; i++)); do
    C="${MAIN_COMMITS[$i]}"
    TREE="$(git rev-parse "$C^{tree}")"
    MSG="$(git log -1 --format=%B "$C" | grep -v -i -E '^\s*co-authored-by:\s*' | grep -v -i -E '^\s*signed-off-by:\s*')"
    if [ -z "$MSG" ]; then MSG="Commit $C"; fi
    
    AUTHOR_DATE="$(git log -1 --format=%aI "$C")"
    COMMITTER_DATE="$(git log -1 --format=%cI "$C")"
    
    PARENT_ARGS=()
    if [ -n "$PARENT" ]; then
        PARENT_ARGS=("-p" "$PARENT")
    fi
    
    NEW_P="$(GIT_AUTHOR_NAME="$PLANKTON_NAME" \
             GIT_AUTHOR_EMAIL="$PLANKTON_EMAIL" \
             GIT_AUTHOR_DATE="$AUTHOR_DATE" \
             GIT_COMMITTER_NAME="$PLANKTON_NAME" \
             GIT_COMMITTER_EMAIL="$PLANKTON_EMAIL" \
             GIT_COMMITTER_DATE="$COMMITTER_DATE" \
             git commit-tree "$TREE" "${PARENT_ARGS[@]}" -m "$MSG")"
    PARENT="$NEW_P"
done

if [ -n "$PARENT" ]; then
    git update-ref refs/heads/planktonotc-main "$PARENT"
fi

# Push to both remotes
echo "Pushing main to $NAD7_REMOTE ($NAD7_URL)..."
git push "$NAD7_REMOTE" main:main

echo "Pushing planktonotc-main to $PLANKTON_REMOTE ($PLANKTON_URL)..."
if [ "$FORCE_PUSH" = true ]; then
    git push --force "$PLANKTON_REMOTE" planktonotc-main:main
else
    git push "$PLANKTON_REMOTE" planktonotc-main:main
fi

# Fetch and verify
echo "Fetching remotes for verification..."
git fetch "$NAD7_REMOTE" main --quiet
git fetch "$PLANKTON_REMOTE" main --quiet

NAD7_LATEST="$(git log -1 --format='%an <%ae> | %cn <%ce>' "$NAD7_REMOTE/main")"
PLANKTON_LATEST="$(git log -1 --format='%an <%ae> | %cn <%ce>' "$PLANKTON_REMOTE/main")"
NAD7_URL_ACTUAL="$(git remote get-url "$NAD7_REMOTE")"
PLANKTON_URL_ACTUAL="$(git remote get-url "$PLANKTON_REMOTE")"

echo ""
echo "================ PUSH VERIFICATION ================"
echo "Remote 1: $NAD7_REMOTE"
echo "  URL: $NAD7_URL_ACTUAL"
echo "  Latest Commit Author: $NAD7_LATEST"
echo "Remote 2: $PLANKTON_REMOTE"
echo "  URL: $PLANKTON_URL_ACTUAL"
echo "  Latest Commit Author: $PLANKTON_LATEST"
echo "===================================================="
echo ""

# Full history audit
NAD7_BAD="$(git log --format='%an <%ae> | %cn <%ce>' "$NAD7_REMOTE/main" | sort -u | grep -v "^${NAD7_NAME} <${NAD7_EMAIL}> | ${NAD7_NAME} <${NAD7_EMAIL}>$" || true)"
PLANKTON_BAD="$(git log --format='%an <%ae> | %cn <%ce>' "$PLANKTON_REMOTE/main" | sort -u | grep -v "^${PLANKTON_NAME} <${PLANKTON_EMAIL}> | ${PLANKTON_NAME} <${PLANKTON_EMAIL}>$" || true)"

if [ -n "$NAD7_BAD" ]; then
    echo "Identity audit failed on $NAD7_REMOTE/main! Unexpected identities: $NAD7_BAD" >&2
    exit 1
fi
if [ -n "$PLANKTON_BAD" ]; then
    echo "Identity audit failed on $PLANKTON_REMOTE/main! Unexpected identities: $PLANKTON_BAD" >&2
    exit 1
fi

echo "History audit passed: 100% strictly isolated identities across all commits."

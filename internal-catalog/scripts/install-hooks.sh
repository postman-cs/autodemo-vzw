#!/bin/bash
# Install git hooks for this repository.
# Run once after cloning: bash scripts/install-hooks.sh

set -euo pipefail

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
    echo "Skipping hook install: not inside a git worktree."
    exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CATALOG_DIR="$(dirname "$SCRIPT_DIR")"
CATALOG_REL="${CATALOG_DIR#"$REPO_ROOT"/}"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

if [ ! -d "$HOOKS_DIR" ]; then
    echo "Skipping hook install: $HOOKS_DIR not found."
    exit 0
fi

# Pre-commit hook: unstage context files + actionlint + regression tests
cat > "$HOOKS_DIR/pre-commit" << 'HOOKEOF'
#!/bin/bash

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

# Pre-commit hook: unstage context files + actionlint + regression tests
# Bypass with: git commit --no-verify

CHECK_BUN_LOCK_SCRIPT="$REPO_ROOT/$CATALOG_REL/scripts/check-bun-lock.mjs"

# --- Section 1: Unstage AI agent context files ---

UNSTAGE_FILES=(
    "CLAUDE.md"
    "GEMINI.md"
    "PROGRESS.md"
    "TODO.md"
    "docs/CHANGELOG.md"
    "docs/IMPLEMENTATION.md"
    "docs/PROGRESS.md"
    "docs/TODO.md"
    "docs/CLAUDE.md"
    "docs/LOOKER_INTEGRATION_GUIDE.md"
    "docs/data_dictionary_extraction.md"
    "docs/keychain-change-inventory.md"
    "assets/AppIcon.icns"
    "assets/icon.png"
    "logs/"
    "okr/"
)

UNSTAGED_FILES=()
for file in "${UNSTAGE_FILES[@]}"; do
    if git diff --cached --name-only | grep -q "^$file"; then
        UNSTAGED_FILES+=("$file")
    fi
done

if [ ${#UNSTAGED_FILES[@]} -gt 0 ]; then
    echo "Pre-commit: Unstaging context files..."
    for file in "${UNSTAGED_FILES[@]}"; do
        git restore --staged "$file" 2>/dev/null || true
        echo "  Unstaged: $file"
    done
    echo ""
fi

# --- Section 2: Actionlint on staged workflow files ---

# --- Section 2a: Auto-build action bundles when action source changes ---

STAGED_FILES="$(git diff --cached --name-only --diff-filter=ACM || true)"

# --- Section 2b: Prevent bun.lock drift ---
if echo "$STAGED_FILES" | grep -Eq '^(package\.json$|bun\.lock$)'; then
    echo "Checking for bun.lock drift..."
    if ! node "$CHECK_BUN_LOCK_SCRIPT" --staged; then
        echo ""
        echo "ERROR: bun.lock validation failed."
        echo "Run 'bun install' to update the lockfile, stage bun.lock, and try again."
        exit 1
    fi
    echo "bun.lock is in sync."
fi

STAGED_ACTION_SOURCES="$(
    echo "$STAGED_FILES" \
      | awk -F/ '/^\.github\/actions\/[^\/]+\/src\// { print $3 }' \
      | sort -u \
      | paste -sd, -
)"

SHARED_ACTION_INPUT_CHANGED="false"
if echo "$STAGED_FILES" | grep -Eq '^(package\.json$|package-lock\.json$|bun\.lock$)'; then
    SHARED_ACTION_INPUT_CHANGED="true"
fi
if echo "$STAGED_FILES" | grep -q '^\.github/actions/_lib/'; then
    SHARED_ACTION_INPUT_CHANGED="true"
fi

if [ "$SHARED_ACTION_INPUT_CHANGED" = "true" ] || [ -n "$STAGED_ACTION_SOURCES" ]; then
    echo ""
    echo "Auto-syncing GitHub Action bundles..."
    if [ "$SHARED_ACTION_INPUT_CHANGED" = "true" ]; then
        echo "Shared dependency inputs changed; rebuilding all action bundles."
        if ! npm run build:actions; then
            echo "Action bundle build failed. Commit blocked."
            exit 1
        fi
        git add .github/actions/*/dist
    else
        echo "Rebuilding changed actions: $STAGED_ACTION_SOURCES"
        if ! ACTIONS_TO_BUILD="$STAGED_ACTION_SOURCES" npm run build:actions; then
            echo "Action bundle build failed. Commit blocked."
            exit 1
        fi
        OLD_IFS="$IFS"
        IFS=','
        for action_name in $STAGED_ACTION_SOURCES; do
            git add ".github/actions/${action_name}/dist"
        done
        IFS="$OLD_IFS"
    fi
fi

STAGED_WORKFLOWS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.github/workflows/.*\.ya?ml$' || true)
if [ -n "$STAGED_WORKFLOWS" ]; then
    if command -v actionlint &> /dev/null; then
        echo "Running actionlint on staged workflow files..."
        if ! actionlint -config-file .github/actionlint.yaml $STAGED_WORKFLOWS; then
            echo "actionlint failed. Please fix the errors above."
            exit 1
        fi
    fi
fi

# Actionlint on generated provision workflow when provision-workflow.ts is staged
if git diff --cached --name-only | grep -q "src/lib/provision-workflow.ts"; then
    if command -v actionlint &> /dev/null && command -v npx &> /dev/null; then
        echo "Running actionlint on generated provision workflow..."
        TMPFILE=$(mktemp /tmp/provision-XXXXXX.yml)
        trap "rm -f $TMPFILE" EXIT
        npx tsx -e "
          import { generateProvisionWorkflow } from './src/lib/provision-workflow.ts';
          process.stdout.write(generateProvisionWorkflow());
        " > "$TMPFILE" 2>/dev/null
        if [ -s "$TMPFILE" ]; then
            if ! actionlint -shellcheck="" "$TMPFILE"; then
                echo ""
                echo "Generated provision.yml has actionlint errors."
                echo "Fix src/lib/provision-workflow.ts and try again."
                rm -f "$TMPFILE"
                exit 1
            fi
            echo "Generated provision.yml passed actionlint"
        fi
        rm -f "$TMPFILE"
    fi
fi

# --- Section 3: Typecheck on staged TypeScript changes ---

STAGED_TS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|tsx)$' || true)

if [ -n "$STAGED_TS" ]; then
    echo ""
    echo "Running typecheck..."
    if ! bun run typecheck 2>&1 | tail -10; then
        echo ""
        echo "Typecheck FAILED. Commit blocked."
        echo "Run 'bun run typecheck' to debug."
        echo "Bypass with: git commit --no-verify"
        exit 1
    fi
    echo "Typecheck passed."
fi

# --- Section 4: Design System Validation (staged frontend files) ---

STAGED_FRONTEND=$(git diff --cached --name-only --diff-filter=ACM | grep -E '^frontend/src/' || true)

if [ -n "$STAGED_FRONTEND" ]; then
    echo ""
    echo "Running design system validation on staged frontend files..."
    if ! npm run validate:design-system -- --staged 2>&1 | tail -20; then
        echo ""
        echo "Design system validation FAILED. Commit blocked."
        echo "Run 'npm run validate:design-system -- --staged' to debug."
        echo "Bypass with: git commit --no-verify"
        exit 1
    fi
    echo "Design system validation passed."
fi

# --- Section 5: 1Password Sync ---

SYNC_1PASSWORD_SCRIPT="$REPO_ROOT/scripts/sync-1password.sh"
if [ -x "$SYNC_1PASSWORD_SCRIPT" ]; then
    echo ""
    echo "Running 1Password sync..."
    if ! "$SYNC_1PASSWORD_SCRIPT"; then
        echo ""
        echo "Warning: 1Password sync failed."
    fi
fi

# --- Section 6: Regression tests ---

STAGED_ACTION_METADATA=$(git diff --cached --name-only --diff-filter=ACM | grep -E '^\.github/actions/[^/]+/action\.ya?ml$' || true)
if [ -n "$STAGED_ACTION_METADATA" ]; then
    echo ""
    echo "Validating staged GitHub Action metadata..."
    for action_file in $STAGED_ACTION_METADATA; do
        if ! node -e "
          const fs = require('fs');
          const YAML = require('yaml');
          const file = process.argv[1];
          const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
          if (!doc || typeof doc !== 'object') throw new Error('must parse to an object');
          if (!doc.name || !doc.description) throw new Error('requires name and description');
          if (!doc.runs || typeof doc.runs !== 'object') throw new Error('requires runs block');
          if (!doc.runs.using || !doc.runs.main) throw new Error('runs.using and runs.main are required');
        " "$action_file"; then
            echo "Action metadata validation failed: $action_file"
            exit 1
        fi
    done
    echo "Action metadata validation passed."
fi

STAGED_ACTION_SOURCE=$(git diff --cached --name-only --diff-filter=ACM | grep -E '^\.github/actions/[^/]+/(src/|action\.ya?ml)' || true)
if [ -n "$STAGED_ACTION_SOURCE" ]; then
    echo ""
    echo "Running action unit tests (test:actions)..."
    if ! npm run test:actions --silent 2>&1 | tail -5; then
        echo ""
        echo "Action tests FAILED. Commit blocked."
        echo "Run 'npm run test:actions' to debug."
        echo "Bypass with: git commit --no-verify"
        exit 1
    fi
    echo "Action tests passed."
fi

STAGED_SRC=$(git diff --cached --name-only --diff-filter=ACM | grep -E '^(src/|tests/)' || true)

if [ -n "$STAGED_SRC" ]; then
    echo ""
    echo "Running regression tests (4 files, ~2.5s)..."
    if ! npm run test:regression --silent 2>&1 | tail -5; then
        echo ""
        echo "Regression tests FAILED. Commit blocked."
        echo "Run 'npm run test:regression' to debug."
        echo "Bypass with: git commit --no-verify"
        exit 1
    fi
    echo "Regression tests passed."
else
    echo "No src/ or tests/ changes staged, skipping regression tests."
fi

exit 0
HOOKEOF

chmod +x "$HOOKS_DIR/pre-commit"
echo "Installed pre-commit hook -> $HOOKS_DIR/pre-commit"

cat > "$HOOKS_DIR/pre-push" << HOOKEOF
#!/bin/bash

set -euo pipefail

REPO_ROOT="$REPO_ROOT"
CATALOG_REL="$CATALOG_REL"
CHECK_BUN_LOCK_SCRIPT="$REPO_ROOT/$CATALOG_REL/scripts/check-bun-lock.mjs"

echo "Running bun.lock validation before push..."
node "\$CHECK_BUN_LOCK_SCRIPT"
HOOKEOF

chmod +x "$HOOKS_DIR/pre-push"
echo "Installed pre-push hook -> $HOOKS_DIR/pre-push"

# Post-checkout hook: auto-pull .env from SM when missing or on branch switch
cat > "$HOOKS_DIR/post-checkout" << 'HOOKEOF'
#!/bin/bash

set -euo pipefail

# Post-checkout hook: sync .env from AWS Secrets Manager
# Runs after git checkout and git clone (unless --no-checkout).
# Args: $1=prev_ref, $2=new_ref, $3=branch_flag (1=branch, 0=file)

REPO_ROOT="$(git rev-parse --show-toplevel)"
ENV_FILE="$REPO_ROOT/.env"
SYNC_SCRIPT="$REPO_ROOT/scripts/env-sync.sh"

# Only run on branch checkouts, not file checkouts
if [ "${3:-0}" != "1" ]; then
    exit 0
fi

if [ ! -x "$SYNC_SCRIPT" ]; then
    exit 0
fi

if [ ! -f "$ENV_FILE" ]; then
    echo ""
    echo "env-sync: .env not found. Pulling from AWS Secrets Manager..."
    "$SYNC_SCRIPT" pull 2>&1 | sed 's/^/  /'
elif [ -f "$ENV_FILE" ]; then
    # Check staleness: pull if .env is older than 24 hours
    if [ "$(uname)" = "Darwin" ]; then
        file_age=$(( $(date +%s) - $(stat -f %m "$ENV_FILE") ))
    else
        file_age=$(( $(date +%s) - $(stat -c %Y "$ENV_FILE") ))
    fi
    if [ "$file_age" -gt 86400 ]; then
        echo ""
        echo "env-sync: .env is older than 24h. Pulling latest from AWS Secrets Manager..."
        "$SYNC_SCRIPT" pull 2>&1 | sed 's/^/  /'
    fi
fi
HOOKEOF

chmod +x "$HOOKS_DIR/post-checkout"
echo "Installed post-checkout hook -> $HOOKS_DIR/post-checkout"

# Post-merge hook: auto-pull .env from SM after git pull
cat > "$HOOKS_DIR/post-merge" << 'HOOKEOF'
#!/bin/bash

set -euo pipefail

# Post-merge hook: refresh .env from AWS Secrets Manager after pull/merge.
# Secrets may have been rotated by another developer.

REPO_ROOT="$(git rev-parse --show-toplevel)"
SYNC_SCRIPT="$REPO_ROOT/scripts/env-sync.sh"

if [ ! -x "$SYNC_SCRIPT" ]; then
    exit 0
fi

# Only pull if .env.schema changed in the merge (new keys added)
if git diff-tree -r --name-only ORIG_HEAD HEAD 2>/dev/null | grep -q '\.env\.schema$'; then
    echo ""
    echo "env-sync: .env.schema changed. Pulling latest secrets..."
    "$SYNC_SCRIPT" pull 2>&1 | sed 's/^/  /'
fi
HOOKEOF

chmod +x "$HOOKS_DIR/post-merge"
echo "Installed post-merge hook -> $HOOKS_DIR/post-merge"

# Preserve existing commit-msg hook if present
if [ -f "$HOOKS_DIR/commit-msg" ]; then
    echo "Existing commit-msg hook preserved."
else
    echo "No commit-msg hook found (expected for AI attribution check)."
fi

echo "Done. Hooks installed."

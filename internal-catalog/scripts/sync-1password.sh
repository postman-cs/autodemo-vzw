#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$(cd "$(dirname "$0")/.." && pwd)")"
ENV_FILE="$REPO_ROOT/.env"
DEFAULT_VAULT_ID="m6hrbahxfdgv56kkxrntu3aqya"
VAULT="${ONEPASSWORD_VAULT_ID:-${ONEPASSWORD_VAULT:-$DEFAULT_VAULT_ID}}"

if ! command -v op &> /dev/null; then
    echo "1Password CLI (op) could not be found. Skipping 1Password sync."
    exit 0
fi

if ! op whoami >/dev/null 2>&1; then
    echo "Not authenticated to 1Password CLI. Please run 'op signin'. Skipping 1Password sync."
    exit 0
fi

if [ ! -f "$ENV_FILE" ]; then
    echo "Error: $ENV_FILE not found. Skipping sync."
    exit 0
fi

SLUGS=$(grep -oE '^(export[[:space:]]+)?POSTMAN_TEAM__[A-Za-z0-9_]+__API_KEY' "$ENV_FILE" | sed -E 's/^export[[:space:]]+//' | awk -F'__' '{print $2}' | sort -u || true)

if [ -z "$SLUGS" ]; then
    echo "No POSTMAN_TEAM__* entries found in .env. Nothing to sync to 1Password."
    exit 0
fi

echo "Syncing local tenant credentials to 1Password vault: $VAULT..."

SYNCED_COUNT=0

for RAW_SLUG in $SLUGS; do
    SLUG=$(echo "$RAW_SLUG" | tr '[:upper:]' '[:lower:]' | tr '_' '-' | sed 's/--*/-/g; s/^-//; s/-$//')
    
    API_KEY=$(grep -E "^(export[[:space:]]+)?POSTMAN_TEAM__${RAW_SLUG}__API_KEY=" "$ENV_FILE" | cut -d'=' -f2- | tr -d '"' | tr -d "'" || true)
    ACCESS_TOKEN=$(grep -E "^(export[[:space:]]+)?POSTMAN_TEAM__${RAW_SLUG}__ACCESS_TOKEN=" "$ENV_FILE" | cut -d'=' -f2- | tr -d '"' | tr -d "'" || true)
    
    if [ -z "$API_KEY" ] || [ -z "$ACCESS_TOKEN" ]; then
        echo "  ${SLUG}: Skipped (missing API_KEY or ACCESS_TOKEN)"
        continue
    fi

    ITEM_TITLE="Team: ${SLUG}"

    if op item get "$ITEM_TITLE" --vault "$VAULT" >/dev/null 2>&1; then
        echo "  ${SLUG}: Updating existing item in 1Password..."
        op item edit "$ITEM_TITLE" --vault "$VAULT" \
            "api_key[password]=${API_KEY}" \
            "access_token[password]=${ACCESS_TOKEN}" >/dev/null 2>&1 || echo "  ${SLUG}: Update failed"
    else
        echo "  ${SLUG}: Creating new item in 1Password..."
        op item create --category "API Credential" \
            --title "$ITEM_TITLE" \
            --vault "$VAULT" \
            --tags "managed-by:vzw-partner-demo,team-slug:${SLUG}" \
            "api_key[password]=${API_KEY}" \
            "access_token[password]=${ACCESS_TOKEN}" >/dev/null 2>&1 || echo "  ${SLUG}: Create failed"
    fi
    
    SYNCED_COUNT=$((SYNCED_COUNT + 1))
done

echo "Synced $SYNCED_COUNT tenant(s) to 1Password."

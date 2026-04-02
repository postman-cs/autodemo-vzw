#!/usr/bin/env bash
# Configure .env for a Cloudflare account migration.
# Updates CF_EMAIL, CF_API_KEY, CF_ACCOUNT_ID, CF_WORKER_SUBDOMAIN, and CF_ZONE_ID.
#
# Usage:
#   scripts/configure-cloudflare-account.sh \
#     --email jared.boynton@gmail.com \
#     --api-key "<global-api-key>" \
#     [--zone-name <zone-name>] \
#     [--account-id <account-id>] \
#     [--env-file .env]

set -euo pipefail

EMAIL=""
API_KEY=""
ZONE_NAME=""
ACCOUNT_ID=""
ENV_FILE=".env"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email)
      EMAIL="${2:-}"
      shift 2
      ;;
    --api-key)
      API_KEY="${2:-}"
      shift 2
      ;;
    --zone-name)
      ZONE_NAME="${2:-}"
      shift 2
      ;;
    --account-id)
      ACCOUNT_ID="${2:-}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$EMAIL" || -z "$API_KEY" ]]; then
  cat >&2 <<'EOF'
Missing required arguments.

Usage:
  scripts/configure-cloudflare-account.sh \
    --email <cloudflare-email> \
    --api-key <cloudflare-global-api-key> \
    [--zone-name <zone-name>] \
    [--account-id <account-id>] \
    [--env-file <path-to-env>]
EOF
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 1
fi

for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Required command not found: $cmd" >&2
    exit 1
  fi
done

CF_HEADERS=(
  -H "X-Auth-Email: ${EMAIL}"
  -H "X-Auth-Key: ${API_KEY}"
)

api_get() {
  local url="$1"
  curl -sS "$url" "${CF_HEADERS[@]}"
}

upsert_env_key() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i '' "s|^${key}=.*$|${key}=${value}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

echo "Validating Cloudflare credentials..."
USER_JSON="$(api_get "https://api.cloudflare.com/client/v4/user")"
if [[ "$(echo "$USER_JSON" | jq -r '.success')" != "true" ]]; then
  echo "Cloudflare auth failed: $(echo "$USER_JSON" | jq -c '.errors')" >&2
  exit 1
fi

if [[ -z "$ACCOUNT_ID" ]]; then
  ACCOUNTS_JSON="$(api_get "https://api.cloudflare.com/client/v4/accounts?per_page=100")"
  if [[ "$(echo "$ACCOUNTS_JSON" | jq -r '.success')" != "true" ]]; then
    echo "Unable to list accounts: $(echo "$ACCOUNTS_JSON" | jq -c '.errors')" >&2
    exit 1
  fi

  ACCOUNT_COUNT="$(echo "$ACCOUNTS_JSON" | jq '.result | length')"
  if [[ "$ACCOUNT_COUNT" -eq 0 ]]; then
    echo "No Cloudflare accounts available for this identity." >&2
    exit 1
  elif [[ "$ACCOUNT_COUNT" -gt 1 ]]; then
    echo "Multiple Cloudflare accounts found. Re-run with --account-id." >&2
    echo "$ACCOUNTS_JSON" | jq -r '.result[] | "  - \(.id)  \(.name)"' >&2
    exit 1
  fi
  ACCOUNT_ID="$(echo "$ACCOUNTS_JSON" | jq -r '.result[0].id')"
fi

SUBDOMAIN_JSON="$(api_get "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/subdomain")"
if [[ "$(echo "$SUBDOMAIN_JSON" | jq -r '.success')" != "true" ]]; then
  echo "Unable to fetch Workers subdomain: $(echo "$SUBDOMAIN_JSON" | jq -c '.errors')" >&2
  exit 1
fi
WORKERS_SUBDOMAIN="$(echo "$SUBDOMAIN_JSON" | jq -r '.result.subdomain')"
WORKER_TARGET="catalog-provision.${WORKERS_SUBDOMAIN}.workers.dev"

ZONES_JSON="$(api_get "https://api.cloudflare.com/client/v4/zones?per_page=100")"
if [[ "$(echo "$ZONES_JSON" | jq -r '.success')" != "true" ]]; then
  echo "Unable to list zones: $(echo "$ZONES_JSON" | jq -c '.errors')" >&2
  exit 1
fi

TARGET_ZONE_ID=""
if [[ -n "$ZONE_NAME" ]]; then
  TARGET_ZONE_ID="$(echo "$ZONES_JSON" | jq -r --arg zone "$ZONE_NAME" '.result[] | select(.name == $zone) | .id' | head -n 1)"
fi

if [[ -z "$TARGET_ZONE_ID" ]]; then
  # Clear stale zone id to avoid accidentally targeting a personal account zone.
  TARGET_ZONE_ID=""
fi

echo "Updating ${ENV_FILE}..."
upsert_env_key "CF_EMAIL" "$EMAIL"
upsert_env_key "CF_API_KEY" "$API_KEY"
upsert_env_key "CF_ACCOUNT_ID" "$ACCOUNT_ID"
upsert_env_key "CF_WORKER_SUBDOMAIN" "$WORKER_TARGET"
upsert_env_key "CF_ZONE_ID" "$TARGET_ZONE_ID"

echo "Cloudflare account configuration updated."
echo "  CF_EMAIL=${EMAIL}"
echo "  CF_ACCOUNT_ID=${ACCOUNT_ID}"
echo "  CF_WORKER_SUBDOMAIN=${WORKER_TARGET}"
if [[ -n "$TARGET_ZONE_ID" ]]; then
  if [[ -n "$ZONE_NAME" ]]; then
    echo "  CF_ZONE_ID=${TARGET_ZONE_ID} (zone: ${ZONE_NAME})"
  else
    echo "  CF_ZONE_ID=${TARGET_ZONE_ID}"
  fi
else
  if [[ -n "$ZONE_NAME" ]]; then
    echo "  CF_ZONE_ID is empty (zone '${ZONE_NAME}' not found in this account)."
  else
    echo "  CF_ZONE_ID is empty (no zone selected)."
  fi
fi

echo "Next step: if you need zone-scoped DNS operations, rerun with --zone-name <zone>."

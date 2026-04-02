#!/usr/bin/env bash

# env-sync.sh -- Bidirectional sync between .env and AWS Secrets Manager
#
# Usage:
#   ./scripts/env-sync.sh pull          # SM -> .env (safe, non-destructive)
#   ./scripts/env-sync.sh push          # .env -> SM (overwrites remote)
#   ./scripts/env-sync.sh diff          # Show drift between .env and SM
#   ./scripts/env-sync.sh seed          # Initial upload of .env to SM (creates secret)
#
# All SM calls use curl -4 (force IPv4) to bypass the Python/urllib3 IPv6
# hang on secretsmanager.eu-central-1.amazonaws.com.

set -euo pipefail

REGION="eu-central-1"
SECRET_NAME="/vzw-partner-demo/worker-env"
SM_ENDPOINT="https://secretsmanager.${REGION}.amazonaws.com"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$(cd "$(dirname "$0")/.." && pwd)")"
ENV_FILE="$REPO_ROOT/.env"
SCHEMA_FILE="$REPO_ROOT/.env.schema"

# -- Credentials ---------------------------------------------------------------

resolve_credentials() {
  export AWS_PROFILE="${AWS_PROFILE:-vzw-partner-demo-user}"
  eval "$(aws configure export-credentials --profile "$AWS_PROFILE" --format env 2>/dev/null)" || true

  if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    echo "Error: AWS credentials not found. Set AWS_PROFILE or export AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY." >&2
    exit 1
  fi
}

# -- SM API via curl -4 --------------------------------------------------------

sm_call() {
  local target=$1
  local payload=$2
  local result
  local http_code

  result=$(curl -4 -sS -w "\n%{http_code}" \
    --aws-sigv4 "aws:amz:${REGION}:secretsmanager" \
    --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" \
    ${AWS_SESSION_TOKEN:+-H "X-Amz-Security-Token: ${AWS_SESSION_TOKEN}"} \
    -H "X-Amz-Target: secretsmanager.${target}" \
    -H "Content-Type: application/x-amz-json-1.1" \
    -d "$payload" \
    "$SM_ENDPOINT" 2>&1)

  http_code=$(echo "$result" | tail -1)
  local body
  body=$(echo "$result" | sed '$d')

  if [ "$http_code" -ge 400 ] 2>/dev/null; then
    echo "$body" >&2
    return 1
  fi

  echo "$body"
}

# -- .env <-> JSON conversion ---------------------------------------------------

env_to_json() {
  # Parse .env into a JSON object, preserving order. Skips comments and blanks.
  local file=$1
  jq -Rn '[inputs | select(test("^[A-Za-z_][A-Za-z0-9_]*=")) | capture("^(?<key>[^=]+)=(?<value>.*)$")] | from_entries' < "$file"
}

json_to_env() {
  # Convert JSON object to .env format with group headers.
  local json=$1

  # Ordered group definitions: prefix -> comment header
  local -a groups=(
    "CF_:# Cloudflare"
    "CLOUDFLARE_:# Cloudflare aliases"
    "POSTMAN_:# Postman"
    "GH_:# GitHub"
    "AWS_:# AWS"
    "AIRTABLE_:# Airtable"
    "KUBECONFIG_:# Kubernetes"
    "K8S_:# Kubernetes"
    "AUTH_:# Auth"
    "FERN_:# Fern"
  )

  local output=""
  local _emitted=" "

  for mapping in "${groups[@]}"; do
    local prefix="${mapping%%:*}"
    local header="${mapping#*:}"
    local block=""

    for key in $(echo "$json" | jq -r 'keys[]'); do
      if [[ "$key" == ${prefix}* ]] && [[ "$_emitted" != *" ${key} "* ]]; then
        local value
        value=$(echo "$json" | jq -r --arg k "$key" '.[$k]')
        block+="${key}=${value}"$'\n'
        _emitted+="${key} "
      fi
    done

    if [ -n "$block" ]; then
      [ -n "$output" ] && output+=$'\n'
      output+="${header}"$'\n'
      output+="$block"
    fi
  done

  # Emit any remaining keys not matched by a group
  local remainder=""
  for key in $(echo "$json" | jq -r 'keys[]'); do
    if [[ "$_emitted" != *" ${key} "* ]]; then
      local value
      value=$(echo "$json" | jq -r --arg k "$key" '.[$k]')
      remainder+="${key}=${value}"$'\n'
    fi
  done
  if [ -n "$remainder" ]; then
    [ -n "$output" ] && output+=$'\n'
    output+="$remainder"
  fi

  printf '%s' "$output"
}

# -- Per-tenant secret sync -----------------------------------------------------

sync_tenant_secrets() {
  # Parse POSTMAN_TEAM__<SLUG>__API_KEY / ACCESS_TOKEN from env JSON and
  # upsert each team's credentials into SM at /postman/tenants/{slug}/...
  local env_json=$1
  local prefix="/postman/tenants"
  local tenant_count=0

  # Extract unique slugs from POSTMAN_TEAM__*__* keys
  local slugs
  slugs=$(echo "$env_json" | jq -r '
    keys[] | select(startswith("POSTMAN_TEAM__"))
    | split("__") | if length >= 3 then .[1] else empty end
  ' | sort -u)

  if [ -z "$slugs" ]; then
    echo "Tenant secrets: No POSTMAN_TEAM__* entries found in .env"
    return 0
  fi

  echo "Syncing per-tenant secrets to SM..."

  for raw_slug in $slugs; do
    # Normalize slug: lowercase, replace underscores with hyphens
    local slug
    slug=$(echo "$raw_slug" | tr '[:upper:]' '[:lower:]' | tr '_' '-' | sed 's/--*/-/g; s/^-//; s/-$//')

    local api_key access_token
    api_key=$(echo "$env_json" | jq -r --arg k "POSTMAN_TEAM__${raw_slug}__API_KEY" '.[$k] // empty')
    access_token=$(echo "$env_json" | jq -r --arg k "POSTMAN_TEAM__${raw_slug}__ACCESS_TOKEN" '.[$k] // empty')

    if [ -z "$api_key" ] || [ -z "$access_token" ]; then
      echo "  ${slug}: Skipped (missing API_KEY or ACCESS_TOKEN)"
      continue
    fi

    # Upsert api-key
    sm_call CreateSecret "$(jq -n \
      --arg name "${prefix}/${slug}/api-key" \
      --arg desc "Postman API Key for ${slug}" \
      --arg val "$api_key" \
      --arg tok "$(uuidgen)" \
      '{Name: $name, Description: $desc, SecretString: $val, ClientRequestToken: $tok, Tags: [{Key: "ResourceGroup", Value: "vzw-partner-demo"}, {Key: "tenant-slug", Value: "'"${slug}"'"}]}')" > /dev/null 2>&1 || \
    sm_call PutSecretValue "$(jq -n \
      --arg id "${prefix}/${slug}/api-key" \
      --arg val "$api_key" \
      --arg tok "$(uuidgen)" \
      '{SecretId: $id, SecretString: $val, ClientRequestToken: $tok}')" > /dev/null 2>&1

    # Upsert access-token
    sm_call CreateSecret "$(jq -n \
      --arg name "${prefix}/${slug}/access-token" \
      --arg desc "Postman Access Token for ${slug}" \
      --arg val "$access_token" \
      --arg tok "$(uuidgen)" \
      '{Name: $name, Description: $desc, SecretString: $val, ClientRequestToken: $tok, Tags: [{Key: "ResourceGroup", Value: "vzw-partner-demo"}, {Key: "tenant-slug", Value: "'"${slug}"'"}]}')" > /dev/null 2>&1 || \
    sm_call PutSecretValue "$(jq -n \
      --arg id "${prefix}/${slug}/access-token" \
      --arg val "$access_token" \
      --arg tok "$(uuidgen)" \
      '{SecretId: $id, SecretString: $val, ClientRequestToken: $tok}')" > /dev/null 2>&1

    echo "  ${slug}: OK (api-key + access-token)"
    tenant_count=$((tenant_count + 1))
  done

  echo "Synced $tenant_count tenant(s) to SM"
}

# -- Commands -------------------------------------------------------------------

cmd_pull() {
  echo "Pulling secrets from SM: $SECRET_NAME ..."
  local secret_json
  secret_json=$(sm_call GetSecretValue "$(jq -n --arg id "$SECRET_NAME" '{SecretId: $id}')")

  local env_json
  env_json=$(printf '%s' "$secret_json" | python3 -c "
import sys, json
resp = json.load(sys.stdin)
inner = json.loads(resp['SecretString'])
json.dump(inner, sys.stdout, separators=(',', ':'))
")

  if [ -z "$env_json" ] || [ "$env_json" = "null" ]; then
    echo "Error: Secret $SECRET_NAME is empty or not found." >&2
    return 1
  fi

  # Validate it parses as JSON (use printf to preserve raw content)
  if ! printf '%s' "$env_json" | jq empty 2>/dev/null; then
    echo "Error: Secret value is not valid JSON." >&2
    return 1
  fi

  local key_count
  key_count=$(printf '%s' "$env_json" | jq 'length')

  # Back up existing .env
  if [ -f "$ENV_FILE" ]; then
    cp "$ENV_FILE" "${ENV_FILE}.bak"
  fi

  json_to_env "$env_json" > "$ENV_FILE"
  echo "Wrote $key_count variables to .env"

  # Validate against schema if present
  if [ -f "$SCHEMA_FILE" ]; then
    validate_schema "$ENV_FILE" || true
  fi
}

cmd_push() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "Error: $ENV_FILE not found. Nothing to push." >&2
    return 1
  fi

  local env_json
  env_json=$(env_to_json "$ENV_FILE")
  local key_count
  key_count=$(echo "$env_json" | jq 'length')

  echo "Pushing $key_count variables from .env to SM: $SECRET_NAME ..."

  sm_call PutSecretValue "$(jq -n \
    --arg id "$SECRET_NAME" \
    --arg val "$env_json" \
    --arg tok "$(uuidgen)" \
    '{SecretId: $id, SecretString: $val, ClientRequestToken: $tok}')" > /dev/null

  echo "Pushed $key_count variables to $SECRET_NAME"

  # Sync per-tenant Postman credentials to SM (/postman/tenants/{slug}/...)
  sync_tenant_secrets "$env_json"
}

cmd_seed() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "Error: $ENV_FILE not found. Nothing to seed." >&2
    return 1
  fi

  local env_json
  env_json=$(env_to_json "$ENV_FILE")
  local key_count
  key_count=$(echo "$env_json" | jq 'length')

  echo "Seeding $key_count variables from .env to SM: $SECRET_NAME ..."

  if sm_call CreateSecret "$(jq -n \
    --arg name "$SECRET_NAME" \
    --arg desc "Worker environment variables for vzw-partner-demo" \
    --arg val "$env_json" \
    --arg tok "$(uuidgen)" \
    '{Name: $name, Description: $desc, SecretString: $val, ClientRequestToken: $tok, Tags: [{Key: "ResourceGroup", Value: "vzw-partner-demo"}]}')" > /dev/null 2>&1; then
    echo "Created secret $SECRET_NAME with $key_count variables."
  else
    echo "Secret already exists. Use 'push' to update." >&2
    return 1
  fi
}

cmd_diff() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "Error: $ENV_FILE not found." >&2
    return 1
  fi

  echo "Comparing .env vs SM: $SECRET_NAME ..."

  local remote_raw
  remote_raw=$(sm_call GetSecretValue "$(jq -n --arg id "$SECRET_NAME" '{SecretId: $id}')" 2>/dev/null) || {
    echo "Error: Could not fetch secret. Has it been seeded?" >&2
    return 1
  }

  local remote_json
  remote_json=$(echo "$remote_raw" | jq -r '.SecretString')
  local local_json
  local_json=$(env_to_json "$ENV_FILE")

  local remote_keys local_keys
  remote_keys=$(echo "$remote_json" | jq -r 'keys[]' | sort)
  local_keys=$(echo "$local_json" | jq -r 'keys[]' | sort)

  local has_diff=false

  # Keys only in remote
  local only_remote
  only_remote=$(comm -23 <(echo "$remote_keys") <(echo "$local_keys"))
  if [ -n "$only_remote" ]; then
    has_diff=true
    echo ""
    echo "Keys only in SM (missing from .env):"
    echo "$only_remote" | sed 's/^/  + /'
  fi

  # Keys only in local
  local only_local
  only_local=$(comm -13 <(echo "$remote_keys") <(echo "$local_keys"))
  if [ -n "$only_local" ]; then
    has_diff=true
    echo ""
    echo "Keys only in .env (missing from SM):"
    echo "$only_local" | sed 's/^/  - /'
  fi

  # Value differences
  local common_keys
  common_keys=$(comm -12 <(echo "$remote_keys") <(echo "$local_keys"))
  local value_diffs=""
  for key in $common_keys; do
    local rv lv
    rv=$(echo "$remote_json" | jq -r --arg k "$key" '.[$k]')
    lv=$(echo "$local_json" | jq -r --arg k "$key" '.[$k]')
    if [ "$rv" != "$lv" ]; then
      value_diffs+="  ~ ${key}"$'\n'
    fi
  done

  if [ -n "$value_diffs" ]; then
    has_diff=true
    echo ""
    echo "Keys with different values:"
    echo -n "$value_diffs"
  fi

  if [ "$has_diff" = false ]; then
    echo "In sync. No differences found."
  fi
}

validate_schema() {
  local env_file=$1
  local missing=()
  while IFS= read -r line; do
    [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
    local key="${line%%=*}"
    key="${key%% *}"
    if ! grep -q "^${key}=" "$env_file" 2>/dev/null; then
      missing+=("$key")
    fi
  done < "$SCHEMA_FILE"

  if [ ${#missing[@]} -gt 0 ]; then
    echo "Warning: .env is missing keys required by .env.schema:"
    printf '  %s\n' "${missing[@]}"
    return 1
  fi
  return 0
}

# -- Entrypoint -----------------------------------------------------------------

usage() {
  echo "Usage: $0 {pull|push|diff|seed}"
  echo ""
  echo "  pull   Fetch secrets from AWS SM and write .env"
  echo "  push   Upload .env to AWS SM (overwrites remote)"
  echo "  diff   Compare .env against AWS SM"
  echo "  seed   Create the SM secret for the first time from .env"
  exit 1
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] || [ $# -eq 0 ]; then
  usage
fi

resolve_credentials

case "${1:-}" in
  pull)  cmd_pull ;;
  push)  cmd_push ;;
  diff)  cmd_diff ;;
  seed)  cmd_seed ;;
  *)     usage ;;
esac

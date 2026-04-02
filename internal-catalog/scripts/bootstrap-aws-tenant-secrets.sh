#!/usr/bin/env bash

# DEPRECATED: Use POSTMAN_TEAM__<SLUG>__* env vars in .env and run
# `./scripts/env-sync.sh push` instead. env-sync.sh now automatically
# extracts per-tenant credentials and writes them to SM.
#
# bootstrap-aws-tenant-secrets.sh
# Bootstraps a new Postman tenant's credentials into AWS Secrets Manager

set -e

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <postman_team_slug> <postman_api_key> <postman_access_token>"
  exit 1
fi

SLUG=$1
API_KEY=$2
ACCESS_TOKEN=$3
PREFIX="/postman/tenants"
REGION="eu-central-1"
SM_ENDPOINT="https://secretsmanager.${REGION}.amazonaws.com"

# Resolve AWS credentials from the vzw-partner-demo-user profile
export AWS_PROFILE="${AWS_PROFILE:-vzw-partner-demo-user}"
eval "$(aws configure export-credentials --profile "$AWS_PROFILE" --format env 2>/dev/null)" || true

if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ]; then
  echo "Error: AWS credentials not found. Set AWS_PROFILE or export AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY."
  exit 1
fi

# Use curl with -4 (force IPv4) instead of the AWS CLI for Secrets Manager calls.
# The AWS CLI's Python runtime tries IPv6 first when AAAA DNS records exist.
# IPv6 to secretsmanager.eu-central-1.amazonaws.com is unreachable on this
# network, causing the CLI to hang indefinitely on the TLS handshake.
sm_call() {
  local target=$1
  local payload=$2
  curl -4 -sS --fail-with-body \
    --aws-sigv4 "aws:amz:${REGION}:secretsmanager" \
    --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" \
    ${AWS_SESSION_TOKEN:+-H "X-Amz-Security-Token: ${AWS_SESSION_TOKEN}"} \
    -H "X-Amz-Target: secretsmanager.${target}" \
    -H "Content-Type: application/x-amz-json-1.1" \
    -d "$payload" \
    "$SM_ENDPOINT"
}

echo "Bootstrapping tenant: $SLUG into AWS Secrets Manager..."

# Create or update API Key Secret
sm_call CreateSecret "$(jq -n \
  --arg name "$PREFIX/$SLUG/api-key" \
  --arg desc "Postman API Key for $SLUG" \
  --arg val "$API_KEY" \
  --arg tok "$(uuidgen)" \
  '{Name: $name, Description: $desc, SecretString: $val, ClientRequestToken: $tok, Tags: [{Key: "ResourceGroup", Value: "vzw-partner-demo"}]}')" 2>&1 || \
sm_call PutSecretValue "$(jq -n \
  --arg id "$PREFIX/$SLUG/api-key" \
  --arg val "$API_KEY" \
  --arg tok "$(uuidgen)" \
  '{SecretId: $id, SecretString: $val, ClientRequestToken: $tok}')" 2>&1

echo "  api-key: OK"

# Create or update Access Token Secret
sm_call CreateSecret "$(jq -n \
  --arg name "$PREFIX/$SLUG/access-token" \
  --arg desc "Postman Access Token for $SLUG" \
  --arg val "$ACCESS_TOKEN" \
  --arg tok "$(uuidgen)" \
  '{Name: $name, Description: $desc, SecretString: $val, ClientRequestToken: $tok, Tags: [{Key: "ResourceGroup", Value: "vzw-partner-demo"}]}')" 2>&1 || \
sm_call PutSecretValue "$(jq -n \
  --arg id "$PREFIX/$SLUG/access-token" \
  --arg val "$ACCESS_TOKEN" \
  --arg tok "$(uuidgen)" \
  '{SecretId: $id, SecretString: $val, ClientRequestToken: $tok}')" 2>&1

echo "  access-token: OK"

echo "Successfully bootstrapped secrets for $SLUG."

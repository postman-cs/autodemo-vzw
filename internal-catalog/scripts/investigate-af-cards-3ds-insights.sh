#!/usr/bin/env bash
# Investigation script for af-cards-3ds stage Insights configuration.
# Run from repo root; source .env for AUTH_SESSION_SECRET, GH_TOKEN, kubeconfig.
set -euo pipefail

WORKER_URL="${CATALOG_ADMIN_WORKER_URL:-https://se.pm-catalog.dev}"
SPEC_ID="af-cards-3ds"
REPO="postman-cs/af-cards-3ds"
REPORT=""

append_report() { REPORT="${REPORT}$1"; }

NL=$'\n'

# ---------------------------------------------------------------------------
# Step 1: Query deployment state via worker API
# ---------------------------------------------------------------------------
step1_deployment_state() {
  append_report "${NL}## Step 1: Deployment State${NL}${NL}"
  if [[ -z "${AUTH_SESSION_SECRET:-}" ]]; then
    append_report "SKIP: AUTH_SESSION_SECRET not set. Set it and re-run, or query /api/deployments manually with valid session.${NL}"
    append_report "To mint session: source .env; use the script in CLAUDE.md 'Accessing auth-gated worker APIs locally'.${NL}"
    return
  fi

  SESSION_TOKEN=""
  if command -v node &>/dev/null; then
    SESSION_TOKEN=$(node -e "
      const { webcrypto } = require('crypto');
      const secret = process.env.AUTH_SESSION_SECRET;
      const now = Math.floor(Date.now() / 1000);
      const payload = { sub: 'investigate', login: 'investigate', orgs: ['postman-fde'], iat: now, exp: now + 3600 };
      const enc = new TextEncoder();
      const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      (async () => {
        const key = await webcrypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const payloadPart = b64url(enc.encode(JSON.stringify(payload)));
        const sig = await webcrypto.subtle.sign('HMAC', key, enc.encode(payloadPart));
        process.stdout.write(payloadPart + '.' + b64url(new Uint8Array(sig)));
      })();
    ")
  fi

  if [[ -z "$SESSION_TOKEN" ]]; then
    append_report "SKIP: Could not mint session token.${NL}"
    return
  fi

  RAW=$(curl -sS --cookie "catalog_admin_session=${SESSION_TOKEN}" "${WORKER_URL}/api/deployments")
  if echo "$RAW" | jq -e '.error' &>/dev/null; then
    append_report "ERROR: $(echo "$RAW" | jq -r '.error')${NL}"
    return
  fi

  DEPLOYMENT=$(echo "$RAW" | jq --arg spec "$SPEC_ID" '.deployments[]? | select(.spec_id == $spec)')
  if [[ -z "$DEPLOYMENT" || "$DEPLOYMENT" == "null" ]]; then
    append_report "No deployment record found for $SPEC_ID.${NL}"
    return
  fi

  append_report "Found deployment:${NL}"
  append_report "\`\`\`json${NL}$(echo "$DEPLOYMENT" | jq '{spec_id, status, runtime_mode, environments_json, system_env_map, environment_deployments}')${NL}\`\`\`${NL}${NL}"

  RUNTIME=$(echo "$DEPLOYMENT" | jq -r '.runtime_mode // "unknown"')
  append_report "- runtime_mode: $RUNTIME${NL}"
  if [[ "$RUNTIME" != "k8s_workspace" && "$RUNTIME" != "ecs_service" ]]; then
    append_report "- WARNING: Runtime $RUNTIME does not use per-service Insights sidecar. k8s_discovery uses DaemonSet; lambda has no agent.${NL}"
  fi

  SYS_MAP=$(echo "$DEPLOYMENT" | jq -r '.system_env_map // "{}"')
  if echo "$SYS_MAP" | jq -e '.stage' &>/dev/null; then
    append_report "- system_env_map contains stage: $(echo "$SYS_MAP" | jq -r '.stage')${NL}"
  else
    append_report "- WARNING: system_env_map missing stage. Bifrost may have returned only prod.${NL}"
  fi

  ENV_DEPLOYS=$(echo "$DEPLOYMENT" | jq -r '.environment_deployments // "[]"')
  STAGE_ENTRY=$(echo "$ENV_DEPLOYS" | jq '.[] | select(.environment == "stage")')
  if [[ -n "$STAGE_ENTRY" && "$STAGE_ENTRY" != "null" ]]; then
    append_report "- stage environment_deployments: $(echo "$STAGE_ENTRY" | jq -c '.')${NL}"
  else
    append_report "- No stage entry in environment_deployments.${NL}"
  fi
}

# ---------------------------------------------------------------------------
# Step 2: Inspect GitHub repo variables
# ---------------------------------------------------------------------------
step2_github_vars() {
  append_report "${NL}## Step 2: GitHub Repo Variables${NL}${NL}"
  if ! command -v gh &>/dev/null; then
    append_report "SKIP: gh CLI not found.${NL}"
    return
  fi
  if [[ -z "${GH_TOKEN:-}" ]]; then
    append_report "SKIP: GH_TOKEN not set. gh may use cached auth.${NL}"
  fi

  for VAR in POSTMAN_SYSTEM_ENV_STAGE POSTMAN_SYSTEM_ENV_PROD ENVIRONMENT_DEPLOYMENTS_JSON POSTMAN_INSIGHTS_ONBOARDING_MODE POSTMAN_WORKSPACE_ID; do
    VAL=$(gh api "repos/${REPO}/actions/variables/${VAR}" 2>/dev/null | jq -r '.value // "MISSING"')
    append_report "- ${VAR}: ${VAL}${NL}"
  done
}

# ---------------------------------------------------------------------------
# Step 3: Latest provision workflow run
# ---------------------------------------------------------------------------
step3_workflow_run() {
  append_report "${NL}## Step 3: Latest Provision Workflow Run${NL}${NL}"
  if ! command -v gh &>/dev/null; then
    append_report "SKIP: gh CLI not found.${NL}"
    return
  fi

  RUNS=$(gh run list --repo "$REPO" --workflow "provision.yml" -L 1 --json databaseId,conclusion,status,displayTitle,createdAt 2>/dev/null || true)
  if [[ -z "$RUNS" || "$RUNS" == "[]" ]]; then
    RUNS=$(gh run list --repo "$REPO" -L 5 --json databaseId,conclusion,status,displayTitle,workflowName,createdAt 2>/dev/null | jq '[.[] | select(.workflowName == "Provision API Lifecycle" or .workflowName == "provision.yml")] | .[0]')
  fi
  if [[ -z "$RUNS" || "$RUNS" == "null" || "$RUNS" == "[]" ]]; then
    append_report "No provision workflow runs found.${NL}"
    return
  fi

  RUN_ID=$(echo "$RUNS" | jq -r 'if type == "array" then .[0].databaseId else .databaseId end')
  append_report "Latest run ID: $RUN_ID${NL}"
  append_report "View: https://github.com/${REPO}/actions/runs/${RUN_ID}${NL}${NL}"
  append_report "Check workflow inputs (environments, system_env_map, environment_sync_enabled) and aws-deploy logs for INJECT_INSIGHTS_SIDECAR and any 'Environment sync disabled' warnings.${NL}"
}

# ---------------------------------------------------------------------------
# Step 4: In-cluster deployment (sidecar)
# ---------------------------------------------------------------------------
step4_incluster() {
  append_report "${NL}## Step 4: In-Cluster Deployment${NL}${NL}"
  if ! command -v kubectl &>/dev/null; then
    append_report "SKIP: kubectl not found.${NL}"
    return
  fi

  SIDECAR=""
  for DEPLOY in af-cards-3ds-stage af-cards-3ds; do
    SIDECAR=$(kubectl get deployment "$DEPLOY" -n vzw-partner-demo -o yaml 2>/dev/null | grep -A 25 "postman-insights-agent" || true)
    if [[ -n "$SIDECAR" ]]; then
      append_report "Deployment $DEPLOY has Insights sidecar. Excerpt:${NL}\`\`\`${NL}$SIDECAR${NL}\`\`\`${NL}${NL}"
      break
    fi
  done
  if [[ -z "$SIDECAR" ]]; then
    append_report "No af-cards-3ds deployment with postman-insights-agent found in vzw-partner-demo namespace.${NL}"
  fi
}

# ---------------------------------------------------------------------------
# Step 5: Diagnosis summary
# ---------------------------------------------------------------------------
step5_diagnosis() {
  append_report "${NL}## Diagnosis Summary${NL}${NL}"
  append_report "See docs/af-cards-3ds-stage-insights-diagnosis.md and .cursor/plans/ for full analysis.${NL}"
  append_report "Key checks: system_env_map has stage, sidecar has correct --system-env, traffic has been generated.${NL}"
}

# Run all steps
step1_deployment_state
step2_github_vars
step3_workflow_run
step4_incluster
step5_diagnosis

echo "# af-cards-3ds Stage Insights Investigation Report"
echo "$REPORT"

#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────
# blast-traffic.sh -- Generate realistic API traffic across all
# deployed services so Postman Insights can build endpoint models
# and dependency graphs.
#
# Auto-discovers services and routes from the worker deployments
# API and OpenAPI specs. Reads credentials from .env.
#
# Usage:
#   ./scripts/blast-traffic.sh              # default: 3 rounds
#   ./scripts/blast-traffic.sh --rounds 10
# ───────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [ -f "${REPO_ROOT}/.env" ]; then
  set -a; source "${REPO_ROOT}/.env"; set +a
fi

WORKER_URL="${WORKER_URL:-https://se.pm-catalog.dev}"
ROUNDS=3
CONCURRENT=8

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rounds)      ROUNDS="$2"; shift 2 ;;
    --worker-url)  WORKER_URL="$2"; shift 2 ;;
    --concurrent)  CONCURRENT="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

RESULTS_DIR="$(mktemp -d)"
trap 'rm -rf "${RESULTS_DIR}"' EXIT

# ── Discover active deployments ──────────────────────────────
echo "Discovering active deployments from ${WORKER_URL}..."

AUTH_HEADERS=()
if [ -n "${CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
  AUTH_HEADERS=(-H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}")
elif [ -n "${POSTMAN_ACCESS_TOKEN:-}" ]; then
  AUTH_HEADERS=(-H "Authorization: Bearer ${POSTMAN_ACCESS_TOKEN}")
fi

DEPLOYMENTS_RAW=$(curl -sS --max-time 15 "${AUTH_HEADERS[@]}" "${WORKER_URL}/api/deployments")

mapfile -t SPECS < <(echo "$DEPLOYMENTS_RAW" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for d in data.get('deployments', []):
    if d.get('status') != 'active':
        continue
    spec_id = d.get('spec_id', '')
    env_raw = d.get('environment_deployments', '[]')
    try:
        envs = json.loads(env_raw) if isinstance(env_raw, str) else (env_raw or [])
    except:
        envs = []
    urls = []
    for ed in envs:
        u = ed.get('runtime_url') or ed.get('url', '')
        if u and ed.get('status') == 'active':
            urls.append(u)
    if not urls:
        base = d.get('runtime_base_url', '')
        if base:
            urls = [base]
    if spec_id and urls:
        print(spec_id + '|' + ';'.join(urls))
" 2>/dev/null)

if [ "${#SPECS[@]}" -eq 0 ] || [ -z "${SPECS[0]}" ]; then
  echo "No active deployments found."
  exit 0
fi
echo "Found ${#SPECS[@]} active services"

# ── Fetch registry for spec filenames ────────────────────────
REGISTRY=$(curl -sS --max-time 10 "${WORKER_URL}/specs/registry.json" 2>/dev/null || echo "[]")

# ── Extract routes from spec YAML (grep-based, no PyYAML) ───
extract_routes() {
  local spec_id="$1"
  local filename
  filename=$(echo "$REGISTRY" | python3 -c "
import json, sys
for e in json.load(sys.stdin):
    if e.get('id') == '${spec_id}':
        print(e.get('filename', ''))
        break
" 2>/dev/null)

  echo "GET /health"

  if [ -z "$filename" ]; then
    return
  fi

  local spec_dir="${REPO_ROOT}/specs"
  local spec_file="${spec_dir}/${filename}"
  local spec_content=""

  if [ -f "$spec_file" ]; then
    spec_content=$(cat "$spec_file")
  else
    spec_content=$(curl -sS --max-time 10 "${WORKER_URL}/specs/${filename}" 2>/dev/null || true)
  fi

  if [ -z "$spec_content" ]; then
    return
  fi

  echo "$spec_content" | awk '
    /^  \/[^ ]+:/ {
      gsub(/:$/, "", $1)
      gsub(/^ +/, "", $1)
      current_path = $1
      next
    }
    /^    (get|post|put|patch|delete):/ && current_path != "" {
      gsub(/:$/, "", $1)
      gsub(/^ +/, "", $1)
      method = toupper($1)
      path = current_path
      gsub(/\{[^}]+\}/, "test-001", path)
      if (path != "/health") print method " " path
    }
  '
}

# ── Blast a single service URL ───────────────────────────────
blast_service() {
  local spec_id="$1" base_url="$2"
  local routes
  routes=$(extract_routes "$spec_id")
  local ok=0 fail=0

  while IFS= read -r line; do
    line="$(echo "$line" | xargs)"
    [ -z "$line" ] && continue
    local method path
    method="$(echo "$line" | awk '{print $1}')"
    path="$(echo "$line" | awk '{print $2}')"

    local status
    if [ "$method" = "POST" ] || [ "$method" = "PUT" ] || [ "$method" = "PATCH" ]; then
      status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
        -X "$method" -H "Content-Type: application/json" -d '{}' "${base_url}${path}" 2>/dev/null || echo "000")
    else
      status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
        -X "$method" "${base_url}${path}" 2>/dev/null || echo "000")
    fi

    if [[ "$status" -ge 400 || "$status" == "000" ]]; then
      fail=$((fail + 1))
    else
      ok=$((ok + 1))
    fi
  done <<< "$routes"

  echo "${ok} ${fail}" >> "${RESULTS_DIR}/counts"
}

# ── Count URLs ───────────────────────────────────────────────
URL_COUNT=0
for entry in "${SPECS[@]}"; do
  IFS='|' read -r _ url_list <<< "$entry"
  IFS=';' read -ra urls <<< "$url_list"
  URL_COUNT=$((URL_COUNT + ${#urls[@]}))
done

echo "Blasting ${#SPECS[@]} services across ${URL_COUNT} env URLs x ${ROUNDS} rounds"
echo ""

# ── Run rounds ───────────────────────────────────────────────
for round in $(seq 1 "$ROUNDS"); do
  active=0
  for entry in "${SPECS[@]}"; do
    IFS='|' read -r spec_id url_list <<< "$entry"
    IFS=';' read -ra urls <<< "$url_list"
    for url in "${urls[@]}"; do
      blast_service "$spec_id" "$url" &
      active=$((active + 1))
      if (( active % CONCURRENT == 0 )); then
        wait
      fi
    done
  done
  wait
  echo "  Round ${round}/${ROUNDS} complete"
done

# ── Summary ──────────────────────────────────────────────────
TOTAL_OK=0; TOTAL_FAIL=0
if [ -f "${RESULTS_DIR}/counts" ]; then
  while read -r ok fail; do
    TOTAL_OK=$((TOTAL_OK + ok))
    TOTAL_FAIL=$((TOTAL_FAIL + fail))
  done < "${RESULTS_DIR}/counts"
fi
TOTAL=$((TOTAL_OK + TOTAL_FAIL))

echo ""
echo "Done: ${TOTAL} requests (${TOTAL_OK} ok, ${TOTAL_FAIL} errors) across ${#SPECS[@]} services"

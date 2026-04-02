#!/usr/bin/env bash
set -euo pipefail

APPLY=false
SLUG_FILTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=true
      shift
      ;;
    --slug)
      SLUG_FILTER="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: $0 [--apply] [--slug <slug>]"
      exit 1
      ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required"
  exit 1
fi

echo "Runtime migration mode: $([[ "$APPLY" == "true" ]] && echo "APPLY" || echo "DRY-RUN")"
[[ -n "$SLUG_FILTER" ]] && echo "Tenant filter: ${SLUG_FILTER}"

KEYS_JSON="$(npx wrangler kv key list --binding PORTAL_CONFIG --remote)"
mapfile -t KEYS < <(echo "$KEYS_JSON" | jq -r '.[].name')

UPDATED=0
SKIPPED=0
FAILED=0

for KEY in "${KEYS[@]}"; do
  if [[ "$KEY" == views:* || "$KEY" == audit:* || "$KEY" == runtime_pool:* ]]; then
    continue
  fi
  if [[ -n "$SLUG_FILTER" && "$KEY" != "$SLUG_FILTER" ]]; then
    continue
  fi

  RAW="$(npx wrangler kv key get --binding PORTAL_CONFIG "$KEY" --remote 2>/dev/null || true)"
  if [[ -z "$RAW" ]]; then
    SKIPPED=$((SKIPPED + 1))
    echo "skip ${KEY}: empty config"
    continue
  fi

  TMP_IN="$(mktemp)"
  TMP_OUT="$(mktemp)"
  trap 'rm -f "$TMP_IN" "$TMP_OUT"' EXIT
  printf '%s' "$RAW" > "$TMP_IN"

  if ! python3 - "$TMP_IN" "$TMP_OUT" <<'PY'
import json
import re
import sys

in_path, out_path = sys.argv[1], sys.argv[2]
with open(in_path, "r", encoding="utf-8") as f:
    cfg = json.load(f)

templates = cfg.get("templates") or []
if not isinstance(templates, list):
    templates = []

def slugify(value: str) -> str:
    value = (value or "").strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-+", "-", value).strip("-")
    return value or "template"

def infer_runtime(template: dict) -> str:
    runtime = template.get("runtime")
    if runtime in ("lambda", "ecs_service", "k8s_roadmap"):
        return runtime
    title = (template.get("title") or "").lower()
    if "lambda" in title:
        return "lambda"
    if "ecs" in title or "eks" in title:
        return "ecs_service"
    if "k8s" in title or "kubernetes" in title:
        return "k8s_roadmap"
    return "lambda"

canonical = [
    {
        "id": "python-3-11-flask-system-api-lambda",
        "runtime": "lambda",
        "provisioning_enabled": True,
        "title": "Python 3.11 Flask System API (AWS Lambda)",
        "description": "Production-ready REST API with Postman workspace, test collections, CI/CD pipeline, and API Gateway integration.",
        "version": "Template Version 4.0",
        "highlighted": True,
        "enabled": True,
        "postman_integrated": True,
    },
    {
        "id": "python-3-11-flask-system-api-ecs-k8s",
        "runtime": "ecs_service",
        "provisioning_enabled": True,
        "title": "Python 3.11 Flask System API (ECS/K8s)",
        "description": "Production-ready REST API with Postman workspace, test collections, CI/CD pipeline, and prewarmed ECS runtime for fast demo deployment.",
        "version": "Template Version 4.0",
        "highlighted": True,
        "enabled": True,
        "postman_integrated": True,
    },
]

normalized = []
for idx, template in enumerate(templates):
    if not isinstance(template, dict):
        continue
    runtime = infer_runtime(template)
    enabled = template.get("enabled", True)
    provisioning_enabled = template.get("provisioning_enabled", enabled)
    normalized.append({
        **template,
        "id": template.get("id") or slugify(template.get("title") or f"template-{idx+1}"),
        "runtime": runtime,
        "enabled": enabled,
        "provisioning_enabled": provisioning_enabled,
        "postman_integrated": template.get("postman_integrated", True),
    })

has_lambda = any(t.get("runtime") == "lambda" and t.get("provisioning_enabled") for t in normalized)
has_ecs = any(t.get("runtime") == "ecs_service" and t.get("provisioning_enabled") for t in normalized)
if not has_lambda:
    normalized.append(dict(canonical[0]))
if not has_ecs:
    normalized.append(dict(canonical[1]))

dedup = {}
for template in normalized:
    tid = template.get("id") or slugify(template.get("title") or "template")
    if tid not in dedup:
        dedup[tid] = {**template, "id": tid}

rank = {"lambda": 0, "ecs_service": 1, "k8s_roadmap": 2}
final_templates = sorted(
    dedup.values(),
    key=lambda t: rank.get(t.get("runtime") or "lambda", 3),
)

if not any(t.get("highlighted") for t in final_templates):
    for t in final_templates:
        if t.get("runtime") == "lambda":
            t["highlighted"] = True
            break

cfg["templates"] = final_templates
backend = cfg.get("backend") or {}
runtime_defaults = backend.get("runtime_defaults") or {}
runtime_defaults.setdefault("default_runtime", "lambda")
runtime_defaults.setdefault("ecs_base_url", "")
runtime_defaults.setdefault("ecs_cluster_name", "")
runtime_defaults.setdefault("ecs_service_name", "")
runtime_defaults.setdefault("ecs_task_definition", "")
backend["runtime_defaults"] = runtime_defaults
cfg["backend"] = backend

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f)
PY
  then
    FAILED=$((FAILED + 1))
    echo "fail ${KEY}: unable to transform config"
    rm -f "$TMP_IN" "$TMP_OUT"
    continue
  fi

  if [[ "$APPLY" == "true" ]]; then
    npx wrangler kv key put --binding PORTAL_CONFIG "$KEY" --path "$TMP_OUT" --remote >/dev/null
    echo "updated ${KEY}"
  else
    TEMPLATE_COUNT="$(jq '.templates | length' "$TMP_OUT")"
    echo "plan ${KEY}: templates=${TEMPLATE_COUNT}"
  fi
  UPDATED=$((UPDATED + 1))
  rm -f "$TMP_IN" "$TMP_OUT"
done

echo "Done: updated=${UPDATED} skipped=${SKIPPED} failed=${FAILED}"

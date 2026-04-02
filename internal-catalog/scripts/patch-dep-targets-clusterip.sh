#!/usr/bin/env bash
# patch-dep-targets-clusterip.sh
#
# Patches DEPENDENCY_TARGETS_JSON on all k8s deployments in the vzw-partner-demo
# namespace to use internal ClusterIP DNS instead of the external NLB hostname.
#
# This fixes Insights sidecar dependency graph resolution — NLB/ingress routing
# destroys source/dest pod IP identity, but ClusterIP DNS routes pod-to-pod.
#
# Usage:
#   ./scripts/patch-dep-targets-clusterip.sh              # apply patches
#   ./scripts/patch-dep-targets-clusterip.sh --dry-run    # preview only
#
# Requires: kubectl configured with access to the target cluster.
#   Set KUBECONFIG_B64 to auto-decode, or have KUBECONFIG/~/.kube/config ready.

set -euo pipefail

NAMESPACE="${K8S_NAMESPACE:-vzw-partner-demo}"
DRY_RUN=false
PATCHED=0
SKIPPED=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

# Auto-decode KUBECONFIG_B64 if set and KUBECONFIG is not
if [[ -n "${KUBECONFIG_B64:-}" && -z "${KUBECONFIG:-}" ]]; then
  tmpkc="$(mktemp)"
  echo "$KUBECONFIG_B64" | base64 -d > "$tmpkc"
  export KUBECONFIG="$tmpkc"
  trap 'rm -f "$tmpkc"' EXIT
fi

echo "=== Patch DEPENDENCY_TARGETS_JSON: NLB → ClusterIP DNS ==="
echo "Namespace: $NAMESPACE"
echo "Dry run:   $DRY_RUN"
echo ""

# Get all deployment names
deployments=$(kubectl get deployments -n "$NAMESPACE" -o jsonpath='{.items[*].metadata.name}')

if [[ -z "$deployments" ]]; then
  echo "No deployments found in namespace $NAMESPACE"
  exit 0
fi

for deploy in $deployments; do
  # Read DEPENDENCY_TARGETS_JSON from the first container (app container)
  current=$(kubectl get deployment "$deploy" -n "$NAMESPACE" \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="DEPENDENCY_TARGETS_JSON")].value}' 2>/dev/null || true)

  # Skip if empty or not set
  if [[ -z "$current" || "$current" == "[]" ]]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Skip if already using ClusterIP DNS
  if echo "$current" | grep -q "svc.cluster.local"; then
    echo "SKIP $deploy (already using ClusterIP DNS)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Transform NLB URLs to ClusterIP DNS
  # Input:  ["http://af225b...elb.eu-west-2.amazonaws.com/svc/af-cards-3ds-prod", ...]
  # Output: ["http://af-cards-3ds-prod.vzw-partner-demo.svc.cluster.local/svc/af-cards-3ds-prod", ...]
  new_value=$(echo "$current" | python3 -c "
import json, sys, re

data = json.load(sys.stdin)
namespace = '$NAMESPACE'
result = []
for url in data:
    m = re.search(r'/svc/([^/]+)/?$', url.rstrip('/'))
    if m:
        svc = m.group(1)
        result.append(f'http://{svc}.{namespace}.svc.cluster.local/svc/{svc}')
    else:
        result.append(url)
print(json.dumps(result))
")

  echo "PATCH $deploy"
  echo "  BEFORE: $current"
  echo "  AFTER:  $new_value"

  if [[ "$DRY_RUN" == "false" ]]; then
    kubectl set env deployment/"$deploy" -n "$NAMESPACE" \
      -c "$(kubectl get deployment "$deploy" -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[0].name}')" \
      "DEPENDENCY_TARGETS_JSON=$new_value"
  fi

  PATCHED=$((PATCHED + 1))
done

echo ""
echo "=== Summary ==="
echo "Patched: $PATCHED"
echo "Skipped: $SKIPPED"
if [[ "$DRY_RUN" == "true" && "$PATCHED" -gt 0 ]]; then
  echo "(dry run — no changes applied, re-run without --dry-run to apply)"
fi

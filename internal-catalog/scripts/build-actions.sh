#!/usr/bin/env bash
set -euo pipefail

if command -v nproc >/dev/null 2>&1; then
  default_jobs="$(nproc)"
elif command -v getconf >/dev/null 2>&1; then
  default_jobs="$(getconf _NPROCESSORS_ONLN)"
elif command -v sysctl >/dev/null 2>&1; then
  default_jobs="$(sysctl -n hw.ncpu)"
else
  default_jobs=2
fi

max_jobs="${MAX_ACTION_BUILDS:-$default_jobs}"
if [[ ! "$max_jobs" =~ ^[0-9]+$ ]] || [ "$max_jobs" -lt 1 ]; then
  echo "Invalid MAX_ACTION_BUILDS value: $max_jobs"
  exit 1
fi

echo "Compiling GitHub Actions (parallel, max_jobs=$max_jobs)..."

actions=()
for action in .github/actions/*; do
  if [ -d "$action" ] && [ -f "$action/src/index.ts" ]; then
    actions+=("$action")
  fi
done

if [ "${#actions[@]}" -eq 0 ]; then
  echo "No action bundles detected."
  exit 0
fi

# Optional filter for targeted builds (comma/space/newline separated).
# Accepts action names (aws-deploy) or paths (.github/actions/aws-deploy).
if [ -n "${ACTIONS_TO_BUILD:-}" ]; then
  filtered=()
  while IFS= read -r token; do
    token="$(echo "$token" | xargs)"
    [ -z "$token" ] && continue

    if [ -d "$token" ] && [ -f "$token/src/index.ts" ]; then
      filtered+=("$token")
      continue
    fi

    candidate=".github/actions/$token"
    if [ -d "$candidate" ] && [ -f "$candidate/src/index.ts" ]; then
      filtered+=("$candidate")
      continue
    fi

    echo "Warning: ACTIONS_TO_BUILD entry not recognized: $token"
  done < <(printf '%s\n' "$ACTIONS_TO_BUILD" | tr ', ' '\n\n')

  if [ "${#filtered[@]}" -eq 0 ]; then
    echo "No matching action bundles for ACTIONS_TO_BUILD=$ACTIONS_TO_BUILD"
    exit 0
  fi

  actions=("${filtered[@]}")
fi

echo "Actions selected: ${actions[*]}"

pids=()
for action in "${actions[@]}"; do
  echo "Building $(basename "$action")..."
  bunx @vercel/ncc build "$action/src/index.ts" -o "$action/dist" &
  pids+=("$!")

  if [ "${#pids[@]}" -ge "$max_jobs" ]; then
    if ! wait "${pids[0]}"; then
      echo "One or more action builds failed."
      exit 1
    fi
    pids=("${pids[@]:1}")
  fi
done

for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    echo "One or more action builds failed."
    exit 1
  fi
done

echo "All actions compiled successfully."

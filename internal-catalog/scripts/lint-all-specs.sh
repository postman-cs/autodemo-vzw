#!/usr/bin/env bash
set -euo pipefail

SPECS_DIR="$(cd "$(dirname "$0")/../specs" && pwd)"
RESULTS_DIR=$(mktemp -d)
trap 'rm -rf "${RESULTS_DIR}"' EXIT

SPECS=()
while IFS= read -r -d '' f; do
  SPECS+=("$f")
done < <(find "${SPECS_DIR}" -name '*.yaml' -type f -print0 | sort -z)
TOTAL=${#SPECS[@]}
PARALLEL=${1:-10}

if [ "${TOTAL}" -eq 0 ]; then
  echo "No spec files found under ${SPECS_DIR}"
  exit 1
fi

echo "Linting ${TOTAL} specs (${PARALLEL} parallel)..."
echo ""

lint_spec() {
  local SPEC_PATH="$1"
  local REL_PATH="${SPEC_PATH#${SPECS_DIR}/}"
  local NAME
  NAME=$(basename "${SPEC_PATH}" .yaml)
  local OUT_FILE="${RESULTS_DIR}/${NAME}.out"
  local EXIT_CODE=0

  OUTPUT=$(postman spec lint "${SPEC_PATH}" -o json 2>&1) || EXIT_CODE=$?

  ERRORS=0
  WARNINGS=0
  if echo "${OUTPUT}" | jq -e '.violations' >/dev/null 2>&1; then
    ERRORS=$(echo "${OUTPUT}" | jq '[.violations[] | select(.severity=="ERROR")] | length')
    WARNINGS=$(echo "${OUTPUT}" | jq '[.violations[] | select(.severity=="WARNING")] | length')
  fi

  if [ "${EXIT_CODE}" -ne 0 ] || [ "${ERRORS}" -gt 0 ]; then
    echo "FAIL  ${REL_PATH}: ${ERRORS} errors, ${WARNINGS} warnings"
    echo "FAIL ${ERRORS} ${WARNINGS} ${REL_PATH}" > "${OUT_FILE}"
    if [ "${ERRORS}" -gt 0 ]; then
      echo "${OUTPUT}" | jq -r '.violations[] | select(.severity=="ERROR") | "  \(.path): \(.issue)"' 2>/dev/null | head -5
    fi
  else
    echo "OK    ${REL_PATH}: ${WARNINGS} warnings"
    echo "OK 0 ${WARNINGS} ${REL_PATH}" > "${OUT_FILE}"
  fi
}

export -f lint_spec
export RESULTS_DIR SPECS_DIR

printf '%s\n' "${SPECS[@]}" | xargs -P "${PARALLEL}" -I{} bash -c 'lint_spec "$@"' _ {}

echo ""
echo "--- Summary ---"

PASS=0
FAIL=0
TOTAL_ERRORS=0
TOTAL_WARNINGS=0
CLEAN=0

for f in "${RESULTS_DIR}"/*.out; do
  read -r STATUS ERRS WARNS REST < "${f}"
  TOTAL_WARNINGS=$((TOTAL_WARNINGS + WARNS))
  if [ "${STATUS}" = "FAIL" ]; then
    FAIL=$((FAIL + 1))
    TOTAL_ERRORS=$((TOTAL_ERRORS + ERRS))
  else
    PASS=$((PASS + 1))
    if [ "${WARNS}" -eq 0 ]; then
      CLEAN=$((CLEAN + 1))
    fi
  fi
done

echo "${PASS} passed (${CLEAN} clean, $((PASS - CLEAN)) with warnings), ${FAIL} failed"
echo "Total: ${TOTAL_ERRORS} errors, ${TOTAL_WARNINGS} warnings across ${TOTAL} specs"

if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi

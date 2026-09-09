#!/bin/zsh
# Forward smoke options, for example:
#   ./run-smoke-compare-stmt.zsh --resume

set -euo pipefail

CLI_ROOT="${0:A:h}"
SAMPLES_DIR="${OCCS_SAMPLES_DIR:-$HOME/occs-samples/statement}"
SUITE_FILE="${OCCS_SMOKE_SUITE:-$SAMPLES_DIR/smoke-statements.json}"
SMOKE_TARGET="${OCCS_SMOKE_TARGET:-non-prod}"
COMPARE_SOURCE="${OCCS_COMPARE_SOURCE:-non-prod}"
COMPARE_TARGET="${OCCS_COMPARE_TARGET:-pre-prod}"
REQUEST_TIMEOUT="${OCCS_SMOKE_TIMEOUT:-60000}"
EXTRA_SMOKE_ARGS=("$@")

if [[ ! -f "$SUITE_FILE" ]]; then
  print -u2 "Smoke suite not found: $SUITE_FILE"
  print -u2 "Set OCCS_SAMPLES_DIR or OCCS_SMOKE_SUITE to its current location."
  exit 1
fi

print "\n=== Smoke comparison: $COMPARE_SOURCE vs $COMPARE_TARGET ==="
node "$CLI_ROOT/bin/occs.js" smoke \
  --suite "$SUITE_FILE" \
  --tenancy "$COMPARE_SOURCE" \
  --compare-tenancy "$COMPARE_TARGET" \
  --output "$SAMPLES_DIR/smoke-output-$COMPARE_SOURCE-vs-$COMPARE_TARGET" \
  --timeout "$REQUEST_TIMEOUT" \
  "${EXTRA_SMOKE_ARGS[@]}"

print "\nSmoke runs complete."

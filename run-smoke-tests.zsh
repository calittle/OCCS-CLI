#!/bin/zsh
# Run the standard pre-production smoke test, then compare non-production with pre-production.
# Override defaults when needed, for example:
#   OCCS_SAMPLES_DIR="$HOME/Documents/samples" ./run-smoke-tests.zsh

set -euo pipefail

CLI_ROOT="${0:A:h}"
SAMPLES_DIR="${OCCS_SAMPLES_DIR:-/Users/clittle/Library/CloudStorage/OneDrive-OracleCorporation/Project Repository/400243832 - Example CCS Implementation/working/samples}"
SUITE_FILE="${OCCS_SMOKE_SUITE:-$SAMPLES_DIR/smoke-suite.json}"
SMOKE_TARGET="${OCCS_SMOKE_TARGET:-pre-prod}"
COMPARE_SOURCE="${OCCS_COMPARE_SOURCE:-non-prod}"
COMPARE_TARGET="${OCCS_COMPARE_TARGET:-pre-prod}"
REQUEST_TIMEOUT="${OCCS_SMOKE_TIMEOUT:-60000}"

if [[ ! -f "$SUITE_FILE" ]]; then
  print -u2 "Smoke suite not found: $SUITE_FILE"
  print -u2 "Set OCCS_SAMPLES_DIR or OCCS_SMOKE_SUITE to its current location."
  exit 1
fi

print "\n=== Regular smoke test: $SMOKE_TARGET ==="
node "$CLI_ROOT/bin/occs.js" smoke \
  --suite "$SUITE_FILE" \
  --tenancy "$SMOKE_TARGET" \
  --output "$SAMPLES_DIR/smoke-output-$SMOKE_TARGET" \
  --timeout "$REQUEST_TIMEOUT"

print "\n=== Smoke comparison: $COMPARE_SOURCE vs $COMPARE_TARGET ==="
node "$CLI_ROOT/bin/occs.js" smoke \
  --suite "$SUITE_FILE" \
  --tenancy "$COMPARE_SOURCE" \
  --compare-tenancy "$COMPARE_TARGET" \
  --output "$SAMPLES_DIR/smoke-output-$COMPARE_SOURCE-vs-$COMPARE_TARGET" \
  --timeout "$REQUEST_TIMEOUT"

print "\nSmoke runs complete. Each command prints its timestamped output folder."

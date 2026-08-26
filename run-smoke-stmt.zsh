#!/bin/zsh
# Forward smoke options, for example:
#   ./run-smoke-stmt.zsh --resume

set -euo pipefail

CLI_ROOT="${0:A:h}"
SAMPLES_DIR="${OCCS_SAMPLES_DIR:-/Users/clittle/Library/CloudStorage/OneDrive-OracleCorporation/Project Repository/400243832 - Example CCS Implementation/working/samples/statement}"
SUITE_FILE="${OCCS_SMOKE_SUITE:-$SAMPLES_DIR/smoke-statements.json}"
SMOKE_TARGET="${OCCS_SMOKE_TARGET:-non-prod}"
REQUEST_TIMEOUT="${OCCS_SMOKE_TIMEOUT:-60000}"
EXTRA_SMOKE_ARGS=("$@")

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
  --timeout "$REQUEST_TIMEOUT" \
  "${EXTRA_SMOKE_ARGS[@]}"

print "\nSmoke runs complete. Each command prints its timestamped output folder."
